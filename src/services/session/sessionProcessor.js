import { ChatSession } from '../../models/ChatSession.js'
import { env } from '../../config/environment.js'
import {
  emitJobUpdate,
  emitSessionStatus,
  emitSessionComplete,
  emitSessionFailure,
} from '../realtime/sessionStream.js'
import {
  buildPreferenceProfile,
  generateAssistantSummary,
} from '../gemini/geminiService.js'
import { normalizeScrapedJobs } from '../matching/jobNormalizer.js'
import { scoreJobForProfile } from '../scoring/jobScorer.js'
import { scrapeJobsWithPlaywright } from '../scraping/playwrightScraper.js'
import { buildMatchedJobs } from './matchPipeline.js'
import {
  clearSessionAbortSignal,
  createSessionAbortSignal,
} from './sessionControl.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const toSafeErrorMessage = (error) => {
  return error instanceof Error ? error.message : 'Unexpected processing failure.'
}

const debugLog = (sessionId, message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[session:${sessionId}] ${message}`, context)
}

const buildJobKey = (job) =>
  String(
    job.jobHash ||
      job.externalId ||
      `${job.title || ''}-${job.company || ''}-${job.applyLink || ''}`,
  ).toLowerCase()

const mergeUniqueJobs = (existingJobs, incomingJobs, limit = 60) => {
  const merged = []
  const seen = new Set()

  for (const job of [...existingJobs, ...incomingJobs]) {
    const key = buildJobKey(job)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(job)
    if (merged.length >= limit) break
  }

  return merged
}

const INITIAL_SCRAPE_GOAL = 15
const DEEP_SCRAPE_GOAL = 34
const INITIAL_SOURCE_CAP = 12
const DEEP_SOURCE_CAP = 24
const HIGH_RELEVANCE_SCORE = 60
const MIN_HIGH_RELEVANCE_ROLES = 4

const countHighRelevanceJobs = (jobs) => {
  return (jobs || []).filter((job) => Number(job?.matchScore || 0) >= HIGH_RELEVANCE_SCORE).length
}

const buildContinuationPrompt = ({ foundJobs, strongJobs }) => {
  if (foundJobs <= 0 || strongJobs <= 0) {
    return (
      'I could not find strongly relevant openings for this exact query yet. ' +
      'You can tweak your query, or ask me to hunt deeper by saying "move further".'
    )
  }

  return (
    `I paused after collecting ${foundJobs} jobs (${strongJobs} strong matches) to keep load efficient. ` +
    'Want me to continue searching deeper? Say "move further".'
  )
}

export const processSessionInBackground = async ({ sessionId, prompt, resumeText }) => {
  const startedAt = Date.now()
  const abortSignal = createSessionAbortSignal(sessionId)
  let activePhase = 'initializing'
  let phaseStartedAt = Date.now()
  let phaseHeartbeat
  let structuredProfile = null
  const streamedJobs = []
  const streamedJobKeys = new Set()

  const throwIfAborted = () => {
    if (!abortSignal?.aborted) return
    const abortError = new Error(String(abortSignal.reason || 'Search cancelled by user request.'))
    abortError.name = 'AbortError'
    throw abortError
  }

  const setPhase = (phase, statusMessage) => {
    throwIfAborted()
    activePhase = phase
    phaseStartedAt = Date.now()
    emitSessionStatus(sessionId, statusMessage)
    debugLog(sessionId, `phase -> ${phase}`, { statusMessage })
  }

  const runPhase = async (phase, statusMessage, task) => {
    setPhase(phase, statusMessage)
    const stepStartedAt = Date.now()
    try {
      throwIfAborted()
      const result = await task()
      throwIfAborted()
      debugLog(sessionId, `phase complete: ${phase}`, {
        elapsedMs: Date.now() - stepStartedAt,
      })
      return result
    } catch (error) {
      debugLog(sessionId, `phase failed: ${phase}`, {
        elapsedMs: Date.now() - stepStartedAt,
        reason: error.message,
      })
      throw error
    }
  }

  const appendStreamedJobs = async (targetJobs) => {
    const normalizedBatch = normalizeScrapedJobs(targetJobs)
    for (const normalizedJob of normalizedBatch) {
      throwIfAborted()
      const scoredJob = scoreJobForProfile(normalizedJob, structuredProfile)
      const streamJob = {
        ...scoredJob,
        scrapedAt: new Date(),
      }

      const key = buildJobKey(streamJob)
      if (!key || streamedJobKeys.has(key)) continue

      streamedJobKeys.add(key)
      streamedJobs.push(streamJob)
      emitJobUpdate(sessionId, streamJob)
      await wait(45)
    }
  }

  try {
    phaseHeartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - phaseStartedAt) / 1000)
      const totalSeconds = Math.round((Date.now() - startedAt) / 1000)
      emitSessionStatus(
        sessionId,
        `Still working on ${activePhase} (${elapsedSeconds}s in phase, ${totalSeconds}s total)...`,
      )
      debugLog(sessionId, 'heartbeat', {
        activePhase,
        phaseElapsedSeconds: elapsedSeconds,
        totalElapsedSeconds: totalSeconds,
      })
    }, 8000)

    const { profile } = await runPhase(
      'profile-analysis',
      'Analyzing profile and preparing dynamic sources...',
      () => buildPreferenceProfile({ prompt, resumeText }),
    )
    structuredProfile = profile

    await runPhase('persist-profile', 'Saving profile context...', () =>
      ChatSession.findByIdAndUpdate(sessionId, {
        $set: {
          structuredProfile,
          preferenceProfile: structuredProfile,
        },
      }),
    )

    const initialScrapedJobs = await runPhase(
      'scraping-initial',
      'Starting focused scraping batch...',
      () =>
        scrapeJobsWithPlaywright(structuredProfile, {
          abortSignal,
          maxTargetsToScan: INITIAL_SOURCE_CAP,
          stopAfterJobs: INITIAL_SCRAPE_GOAL,
          perSourceCap: 5,
          finalDiversifiedLimit: 20,
          onStatus: (statusMessage) => {
            emitSessionStatus(sessionId, statusMessage)
          },
          onTargetJobs: appendStreamedJobs,
        }),
    )
    let combinedScrapedJobs = mergeUniqueJobs([], initialScrapedJobs, 160)

    let matched = await runPhase(
      'ai-filter-ranking',
      'Applying AI filtering and ranking on initial batch...',
      () =>
        buildMatchedJobs({
          rawJobs: combinedScrapedJobs,
          profile: structuredProfile,
        }),
    )
    let strongMatchCount = countHighRelevanceJobs(matched.filteredJobs)
    const needsDeeperSearch =
      matched.filteredJobs.length < 6 || strongMatchCount < MIN_HIGH_RELEVANCE_ROLES

    if (needsDeeperSearch) {
      const deeperScrapedJobs = await runPhase(
        'scraping-deeper',
        'Initial relevance is low. Searching deeper sources...',
        () =>
          scrapeJobsWithPlaywright(structuredProfile, {
            abortSignal,
            maxTargetsToScan: DEEP_SOURCE_CAP,
            stopAfterJobs: DEEP_SCRAPE_GOAL,
            perSourceCap: 6,
            finalDiversifiedLimit: 34,
            onStatus: (statusMessage) => {
              emitSessionStatus(sessionId, statusMessage)
            },
            onTargetJobs: appendStreamedJobs,
          }),
      )

      combinedScrapedJobs = mergeUniqueJobs(combinedScrapedJobs, deeperScrapedJobs, 220)
      matched = await runPhase(
        'ai-filter-ranking-deeper',
        'Re-scoring expanded results...',
        () =>
          buildMatchedJobs({
            rawJobs: combinedScrapedJobs,
            profile: structuredProfile,
          }),
      )
      strongMatchCount = countHighRelevanceJobs(matched.filteredJobs)
    }

    const filteredJobs = matched.filteredJobs.map((job) => ({
      ...job,
      scrapedAt: new Date(),
    }))
    const mergedJobs = mergeUniqueJobs(streamedJobs, filteredJobs, 60)

    setPhase('final-streaming', 'Finalizing top matches...')
    for (const job of filteredJobs) {
      throwIfAborted()
      const key = buildJobKey(job)
      if (streamedJobKeys.has(key)) continue
      streamedJobKeys.add(key)
      emitJobUpdate(sessionId, job)
      await wait(85)
    }
    debugLog(sessionId, 'phase complete: final-streaming', {
      streamedJobs: streamedJobs.length,
      finalJobs: filteredJobs.length,
      mergedJobs: mergedJobs.length,
    })

    const summary = await runPhase('assistant-summary', 'Generating assistant summary...', () =>
      generateAssistantSummary({
        profile: structuredProfile,
        topJobs: filteredJobs.slice(0, 5),
        userPrompt: prompt,
      }),
    )
    const continuationPrompt = buildContinuationPrompt({
      foundJobs: filteredJobs.length,
      strongJobs: strongMatchCount,
    })
    const finalSummary = `${summary}\n\n${continuationPrompt}`

    await runPhase('persist-session', 'Saving session results...', () =>
      ChatSession.findByIdAndUpdate(sessionId, {
        $set: {
          status: 'completed',
          errorMessage: '',
          jobs: mergedJobs,
          filteredJobs,
          lastScrapedJobs: matched.normalizedJobs.slice(0, 180),
        },
        $push: {
          messages: {
            role: 'assistant',
            content: finalSummary,
            createdAt: new Date(),
          },
          conversationHistory: {
            role: 'assistant',
            content: finalSummary,
            createdAt: new Date(),
          },
        },
      }),
    )

    clearInterval(phaseHeartbeat)
    phaseHeartbeat = null
    debugLog(sessionId, 'session processing completed', {
      totalElapsedMs: Date.now() - startedAt,
    })
    emitSessionStatus(
      sessionId,
      `Search complete in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
    )
    emitSessionComplete(sessionId, finalSummary)
  } catch (error) {
    if (phaseHeartbeat) {
      clearInterval(phaseHeartbeat)
      phaseHeartbeat = null
    }
    if (error?.name === 'AbortError') {
      const stoppedSummary =
        streamedJobs.length > 0
          ? `Stopped the search as requested. I found ${streamedJobs.length} jobs so far. Say "move further" whenever you want me to continue hunting deeper.`
          : 'Stopped the search as requested. I could not find relevant openings yet. You can tweak the query, or ask me to hunt deeper.'

      const partialSet = {
        status: 'completed',
        errorMessage: '',
        jobs: mergeUniqueJobs([], streamedJobs, 60),
        filteredJobs: mergeUniqueJobs([], streamedJobs, 60),
        lastScrapedJobs: mergeUniqueJobs([], streamedJobs, 120),
      }

      if (structuredProfile) {
        partialSet.structuredProfile = structuredProfile
        partialSet.preferenceProfile = structuredProfile
      }

      await ChatSession.findByIdAndUpdate(sessionId, {
        $set: partialSet,
        $push: {
          messages: {
            role: 'assistant',
            content: stoppedSummary,
            createdAt: new Date(),
          },
          conversationHistory: {
            role: 'assistant',
            content: stoppedSummary,
            createdAt: new Date(),
          },
        },
      })

      emitSessionStatus(sessionId, 'Search stopped by user.')
      emitSessionComplete(sessionId, stoppedSummary)
      return
    }

    const errorMessage = toSafeErrorMessage(error)
    debugLog(sessionId, 'session processing failed', {
      activePhase,
      totalElapsedMs: Date.now() - startedAt,
      reason: errorMessage,
    })

    await ChatSession.findByIdAndUpdate(sessionId, {
      $set: {
        status: 'failed',
        errorMessage,
      },
      $push: {
        messages: {
          role: 'assistant',
          content:
            'I could not complete this job search request right now. Please try again in a few moments.',
          createdAt: new Date(),
        },
        conversationHistory: {
          role: 'assistant',
          content:
            'I could not complete this job search request right now. Please try again in a few moments.',
          createdAt: new Date(),
        },
      },
    })

    emitSessionStatus(sessionId, `Search failed during ${activePhase}: ${errorMessage}`)
    emitSessionFailure(sessionId, errorMessage)
  } finally {
    clearSessionAbortSignal(sessionId)
  }
}

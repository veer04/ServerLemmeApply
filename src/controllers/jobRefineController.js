import { ChatSession } from '../models/ChatSession.js'
import {
  generateAssistantSummary,
  refineProfileWithInstruction,
} from '../services/gemini/geminiService.js'
import { scrapeJobsWithPlaywright } from '../services/scraping/playwrightScraper.js'
import { buildMatchedJobs } from '../services/session/matchPipeline.js'

const baseProfile = {
  role: '',
  primarySkills: [],
  secondarySkills: [],
  experienceYears: 0,
  locationPreference: '',
  remotePreference: false,
  salaryExpectation: {
    min: 0,
    max: 0,
    currency: 'INR',
    type: 'LPA',
  },
  seniorityLevel: '',
}

const buildJobKey = (job) =>
  String(job.externalId || `${job.title || ''}-${job.company || ''}-${job.applyLink || ''}`).toLowerCase()

const mergeJobs = (existingJobs, incomingJobs, limit = 60) => {
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

const continuationInstructionRegex =
  /\b(move\s*further|continue|search\s*more|more\s*jobs|load\s*more|hunt\s*deeper|go\s*deeper|keep\s*searching|keep\s*going)\b/i

const countStrongMatches = (jobs) => {
  return (jobs || []).filter((job) => Number(job?.matchScore || 0) >= 60).length
}

export const refineJobs = async (request, response, next) => {
  try {
    const sessionId = String(request.body.sessionId || '').trim()
    const instruction = String(request.body.instruction || '').trim()
    const loadMore = Boolean(request.body.loadMore)
    const continuationRequested = continuationInstructionRegex.test(instruction)
    const shouldLoadMore = loadMore || continuationRequested

    if (!sessionId || !instruction) {
      const error = new Error('sessionId and instruction are required.')
      error.statusCode = 400
      throw error
    }

    const session = await ChatSession.findById(sessionId)
    if (!session) {
      const error = new Error('Session not found for refinement.')
      error.statusCode = 404
      throw error
    }

    const currentProfile = session.structuredProfile || session.preferenceProfile || baseProfile
    const refinedProfile = await refineProfileWithInstruction({
      currentProfile,
      instruction,
    })

    const cachedJobs = Array.isArray(session.lastScrapedJobs) ? session.lastScrapedJobs : []
    const existingJobs = Array.isArray(session.jobs) ? session.jobs : []
    let matched = await buildMatchedJobs({
      rawJobs: cachedJobs,
      profile: refinedProfile,
    })

    let rescraped = false
    let combinedRawJobs = matched.normalizedJobs
    const weakRelevance = matched.filteredJobs.length < 5 || countStrongMatches(matched.filteredJobs) < 3
    if (shouldLoadMore || weakRelevance) {
      const freshlyScraped = await scrapeJobsWithPlaywright(refinedProfile, {
        maxTargetsToScan: shouldLoadMore ? 20 : 14,
        stopAfterJobs: shouldLoadMore ? 30 : 20,
        perSourceCap: shouldLoadMore ? 6 : 5,
        finalDiversifiedLimit: shouldLoadMore ? 34 : 22,
      })
      combinedRawJobs = [...cachedJobs, ...freshlyScraped]
      matched = await buildMatchedJobs({
        rawJobs: combinedRawJobs,
        profile: refinedProfile,
      })
      rescraped = true
    }

    const finalJobs = matched.filteredJobs.map((job) => ({
      ...job,
      scrapedAt: new Date(),
    }))
    const existingKeys = new Set(existingJobs.map((job) => buildJobKey(job)))
    const additionalJobs = matched.scoredJobs
      .filter((job) => !existingKeys.has(buildJobKey(job)))
      .slice(0, 12)
      .map((job) => ({
        ...job,
        scrapedAt: new Date(),
      }))
    const mergedJobs = mergeJobs(existingJobs, loadMore ? additionalJobs : finalJobs)

    let assistantSummary = await generateAssistantSummary({
      profile: refinedProfile,
      topJobs: shouldLoadMore ? additionalJobs.slice(0, 5) : finalJobs,
      userPrompt: instruction,
      isRefinement: true,
    })
    if (mergedJobs.length === 0 || countStrongMatches(mergedJobs) === 0) {
      assistantSummary = `${assistantSummary}\n\nI could not find strongly relevant openings for this instruction yet. You can tweak the query, or ask me to hunt deeper by saying "move further".`
    }

    await ChatSession.findByIdAndUpdate(sessionId, {
      $set: {
        status: 'completed',
        errorMessage: '',
        structuredProfile: refinedProfile,
        preferenceProfile: refinedProfile,
        jobs: mergedJobs,
        filteredJobs: mergedJobs,
        lastScrapedJobs: combinedRawJobs.slice(0, 220),
      },
      $push: {
        messages: {
          $each: [
            { role: 'user', content: instruction, createdAt: new Date() },
            { role: 'assistant', content: assistantSummary, createdAt: new Date() },
          ],
        },
        conversationHistory: {
          $each: [
            { role: 'user', content: instruction, createdAt: new Date() },
            { role: 'assistant', content: assistantSummary, createdAt: new Date() },
          ],
        },
      },
    })

    response.json({
      sessionId,
      structuredProfile: refinedProfile,
      jobs: mergedJobs,
      assistantMessage: assistantSummary,
      averageMatchScore: matched.averageMatchScore,
      rescraped,
      usedCachedJobs: cachedJobs.length > 0,
      loadMore: shouldLoadMore,
      continuationRequested,
    })
  } catch (error) {
    next(error)
  }
}

import { ChatSession } from '../models/ChatSession.js'
import {
  generateAssistantSummary,
  refineProfileWithInstruction,
} from '../services/gemini/geminiService.js'
import { handleUserMessage } from '../services/chat/chatRouter.js'
import {
  getUserContext,
  mergeExtractedProfile,
  recordConversationTurn,
  updateUserContext,
} from '../services/context/contextService.js'
import { scrapeJobsWithPlaywright } from '../services/scraping/playwrightScraper.js'
import { buildMatchedJobs } from '../services/session/matchPipeline.js'
import { calculateTokensUsed } from '../services/token/tokenService.js'
import {
  buildTokenUsagePayload,
  getLimitsForIdentity,
  incrementUsageTokensAtomic,
  normalizeUsageMeta,
  resolveUsageIdentityFromRequest,
} from '../services/token/usageService.js'
import mongoose from 'mongoose'

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

const toSortedFiniteNumbers = (values) =>
  (Array.isArray(values) ? values : [])
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .sort((left, right) => left - right)

const percentile = (values, percentileValue) => {
  const sorted = toSortedFiniteNumbers(values)
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]

  const normalizedPercentile = Math.max(0, Math.min(100, Number(percentileValue) || 0))
  const rank = (normalizedPercentile / 100) * (sorted.length - 1)
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  if (lowerIndex === upperIndex) return sorted[lowerIndex]

  const weight = rank - lowerIndex
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight
}

const getStrongMatchStats = (jobs) => {
  const scores = toSortedFiniteNumbers((jobs || []).map((job) => Number(job?.matchScore || 0)))
  if (scores.length === 0) {
    return {
      strongCount: 0,
      minStrongRequired: 2,
    }
  }

  const strongCutoff = scores.length >= 4 ? percentile(scores, 75) : 60
  const strongCount = scores.filter((score) => score >= strongCutoff).length
  const minStrongRequired = Math.max(2, Math.ceil(scores.length * 0.25))
  return { strongCount, minStrongRequired }
}

const parseExperienceYearsFromText = (value) => {
  const matched = String(value || '').match(/(\d+)/)
  return matched ? Number(matched[1]) : 0
}

const mergeProfileWithContextData = (profile, contextProfile) => {
  const base = profile && typeof profile === 'object' ? profile : baseProfile
  const mergedContext = contextProfile && typeof contextProfile === 'object' ? contextProfile : {}
  const mergedSkills = [
    ...new Set([
      ...(Array.isArray(base.primarySkills) ? base.primarySkills : []),
      ...(Array.isArray(base.secondarySkills) ? base.secondarySkills : []),
      ...(Array.isArray(mergedContext.skills) ? mergedContext.skills : []),
    ]),
  ]

  const contextExperienceYears = parseExperienceYearsFromText(mergedContext.experience)

  return {
    ...base,
    role: String(base.role || mergedContext.role || '').trim(),
    primarySkills: mergedSkills.slice(0, 10),
    secondarySkills: mergedSkills.slice(10, 20),
    experienceYears: Math.max(Number(base.experienceYears || 0), contextExperienceYears),
    locationPreference: String(base.locationPreference || mergedContext.location || '').trim(),
  }
}

export const refineJobs = async (request, response, next) => {
  try {
    const sessionId = String(request.body.sessionId || '').trim()
    const instruction = String(request.body.instruction || '').trim()
    const loadMore = Boolean(request.body.loadMore)
    const userId = String(request.user?.userId || '').trim()
    let continuationRequested = continuationInstructionRegex.test(instruction)
    let shouldLoadMore = loadMore || continuationRequested

    if (!sessionId || !instruction) {
      const error = new Error('sessionId and instruction are required.')
      error.statusCode = 400
      throw error
    }
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      const error = new Error('sessionId must be a valid ObjectId.')
      error.statusCode = 400
      throw error
    }

    const session = await ChatSession.findOne({
      _id: sessionId,
      userId: new mongoose.Types.ObjectId(userId),
    })
    if (!session) {
      const error = new Error('Session not found for this user.')
      error.statusCode = 404
      throw error
    }

    const usageIdentity = normalizeUsageMeta({
      ...(request.usageContext || resolveUsageIdentityFromRequest(request)),
      inputText: instruction,
    })
    const userContext = getUserContext(usageIdentity)
    const routeResult = await handleUserMessage(instruction, userContext)
    const mergedContextProfile = mergeExtractedProfile(
      userContext.extractedProfile,
      routeResult?.mergedProfile || routeResult?.extractedData || {},
    )

    updateUserContext(usageIdentity, {
      lastIntent: routeResult?.intent || 'UNKNOWN',
      extractedProfile: mergedContextProfile,
      lastSearchQuery: routeResult?.shouldScrape
        ? String(routeResult?.searchPrompt || instruction).trim()
        : userContext?.lastSearchQuery || '',
      pendingAction: routeResult?.pendingAction || '',
    })
    recordConversationTurn(usageIdentity, {
      role: 'user',
      content: instruction,
    })

    if (!routeResult?.shouldScrape) {
      const assistantMessage = String(
        routeResult?.message || 'I can help with career guidance or search. Tell me what you need.',
      ).trim()
      const preservedJobs = Array.isArray(session.jobs) ? session.jobs : []

      await ChatSession.findByIdAndUpdate(sessionId, {
        $set: {
          status: 'completed',
          errorMessage: '',
        },
        $push: {
          messages: {
            $each: [
              { role: 'user', content: instruction, createdAt: new Date() },
              { role: 'assistant', content: assistantMessage, createdAt: new Date() },
            ],
          },
          conversationHistory: {
            $each: [
              { role: 'user', content: instruction, createdAt: new Date() },
              { role: 'assistant', content: assistantMessage, createdAt: new Date() },
            ],
          },
        },
      })

      recordConversationTurn(usageIdentity, {
        role: 'assistant',
        content: assistantMessage,
      })

      response.json({
        sessionId,
        structuredProfile: session.structuredProfile || session.preferenceProfile || baseProfile,
        jobs: preservedJobs,
        assistantMessage,
        averageMatchScore:
          preservedJobs.length > 0
            ? Math.round(
                preservedJobs.reduce((sum, job) => sum + Number(job?.matchScore || 0), 0) /
                  preservedJobs.length,
              )
            : 0,
        rescraped: false,
        usedCachedJobs: false,
        loadMore: false,
        continuationRequested: false,
        responseType: routeResult?.type || 'CHAT',
        suggestions: Array.isArray(routeResult?.suggestions) ? routeResult.suggestions.slice(0, 5) : [],
        tokenUsage: request.usageContext?.tokenUsage || null,
      })
      return
    }

    const normalizedInstruction = String(routeResult?.searchPrompt || instruction).trim() || instruction
    continuationRequested = continuationInstructionRegex.test(normalizedInstruction)
    shouldLoadMore = loadMore || continuationRequested

    const currentProfile = mergeProfileWithContextData(
      session.structuredProfile || session.preferenceProfile || baseProfile,
      mergedContextProfile,
    )
    const refinedProfile = await refineProfileWithInstruction({
      currentProfile,
      instruction: normalizedInstruction,
    })

    const cachedJobs = Array.isArray(session.lastScrapedJobs) ? session.lastScrapedJobs : []
    const existingJobs = Array.isArray(session.jobs) ? session.jobs : []
    let matched = await buildMatchedJobs({
      rawJobs: cachedJobs,
      profile: refinedProfile,
    })

    let rescraped = false
    let combinedRawJobs = matched.normalizedJobs
    const strongMatchStats = getStrongMatchStats(matched.filteredJobs)
    const weakRelevance =
      matched.filteredJobs.length < 5 ||
      strongMatchStats.strongCount < strongMatchStats.minStrongRequired
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

    const usageLimits = request.usageContext?.limits || getLimitsForIdentity(usageIdentity)
    const jobsReturnedForUsage = shouldLoadMore ? additionalJobs : finalJobs
    const tokenStats = calculateTokensUsed({
      inputText: normalizedInstruction,
      jobsReturned: jobsReturnedForUsage,
      aiEnrichmentUsed: true,
    })
    let tokenUsage = request.usageContext?.tokenUsage || null
    const hasTrackableIdentity =
      Boolean(usageIdentity?.userId) ||
      (Boolean(usageIdentity?.isGuest) &&
        Boolean(usageIdentity?.ipAddress) &&
        usageIdentity.ipAddress !== 'unknown')
    if (hasTrackableIdentity) {
      try {
        const updatedUsage = await incrementUsageTokensAtomic(usageIdentity, tokenStats.totalTokens)
        tokenUsage = buildTokenUsagePayload({
          usage: updatedUsage,
          limits: usageLimits,
        })
      } catch {
        tokenUsage = null
      }
    }

    let assistantSummary = await generateAssistantSummary({
      profile: refinedProfile,
      topJobs: shouldLoadMore ? additionalJobs.slice(0, 5) : finalJobs,
      userPrompt: normalizedInstruction,
      isRefinement: true,
    })
    if (mergedJobs.length === 0 || getStrongMatchStats(mergedJobs).strongCount === 0) {
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

    recordConversationTurn(usageIdentity, {
      role: 'assistant',
      content: assistantSummary,
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
      responseType: 'JOB_RESULT',
      suggestions: [],
      tokenUsage,
    })
  } catch (error) {
    next(error)
  }
}

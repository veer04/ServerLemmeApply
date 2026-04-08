import { ChatSession } from '../models/ChatSession.js'
import { UserProfile } from '../models/UserProfile.js'
import { env } from '../config/environment.js'
import { extractResumeText } from '../services/files/resumeTextExtractor.js'
import { initSessionStream } from '../services/realtime/sessionStream.js'
import { dispatchSessionProcessing } from '../services/session/sessionQueue.js'
import {
  buildTokenUsagePayload,
  getLimitsForIdentity,
  resolveUsageIdentityFromRequest,
  syncUsageWindow,
} from '../services/token/usageService.js'
import mongoose from 'mongoose'
import path from 'node:path'

const parseJsonSafely = (value, fallback = {}) => {
  if (!value) return fallback

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const toSessionSummary = (session) => {
  const lastAssistantMessage = session.messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content

  return {
    id: session._id.toString(),
    title: session.prompt,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    preview: lastAssistantMessage || '',
  }
}

const parseDateOrNow = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

const normalizeImportedMessage = (message) => {
  const source = message && typeof message === 'object' ? message : {}
  const role = ['user', 'assistant', 'system'].includes(String(source.role || '').trim())
    ? String(source.role).trim()
    : 'user'
  const content = String(source.content || '').trim()
  if (!content) return null
  return {
    role,
    content: content.slice(0, 4000),
    createdAt: parseDateOrNow(source.createdAt),
  }
}

const normalizeImportedJob = (job) => {
  const source = job && typeof job === 'object' ? job : {}
  const title = String(source.title || '').trim()
  const company = String(source.company || '').trim()
  if (!title || !company) return null

  const matchScore = Number(source.matchScore)
  return {
    source: String(source.source || '').trim() || 'guest',
    externalId: String(source.externalId || '').trim(),
    title: title.slice(0, 220),
    company: company.slice(0, 160),
    location: String(source.location || 'Not specified').trim() || 'Not specified',
    salary: String(source.salary || 'Not disclosed').trim() || 'Not disclosed',
    description: String(source.description || '').trim().slice(0, 6000),
    applyLink: String(source.applyLink || '#').trim() || '#',
    matchScore: Number.isFinite(matchScore) ? matchScore : 0,
    matchReasons: Array.isArray(source.matchReasons)
      ? source.matchReasons.map((reason) => String(reason || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    scrapedAt: parseDateOrNow(source.scrapedAt || source.bookmarkedAt),
  }
}

const toObjectId = (rawValue, fieldName = 'userId') => {
  const value = String(rawValue || '').trim()
  if (!mongoose.Types.ObjectId.isValid(value)) {
    const error = new Error(`${fieldName} must be a valid ObjectId.`)
    error.statusCode = 400
    throw error
  }
  return new mongoose.Types.ObjectId(value)
}

const buildStoredProfileContext = (profileDocument) => {
  if (!profileDocument) return ''

  const lines = []
  if (profileDocument.resumeUrl) {
    lines.push(`Resume on file: ${path.basename(String(profileDocument.resumeUrl || ''))}`)
  }
  if (Array.isArray(profileDocument.skills) && profileDocument.skills.length > 0) {
    lines.push(`Saved Skills: ${profileDocument.skills.join(', ')}`)
  }
  if (profileDocument.experience) {
    lines.push(`Saved Experience: ${profileDocument.experience}`)
  }
  const packageData = profileDocument.package || {}
  if (Number(packageData.max || 0) > 0) {
    lines.push(
      `Saved Expected Package: ${Number(packageData.min || 0)}-${Number(packageData.max || 0)} ${String(packageData.type || 'LPA')} (${String(packageData.currency || 'INR')})`,
    )
  }

  return lines.join('\n')
}

const parseExperienceYearsFromLabel = (value) => {
  const matched = String(value || '').match(/(\d+)\s*\+?\s*(years?|yrs?)/i)
  return matched ? Number(matched[1]) : 0
}

const buildProfileSeed = (profileDocument) => {
  if (!profileDocument) return null

  const packageData = profileDocument.package || {}
  return {
    primarySkills: Array.isArray(profileDocument.skills) ? profileDocument.skills.slice(0, 10) : [],
    secondarySkills: [],
    experienceYears: parseExperienceYearsFromLabel(profileDocument.experience),
    salaryExpectation: {
      min: Math.max(0, Number(packageData.min || 0)),
      max: Math.max(0, Number(packageData.max || 0)),
      currency: String(packageData.currency || 'INR').toUpperCase(),
      type: String(packageData.type || 'LPA'),
    },
  }
}

export const createChatSession = async (request, response, next) => {
  try {
    if (!env.vertexProject) {
      const error = new Error(
        'VERTEX_PROJECT_ID is not configured in server/.env. Add it to enable Vertex AI matching.',
      )
      error.statusCode = 503
      throw error
    }

    const prompt = String(request.body.prompt || '').trim()
    if (!prompt) {
      const error = new Error('Prompt is required.')
      error.statusCode = 400
      throw error
    }

    const metadata = parseJsonSafely(request.body.metadata)
    const quickContext = Array.isArray(metadata.selectedActions)
      ? metadata.selectedActions.join(', ')
      : ''
    const usageIdentity = resolveUsageIdentityFromRequest(request)
    const usageLimits = request.usageContext?.limits || getLimitsForIdentity(usageIdentity)
    const tokenUsageSnapshot = buildTokenUsagePayload({
      usage: request.usage,
      limits: usageLimits,
    })
    const userId = toObjectId(request.user?.userId, 'userId')
    const storedProfile = await UserProfile.findOne({ userId }).lean()
    const storedProfileContext = buildStoredProfileContext(storedProfile)
    const profileSeed = buildProfileSeed(storedProfile)

    const resumeText = await extractResumeText(request.file)
    const enrichedPrompt = [
      prompt,
      quickContext ? `Additional context: ${quickContext}` : '',
      storedProfileContext ? `Saved profile context:\n${storedProfileContext}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const messages = [
      { role: 'user', content: prompt, createdAt: new Date() },
      {
        role: 'assistant',
        content: 'Analyzing your profile and AI searching live job opportunities...',
        createdAt: new Date(),
      },
    ]

    const attachments = request.file
      ? [
          {
            originalName: request.file.originalname,
            mimeType: request.file.mimetype,
            size: request.file.size,
            filePath: request.file.path,
          },
        ]
      : []

    const session = await ChatSession.create({
      userId,
      prompt,
      resumeText,
      attachments,
      messages,
      conversationHistory: [
        { role: 'user', content: prompt, createdAt: new Date() },
        {
          role: 'assistant',
          content: 'Analyzing your profile and AI searching live job opportunities...',
          createdAt: new Date(),
        },
      ],
      status: 'processing',
    })

    const sessionId = session._id.toString()
    initSessionStream(sessionId)

    const dispatchResult = await dispatchSessionProcessing({
      sessionId,
      prompt: enrichedPrompt,
      resumeText,
      profileSeed,
      usageMeta: {
        ...usageIdentity,
        inputText: prompt,
      },
    })

    response.status(201).json({
      sessionId,
      status: session.status,
      assistantMessage: messages[1].content,
      processingMode: dispatchResult.mode,
      tokenUsage: tokenUsageSnapshot,
    })
  } catch (error) {
    next(error)
  }
}

export const getTokenUsage = async (request, response, next) => {
  try {
    const identity = resolveUsageIdentityFromRequest(request)
    const limits = getLimitsForIdentity(identity)
    const usage = await syncUsageWindow(identity)

    response.json({
      tokenUsage: buildTokenUsagePayload({
        usage,
        limits,
      }),
    })
  } catch (error) {
    next(error)
  }
}

export const listChatSessions = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user?.userId, 'userId')
    const sessions = await ChatSession.find({ userId })
      .sort({ updatedAt: -1 })
      .limit(25)
      .select('prompt status createdAt updatedAt messages')

    response.json({
      sessions: sessions.map(toSessionSummary),
    })
  } catch (error) {
    next(error)
  }
}

export const getChatSessionById = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user?.userId, 'userId')
    const sessionId = String(request.params.sessionId || '').trim()
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      const error = new Error('sessionId must be a valid ObjectId.')
      error.statusCode = 400
      throw error
    }

    const session = await ChatSession.findOne({
      _id: sessionId,
      userId,
    })
    if (!session) {
      const error = new Error('Session not found for this user.')
      error.statusCode = 404
      throw error
    }

    response.json({
      session: {
        id: session._id.toString(),
        prompt: session.prompt,
        status: session.status,
        messages: session.messages,
        jobs: session.jobs,
        filteredJobs: session.filteredJobs || session.jobs,
        profile: session.structuredProfile || session.preferenceProfile,
        structuredProfile: session.structuredProfile || session.preferenceProfile,
        createdAt: session.createdAt,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const migrateGuestChats = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user?.userId, 'userId')
    const incomingChats = Array.isArray(request.body?.chats) ? request.body.chats : []

    if (incomingChats.length === 0) {
      response.json({
        imported: 0,
        attempted: 0,
        skipped: 0,
      })
      return
    }

    const MAX_CHATS = 15
    const MAX_MESSAGES_PER_CHAT = 120
    const MAX_JOBS_PER_CHAT = 60
    const limitedChats = incomingChats.slice(0, MAX_CHATS)

    const documents = limitedChats
      .map((chat) => {
        const source = chat && typeof chat === 'object' ? chat : {}
        const normalizedMessages = (Array.isArray(source.messages) ? source.messages : [])
          .map(normalizeImportedMessage)
          .filter(Boolean)
          .slice(0, MAX_MESSAGES_PER_CHAT)
        if (normalizedMessages.length === 0) return null

        const normalizedJobs = (Array.isArray(source.jobs) ? source.jobs : [])
          .map(normalizeImportedJob)
          .filter(Boolean)
          .slice(0, MAX_JOBS_PER_CHAT)

        const firstUserMessage =
          normalizedMessages.find((message) => message.role === 'user')?.content || ''
        const prompt = firstUserMessage || String(source.title || '').trim() || 'Imported guest chat'
        const status = ['processing', 'completed', 'failed'].includes(String(source.status || '').trim())
          ? String(source.status).trim()
          : 'completed'

        return {
          userId,
          prompt: prompt.slice(0, 240),
          messages: normalizedMessages,
          conversationHistory: normalizedMessages,
          jobs: normalizedJobs,
          filteredJobs: normalizedJobs,
          lastScrapedJobs: normalizedJobs,
          status,
          createdAt: parseDateOrNow(source.createdAt),
          updatedAt: parseDateOrNow(source.updatedAt),
        }
      })
      .filter(Boolean)

    if (documents.length === 0) {
      response.json({
        imported: 0,
        attempted: limitedChats.length,
        skipped: limitedChats.length,
      })
      return
    }

    const inserted = await ChatSession.insertMany(documents, { ordered: false })

    response.json({
      imported: inserted.length,
      attempted: limitedChats.length,
      skipped: Math.max(0, limitedChats.length - inserted.length),
    })
  } catch (error) {
    next(error)
  }
}

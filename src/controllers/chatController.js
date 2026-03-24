import { ChatSession } from '../models/ChatSession.js'
import { env } from '../config/environment.js'
import { extractResumeText } from '../services/files/resumeTextExtractor.js'
import { initSessionStream } from '../services/realtime/sessionStream.js'
import { processSessionInBackground } from '../services/session/sessionProcessor.js'
import mongoose from 'mongoose'

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

const toObjectId = (rawValue) => {
  const fallbackUserId = '64f1c2a3b4d5e6f708091011'
  const value = String(rawValue || fallbackUserId).trim()
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(fallbackUserId)
  }
  return new mongoose.Types.ObjectId(value)
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

    const resumeText = await extractResumeText(request.file)
    const enrichedPrompt = quickContext ? `${prompt}\nAdditional context: ${quickContext}` : prompt
    const userId = toObjectId(request.headers['x-user-id'])

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

    void processSessionInBackground({
      sessionId,
      prompt: enrichedPrompt,
      resumeText,
    })

    response.status(201).json({
      sessionId,
      status: session.status,
      assistantMessage: messages[1].content,
    })
  } catch (error) {
    next(error)
  }
}

export const listChatSessions = async (_request, response, next) => {
  try {
    const sessions = await ChatSession.find({})
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
    const session = await ChatSession.findById(request.params.sessionId)
    if (!session) {
      const error = new Error('Session not found.')
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

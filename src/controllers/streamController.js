import {
  getSessionSnapshot,
  subscribeToSessionStream,
} from '../services/realtime/sessionStream.js'
import { ChatSession } from '../models/ChatSession.js'
import { cancelSessionProcessing } from '../services/session/sessionControl.js'

const writeSseEvent = (response, eventName, payload) => {
  response.write(`event: ${eventName}\n`)
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export const streamSessionJobs = (request, response) => {
  const { sessionId } = request.params
  const snapshot = getSessionSnapshot(sessionId)

  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders?.()

  writeSseEvent(response, 'ready', { sessionId })

  if (snapshot.statusMessage) {
    writeSseEvent(response, 'status', { statusMessage: snapshot.statusMessage })
  }

  snapshot.jobs.forEach((job) => {
    writeSseEvent(response, 'job', job)
  })

  if (snapshot.status === 'completed') {
    writeSseEvent(response, 'done', { summary: snapshot.summary })
    response.end()
    return
  }

  if (snapshot.status === 'failed') {
    writeSseEvent(response, 'error', { errorMessage: snapshot.errorMessage })
    response.end()
    return
  }

  const heartbeat = setInterval(() => {
    writeSseEvent(response, 'ping', { time: Date.now() })
  }, 15000)

  const unsubscribe = subscribeToSessionStream(sessionId, {
    onJob: (job) => writeSseEvent(response, 'job', job),
    onStatus: ({ statusMessage }) => writeSseEvent(response, 'status', { statusMessage }),
    onDone: ({ summary }) => {
      writeSseEvent(response, 'done', { summary })
      cleanup()
      response.end()
    },
    onError: ({ errorMessage }) => {
      writeSseEvent(response, 'error', { errorMessage })
      cleanup()
      response.end()
    },
  })

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }

  request.on('close', cleanup)
}

export const stopSessionProcessing = async (request, response, next) => {
  try {
    const sessionId = String(request.params.sessionId || '').trim()
    if (!sessionId) {
      const error = new Error('sessionId is required.')
      error.statusCode = 400
      throw error
    }

    const session = await ChatSession.findById(sessionId).select('status')
    if (!session) {
      const error = new Error('Session not found.')
      error.statusCode = 404
      throw error
    }

    const stopped = cancelSessionProcessing(sessionId, 'Search stopped by user.')
    response.json({
      sessionId,
      stopped,
      status: stopped ? 'stopping' : session.status,
      message: stopped
        ? 'Stop signal sent. Wrapping up current processing.'
        : 'Session is not actively processing.',
    })
  } catch (error) {
    next(error)
  }
}

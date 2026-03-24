import { EventEmitter } from 'node:events'

const streamEmitter = new EventEmitter()
const sessionStreams = new Map()

const ensureStreamState = (sessionId) => {
  if (!sessionStreams.has(sessionId)) {
    sessionStreams.set(sessionId, {
      jobs: [],
      status: 'processing',
      statusMessage: '',
      summary: '',
      errorMessage: '',
      updatedAt: Date.now(),
    })
  }

  return sessionStreams.get(sessionId)
}

export const initSessionStream = (sessionId) => {
  return ensureStreamState(sessionId)
}

export const emitJobUpdate = (sessionId, job) => {
  const streamState = ensureStreamState(sessionId)
  streamState.jobs.push(job)
  streamState.updatedAt = Date.now()
  streamEmitter.emit(`job:${sessionId}`, job)
}

export const emitSessionStatus = (sessionId, statusMessage) => {
  const streamState = ensureStreamState(sessionId)
  streamState.statusMessage = String(statusMessage || '').trim()
  streamState.updatedAt = Date.now()
  streamEmitter.emit(`status:${sessionId}`, {
    statusMessage: streamState.statusMessage,
  })
}

export const emitSessionComplete = (sessionId, summary) => {
  const streamState = ensureStreamState(sessionId)
  streamState.status = 'completed'
  streamState.statusMessage = 'Search complete.'
  streamState.summary = summary
  streamState.updatedAt = Date.now()
  streamEmitter.emit(`done:${sessionId}`, { summary })
}

export const emitSessionFailure = (sessionId, errorMessage) => {
  const streamState = ensureStreamState(sessionId)
  streamState.status = 'failed'
  streamState.statusMessage = 'Search failed.'
  streamState.errorMessage = errorMessage
  streamState.updatedAt = Date.now()
  streamEmitter.emit(`error:${sessionId}`, { errorMessage })
}

export const getSessionSnapshot = (sessionId) => {
  return ensureStreamState(sessionId)
}

export const subscribeToSessionStream = (sessionId, handlers) => {
  const onJob = (payload) => handlers.onJob?.(payload)
  const onStatus = (payload) => handlers.onStatus?.(payload)
  const onDone = (payload) => handlers.onDone?.(payload)
  const onError = (payload) => handlers.onError?.(payload)

  streamEmitter.on(`job:${sessionId}`, onJob)
  streamEmitter.on(`status:${sessionId}`, onStatus)
  streamEmitter.on(`done:${sessionId}`, onDone)
  streamEmitter.on(`error:${sessionId}`, onError)

  return () => {
    streamEmitter.off(`job:${sessionId}`, onJob)
    streamEmitter.off(`status:${sessionId}`, onStatus)
    streamEmitter.off(`done:${sessionId}`, onDone)
    streamEmitter.off(`error:${sessionId}`, onError)
  }
}

import { EventEmitter } from 'node:events'
import { env } from '../../config/environment.js'
import {
  REDIS_CHANNEL_STREAM,
  getRedisJson,
  getRedisNodeId,
  publishRedisMessage,
  registerRedisMessageHandler,
  setRedisJson,
} from '../infrastructure/redisRealtime.js'

const streamEmitter = new EventEmitter()
const sessionStreams = new Map()

const SESSION_STREAM_KEY_PREFIX = 'aaply:session-stream:'
const SESSION_STREAM_TTL_SECONDS = 60 * 60 * 6
const localNodeId = getRedisNodeId()
let redisBridgeReady = false

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[session-stream] ${message}`, context)
}

const normalizeSessionId = (sessionId) => String(sessionId || '').trim()
const buildSnapshotRedisKey = (sessionId) => `${SESSION_STREAM_KEY_PREFIX}${normalizeSessionId(sessionId)}`

const ensureStreamState = (sessionId) => {
  const key = normalizeSessionId(sessionId)
  if (!sessionStreams.has(key)) {
    sessionStreams.set(key, {
      jobs: [],
      status: 'processing',
      statusMessage: '',
      summary: '',
      errorMessage: '',
      updatedAt: Date.now(),
    })
  }

  return sessionStreams.get(key)
}

const persistSnapshot = async (sessionId, streamState) => {
  const key = normalizeSessionId(sessionId)
  if (!key) return

  await setRedisJson(buildSnapshotRedisKey(key), streamState, {
    ttlSeconds: SESSION_STREAM_TTL_SECONDS,
  })
}

const applyEvent = (sessionId, eventName, payload, options = {}) => {
  const key = normalizeSessionId(sessionId)
  if (!key) return

  const streamState = ensureStreamState(key)
  if (eventName === 'job') {
    streamState.jobs.push(payload)
    streamState.updatedAt = Date.now()
    streamEmitter.emit(`job:${key}`, payload)
  } else if (eventName === 'status') {
    streamState.statusMessage = String(payload?.statusMessage || '').trim()
    streamState.updatedAt = Date.now()
    streamEmitter.emit(`status:${key}`, {
      statusMessage: streamState.statusMessage,
    })
  } else if (eventName === 'done') {
    streamState.status = 'completed'
    streamState.statusMessage = 'Search complete.'
    streamState.summary = payload?.summary || ''
    streamState.updatedAt = Date.now()
    streamEmitter.emit(`done:${key}`, { summary: streamState.summary })
  } else if (eventName === 'error') {
    streamState.status = 'failed'
    streamState.statusMessage = 'Search failed.'
    streamState.errorMessage = payload?.errorMessage || ''
    streamState.updatedAt = Date.now()
    streamEmitter.emit(`error:${key}`, { errorMessage: streamState.errorMessage })
  }

  void persistSnapshot(key, streamState)

  if (!options.fromRedis) {
    void publishRedisMessage(REDIS_CHANNEL_STREAM, {
      sessionId: key,
      event: eventName,
      data: payload,
    })
  }
}

const ensureRedisBridge = () => {
  if (redisBridgeReady) return
  redisBridgeReady = true

  registerRedisMessageHandler(REDIS_CHANNEL_STREAM, (envelope) => {
    if (!envelope || typeof envelope !== 'object') return
    if (String(envelope.originNodeId || '') === localNodeId) return

    const payload = envelope.payload || {}
    const sessionId = normalizeSessionId(payload.sessionId)
    const eventName = String(payload.event || '').trim()
    if (!sessionId || !eventName) return

    applyEvent(sessionId, eventName, payload.data, { fromRedis: true })
  })
  debugLog('redis stream bridge attached', {
    nodeId: localNodeId,
  })
}

export const initSessionStream = (sessionId) => {
  ensureRedisBridge()
  return ensureStreamState(sessionId)
}

export const emitJobUpdate = (sessionId, job) => {
  ensureRedisBridge()
  applyEvent(sessionId, 'job', job)
}

export const emitSessionStatus = (sessionId, statusMessage) => {
  ensureRedisBridge()
  applyEvent(sessionId, 'status', {
    statusMessage,
  })
}

export const emitSessionComplete = (sessionId, summary) => {
  ensureRedisBridge()
  applyEvent(sessionId, 'done', { summary })
}

export const emitSessionFailure = (sessionId, errorMessage) => {
  ensureRedisBridge()
  applyEvent(sessionId, 'error', { errorMessage })
}

export const getSessionSnapshot = async (sessionId) => {
  ensureRedisBridge()

  const key = normalizeSessionId(sessionId)
  const localSnapshot = sessionStreams.get(key)
  if (localSnapshot) return localSnapshot

  const persistedSnapshot = await getRedisJson(buildSnapshotRedisKey(key))
  if (persistedSnapshot && typeof persistedSnapshot === 'object') {
    sessionStreams.set(key, persistedSnapshot)
    return persistedSnapshot
  }

  return ensureStreamState(key)
}

export const subscribeToSessionStream = (sessionId, handlers) => {
  ensureRedisBridge()

  const key = normalizeSessionId(sessionId)
  const onJob = (payload) => handlers.onJob?.(payload)
  const onStatus = (payload) => handlers.onStatus?.(payload)
  const onDone = (payload) => handlers.onDone?.(payload)
  const onError = (payload) => handlers.onError?.(payload)

  streamEmitter.on(`job:${key}`, onJob)
  streamEmitter.on(`status:${key}`, onStatus)
  streamEmitter.on(`done:${key}`, onDone)
  streamEmitter.on(`error:${key}`, onError)

  return () => {
    streamEmitter.off(`job:${key}`, onJob)
    streamEmitter.off(`status:${key}`, onStatus)
    streamEmitter.off(`done:${key}`, onDone)
    streamEmitter.off(`error:${key}`, onError)
  }
}

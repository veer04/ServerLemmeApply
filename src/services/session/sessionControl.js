import {
  REDIS_CHANNEL_CONTROL,
  getRedisNodeId,
  publishRedisMessage,
  registerRedisMessageHandler,
} from '../infrastructure/redisRealtime.js'

const sessionAbortControllers = new Map()
const pendingCancelReasons = new Map()
const localNodeId = getRedisNodeId()
let remoteCancelBridgeReady = false

const normalizeSessionId = (sessionId) => String(sessionId || '').trim()

const applyCancellation = (sessionId, reason = 'Search cancelled by user request.') => {
  const key = normalizeSessionId(sessionId)
  if (!key) return false

  const normalizedReason = String(reason || 'Search cancelled by user request.')
  pendingCancelReasons.set(key, normalizedReason)

  const controller = sessionAbortControllers.get(key)
  if (!controller || controller.signal.aborted) return false
  controller.abort(normalizedReason)
  return true
}

const ensureRemoteCancelBridge = () => {
  if (remoteCancelBridgeReady) return
  remoteCancelBridgeReady = true

  registerRedisMessageHandler(REDIS_CHANNEL_CONTROL, (envelope) => {
    if (!envelope || typeof envelope !== 'object') return
    if (String(envelope.originNodeId || '') === localNodeId) return

    const payload = envelope.payload || {}
    if (String(payload.type || '') !== 'cancel') return
    applyCancellation(payload.sessionId, payload.reason)
  })
}

const getOrCreateAbortController = (sessionId) => {
  ensureRemoteCancelBridge()

  const key = normalizeSessionId(sessionId)
  if (!key) return null

  const existing = sessionAbortControllers.get(key)
  if (existing && !existing.signal.aborted) {
    const pendingReason = pendingCancelReasons.get(key)
    if (pendingReason && !existing.signal.aborted) {
      existing.abort(String(pendingReason))
    }
    return existing
  }

  const controller = new AbortController()
  const pendingReason = pendingCancelReasons.get(key)
  if (pendingReason) {
    controller.abort(String(pendingReason))
  }
  sessionAbortControllers.set(key, controller)
  return controller
}

export const createSessionAbortSignal = (sessionId) => {
  const controller = getOrCreateAbortController(sessionId)
  return controller?.signal || null
}

export const cancelSessionProcessing = (sessionId, reason = 'Search cancelled by user request.') => {
  ensureRemoteCancelBridge()

  const key = normalizeSessionId(sessionId)
  if (!key) return false

  const hadActiveController = Boolean(
    sessionAbortControllers.get(key) && !sessionAbortControllers.get(key).signal.aborted,
  )
  const hadPendingCancel = pendingCancelReasons.has(key)
  applyCancellation(key, reason)

  void publishRedisMessage(REDIS_CHANNEL_CONTROL, {
    type: 'cancel',
    sessionId: key,
    reason: String(reason || 'Search cancelled by user request.'),
  })

  return hadActiveController || !hadPendingCancel
}

export const isSessionCancelled = (sessionId) => {
  const key = normalizeSessionId(sessionId)
  const controller = sessionAbortControllers.get(key)
  return Boolean(controller?.signal?.aborted || pendingCancelReasons.has(key))
}

export const clearSessionAbortSignal = (sessionId) => {
  const key = normalizeSessionId(sessionId)
  if (!key) return
  sessionAbortControllers.delete(key)
  pendingCancelReasons.delete(key)
}

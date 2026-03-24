const sessionAbortControllers = new Map()

const getOrCreateAbortController = (sessionId) => {
  const key = String(sessionId || '').trim()
  if (!key) return null

  const existing = sessionAbortControllers.get(key)
  if (existing && !existing.signal.aborted) {
    return existing
  }

  const controller = new AbortController()
  sessionAbortControllers.set(key, controller)
  return controller
}

export const createSessionAbortSignal = (sessionId) => {
  const controller = getOrCreateAbortController(sessionId)
  return controller?.signal || null
}

export const cancelSessionProcessing = (sessionId, reason = 'Search cancelled by user request.') => {
  const key = String(sessionId || '').trim()
  if (!key) return false

  const controller = sessionAbortControllers.get(key)
  if (!controller || controller.signal.aborted) return false

  controller.abort(String(reason))
  return true
}

export const isSessionCancelled = (sessionId) => {
  const key = String(sessionId || '').trim()
  const controller = sessionAbortControllers.get(key)
  return Boolean(controller?.signal?.aborted)
}

export const clearSessionAbortSignal = (sessionId) => {
  const key = String(sessionId || '').trim()
  if (!key) return
  sessionAbortControllers.delete(key)
}

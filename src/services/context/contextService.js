const CONTEXT_TTL_MS = 1000 * 60 * 60 * 6
const MAX_HISTORY_MESSAGES = 40

const contextStore = new Map()

const cleanText = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

const uniqueList = (values) => [
  ...new Set((Array.isArray(values) ? values : []).map((value) => cleanText(value)).filter(Boolean)),
]

const parseExperienceYears = (value) => {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  const matched = cleanText(value).match(/(\d+)/)
  return matched ? Number(matched[1]) : 0
}

const toIdentityKey = (identity) => {
  const userId = cleanText(identity?.userId)
  if (userId) return `user:${userId}`

  const sessionId = cleanText(identity?.sessionId)
  if (sessionId) return `session:${sessionId}`

  const guestId = cleanText(identity?.guestId)
  if (guestId) return `guest:${guestId}`

  const ipAddress = cleanText(identity?.ipAddress)
  if (ipAddress) return `ip:${ipAddress}`
  return 'guest:unknown'
}

const createDefaultContext = (identity) => ({
  identityKey: toIdentityKey(identity),
  userId: cleanText(identity?.userId),
  guestId: cleanText(identity?.guestId),
  sessionId: cleanText(identity?.sessionId),
  ipAddress: cleanText(identity?.ipAddress),
  lastIntent: 'UNKNOWN',
  lastSearchQuery: '',
  pendingAction: '',
  extractedProfile: {
    role: '',
    skills: [],
    experience: '',
    location: '',
  },
  conversationHistory: [],
  updatedAt: Date.now(),
})

const maybePruneExpiredContext = () => {
  const now = Date.now()
  for (const [key, value] of contextStore.entries()) {
    const updatedAt = Number(value?.updatedAt || 0)
    if (!updatedAt || now - updatedAt > CONTEXT_TTL_MS) {
      contextStore.delete(key)
    }
  }
}

export const mergeExtractedProfile = (baseProfile, incomingProfile) => {
  const base = baseProfile && typeof baseProfile === 'object' ? baseProfile : {}
  const incoming = incomingProfile && typeof incomingProfile === 'object' ? incomingProfile : {}

  const baseExperienceYears = parseExperienceYears(base.experience)
  const incomingExperienceYears = parseExperienceYears(incoming.experience)
  const experience =
    incomingExperienceYears >= baseExperienceYears
      ? cleanText(incoming.experience || '')
      : cleanText(base.experience || '')

  return {
    role: cleanText(incoming.role || base.role),
    skills: uniqueList([...(base.skills || []), ...(incoming.skills || [])]).slice(0, 16),
    experience,
    location: cleanText(incoming.location || base.location),
  }
}

export const getUserContext = (identity) => {
  maybePruneExpiredContext()
  const key = toIdentityKey(identity)
  const existing = contextStore.get(key)
  if (existing) {
    existing.userId = cleanText(identity?.userId) || existing.userId
    existing.guestId = cleanText(identity?.guestId) || existing.guestId
    existing.sessionId = cleanText(identity?.sessionId) || existing.sessionId
    existing.ipAddress = cleanText(identity?.ipAddress) || existing.ipAddress
    existing.updatedAt = Date.now()
    return existing
  }

  const created = createDefaultContext(identity)
  contextStore.set(key, created)
  return created
}

export const updateUserContext = (identity, patch) => {
  const context = getUserContext(identity)
  const payload =
    typeof patch === 'function'
      ? patch({ ...context })
      : patch && typeof patch === 'object'
        ? patch
        : {}

  if (payload.extractedProfile) {
    context.extractedProfile = mergeExtractedProfile(context.extractedProfile, payload.extractedProfile)
  }
  if (payload.lastIntent) context.lastIntent = cleanText(payload.lastIntent).toUpperCase()
  if (payload.lastSearchQuery !== undefined) context.lastSearchQuery = cleanText(payload.lastSearchQuery)
  if (payload.pendingAction !== undefined) context.pendingAction = cleanText(payload.pendingAction).toUpperCase()
  context.updatedAt = Date.now()
  contextStore.set(context.identityKey, context)
  return context
}

export const recordConversationTurn = (identity, { role = 'user', content = '' } = {}) => {
  const message = cleanText(content)
  if (!message) return getUserContext(identity)

  const context = getUserContext(identity)
  const normalizedRole = ['user', 'assistant', 'system'].includes(role) ? role : 'user'
  context.conversationHistory.push({
    role: normalizedRole,
    content: message,
    createdAt: new Date().toISOString(),
  })
  if (context.conversationHistory.length > MAX_HISTORY_MESSAGES) {
    context.conversationHistory = context.conversationHistory.slice(-MAX_HISTORY_MESSAGES)
  }
  context.updatedAt = Date.now()
  contextStore.set(context.identityKey, context)
  return context
}

export const clearUserContext = (identity) => {
  const key = toIdentityKey(identity)
  contextStore.delete(key)
}

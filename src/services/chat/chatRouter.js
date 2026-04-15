import { VertexAI } from '@google-cloud/vertexai'
import { env } from '../../config/environment.js'
import { detectUserIntent, intentConstants } from '../intent/intentService.js'
import { mergeExtractedProfile } from '../context/contextService.js'

const { INTENTS } = intentConstants

const AFFIRMATIVE_INTENT_REGEX =
  /^(yes|yeah|yep|sure|go ahead|continue|move further|search now|find now|start search)$/i
const LIGHT_ACK_REGEX = /^(ok|okay|cool|got it|understood|noted|fine|thanks|thank you)$/i
const GENERIC_JOB_REQUEST_REGEX =
  /\b(looking\s+for\s+jobs?|find\s+jobs?|search\s+jobs?|want\s+jobs?|need\s+a\s+job|openings?|vacancies?|job opportunities?)\b/i
const EXPLICIT_SEARCH_ACTION_REGEX =
  /\b(find|search|show|start|fetch|get|look\s+for|hunt)\b/i
const CONTINUE_SEARCH_ACTION_REGEX =
  /\b(move\s*further|continue|search\s*more|more\s*jobs|load\s*more|hunt\s*deeper|go\s*deeper|keep\s*searching|keep\s*going)\b/i
const PROFILE_ONLY_UPDATE_REGEX =
  /\b(i\s+know|my\s+skills?|i\s+have\s+\d+\+?\s*(?:years?|yrs?)|my\s+experience|i\s+am\s+from|location\s+is|preferred\s+location)\b/i

const PENDING_ACTIONS = {
  NONE: '',
  CONFIRM_JOB_SEARCH: 'CONFIRM_JOB_SEARCH',
  CONFIRM_CONTINUE_SEARCH: 'CONFIRM_CONTINUE_SEARCH',
  PROVIDE_SEARCH_DETAILS: 'PROVIDE_SEARCH_DETAILS',
  CLARIFY_INTENT: 'CLARIFY_INTENT',
}

const cleanText = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

const uniqueList = (items) => [...new Set((Array.isArray(items) ? items : []).map(cleanText).filter(Boolean))]

const parseExperienceYears = (value) => {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  const matched = cleanText(value).match(/(\d+)/)
  return matched ? Number(matched[1]) : 0
}

const vertexClient = env.vertexProject
  ? new VertexAI({
      project: env.vertexProject,
      location: env.vertexLocation,
    })
  : null

const CAREER_REPLY_CACHE_TTL_MS = 1000 * 60 * 30
const careerReplyCache = new Map()

const buildCareerReplyCacheKey = (message, profile, scopeKey = 'global') =>
  [
    cleanText(scopeKey).toLowerCase(),
    cleanText(message).toLowerCase(),
    cleanText(profile?.role).toLowerCase(),
    uniqueList(profile?.skills || [])
      .slice(0, 8)
      .join(','),
  ].join('|')

const getCachedCareerReply = (cacheKey) => {
  const cached = careerReplyCache.get(cacheKey)
  if (!cached) return ''
  if (Date.now() > cached.expiresAt) {
    careerReplyCache.delete(cacheKey)
    return ''
  }
  return String(cached.value || '')
}

const setCachedCareerReply = (cacheKey, value) => {
  careerReplyCache.set(cacheKey, {
    value: String(value || ''),
    expiresAt: Date.now() + CAREER_REPLY_CACHE_TTL_MS,
  })
}

const buildSearchProfile = (contextProfile, extractedData) => {
  const merged = mergeExtractedProfile(contextProfile, extractedData)
  return {
    role: cleanText(merged.role),
    skills: uniqueList(merged.skills || []).slice(0, 12),
    experience: cleanText(merged.experience),
    location: cleanText(merged.location),
  }
}

const buildJobSearchPrompt = (searchProfile, originalMessage) => {
  const parts = [
    searchProfile.role,
    searchProfile.skills.length > 0 ? `Skills: ${searchProfile.skills.join(', ')}` : '',
    searchProfile.experience ? `Experience: ${searchProfile.experience}` : '',
    searchProfile.location ? `Location: ${searchProfile.location}` : '',
  ].filter(Boolean)

  if (parts.length === 0) return cleanText(originalMessage)
  return parts.join(' | ')
}

const isGenericJobRequest = (message) => GENERIC_JOB_REQUEST_REGEX.test(cleanText(message))

const hasStrongRole = (value) => {
  const role = cleanText(value).toLowerCase()
  if (!role) return false
  if (role.length < 3 || role.length > 70) return false
  if (/\b(looking for|searching for|job|jobs|opening|openings|vacancy|vacancies)\b/.test(role)) {
    return false
  }
  return true
}

const shouldTriggerScraping = ({
  intent,
  confidence,
  profile,
  message,
  extractedData,
  contextSignals = {},
}) => {
  if (intent !== INTENTS.JOB_SEARCH) return false
  if (Number(confidence || 0) <= 0.6) return false

  const normalizedMessage = cleanText(message)
  const confirmedByContext = Boolean(contextSignals?.confirmedJobSearch)
  const hasExplicitSearchAction =
    EXPLICIT_SEARCH_ACTION_REGEX.test(normalizedMessage) ||
    CONTINUE_SEARCH_ACTION_REGEX.test(normalizedMessage)
  const explicitRoleThisTurn = hasStrongRole(extractedData?.role)
  const explicitSkillThisTurn =
    Array.isArray(extractedData?.skills) && extractedData.skills.length > 0
  const hasFreshSearchPayload = explicitRoleThisTurn || explicitSkillThisTurn

  if (!hasExplicitSearchAction && !hasFreshSearchPayload && !confirmedByContext) {
    return false
  }

  const hasRole = hasStrongRole(profile?.role)
  const skills = Array.isArray(profile?.skills) ? profile.skills : []
  const skillCount = skills.length
  if (!hasRole && skillCount <= 0) return false

  const broadRequest = isGenericJobRequest(normalizedMessage)

  if (broadRequest && !hasRole) {
    if (explicitRoleThisTurn) return true
    if (explicitSkillThisTurn && skillCount > 0) return true
    if (confirmedByContext && skillCount > 0) return true
    return false
  }

  return true
}

const buildProfileSummaryText = (searchProfile) => {
  const parts = []
  if (hasStrongRole(searchProfile?.role)) parts.push(searchProfile.role)
  const skills = Array.isArray(searchProfile?.skills) ? searchProfile.skills.slice(0, 3) : []
  if (skills.length > 0) parts.push(`skills like ${skills.join(', ')}`)
  if (cleanText(searchProfile?.location)) parts.push(`location ${searchProfile.location}`)
  return parts.join(' | ')
}

const buildFollowUpSuggestions = (searchProfile) => {
  const suggestions = []
  if (!searchProfile.role) suggestions.push('I am targeting Frontend Developer role')
  if (!searchProfile.skills || searchProfile.skills.length === 0) {
    suggestions.push('My skills are React, Node.js, MongoDB')
  }
  if (!searchProfile.location) suggestions.push('Preferred location is Bangalore')
  suggestions.push('Search remote jobs')
  return uniqueList(suggestions).slice(0, 4)
}

const buildFollowUpMessage = (searchProfile) => {
  if (!searchProfile.role && (!searchProfile.skills || searchProfile.skills.length === 0)) {
    return 'What role or skills should I search for?'
  }
  if (!searchProfile.role) return 'What role are you targeting?'
  if (!searchProfile.skills || searchProfile.skills.length === 0) {
    return 'Which technologies or skills should I prioritize?'
  }
  if (!searchProfile.location) return 'Preferred location or remote?'
  return 'Share one more detail (role/skills/location) and I will start searching.'
}

const isProfileOnlyUpdate = (message, intent) => {
  if (intent !== INTENTS.JOB_SEARCH) return false
  const normalized = cleanText(message)
  if (!normalized) return false
  const hasProfileSignal = PROFILE_ONLY_UPDATE_REGEX.test(normalized)
  const hasDirectSearchAction = EXPLICIT_SEARCH_ACTION_REGEX.test(normalized)
  return hasProfileSignal && !hasDirectSearchAction
}

const generateFallbackCareerAdvice = (message, searchProfile) => {
  const role = cleanText(searchProfile.role) || 'software engineer'
  const topSkills = uniqueList(searchProfile.skills || []).slice(0, 4)
  const skillText = topSkills.length > 0 ? topSkills.join(', ') : 'problem solving and core CS fundamentals'

  return [
    `Great question. For a ${role} path, focus first on ${skillText}.`,
    'Build 2-3 strong projects, keep your resume impact-oriented, and practice interview storytelling.',
    'If you want, I can also directly find matching jobs for this profile right now.',
  ].join('\n\n')
}

const generateCareerAdvice = async (message, searchProfile, scopeKey = 'global') => {
  const cacheKey = buildCareerReplyCacheKey(message, searchProfile, scopeKey)
  const cached = getCachedCareerReply(cacheKey)
  if (cached) return cached

  if (!vertexClient) {
    const fallback = generateFallbackCareerAdvice(message, searchProfile)
    setCachedCareerReply(cacheKey, fallback)
    return fallback
  }

  try {
    const model = vertexClient.getGenerativeModel({ model: env.geminiModel })
    const promptPayload = `
You are a concise, practical career assistant.
Answer in 4-6 short lines with actionable advice.
Prefer practical steps, no fluff.
Mention that you can also search jobs when user is ready.

User question: ${cleanText(message)}
Known user profile: ${JSON.stringify(searchProfile)}
`

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: promptPayload }] }],
    })
    const text =
      (result?.response?.candidates?.[0]?.content?.parts || [])
        .map((part) => String(part?.text || '').trim())
        .filter(Boolean)
        .join('\n')
        .trim() || generateFallbackCareerAdvice(message, searchProfile)

    setCachedCareerReply(cacheKey, text)
    return text
  } catch {
    const fallback = generateFallbackCareerAdvice(message, searchProfile)
    setCachedCareerReply(cacheKey, fallback)
    return fallback
  }
}

const resolveIntentWithContext = (message, userContext, intentResult) => {
  const normalizedMessage = cleanText(message)
  const pendingAction = cleanText(userContext?.pendingAction).toUpperCase()
  const isAffirmative = AFFIRMATIVE_INTENT_REGEX.test(normalizedMessage)
  const isLightAck = LIGHT_ACK_REGEX.test(normalizedMessage)
  const hasKnownProfile =
    Boolean(cleanText(userContext?.extractedProfile?.role)) ||
    (Array.isArray(userContext?.extractedProfile?.skills) &&
      userContext.extractedProfile.skills.length > 0)
  const canConfirmSearch = [
    PENDING_ACTIONS.CONFIRM_JOB_SEARCH,
    PENDING_ACTIONS.CONFIRM_CONTINUE_SEARCH,
  ].includes(pendingAction)

  if (
    isAffirmative &&
    hasKnownProfile &&
    canConfirmSearch &&
    [
      INTENTS.SMALL_TALK,
      INTENTS.CAREER_QUERY,
      INTENTS.ACKNOWLEDGEMENT,
      INTENTS.UNKNOWN,
      '',
    ].includes(intentResult.intent)
  ) {
    return {
      ...intentResult,
      intent: INTENTS.JOB_SEARCH,
      confidence: Math.max(0.74, Number(intentResult.confidence || 0)),
      contextSignals: {
        confirmedJobSearch: true,
      },
    }
  }

  if (isLightAck && canConfirmSearch) {
    return {
      ...intentResult,
      intent: INTENTS.ACKNOWLEDGEMENT,
      confidence: Math.max(0.86, Number(intentResult.confidence || 0)),
      contextSignals: {
        confirmedJobSearch: false,
      },
    }
  }

  return {
    ...intentResult,
    contextSignals: {
      confirmedJobSearch: false,
    },
  }
}

export const handleUserMessage = async (message, userContext = {}) => {
  const normalizedMessage = cleanText(message)
  const contextScopeKey = cleanText(userContext?.identityKey || 'global')
  const intentDetection = await detectUserIntent(normalizedMessage, {
    enableAi: true,
    scopeKey: contextScopeKey,
  })
  const intentResult = resolveIntentWithContext(normalizedMessage, userContext, intentDetection)
  const pendingAction = cleanText(userContext?.pendingAction).toUpperCase()
  const searchProfile = buildSearchProfile(userContext.extractedProfile, intentResult.extractedData)
  const searchPrompt = buildJobSearchPrompt(searchProfile, normalizedMessage)
  const profileOnlyUpdate = isProfileOnlyUpdate(normalizedMessage, intentResult.intent)
  const scrapingAllowed = shouldTriggerScraping({
    intent: intentResult.intent,
    confidence: intentResult.confidence,
    profile: searchProfile,
    message: normalizedMessage,
    extractedData: intentResult.extractedData,
    contextSignals: intentResult.contextSignals,
  })

  if (intentResult.intent === INTENTS.ACKNOWLEDGEMENT && !scrapingAllowed) {
    const hasProfileHints =
      Boolean(searchProfile.role) ||
      (Array.isArray(searchProfile.skills) && searchProfile.skills.length > 0)
    const waitingForSearchConfirmation = pendingAction === PENDING_ACTIONS.CONFIRM_JOB_SEARCH
    const waitingForDetails = pendingAction === PENDING_ACTIONS.PROVIDE_SEARCH_DETAILS

    if (waitingForDetails) {
      return {
        type: 'FOLLOW_UP',
        message: buildFollowUpMessage(searchProfile),
        jobs: [],
        suggestions: buildFollowUpSuggestions(searchProfile),
        shouldScrape: false,
        intent: INTENTS.ACKNOWLEDGEMENT,
        confidence: intentResult.confidence,
        extractedData: intentResult.extractedData,
        mergedProfile: searchProfile,
        searchPrompt,
        pendingAction: PENDING_ACTIONS.PROVIDE_SEARCH_DETAILS,
      }
    }

    return {
      type: 'CHAT',
      message:
        waitingForSearchConfirmation && hasProfileHints
          ? 'Noted. If you want me to start searching now, say "search jobs now" or share role/skills/location.'
          : 'Got it. I can help with job search or career guidance whenever you want.',
      jobs: [],
      suggestions:
        waitingForSearchConfirmation && hasProfileHints
          ? ['Search jobs now', 'Update location', 'Update skills']
          : ['Find jobs now', 'Career guidance', 'Resume tips'],
      shouldScrape: false,
      intent: INTENTS.ACKNOWLEDGEMENT,
      confidence: intentResult.confidence,
      extractedData: intentResult.extractedData,
      mergedProfile: searchProfile,
      searchPrompt,
      pendingAction: waitingForSearchConfirmation
        ? PENDING_ACTIONS.CONFIRM_JOB_SEARCH
        : PENDING_ACTIONS.CLARIFY_INTENT,
    }
  }

  if (intentResult.intent === INTENTS.SMALL_TALK && !scrapingAllowed) {
    const hasProfileHints =
      Boolean(searchProfile.role) || (Array.isArray(searchProfile.skills) && searchProfile.skills.length > 0)
    return {
      type: 'CHAT',
      message: hasProfileHints
        ? 'Hey! Want me to find jobs using your saved profile context?'
        : 'Hey! I can help with career guidance or job search. Tell me what you want.',
      jobs: [],
      suggestions: hasProfileHints
        ? ['Yes, find jobs now', 'Add preferred location', 'Give me career guidance']
        : ['Find jobs for me', 'Career guidance', 'Resume tips'],
      shouldScrape: false,
      intent: INTENTS.SMALL_TALK,
      confidence: intentResult.confidence,
      extractedData: intentResult.extractedData,
      mergedProfile: searchProfile,
      searchPrompt,
      pendingAction: hasProfileHints
        ? PENDING_ACTIONS.CONFIRM_JOB_SEARCH
        : PENDING_ACTIONS.CLARIFY_INTENT,
    }
  }

  if (intentResult.intent === INTENTS.CAREER_QUERY && !scrapingAllowed) {
    const advice = await generateCareerAdvice(normalizedMessage, searchProfile, contextScopeKey)
    return {
      type: 'CHAT',
      message: advice,
      jobs: [],
      suggestions: ['Find jobs for this profile', 'What skills should I prioritize?', 'Review my resume strategy'],
      shouldScrape: false,
      intent: INTENTS.CAREER_QUERY,
      confidence: intentResult.confidence,
      extractedData: intentResult.extractedData,
      mergedProfile: searchProfile,
      searchPrompt,
      pendingAction: PENDING_ACTIONS.CONFIRM_JOB_SEARCH,
    }
  }

  if (intentResult.intent === INTENTS.JOB_SEARCH) {
    if (profileOnlyUpdate && !scrapingAllowed) {
      const profileSummary = buildProfileSummaryText(searchProfile)
      return {
        type: 'CHAT',
        message: profileSummary
          ? `Great, I noted your context (${profileSummary}). Want me to search jobs now?`
          : 'Great, I noted that. Want me to search jobs now?',
        jobs: [],
        suggestions: [
          'Yes, search jobs now',
          'Target role is Frontend Developer',
          'Skills: React, Node.js, MongoDB',
          'Preferred location: Bangalore',
        ],
        shouldScrape: false,
        intent: INTENTS.JOB_SEARCH,
        confidence: intentResult.confidence,
        extractedData: intentResult.extractedData,
        mergedProfile: searchProfile,
        searchPrompt,
        pendingAction: PENDING_ACTIONS.CONFIRM_JOB_SEARCH,
      }
    }

    if (scrapingAllowed) {
      const profileSummary = buildProfileSummaryText(searchProfile)
      return {
        type: 'JOB_RESULT',
        message: profileSummary
          ? `Got it. Searching live opportunities using: ${profileSummary}.`
          : 'Got it. Searching live opportunities matching your profile now.',
        jobs: [],
        suggestions: [],
        shouldScrape: true,
        intent: INTENTS.JOB_SEARCH,
        confidence: intentResult.confidence,
        extractedData: intentResult.extractedData,
        mergedProfile: searchProfile,
        searchPrompt,
        pendingAction: PENDING_ACTIONS.NONE,
      }
    }

    return {
      type: 'FOLLOW_UP',
      message: buildFollowUpMessage(searchProfile),
      jobs: [],
      suggestions: buildFollowUpSuggestions(searchProfile),
      shouldScrape: false,
      intent: INTENTS.JOB_SEARCH,
      confidence: intentResult.confidence,
      extractedData: intentResult.extractedData,
      mergedProfile: searchProfile,
      searchPrompt,
      pendingAction: PENDING_ACTIONS.PROVIDE_SEARCH_DETAILS,
    }
  }

  return {
    type: 'FOLLOW_UP',
    message: 'Are you looking for jobs right now, or do you want career guidance?',
    jobs: [],
    suggestions: ['Find jobs now', 'Career guidance', 'Resume help'],
    shouldScrape: false,
    intent: intentResult.intent || INTENTS.UNKNOWN,
    confidence: intentResult.confidence,
    extractedData: intentResult.extractedData,
    mergedProfile: searchProfile,
    searchPrompt,
    pendingAction: PENDING_ACTIONS.CLARIFY_INTENT,
  }
}

export const chatRouterUtils = {
  shouldTriggerScraping,
  parseExperienceYears,
}

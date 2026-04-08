import { VertexAI } from '@google-cloud/vertexai'
import { env } from '../../config/environment.js'

const INTENTS = {
  JOB_SEARCH: 'JOB_SEARCH',
  CAREER_QUERY: 'CAREER_QUERY',
  SMALL_TALK: 'SMALL_TALK',
  UNKNOWN: 'UNKNOWN',
}

const JOB_SEARCH_KEYWORDS = [
  'job',
  'jobs',
  'opening',
  'openings',
  'hiring',
  'vacancy',
  'vacancies',
  'apply',
  'find jobs',
  'search jobs',
  'opportunities',
  'roles',
  'position',
  'positions',
  'move further',
  'load more',
  'hunt deeper',
]

const CAREER_QUERY_KEYWORDS = [
  'career',
  'skills',
  'learn',
  'roadmap',
  'resume',
  'cv',
  'interview',
  'portfolio',
  'improve',
  'switch career',
  'become',
  'guidance',
  'advice',
]

const SMALL_TALK_KEYWORDS = [
  'hi',
  'hello',
  'hey',
  'how are you',
  'what is up',
  "what's up",
  'good morning',
  'good evening',
  'my name is',
]

const ROLE_HINTS = [
  'frontend developer',
  'backend developer',
  'full stack developer',
  'software engineer',
  'ui ux designer',
  'ui designer',
  'ux designer',
  'data analyst',
  'data scientist',
  'devops engineer',
  'qa engineer',
  'product manager',
]

const SKILL_HINTS = [
  'react',
  'next.js',
  'nextjs',
  'typescript',
  'javascript',
  'node',
  'node.js',
  'express',
  'mongodb',
  'mysql',
  'postgresql',
  'redis',
  'python',
  'java',
  'aws',
  'docker',
  'kubernetes',
  'system design',
  'dsa',
  'ai/ml',
  'machine learning',
  'html',
  'css',
  'tailwind',
]

const LOCATION_HINTS = [
  'bangalore',
  'bengaluru',
  'hyderabad',
  'pune',
  'mumbai',
  'delhi',
  'gurgaon',
  'noida',
  'chennai',
  'kolkata',
  'india',
  'remote',
]

const GENERIC_ROLE_PHRASES = new Set([
  'i want',
  'want',
  'job',
  'jobs',
  'any job',
  'any jobs',
  'opening',
  'openings',
  'vacancy',
  'vacancies',
  'work',
  'something',
  'opportunity',
  'opportunities',
  'find',
  'search',
  'job search',
  'looking',
  'looking for',
  'searching',
  'searching for',
  'find jobs',
  'search jobs',
])

const SKILL_STOPWORDS = new Set([
  'what',
  'which',
  'should',
  'learn',
  'stack',
  'tech',
  'technology',
  'technologies',
  'prioritize',
  'career',
  'jobs',
  'job',
  'role',
  'roles',
  'in',
  'at',
  'for',
  'with',
  'and',
  'or',
  'the',
  'a',
  'an',
  'i',
  'we',
  'my',
  'your',
  'is',
  'are',
  'to',
  'of',
  'now',
  'later',
])

const SMALL_TALK_EXACT = new Set([
  'hi',
  'hello',
  'hey',
  'hii',
  'yo',
  'sup',
])

const INTENT_CLASSIFIER_CACHE_TTL_MS = 1000 * 60 * 20
const intentCache = new Map()

const vertexClient = env.vertexProject
  ? new VertexAI({
      project: env.vertexProject,
      location: env.vertexLocation,
    })
  : null

const cleanText = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

const normalizePhrase = (value) => cleanText(value).toLowerCase()

const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).filter(Boolean))]

const buildCacheKey = (message) => normalizePhrase(message).slice(0, 280)

const getCachedIntent = (cacheKey) => {
  const cached = intentCache.get(cacheKey)
  if (!cached) return null
  if (Date.now() > cached.expiresAt) {
    intentCache.delete(cacheKey)
    return null
  }
  return cached.value
}

const setCachedIntent = (cacheKey, value) => {
  intentCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + INTENT_CLASSIFIER_CACHE_TTL_MS,
  })
}

const extractRole = (message) => {
  const value = cleanText(message)
  if (!value) return ''

  const directRolePatterns = [
    /(?:looking\s+for|search(?:ing)?\s+for|find)\s+([a-z0-9/+&\-\s]{3,70}?)(?:\s+jobs?|\s+openings?|\s+roles?|\s+in\b|$)/i,
    /([a-z0-9/+&\-\s]{3,70}?)\s+jobs?(?:\s+in\b|$)/i,
    /role\s*(?:is|:)\s*([a-z0-9/+&\-\s]{3,70})/i,
  ]

  for (const pattern of directRolePatterns) {
    const matched = value.match(pattern)
    if (!matched) continue
    const role = cleanText(matched[1])
      .replace(/\b(remote|onsite|hybrid)\b/gi, '')
      .replace(/\b(in|at)\s+[a-z\s]+$/i, '')
      .trim()
    const normalizedRole = normalizePhrase(role)
    if (normalizedRole.length < 3) continue
    if (GENERIC_ROLE_PHRASES.has(normalizedRole)) continue
    if (/^(i|we)\s+(want|need|am|are)\b/i.test(normalizedRole)) continue
    if (/(?:^|\s)(looking|searching)\s+for$/i.test(normalizedRole)) continue
    if (/\d{4}/.test(normalizedRole)) continue
    if (/\b(job|jobs|opening|openings|vacancy|vacancies)\b/.test(normalizedRole)) continue
    return role
  }

  const lowered = normalizePhrase(value)
  for (const roleHint of ROLE_HINTS) {
    if (lowered.includes(roleHint)) return roleHint
  }
  return ''
}

const normalizeSkill = (value) => {
  const normalized = normalizePhrase(value)
    .replace(/^[^a-z0-9]+|[^a-z0-9+.#/-]+$/g, '')
    .replace(/\s+/g, ' ')
  if (!normalized) return ''
  if (normalized === 'node') return 'node.js'
  if (normalized === 'nextjs') return 'next.js'
  return normalized
}

const isValidSkillCandidate = (value) => {
  const normalized = normalizeSkill(value)
  if (!normalized) return false
  if (normalized.length < 2 || normalized.length > 30) return false
  if (/\d{4}/.test(normalized)) return false
  if (SKILL_STOPWORDS.has(normalized)) return false
  if (normalized.split(' ').length > 3) return false
  if (/^(i|we|my|our)\b/.test(normalized)) return false

  const isWhitelisted = SKILL_HINTS.some((skill) => normalizeSkill(skill) === normalized)
  const looksTechnical = /[.+#]|js$|sql$|api$|aws|docker|kubernetes|react|node|python|java|typescript|mongodb|redis|html|css|tailwind|design/i.test(
    normalized,
  )
  return isWhitelisted || looksTechnical
}

const extractSkills = (message) => {
  const lowered = normalizePhrase(message)
  const extracted = new Set()

  for (const skill of SKILL_HINTS) {
    const normalizedSkill = normalizeSkill(skill)
    if (normalizedSkill && lowered.includes(normalizedSkill)) {
      extracted.add(normalizedSkill)
    }
  }

  const groupedSkillMatch = lowered.match(
    /(?:skills?|tech(?:nologies)?|i\s+know|stack)\s*(?:are|:)?\s*([a-z0-9,+/&.\-\s]{4,120})/i,
  )
  if (groupedSkillMatch) {
    const splitSkills = groupedSkillMatch[1]
      .split(/,|\/| and /gi)
      .map((entry) => normalizeSkill(entry))
      .filter((entry) => isValidSkillCandidate(entry))
      .slice(0, 10)
    splitSkills.forEach((entry) => extracted.add(entry))
  }

  return uniq(Array.from(extracted)).slice(0, 12)
}

const extractExperience = (message) => {
  const value = cleanText(message)
  if (!value) return ''

  if (/\bfresher|entry\s*level|college\s*student\b/i.test(value)) return 'fresher'

  const yearsMatch = value.match(/(\d+)\s*(?:\+|plus)?\s*(?:years?|yrs?)/i)
  if (yearsMatch) return `${yearsMatch[1]}+ years`

  const rangeMatch = value.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(?:years?|yrs?)/i)
  if (rangeMatch) return `${rangeMatch[1]}-${rangeMatch[2]} years`

  return ''
}

const extractLocation = (message) => {
  const value = cleanText(message)
  const lowered = normalizePhrase(message)
  if (!value) return ''

  if (/\bremote\b/i.test(value)) return 'remote'
  if (/\bhybrid\b/i.test(value)) return 'hybrid'
  if (/\bonsite|on-site\b/i.test(value)) return 'onsite'

  const inLocationMatch = value.match(/\bin\s+([a-z][a-z\s]{2,40})(?:$|[,.!?])/i)
  if (inLocationMatch) {
    const candidate = cleanText(inLocationMatch[1])
    if (candidate) return candidate
  }

  for (const location of LOCATION_HINTS) {
    if (lowered.includes(location)) return location
  }

  return ''
}

const keywordScore = (message, keywordList) => {
  const value = normalizePhrase(message)
  if (!value) return 0

  return keywordList.reduce((score, keyword) => {
    const normalizedKeyword = normalizePhrase(keyword)
    if (!normalizedKeyword) return score
    return value.includes(normalizedKeyword) ? score + 1 : score
  }, 0)
}

const clampConfidence = (value) => Math.max(0, Math.min(1, Number(value) || 0))

const parseJsonFromText = (rawText) => {
  const cleaned = String(rawText || '').replace(/```json|```/gi, '').trim()
  const firstJsonIndex = cleaned.indexOf('{')
  const lastJsonIndex = cleaned.lastIndexOf('}')
  if (firstJsonIndex === -1 || lastJsonIndex === -1) return null
  try {
    return JSON.parse(cleaned.slice(firstJsonIndex, lastJsonIndex + 1))
  } catch {
    return null
  }
}

const detectByKeywords = (message) => {
  const value = cleanText(message)
  const lowered = normalizePhrase(value)
  const role = extractRole(value)
  const skills = extractSkills(value)
  const experience = extractExperience(value)
  const location = extractLocation(value)

  const extractedData = {
    role,
    skills,
    experience,
    location,
  }

  if (!value) {
    return {
      intent: INTENTS.UNKNOWN,
      confidence: 0,
      extractedData,
    }
  }

  if (SMALL_TALK_EXACT.has(lowered)) {
    return {
      intent: INTENTS.SMALL_TALK,
      confidence: 0.95,
      extractedData,
    }
  }

  const jobScore = keywordScore(value, JOB_SEARCH_KEYWORDS)
  const careerScore = keywordScore(value, CAREER_QUERY_KEYWORDS)
  const smallTalkScore = keywordScore(value, SMALL_TALK_KEYWORDS)
  const hasSearchSignals = Boolean(role || skills.length > 0)

  if (jobScore >= careerScore && jobScore >= smallTalkScore && (jobScore > 0 || hasSearchSignals)) {
    return {
      intent: INTENTS.JOB_SEARCH,
      confidence: clampConfidence(0.58 + jobScore * 0.08 + (hasSearchSignals ? 0.12 : 0)),
      extractedData,
    }
  }

  if (careerScore >= smallTalkScore && careerScore > 0) {
    return {
      intent: INTENTS.CAREER_QUERY,
      confidence: clampConfidence(0.54 + careerScore * 0.09),
      extractedData,
    }
  }

  if (smallTalkScore > 0) {
    return {
      intent: INTENTS.SMALL_TALK,
      confidence: clampConfidence(0.6 + smallTalkScore * 0.08),
      extractedData,
    }
  }

  return {
    intent: INTENTS.UNKNOWN,
    confidence: hasSearchSignals ? 0.52 : 0.32,
    extractedData,
  }
}

const shouldRunAiClassifier = (heuristicResult, options) => {
  if (!options?.enableAi) return false
  if (!vertexClient) return false
  if (!heuristicResult) return true
  if (heuristicResult.intent === INTENTS.UNKNOWN) return true
  return Number(heuristicResult.confidence || 0) < 0.72
}

const classifyWithAi = async (message) => {
  if (!vertexClient) return null
  const model = vertexClient.getGenerativeModel({ model: env.geminiModel })
  const promptPayload = `
You are an intent classifier for a career assistant.
Classify user message into one intent:
- JOB_SEARCH
- CAREER_QUERY
- SMALL_TALK
- UNKNOWN

Also extract:
- role
- skills (array)
- experience
- location

Return ONLY JSON:
{
  "intent": "JOB_SEARCH",
  "confidence": 0.0,
  "extractedData": {
    "role": "",
    "skills": [],
    "experience": "",
    "location": ""
  }
}

User message: ${message}
`

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: promptPayload }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    })
    const textParts = result?.response?.candidates?.[0]?.content?.parts || []
    const text = textParts.map((part) => String(part?.text || '')).join('\n').trim()
    const parsed = parseJsonFromText(text)
    if (!parsed || typeof parsed !== 'object') return null

    const intent = String(parsed.intent || '').trim().toUpperCase()
    const safeIntent = INTENTS[intent] || INTENTS.UNKNOWN
    const extracted = parsed.extractedData && typeof parsed.extractedData === 'object'
      ? parsed.extractedData
      : {}

    return {
      intent: safeIntent,
      confidence: clampConfidence(parsed.confidence),
      extractedData: {
        role: cleanText(extracted.role),
        skills: uniq((Array.isArray(extracted.skills) ? extracted.skills : []).map((entry) => normalizePhrase(entry))).slice(0, 12),
        experience: cleanText(extracted.experience),
        location: cleanText(extracted.location),
      },
    }
  } catch {
    return null
  }
}

const mergeExtractedData = (baseData, nextData) => {
  const base = baseData && typeof baseData === 'object' ? baseData : {}
  const next = nextData && typeof nextData === 'object' ? nextData : {}
  return {
    role: cleanText(next.role || base.role),
    skills: uniq([
      ...(Array.isArray(base.skills) ? base.skills : []),
      ...(Array.isArray(next.skills) ? next.skills : []),
    ]).slice(0, 12),
    experience: cleanText(next.experience || base.experience),
    location: cleanText(next.location || base.location),
  }
}

export const detectUserIntent = async (message, options = {}) => {
  const normalizedMessage = cleanText(message)
  const cacheKey = buildCacheKey(normalizedMessage)
  const cached = getCachedIntent(cacheKey)
  if (cached) return cached

  const heuristicResult = detectByKeywords(normalizedMessage)
  let finalResult = heuristicResult

  if (shouldRunAiClassifier(heuristicResult, options)) {
    const aiResult = await classifyWithAi(normalizedMessage)
    if (aiResult) {
      const mergedExtractedData = mergeExtractedData(
        heuristicResult.extractedData,
        aiResult.extractedData,
      )
      const preferAi =
        aiResult.intent !== INTENTS.UNKNOWN &&
        (heuristicResult.intent === INTENTS.UNKNOWN ||
          aiResult.confidence >= heuristicResult.confidence + 0.08)

      finalResult = preferAi
        ? {
            ...aiResult,
            extractedData: mergedExtractedData,
          }
        : {
            ...heuristicResult,
            extractedData: mergedExtractedData,
          }
    }
  }

  const normalizedResult = {
    intent: finalResult.intent || INTENTS.UNKNOWN,
    confidence: clampConfidence(finalResult.confidence),
    extractedData: {
      role: cleanText(finalResult.extractedData?.role),
      skills: uniq(finalResult.extractedData?.skills || []).slice(0, 12),
      experience: cleanText(finalResult.extractedData?.experience),
      location: cleanText(finalResult.extractedData?.location),
    },
  }

  setCachedIntent(cacheKey, normalizedResult)
  return normalizedResult
}

export const intentConstants = {
  INTENTS,
}

import { VertexAI } from '@google-cloud/vertexai'
import { env } from '../../config/environment.js'
import { buildFallbackProfile } from '../parsing/fallbackProfileParser.js'
import {
  buildGeminiCacheKey,
  getGeminiCache,
  setGeminiCache,
} from './geminiCache.js'

const modelName = env.geminiModel

const vertexClient = env.vertexProject
  ? new VertexAI({
      project: env.vertexProject,
      location: env.vertexLocation,
    })
  : null

const defaultStructuredProfile = {
  role: '',
  primarySkills: [],
  secondarySkills: [],
  experienceYears: 0,
  locationPreference: '',
  remotePreference: false,
  salaryExpectation: {
    min: 0,
    max: 0,
    currency: 'INR',
    type: 'LPA',
  },
  seniorityLevel: '',
}

const GEMINI_CACHE_TTL_MS = 1000 * 60 * 45
const geminiTimeoutMs = Math.max(5000, Number(env.geminiTimeoutMs || 35000))

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[gemini-service] ${message}`, context)
}

const summarizeReasoning = (value, maxLength = 220) => {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

const extractHosts = (urls, limit = 6) => {
  const hosts = []
  const seen = new Set()
  for (const entry of Array.isArray(urls) ? urls : []) {
    try {
      const host = new URL(String(entry || '').trim()).hostname.replace(/^www\./i, '').toLowerCase()
      if (!host || seen.has(host)) continue
      seen.add(host)
      hosts.push(host)
      if (hosts.length >= limit) break
    } catch {
      // Ignore invalid URLs in diagnostics summary.
    }
  }
  return hosts
}

const stripCodeFence = (text) => {
  return text.replace(/```json|```/gi, '').trim()
}

const normalizeArray = (value) => {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 20)
}

const normalizeSalaryExpectation = (value, fallback = {}) => {
  const payload = value && typeof value === 'object' ? value : {}
  const fallbackPayload = fallback && typeof fallback === 'object' ? fallback : {}
  const currency = String(payload.currency ?? fallbackPayload.currency ?? 'INR')
    .trim()
    .toUpperCase()
  const type = String(payload.type ?? fallbackPayload.type ?? 'LPA').trim()
  const min = Math.max(0, Number(payload.min ?? fallbackPayload.min ?? 0) || 0)
  const maxRaw = Math.max(0, Number(payload.max ?? fallbackPayload.max ?? 0) || 0)
  const max = Math.max(min, maxRaw)
  return {
    min,
    max,
    currency,
    type,
  }
}

const parseExperienceLabel = (value) => {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  const matched = String(value || '').match(/(\d+)\s*\+?\s*(years?|yrs?)/i)
  return matched ? Number(matched[1]) : 0
}

const mergeProfileSeed = (baseProfile, profileSeed) => {
  if (!profileSeed || typeof profileSeed !== 'object') return baseProfile

  const seededSkills = normalizeArray(profileSeed.skills || [])
  const basePrimary = normalizeArray(baseProfile.primarySkills || [])
  const baseSecondary = normalizeArray(baseProfile.secondarySkills || [])

  const mergedPrimary = [...new Set([...(basePrimary.length > 0 ? basePrimary : seededSkills.slice(0, 10))])]
  const mergedSecondary = [
    ...new Set([
      ...baseSecondary,
      ...seededSkills.filter((skill) => !mergedPrimary.includes(skill)),
    ]),
  ]

  const mergedExperienceYears = Math.max(
    Number(baseProfile.experienceYears || 0),
    parseExperienceLabel(profileSeed.experience),
  )

  const mergedSalary = normalizeSalaryExpectation(
    baseProfile.salaryExpectation,
    profileSeed.package || {},
  )
  const seededRole = String(profileSeed.role || '').trim()
  const seededLocation = String(profileSeed.locationPreference || '').trim()
  const seededRemote = Boolean(profileSeed.remotePreference)
  const seededSeniority = String(profileSeed.seniorityLevel || '').trim()

  return {
    ...baseProfile,
    role: baseProfile.role || seededRole,
    primarySkills: mergedPrimary.slice(0, 10),
    secondarySkills: mergedSecondary.slice(0, 10),
    experienceYears: mergedExperienceYears,
    locationPreference: baseProfile.locationPreference || seededLocation,
    remotePreference: baseProfile.remotePreference || seededRemote,
    salaryExpectation: mergedSalary,
    seniorityLevel: baseProfile.seniorityLevel || seededSeniority,
  }
}

const normalizeProfile = (rawProfile, fallbackProfile) => {
  return {
    role: String(rawProfile.role ?? fallbackProfile.role ?? '').trim(),
    primarySkills: normalizeArray(
      rawProfile.primarySkills ?? fallbackProfile.primarySkills,
    ),
    secondarySkills: normalizeArray(
      rawProfile.secondarySkills ?? fallbackProfile.secondarySkills,
    ),
    experienceYears: Number(
      rawProfile.experienceYears ?? fallbackProfile.experienceYears ?? 0,
    ),
    locationPreference: String(
      rawProfile.locationPreference ?? fallbackProfile.locationPreference ?? '',
    ).trim(),
    remotePreference: Boolean(
      rawProfile.remotePreference ?? fallbackProfile.remotePreference ?? false,
    ),
    salaryExpectation: normalizeSalaryExpectation(
      rawProfile.salaryExpectation,
      fallbackProfile.salaryExpectation,
    ),
    seniorityLevel: String(
      rawProfile.seniorityLevel ?? fallbackProfile.seniorityLevel ?? '',
    ).trim(),
  }
}

const derivePromptRole = (prompt) => {
  const cleaned = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned.split(' ').slice(0, 8).join(' ')
}

const buildHeuristicStructuredProfile = ({ prompt, resumeText }) => {
  const parsed = buildFallbackProfile(prompt, resumeText)
  const role = parsed.roles[0] || derivePromptRole(prompt)
  const primarySkills = parsed.skills.slice(0, 8)
  const secondarySkills = parsed.skills.slice(8, 16)
  const expectedMin = Number(parsed.expectedPackageLpa || 0)
  const expectedMax = expectedMin ? expectedMin + 8 : 0

  return {
    role,
    primarySkills,
    secondarySkills,
    experienceYears: Number(parsed.experienceYears || 0),
    locationPreference: parsed.locations[0] || '',
    remotePreference: parsed.workMode === 'remote',
    salaryExpectation: {
      min: expectedMin,
      max: expectedMax,
      currency: 'INR',
      type: 'LPA',
    },
    seniorityLevel:
      Number(parsed.experienceYears || 0) >= 5
        ? 'senior'
        : Number(parsed.experienceYears || 0) >= 2
          ? 'mid'
          : 'junior',
  }
}

const parseGeminiJson = (rawText) => {
  const cleaned = stripCodeFence(rawText)
  const firstJsonIndex = cleaned.indexOf('{')
  const lastJsonIndex = cleaned.lastIndexOf('}')

  if (firstJsonIndex === -1 || lastJsonIndex === -1) {
    throw new Error('Gemini response did not include JSON object.')
  }

  return JSON.parse(cleaned.slice(firstJsonIndex, lastJsonIndex + 1))
}

const withTimeout = async (promise, timeoutMs, label) => {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

const getVertexModel = () => {
  if (!vertexClient) return null
  return vertexClient.getGenerativeModel({ model: modelName })
}

const extractVertexText = (result) => {
  const parts = result?.response?.candidates?.[0]?.content?.parts || []
  const text = parts
    .map((part) => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return text
}

const generateWithVertex = async ({ promptPayload, label, expectJson = false }) => {
  const model = getVertexModel()
  if (!model) {
    throw new Error('Vertex AI is not configured. Set VERTEX_PROJECT_ID.')
  }

  const requestPayload = {
    contents: [{ role: 'user', parts: [{ text: promptPayload }] }],
  }

  if (expectJson) {
    requestPayload.generationConfig = {
      responseMimeType: 'application/json',
    }
  }

  const result = await withTimeout(
    model.generateContent(requestPayload),
    geminiTimeoutMs,
    label,
  )

  const text = extractVertexText(result)
  if (!text) {
    throw new Error(`Empty Vertex AI response for ${label}.`)
  }

  return text
}

const buildProfileQueryText = (profile) => {
  const terms = [
    profile.role,
    ...(profile.primarySkills || []),
    ...(profile.secondarySkills || []),
    profile.locationPreference,
    profile.remotePreference ? 'remote' : '',
    profile.seniorityLevel,
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)

  return terms.length > 0 ? terms.slice(0, 8).join(' ') : 'software engineer'
}

const allowedEmploymentTypes = new Set([
  'full-time',
  'internship',
  'contract',
  'part-time',
  'temporary',
  'any',
])

const allowedRemotePolicies = new Set(['remote', 'hybrid', 'onsite', 'any'])

const inferEmploymentType = (roleAndSeniority) => {
  if (/\b(intern|internship|fresher|graduate|entry|new grad)\b/.test(roleAndSeniority)) {
    return 'internship'
  }
  if (/\b(contract|freelance)\b/.test(roleAndSeniority)) return 'contract'
  if (/\b(part[-\s]?time)\b/.test(roleAndSeniority)) return 'part-time'
  return 'full-time'
}

const inferRemotePolicy = (profile) => {
  const location = String(profile?.locationPreference || '').toLowerCase()
  if (profile?.remotePreference) return 'remote'
  if (/\bhybrid\b/i.test(location)) return 'hybrid'
  if (/\bonsite|on-site\b/i.test(location)) return 'onsite'
  return 'any'
}

const buildFallbackSearchIntent = (profile) => {
  const role = String(profile?.role || '').trim() || 'software engineer'
  const allSkills = normalizeArray([
    ...(profile?.primarySkills || []),
    ...(profile?.secondarySkills || []),
  ]).slice(0, 16)
  const roleAndSeniority = `${role} ${String(profile?.seniorityLevel || '')}`.toLowerCase()
  const locations = normalizeArray(
    String(profile?.locationPreference || '')
      .split(/[,/|]/)
      .map((entry) => entry.trim()),
  ).slice(0, 5)
  const experienceYears = Math.max(0, Number(profile?.experienceYears || 0))
  const keywords = normalizeArray([
    role,
    ...allSkills,
    ...locations,
    profile?.remotePreference ? 'remote' : '',
    profile?.seniorityLevel || '',
  ]).slice(0, 24)

  return {
    role,
    mustSkills: allSkills.slice(0, 8),
    niceSkills: allSkills.slice(8, 16),
    experienceYears,
    seniority: String(profile?.seniorityLevel || '').trim(),
    employmentType: inferEmploymentType(roleAndSeniority),
    locations,
    remotePolicy: inferRemotePolicy(profile),
    compensation: normalizeSalaryExpectation(profile?.salaryExpectation, {}),
    preferredCompanies: [],
    excludedTerms: [],
    keywords,
  }
}

const normalizeSearchIntent = (rawIntent, fallbackIntent) => {
  const intent = rawIntent && typeof rawIntent === 'object' ? rawIntent : {}
  const role = String(intent.role ?? fallbackIntent.role ?? '').trim() || fallbackIntent.role
  const mustSkills = normalizeArray(intent.mustSkills ?? intent.skills ?? fallbackIntent.mustSkills).slice(0, 10)
  const niceSkills = normalizeArray(intent.niceSkills ?? fallbackIntent.niceSkills).slice(0, 10)
  const experienceYears = Math.max(
    0,
    Number(intent.experienceYears ?? fallbackIntent.experienceYears ?? 0) || 0,
  )
  const seniority = String(intent.seniority ?? fallbackIntent.seniority ?? '').trim()
  const locations = normalizeArray(intent.locations ?? fallbackIntent.locations).slice(0, 6)
  const rawEmploymentType = String(
    intent.employmentType ?? intent.job_type ?? fallbackIntent.employmentType ?? 'any',
  )
    .trim()
    .toLowerCase()
  const employmentType = allowedEmploymentTypes.has(rawEmploymentType)
    ? rawEmploymentType
    : fallbackIntent.employmentType
  const rawRemotePolicy = String(intent.remotePolicy ?? fallbackIntent.remotePolicy ?? 'any')
    .trim()
    .toLowerCase()
  const remotePolicy = allowedRemotePolicies.has(rawRemotePolicy)
    ? rawRemotePolicy
    : fallbackIntent.remotePolicy
  const compensation = normalizeSalaryExpectation(intent.compensation, fallbackIntent.compensation)
  const preferredCompanies = normalizeArray(intent.preferredCompanies ?? fallbackIntent.preferredCompanies).slice(
    0,
    8,
  )
  const excludedTerms = normalizeArray(intent.excludedTerms ?? fallbackIntent.excludedTerms).slice(0, 12)
  const keywords = normalizeArray(intent.keywords ?? fallbackIntent.keywords).slice(0, 26)

  return {
    role,
    mustSkills,
    niceSkills,
    experienceYears,
    seniority,
    employmentType,
    locations,
    remotePolicy,
    compensation,
    preferredCompanies,
    excludedTerms,
    keywords,
  }
}

const joinQueryParts = (parts) =>
  parts
    .map((entry) => String(entry || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim()

const buildQueryVariantsFromIntent = (intent, limit = 8) => {
  const role = String(intent?.role || '').trim() || 'software engineer'
  const skills = normalizeArray([...(intent?.mustSkills || []), ...(intent?.niceSkills || [])]).slice(0, 6)
  const keywords = normalizeArray(intent?.keywords || []).slice(0, 10)
  const experienceYears = Math.max(0, Number(intent?.experienceYears || 0))
  const experience = experienceYears > 0 ? `${experienceYears}+ years` : ''
  const employmentType = String(intent?.employmentType || '').trim()
  const employmentTypeToken = employmentType === 'full-time' || employmentType === 'any' ? '' : employmentType
  const remotePolicy = String(intent?.remotePolicy || '').trim()
  const remoteToken = remotePolicy === 'any' ? '' : remotePolicy
  const location = normalizeArray(intent?.locations || []).slice(0, 2).join(' ')
  const excludedTerms = normalizeArray(intent?.excludedTerms || []).slice(0, 2).join(' ')

  const variants = [
    joinQueryParts([role, ...skills.slice(0, 3), location, remoteToken]),
    joinQueryParts([role, ...skills.slice(0, 2), experience]),
    joinQueryParts([role, ...keywords.slice(0, 5)]),
    joinQueryParts([role, employmentTypeToken, ...skills.slice(0, 2)]),
    joinQueryParts([role, ...skills.slice(0, 3)]),
    joinQueryParts([role, location, excludedTerms ? `not ${excludedTerms}` : '']),
    joinQueryParts([role]),
  ]

  const deduped = []
  const seen = new Set()
  for (const variant of variants) {
    if (!variant || variant.length < 3) continue
    const key = variant.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(variant)
    if (deduped.length >= limit) break
  }

  return deduped
}

const buildSearchIntentWithGemini = async ({ profile }) => {
  const fallbackIntent = buildFallbackSearchIntent(profile)
  const promptPayload = `
You are a job search intent extractor.
Return ONLY valid JSON with this exact shape:
{
  "role": "",
  "mustSkills": ["..."],
  "niceSkills": ["..."],
  "experienceYears": 0,
  "seniority": "",
  "employmentType": "",
  "locations": ["..."],
  "remotePolicy": "",
  "compensation": { "min": 0, "max": 0, "currency": "INR", "type": "LPA" },
  "preferredCompanies": ["..."],
  "excludedTerms": ["..."],
  "keywords": ["..."]
}

Rules:
- "employmentType" must be one of: "full-time", "internship", "contract", "part-time", "temporary", "any".
- "remotePolicy" must be one of: "remote", "hybrid", "onsite", "any".
- "mustSkills" should contain non-negotiable skills only.
- "niceSkills" should contain adjacent optional skills.
- "keywords" should include high-signal search terms for scraping and ATS.
- Keep "keywords" concise and deduplicated.
- No markdown. No explanation. No extra keys.

Candidate profile:
${JSON.stringify(profile)}
`

  const parsed = await runGeminiJsonTask({
    cacheNamespace: 'search-intent',
    cachePayload: {
      profile: {
        role: profile?.role || '',
        primarySkills: profile?.primarySkills || [],
        secondarySkills: profile?.secondarySkills || [],
        experienceYears: Number(profile?.experienceYears || 0),
        locationPreference: profile?.locationPreference || '',
        remotePreference: Boolean(profile?.remotePreference),
        seniorityLevel: profile?.seniorityLevel || '',
        salaryExpectation: normalizeSalaryExpectation(profile?.salaryExpectation, {}),
      },
    },
    promptPayload,
    fallbackValue: fallbackIntent,
  })

  const normalizedIntent = normalizeSearchIntent(parsed, fallbackIntent)
  debugLog('search intent prepared', {
    role: normalizedIntent.role,
    mustSkillCount: normalizedIntent.mustSkills.length,
    niceSkillCount: normalizedIntent.niceSkills.length,
    employmentType: normalizedIntent.employmentType,
    remotePolicy: normalizedIntent.remotePolicy,
    locationCount: normalizedIntent.locations.length,
    keywordCount: normalizedIntent.keywords.length,
  })
  return normalizedIntent
}

const normalizeHttpUrls = (urls, limit = 25) => {
  if (!Array.isArray(urls)) return []

  const normalized = []
  const seen = new Set()
  for (const raw of urls) {
    try {
      const value = String(raw || '').trim()
      if (!value) continue
      const parsed = new URL(value)
      if (!/^https?:$/i.test(parsed.protocol)) continue
      const href = parsed.toString()
      if (seen.has(href)) continue
      seen.add(href)
      normalized.push(href)
      if (normalized.length >= limit) break
    } catch {
      // Ignore invalid URLs produced by model.
    }
  }

  return normalized
}

const buildJobKey = (job) =>
  String(job.externalId || `${job.title || ''}-${job.company || ''}-${job.applyLink || ''}`).toLowerCase()

const toCompactJob = (job) => ({
  externalId: job.externalId || '',
  title: job.title || '',
  company: job.company || '',
  location: job.location || '',
  salary: job.salary || '',
  source: job.source || '',
  matchScore: Number(job.matchScore || 0),
  description: String(job.description || '').slice(0, 260),
})

const runGeminiJsonTask = async ({
  cacheNamespace,
  cachePayload,
  promptPayload,
  fallbackValue,
  ttlMs = GEMINI_CACHE_TTL_MS,
}) => {
  const cacheKey = buildGeminiCacheKey(cacheNamespace, cachePayload)
  const cached = getGeminiCache(cacheKey)
  if (cached) {
    debugLog('cache hit', { cacheNamespace })
    return cached
  }

  if (!vertexClient) return fallbackValue

  try {
    const start = Date.now()
    const text = await generateWithVertex({
      promptPayload,
      label: `${cacheNamespace} request`,
      expectJson: true,
    })
    const parsed = parseGeminiJson(text)
    setGeminiCache(cacheKey, parsed, ttlMs)
    debugLog('request success', {
      cacheNamespace,
      elapsedMs: Date.now() - start,
    })
    return parsed
  } catch (error) {
    debugLog('request fallback', {
      cacheNamespace,
      reason: error.message,
    })
    return fallbackValue
  }
}

const generateJsonWithGemini = async ({ promptPayload, label }) => {
  const startedAt = Date.now()
  const text = await generateWithVertex({
    promptPayload,
    label,
    expectJson: true,
  })
  debugLog('json call success', {
    label,
    elapsedMs: Date.now() - startedAt,
  })
  return parseGeminiJson(text)
}

export const buildPreferenceProfile = async ({ prompt, resumeText, profileSeed = null }) => {
  if (!vertexClient) {
    throw new Error(
      'Vertex AI is not configured. Set VERTEX_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS.',
    )
  }

  const heuristicProfile = buildHeuristicStructuredProfile({ prompt, resumeText })
  const seededHeuristicProfile = mergeProfileSeed(heuristicProfile, profileSeed)
  const fallbackProfile = normalizeProfile(seededHeuristicProfile, defaultStructuredProfile)

  try {
    const start = Date.now()
    const instruction = `
Extract the candidate's structured hiring profile.
Return ONLY valid JSON with this exact shape:
{
  "role": "",
  "primarySkills": ["..."],
  "secondarySkills": ["..."],
  "experienceYears": 0,
  "locationPreference": "",
  "remotePreference": false,
  "salaryExpectation": {
    "min": 0,
    "max": 0,
    "currency": "INR",
    "type": "LPA"
  },
  "seniorityLevel": ""
}
Strictly no markdown, no explanation, no extra keys.
`

    const promptPayload = [
      instruction,
      `User Prompt: ${prompt}`,
      `Resume Text (trimmed): ${resumeText.slice(0, 5000) || 'N/A'}`,
      `Persisted Profile Seed: ${JSON.stringify(profileSeed || {})}`,
    ].join('\n\n')

    const parsed = await generateJsonWithGemini({
      promptPayload,
      label: 'buildPreferenceProfile',
    })

    const normalized = normalizeProfile(parsed, fallbackProfile)
    debugLog('build profile completed', {
      elapsedMs: Date.now() - start,
      role: normalized.role,
      primarySkills: normalized.primarySkills.length,
      secondarySkills: normalized.secondarySkills.length,
      experienceYears: normalized.experienceYears,
      locationPreference: normalized.locationPreference || 'none',
      remotePreference: normalized.remotePreference,
      salaryMin: Number(normalized.salaryExpectation?.min || 0),
      salaryMax: Number(normalized.salaryExpectation?.max || 0),
    })
    return {
      profile: normalized,
      source: 'gemini',
    }
  } catch (error) {
    debugLog('build profile fallback', {
      reason: error.message,
    })
    return {
      profile: fallbackProfile,
      source: `fallback:${error.message}`,
    }
  }
}

export const refineProfileWithInstruction = async ({ currentProfile, instruction }) => {
  if (!vertexClient) {
    throw new Error('Vertex AI is not configured for profile refinement.')
  }

  const promptPayload = `
You are updating a job search profile based on a new user instruction.
Return ONLY valid JSON in this exact shape:
{
  "role": "",
  "primarySkills": ["..."],
  "secondarySkills": ["..."],
  "experienceYears": 0,
  "locationPreference": "",
  "remotePreference": false,
  "salaryExpectation": {
    "min": 0,
    "max": 0,
    "currency": "INR",
    "type": "LPA"
  },
  "seniorityLevel": ""
}

Current Profile:
${JSON.stringify(currentProfile)}

New User Instruction:
${instruction}

Update only what user explicitly changed, preserve the rest.
`

  try {
    const parsed = await generateJsonWithGemini({
      promptPayload,
      label: 'refineProfileWithInstruction',
    })
    return normalizeProfile(parsed, currentProfile)
  } catch (error) {
    throw new Error(`Gemini refinement failed: ${error.message}`)
  }
}

export const discoverJobSourcesWithGemini = async ({
  profile,
  fallbackTargets = [],
  maxTargets = 20,
}) => {
  const fallback = normalizeHttpUrls(fallbackTargets, Math.max(12, maxTargets))
  const searchIntent = await buildSearchIntentWithGemini({ profile })
  const queryVariants = buildQueryVariantsFromIntent(searchIntent, 10)
  const query = queryVariants[0] || buildProfileQueryText(profile)

  const promptPayload = `
Generate dynamic job search URLs for this candidate profile.
Return ONLY JSON:
{
  "urls": ["https://..."],
  "reasoning": "short",
  "queryPlan": {
    "primaryQuery": "",
    "variantsUsed": ["..."]
  }
}

Rules:
- Include a mix of global, India, and remote-friendly sources.
- Include ATS engines (Greenhouse, Lever, Workday) + startup boards + company career pages.
- Use the structured SearchIntent and provided query variants.
- Prioritize SearchIntent.mustSkills and SearchIntent.locations when composing URLs.
- Respect SearchIntent.excludedTerms and avoid those in query construction.
- Ensure URL query parameters are aligned to the query variants where applicable.
- Avoid duplicates and low-quality/non-job URLs.
- Prefer high-signal sources likely to return engineering jobs quickly.
- Avoid login/help/support/legal pages.
- Return ${maxTargets} to ${Math.max(maxTargets + 6, 24)} URLs.

Profile:
${JSON.stringify(profile)}

SearchIntent:
${JSON.stringify(searchIntent)}

Optimized Query Variants:
${JSON.stringify(queryVariants)}

Fallback hints:
${JSON.stringify(fallback.slice(0, 18))}
`

  const parsed = await runGeminiJsonTask({
    cacheNamespace: 'source-discovery',
    cachePayload: {
      profile,
      searchIntent,
      queryVariants: queryVariants.slice(0, 8),
      maxTargets,
      fallback: fallback.slice(0, 20),
    },
    promptPayload,
    fallbackValue: {
      urls: fallback,
      reasoning: 'Fallback to configured targets.',
      queryPlan: {
        primaryQuery: query,
        variantsUsed: queryVariants.slice(0, 4),
      },
    },
  })

  const discovered = normalizeHttpUrls(parsed.urls || [], Math.max(maxTargets + 8, 28))
  const merged = normalizeHttpUrls([...discovered, ...fallback], maxTargets)
  debugLog('source discovery plan', {
    primaryQuery: parsed?.queryPlan?.primaryQuery || query,
    variantsUsed: Array.isArray(parsed?.queryPlan?.variantsUsed)
      ? parsed.queryPlan.variantsUsed.length
      : 0,
    discoveredCount: discovered.length,
    discoveredHosts: extractHosts(discovered),
    reasoning: summarizeReasoning(parsed?.reasoning),
  })
  return merged.length > 0 ? merged : fallback.slice(0, maxTargets)
}

export const filterJobsWithAI = async ({ profile, jobs }) => {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    debugLog('ai filter skipped - empty jobs', {})
    return {
      relevantJobs: [],
      discardedJobs: [],
      reasoning: 'No jobs available for filtering.',
      source: 'empty',
    }
  }

  const candidateJobs = jobs.slice(0, 45)
  if (!vertexClient || candidateJobs.length <= 8) {
    const fallbackRelevant = candidateJobs.slice(0, 20)
    const fallbackResponse = {
      relevantJobs: fallbackRelevant,
      discardedJobs: candidateJobs.slice(fallbackRelevant.length),
      reasoning: 'AI filter skipped; fallback shortlist selected.',
      source: 'fallback',
    }
    debugLog('ai filter fallback', {
      candidateJobs: candidateJobs.length,
      relevantJobs: fallbackResponse.relevantJobs.length,
      discardedJobs: fallbackResponse.discardedJobs.length,
      reason: summarizeReasoning(fallbackResponse.reasoning),
    })
    return fallbackResponse
  }

  const compactJobs = candidateJobs.map((job, index) => ({
    aiId: `J${index + 1}`,
    ...toCompactJob(job),
  }))
  const aiIdToJob = new Map(compactJobs.map((job, index) => [job.aiId, candidateJobs[index]]))
  const promptPayload = `
You are filtering scraped jobs for relevance.
Return ONLY JSON:
{
  "relevantAiIds": ["J1","J2"],
  "discardedAiIds": ["J3","J4"],
  "reasoning": "short explanation"
}

Filter criteria:
- role/title fit
- skill alignment
- experience and seniority fit
- location/remote preference
- avoid obvious unrelated roles

Profile:
${JSON.stringify(profile)}

Jobs:
${JSON.stringify(compactJobs)}
`

  const parsed = await runGeminiJsonTask({
    cacheNamespace: 'job-filter',
    cachePayload: {
      profile,
      jobs: compactJobs.map((job) => ({
        id: job.externalId || buildJobKey(job),
        title: job.title,
        company: job.company,
      })),
    },
    promptPayload,
    fallbackValue: {
      relevantAiIds: compactJobs.slice(0, 20).map((job) => job.aiId),
      discardedAiIds: [],
      reasoning: 'Fallback filter used due model failure.',
    },
  })

  const relevantIds = new Set(
    Array.isArray(parsed.relevantAiIds)
      ? parsed.relevantAiIds.map((entry) => String(entry))
      : [],
  )
  const discardedIds = new Set(
    Array.isArray(parsed.discardedAiIds)
      ? parsed.discardedAiIds.map((entry) => String(entry))
      : [],
  )

  const relevantJobs =
    relevantIds.size > 0
      ? [...relevantIds].map((id) => aiIdToJob.get(id)).filter(Boolean)
      : compactJobs
          .filter((job) => !discardedIds.has(job.aiId))
          .map((job) => aiIdToJob.get(job.aiId))
          .filter(Boolean)

  const fallbackRelevant = relevantJobs.length > 0 ? relevantJobs : candidateJobs.slice(0, 20)
  const fallbackKeySet = new Set(fallbackRelevant.map((job) => String(job.externalId || buildJobKey(job))))
  const discardedJobs = candidateJobs.filter(
    (job) => !fallbackKeySet.has(String(job.externalId || buildJobKey(job))),
  )

  const response = {
    relevantJobs: fallbackRelevant,
    discardedJobs,
    reasoning: String(parsed.reasoning || 'AI filter completed.').trim(),
    source: relevantJobs.length > 0 ? 'gemini' : 'fallback',
  }
  debugLog('ai filter completed', {
    candidateJobs: candidateJobs.length,
    relevantJobs: response.relevantJobs.length,
    discardedJobs: response.discardedJobs.length,
    source: response.source,
    reason: summarizeReasoning(response.reasoning),
  })
  return response
}

export const rankJobsWithAI = async ({ profile, jobs }) => {
  if (!Array.isArray(jobs) || jobs.length <= 1) {
    debugLog('ai rank skipped - insufficient jobs', {
      candidateJobs: Array.isArray(jobs) ? jobs.length : 0,
    })
    return jobs || []
  }

  const rankCandidates = jobs.slice(0, 25)
  if (!vertexClient) {
    const fallbackRanked = [...rankCandidates].sort(
      (left, right) => Number(right.matchScore || 0) - Number(left.matchScore || 0),
    )
    debugLog('ai rank fallback - no vertex', {
      candidateJobs: rankCandidates.length,
      rankedJobs: fallbackRanked.length,
    })
    return fallbackRanked
  }

  const compact = rankCandidates.map((job, index) => ({
    aiId: `R${index + 1}`,
    ...toCompactJob(job),
  }))
  const aiIdToJob = new Map(compact.map((job, index) => [job.aiId, rankCandidates[index]]))
  const promptPayload = `
Re-rank these jobs for best exact profile fit and career growth.
Return ONLY valid JSON:
{
  "sortedAiIds": ["R1", "R2"],
  "reasoning": "short explanation"
}

Prioritize:
- skill and role match
- realistic seniority alignment
- stronger company/growth opportunities
- preferred location / remote fit

Profile:
${JSON.stringify(profile)}

Jobs:
${JSON.stringify(compact)}
`

  const parsed = await runGeminiJsonTask({
    cacheNamespace: 'job-ranking',
    cachePayload: {
      profile,
      jobs: compact.map((job) => ({
        id: job.externalId || buildJobKey(job),
        title: job.title,
        company: job.company,
        score: job.matchScore,
      })),
    },
    promptPayload,
    fallbackValue: {
      sortedAiIds: compact.map((job) => job.aiId),
      reasoning: 'Fallback rank applied.',
    },
  })

  const orderedIds = Array.isArray(parsed.sortedAiIds)
    ? parsed.sortedAiIds.map((entry) => String(entry))
    : []

  if (orderedIds.length === 0) {
    const fallbackRanked = [...rankCandidates].sort(
      (left, right) => Number(right.matchScore || 0) - Number(left.matchScore || 0),
    )
    debugLog('ai rank fallback - empty sorted ids', {
      candidateJobs: rankCandidates.length,
      rankedJobs: fallbackRanked.length,
      reason: summarizeReasoning(parsed.reasoning || 'No ordering provided by model.'),
    })
    return fallbackRanked
  }

  const rankedFromAi = orderedIds.map((id) => aiIdToJob.get(id)).filter(Boolean)
  const rankedKeys = new Set(rankedFromAi.map((job) => String(job.externalId || buildJobKey(job))))
  const remaining = rankCandidates.filter(
    (job) => !rankedKeys.has(String(job.externalId || buildJobKey(job))),
  )

  const ranked = [
    ...rankedFromAi,
    ...remaining.sort((left, right) => Number(right.matchScore || 0) - Number(left.matchScore || 0)),
  ]
  debugLog('ai rank completed', {
    candidateJobs: rankCandidates.length,
    rankedFromAi: rankedFromAi.length,
    fallbackTail: remaining.length,
    finalRanked: ranked.length,
    reason: summarizeReasoning(parsed.reasoning || 'AI ranking applied.'),
  })
  return ranked
}

export const rerankJobsWithGemini = async ({ profile, jobs }) => {
  return rankJobsWithAI({ profile, jobs })
}

export const generateAssistantSummary = async ({
  profile,
  topJobs,
  userPrompt,
  isRefinement = false,
}) => {
  const topJobBullets = topJobs
    .slice(0, 3)
    .map(
      (job, index) =>
        `${index + 1}. ${job.title} at ${job.company} (${job.location}) - ${job.matchScore}%`,
    )
    .join('\n')

  const deterministicSummary = [
    isRefinement
      ? "I've refined your matches based on your latest instruction."
      : "I've completed a live job match based on your profile.",
    `Primary focus: ${profile.role || 'General software roles'}.`,
    `Top opportunities found: ${topJobs.length}.`,
    topJobBullets || 'No strong roles found yet.',
    '',
    `Prompt context: "${userPrompt}"`,
  ].join('\n')

  if (!vertexClient || topJobs.length === 0) {
    return deterministicSummary
  }

  try {
    const startedAt = Date.now()
    const summaryPrompt = `
Create a concise assistant message for a hiring copilot.
Context:
- User prompt: ${userPrompt}
- Extracted profile: ${JSON.stringify(profile)}
- Top jobs: ${JSON.stringify(topJobs.slice(0, 5))}

Constraints:
- Max 120 words
- Tone: professional and helpful
- Mention 3 strongest role fits
- Do not use markdown symbols like *, **, or headings
- Keep output plain conversational text
`

    const text = await generateWithVertex({
      promptPayload: summaryPrompt,
      label: 'generateAssistantSummary',
      expectJson: false,
    })
    debugLog('assistant summary generated', {
      elapsedMs: Date.now() - startedAt,
      hasText: Boolean(text),
    })
    return text || deterministicSummary
  } catch (error) {
    debugLog('assistant summary fallback', {
      reason: error.message,
    })
    return deterministicSummary
  }
}

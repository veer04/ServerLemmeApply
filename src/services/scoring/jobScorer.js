import { getEmbedding, normalizeEmbeddingInput } from '../../utils/embedding.js'
import { cosineSimilarity as vectorCosineSimilarity } from '../../utils/similarity.js'
import { env } from '../../config/environment.js'

const MATCH_THRESHOLD = 50
const clampScore = (value) => Math.max(0, Math.min(100, Number(value) || 0))
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const sigmoid = (value, steepness = 1) => 1 / (1 + Math.exp(-steepness * Number(value || 0)))

const isEnvDisabled = (value) => ['0', 'false', 'no', 'off'].includes(String(value || '').toLowerCase())
const isEnvEnabled = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback
  return !isEnvDisabled(value)
}
const ENABLE_ADAPTIVE_SCORING = isEnvEnabled(process.env.ADAPTIVE_SCORING_V2, true)
const ENABLE_ADAPTIVE_THRESHOLD = isEnvEnabled(process.env.ADAPTIVE_THRESHOLD_V2, true)
const ENABLE_VERBOSE_SCORE_DEBUG = isEnvEnabled(process.env.JOB_SCORE_VERBOSE, false)
const isScoringDebugEnabled = Boolean(env.jobDebugEnabled)

const toSortedFiniteNumbers = (values) =>
  (Array.isArray(values) ? values : [])
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .sort((left, right) => left - right)

const percentile = (values, percentileValue) => {
  const sorted = toSortedFiniteNumbers(values)
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]

  const normalizedPercentile = Math.max(0, Math.min(100, Number(percentileValue) || 0))
  const rank = (normalizedPercentile / 100) * (sorted.length - 1)
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  if (lowerIndex === upperIndex) return sorted[lowerIndex]

  const weight = rank - lowerIndex
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight
}

const percentileRank = (values, value) => {
  const sorted = toSortedFiniteNumbers(values)
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] <= value ? 1 : 0

  const target = Number(value)
  if (!Number.isFinite(target)) return 0
  let lessOrEqual = 0
  for (const entry of sorted) {
    if (entry <= target) lessOrEqual += 1
  }
  return clamp01(lessOrEqual / sorted.length)
}

const normalizeWeights = (weights) => {
  const total = Object.values(weights).reduce(
    (sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0),
    0,
  )
  if (total <= 0) {
    return {
      semantic: 0.35,
      skills: 0.30,
      experience: 0.15,
      location: 0.10,
      salary: 0.10,
    }
  }

  return {
    semantic: weights.semantic / total,
    skills: weights.skills / total,
    experience: weights.experience / total,
    location: weights.location / total,
    salary: weights.salary / total,
  }
}

const normalizeScoreWithDistribution = (score, scoreDistribution) => {
  if (!ENABLE_ADAPTIVE_SCORING) return score

  const values = toSortedFiniteNumbers(scoreDistribution)
  if (values.length < 5) return score

  const p10 = percentile(values, 10)
  const p90 = percentile(values, 90)
  const spread = Math.max(1e-6, p90 - p10)
  const normalized = ((Number(score) - p10) / spread) * 80 + 10
  return clampScore(normalized)
}

const rounded = (value, precision = 3) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(numeric.toFixed(precision))
}

const buildDistributionStats = (values) => {
  const sorted = toSortedFiniteNumbers(values)
  if (sorted.length === 0) {
    return {
      count: 0,
      min: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      max: 0,
      mean: 0,
    }
  }

  const sum = sorted.reduce((accumulator, score) => accumulator + score, 0)
  return {
    count: sorted.length,
    min: rounded(sorted[0]),
    p25: rounded(percentile(sorted, 25)),
    p50: rounded(percentile(sorted, 50)),
    p75: rounded(percentile(sorted, 75)),
    p90: rounded(percentile(sorted, 90)),
    max: rounded(sorted[sorted.length - 1]),
    mean: rounded(sum / sorted.length),
  }
}

const logScoringBatchSummary = ({
  label = 'score-batch',
  semanticScores = [],
  preliminaryScores = [],
  finalScores = [],
  threshold = null,
  shortlistedCount = null,
}) => {
  if (!isScoringDebugEnabled) return

  console.log('[job-scorer] distribution summary', {
    label,
    adaptiveScoring: ENABLE_ADAPTIVE_SCORING,
    adaptiveThreshold: ENABLE_ADAPTIVE_THRESHOLD,
    semantic: buildDistributionStats(semanticScores),
    preliminary: buildDistributionStats(preliminaryScores),
    final: buildDistributionStats(finalScores),
    threshold: Number.isFinite(Number(threshold)) ? rounded(threshold, 2) : null,
    shortlistedCount: Number.isFinite(Number(shortlistedCount)) ? Number(shortlistedCount) : null,
  })
}

/** STEP 11: in-memory reuse; stripped before API responses (see scoreJobForProfile). */
const JOB_EMBEDDING_VECTOR = '_embeddingVector'
const JOB_EMBEDDING_TEXT_KEY = '_embeddingJobTextNorm'

export const SKILL_MAP = {
  js: 'javascript',
  node: 'nodejs',
  'node.js': 'nodejs',
  reactjs: 'react',
  nextjs: 'next.js',
  mongodb: 'mongo',
}

export const normalizeSkill = (skill) => {
  const normalized = String(skill || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')

  if (!normalized) return ''
  return SKILL_MAP[normalized] || normalized
}

const STOPWORDS = new Set(
  [
    'and',
    'the',
    'with',
    'team',
    'work',
    'experience',
    'good',
    'role',
    'job',
    'jobs',
    'ability',
    'strong',
    'knowledge',
    'developer',
    'engineer',
  ].map((word) => normalizeSkill(word)),
)

const SHORT_SKILL_TOKENS = new Set(['go', 'c', 'r', 'ai', 'ml', 'qa', 'ui', 'ux', 'nlp', 'cv'])

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const removeNoise = (value) => {
  return normalizeText(value)
    .replace(/\b(not specified|not disclosed|n\/a|na|unknown)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const joinTextParts = (parts) =>
  parts
    .flatMap((part) => {
      if (Array.isArray(part)) return part
      return [part]
    })
    .map((part) => removeNoise(part))
    .filter(Boolean)
    .join(' ')

const tokenize = (value) =>
  String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9+.]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2 || SHORT_SKILL_TOKENS.has(part))

const currencyToInr = (amount, currency) => {
  const numeric = Number(amount || 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  const normalizedCurrency = String(currency || 'INR').trim().toUpperCase()
  if (normalizedCurrency === 'USD') return numeric * 83
  if (normalizedCurrency === 'EUR') return numeric * 90
  if (normalizedCurrency === 'GBP') return numeric * 105
  return numeric
}

const normalizeCompensationToLpa = ({ amount, currency = 'INR', type = 'LPA' }) => {
  const numeric = Number(amount || 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0

  const normalizedType = String(type || 'LPA').toLowerCase()
  if (/lpa|lakh/.test(normalizedType)) {
    const yearlyInr = currencyToInr(numeric * 100000, currency)
    return yearlyInr / 100000
  }

  if (/monthly|month/.test(normalizedType)) {
    const yearlyInr = currencyToInr(numeric * 12, currency)
    return yearlyInr / 100000
  }

  // Treat yearly/annual/CTC as yearly amount in selected currency.
  const yearlyInr = currencyToInr(numeric, currency)
  return yearlyInr / 100000
}

const bagOfWords = (tokens) => {
  const bag = new Map()
  for (const token of tokens) {
    bag.set(token, (bag.get(token) || 0) + 1)
  }
  return bag
}

const tokenCosineSimilarity = (leftText, rightText) => {
  const leftBag = bagOfWords(tokenize(leftText))
  const rightBag = bagOfWords(tokenize(rightText))
  if (leftBag.size === 0 || rightBag.size === 0) return 0

  let dotProduct = 0
  let leftMagnitude = 0
  let rightMagnitude = 0

  for (const [, value] of leftBag) {
    leftMagnitude += value * value
  }

  for (const [token, rightValue] of rightBag) {
    rightMagnitude += rightValue * rightValue
    if (leftBag.has(token)) {
      dotProduct += rightValue * leftBag.get(token)
    }
  }

  if (!leftMagnitude || !rightMagnitude) return 0
  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

const parseSalaryLpa = (salaryText) => {
  const text = String(salaryText || '').toLowerCase()
  const matches = [...text.matchAll(/(\d+(\.\d+)?)\s*(lpa|lakh|lakhs)/g)]
  if (matches.length > 0) {
    return Math.max(...matches.map((match) => Number(match[1])))
  }

  // Parse USD/EUR/GBP yearly salary and convert to INR LPA approximation.
  const yearlyUsdMatch = text.match(
    /(\$|usd)\s?(\d[\d,]*(\.\d+)?)\s*(k|m|million)?\s*(per\s*year|\/\s*year|yearly|annually)?/i,
  )
  const yearlyEurMatch = text.match(
    /(€|eur)\s?(\d[\d,]*(\.\d+)?)\s*(k|m|million)?\s*(per\s*year|\/\s*year|yearly|annually)?/i,
  )
  const yearlyGbpMatch = text.match(
    /(£|gbp)\s?(\d[\d,]*(\.\d+)?)\s*(k|m|million)?\s*(per\s*year|\/\s*year|yearly|annually)?/i,
  )

  const normalizeLargeUnit = (value, unit) => {
    const numeric = Number(String(value || '').replace(/,/g, ''))
    if (!Number.isFinite(numeric)) return null
    if (String(unit || '').toLowerCase() === 'k') return numeric * 1000
    if (/(m|million)/i.test(String(unit || ''))) return numeric * 1000000
    return numeric
  }

  const convertCurrencyToInr = (amount, currency) => {
    if (!amount) return null
    if (currency === 'usd') return amount * 83
    if (currency === 'eur') return amount * 90
    if (currency === 'gbp') return amount * 105
    return amount
  }

  const convertYearlyForeignToLpa = (match, currency) => {
    if (!match) return null
    const yearlyAmount = normalizeLargeUnit(match[2], match[4])
    const inrAmount = convertCurrencyToInr(yearlyAmount, currency)
    if (!inrAmount) return null
    return inrAmount / 100000
  }

  return (
    convertYearlyForeignToLpa(yearlyUsdMatch, 'usd') ||
    convertYearlyForeignToLpa(yearlyEurMatch, 'eur') ||
    convertYearlyForeignToLpa(yearlyGbpMatch, 'gbp') ||
    null
  )
}

const parseRequiredExperience = (description) => {
  const match = String(description || '').match(/(\d+)\s*\+?\s*(years?|yrs?)/i)
  return match ? Number(match[1]) : null
}

const skillMatchPercentage = (candidateSkills, jobSkills, { primary = false } = {}) => {
  if (!Array.isArray(jobSkills) || jobSkills.length === 0) return 0.6

  const normalizedJobSkills = [...new Set(jobSkills.map((skill) => normalizeSkill(skill)).filter(Boolean))]
  const normalizedCandidateSkills = [...new Set((candidateSkills || []).map((skill) => normalizeSkill(skill)).filter(Boolean))]

  if (normalizedCandidateSkills.length === 0) {
    // Keep neutral when profile is sparse, but avoid a hard fixed floor.
    const richness = Math.min(1, normalizedJobSkills.length / 16)
    return 0.35 + richness * 0.3
  }

  let weightedMatches = 0
  for (const jobSkill of normalizedJobSkills) {
    const exactMatch = normalizedCandidateSkills.some((candidateSkill) => candidateSkill === jobSkill)
    if (exactMatch) {
      weightedMatches += 1
      continue
    }

    const partialMatch = normalizedCandidateSkills.some((candidateSkill) => {
      return candidateSkill.includes(jobSkill) || jobSkill.includes(candidateSkill)
    })
    if (partialMatch) {
      weightedMatches += 0.65
    }
  }

  // Coverage should be measured against job requirement breadth.
  const coverageScore = weightedMatches / normalizedJobSkills.length
  const primaryBoost = primary ? 1.12 : 1
  return Math.min(1, coverageScore * primaryBoost)
}

const extractJobSkills = (job) => {
  const rawSkillText = [...(job.skillsRequired || []), ...(job.requiredSkills || [])]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join(' ')

  const textTokens = tokenize(`${job.title} ${job.description} ${rawSkillText}`)
  const normalizedTokens = textTokens
    .map((token) => normalizeSkill(token))
    .filter(Boolean)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !/^\d+$/.test(token))

  return [...new Set(normalizedTokens)]
}

export const buildProfileText = (profile) => {
  if (!profile) return ''

  const roleText = joinTextParts([profile.role, profile.targetRole, profile.roleTitle])
  const seniorityText = joinTextParts([profile.seniorityLevel, profile.seniority])
  const primarySkillsText = joinTextParts(profile.primarySkills || profile.skills || [])
  const secondarySkillsText = joinTextParts(profile.secondarySkills || [])
  const experienceText = joinTextParts([
    profile.experience,
    Number.isFinite(Number(profile.experienceYears))
      ? `${Number(profile.experienceYears)} years experience`
      : '',
  ])
  const locationText = joinTextParts([
    profile.locationPreference,
    profile.remotePreference ? 'remote preferred' : '',
  ])
  const compensationText = joinTextParts([
    Number(profile.salaryExpectation?.min || 0)
      ? `${Number(profile.salaryExpectation.min)} ${String(profile.salaryExpectation?.type || 'LPA')}`
      : '',
    Number(profile.salaryExpectation?.max || 0)
      ? `${Number(profile.salaryExpectation.max)} ${String(profile.salaryExpectation?.type || 'LPA')}`
      : '',
    String(profile.salaryExpectation?.currency || 'INR'),
  ])

  return joinTextParts([
    roleText,
    seniorityText,
    `primary skills ${primarySkillsText}`,
    `secondary skills ${secondarySkillsText}`,
    experienceText,
    locationText,
    compensationText,
  ])
}

export const buildJobText = (job) => {
  if (!job) return ''

  const titleText = joinTextParts([job.title, job.role])
  const companyText = joinTextParts([job.company])
  const locationText = joinTextParts([job.location, job.workMode])
  const compensationText = joinTextParts([job.salary])
  const descriptionText = joinTextParts([job.description, job.summary, job.responsibilities])
  const requiredSkillsText = joinTextParts(job.skillsRequired || job.requiredSkills || [])

  return joinTextParts([
    titleText,
    companyText,
    locationText,
    descriptionText,
    `required skills ${requiredSkillsText}`,
    `compensation ${compensationText}`,
  ])
}

const isValidEmbeddingVector = (vector) =>
  Array.isArray(vector) && vector.length > 0

/**
 * STEP 10: Embedding-first semantic score; on any failure or invalid vectors,
 * fall back to token-based cosine (same 0–1 range) so scoring never breaks.
 * STEP 11: Reuse job vectors from `getEmbedding` cache + optional fields on `job`
 * so the same job is not embedded repeatedly across refinements / re-scores.
 */
const resolveJobEmbeddingVector = async (job, jobText, options = {}) => {
  if (options.jobEmbedding !== undefined) {
    return options.jobEmbedding
  }

  const textKey = normalizeEmbeddingInput(jobText)

  if (
    job &&
    typeof job === 'object' &&
    isValidEmbeddingVector(job[JOB_EMBEDDING_VECTOR]) &&
    job[JOB_EMBEDDING_TEXT_KEY] === textKey
  ) {
    return job[JOB_EMBEDDING_VECTOR]
  }

  const vector = await getEmbedding(jobText)

  const shouldAttach =
    options.attachJobEmbedding !== false &&
    job &&
    typeof job === 'object' &&
    isValidEmbeddingVector(vector)

  if (shouldAttach) {
    job[JOB_EMBEDDING_VECTOR] = vector
    job[JOB_EMBEDDING_TEXT_KEY] = textKey
  }

  return vector
}

const semanticTitleSimilarity = async (job, profile, options = {}) => {
  const profileText = buildProfileText(profile)
  const jobText = buildJobText(job)

  const profileEmbedding =
    options.profileEmbedding !== undefined
      ? options.profileEmbedding
      : await getEmbedding(profileText)

  const jobEmbedding = await resolveJobEmbeddingVector(job, jobText, options)

  if (
    isValidEmbeddingVector(profileEmbedding) &&
    isValidEmbeddingVector(jobEmbedding) &&
    profileEmbedding.length === jobEmbedding.length
  ) {
    const semanticScore = vectorCosineSimilarity(profileEmbedding, jobEmbedding)
    if (Number.isFinite(semanticScore)) return semanticScore
  }

  return tokenCosineSimilarity(profileText, jobText)
}

const calibrateSemanticScore = (semanticScore, semanticCalibrationContext = {}) => {
  const safeSemanticScore = clamp01(semanticScore)
  if (!ENABLE_ADAPTIVE_SCORING) {
    if (!Number.isFinite(semanticScore) || semanticScore <= 0) return 0
    if (semanticScore < 0.3) return semanticScore * 0.5
    if (semanticScore < 0.5) return semanticScore * 1.2
    return semanticScore * 1.5
  }

  const semanticDistribution = semanticCalibrationContext?.semanticScores || []
  if (Array.isArray(semanticDistribution) && semanticDistribution.length >= 4) {
    const relativeRank = percentileRank(semanticDistribution, safeSemanticScore)
    return clamp01(relativeRank * 0.65 + safeSemanticScore * 0.35)
  }

  // No batch context available (e.g., live streaming) — keep score stable.
  return safeSemanticScore
}

const experienceAlignment = (job, profile) => {
  const requiredExperience =
    parseRequiredExperience(job.title) ?? parseRequiredExperience(job.description)
  const candidateExperience = Number(profile.experienceYears || 0)
  if (!requiredExperience) return 0.62

  if (!ENABLE_ADAPTIVE_SCORING) {
    if (candidateExperience >= requiredExperience) return 1
    if (candidateExperience + 1 >= requiredExperience) return 0.8
    if (candidateExperience + 2 >= requiredExperience) return 0.6
    return 0.2
  }

  const experienceGap = candidateExperience - requiredExperience
  return clamp01(0.25 + 0.75 * sigmoid(experienceGap, 1.6))
}

const locationAlignment = (job, profile) => {
  const jobLocation = String(job.location || '').toLowerCase()
  const preference = String(profile.locationPreference || '').toLowerCase()
  const remotePreference = Boolean(profile.remotePreference)

  if (!preference && !remotePreference) return 0.62

  if (!ENABLE_ADAPTIVE_SCORING) {
    if (remotePreference && /remote|anywhere|work from home/.test(jobLocation)) return 1
    if (preference && jobLocation.includes(preference)) return 1
    if (!remotePreference && /hybrid|onsite|on-site/.test(jobLocation)) return 0.7
    return 0.3
  }

  if (remotePreference) {
    if (/remote|anywhere|work from home/.test(jobLocation)) return 1
    if (/hybrid/.test(jobLocation)) return 0.74
    return 0.45
  }

  if (preference) {
    if (jobLocation.includes(preference)) return 1

    const preferenceTokens = preference.split(/[^a-z0-9]+/).filter((token) => token.length > 2)
    const overlap = preferenceTokens.some((token) => jobLocation.includes(token))
    if (overlap) return 0.78

    if (/remote|anywhere|work from home/.test(jobLocation)) return 0.6
    if (/hybrid|onsite|on-site/.test(jobLocation)) return 0.68
    return 0.4
  }

  return 0.5
}

const salaryAlignment = (job, profile) => {
  const expected = profile.salaryExpectation || {}
  const expectedCurrency = String(expected.currency || 'INR').toUpperCase()
  const expectedType = String(expected.type || 'LPA')
  const expectedMin = normalizeCompensationToLpa({
    amount: expected.min,
    currency: expectedCurrency,
    type: expectedType,
  })
  const expectedMax = normalizeCompensationToLpa({
    amount: expected.max,
    currency: expectedCurrency,
    type: expectedType,
  })
  if (!expectedMin && !expectedMax) return 0.62

  const offered = parseSalaryLpa(job.salary)
  if (!offered) return 0.58

  if (!ENABLE_ADAPTIVE_SCORING) {
    if (expectedMin && offered < expectedMin * 0.8) return 0.2
    if (expectedMax && offered > expectedMax * 1.35) return 0.6
    if (expectedMin && offered >= expectedMin) return 1
    if (expectedMin && offered >= expectedMin * 0.9) return 0.85
    return 0.6
  }

  const lowerBound = expectedMin || expectedMax * 0.8
  const upperBound = expectedMax || expectedMin * 1.25
  if (!lowerBound && !upperBound) return 0.62

  if (offered >= lowerBound && offered <= upperBound) return 1

  if (offered < lowerBound) {
    const deviationRatio = (lowerBound - offered) / Math.max(lowerBound, 1)
    return clamp01(Math.max(0.2, 1 - deviationRatio * 1.4))
  }

  const deviationRatio = (offered - upperBound) / Math.max(upperBound, 1)
  return clamp01(Math.max(0.35, 0.95 - deviationRatio * 0.8))
}

const getPenaltyScore = ({
  job,
  profile,
  normalizedJobSkills,
  normalizedPrimarySkills,
  semanticScore,
}) => {
  const title = String(job?.title || '').toLowerCase()
  const experienceYears = Number(profile?.experienceYears || 0)
  const requiredExperience =
    parseRequiredExperience(job?.title || '') ?? parseRequiredExperience(job?.description || '') ?? 0

  const primarySet = new Set((normalizedPrimarySkills || []).filter(Boolean))
  const missingCriticalSkills = [...primarySet].filter((skill) => {
    return !normalizedJobSkills.some(
      (jobSkill) => jobSkill === skill || jobSkill.includes(skill) || skill.includes(jobSkill),
    )
  })
  const missingCriticalRatio = primarySet.size > 0 ? missingCriticalSkills.length / primarySet.size : 0

  if (!ENABLE_ADAPTIVE_SCORING) {
    let legacyPenalty = 0

    if (/\b(senior|lead|principal|staff|manager|architect)\b/.test(title) && experienceYears < 2) {
      legacyPenalty += 15
    }
    if (primarySet.size > 0 && missingCriticalSkills.length > 0) {
      legacyPenalty += Math.min(14, Math.round(10 * missingCriticalRatio + 2))
    }
    if (semanticScore < 0.15) {
      legacyPenalty += 20
    }
    return legacyPenalty
  }

  const semanticGap = Math.max(0, 0.55 - clamp01(semanticScore))
  const semanticPenalty = Math.pow(semanticGap, 1.6) * (8 + 12 * missingCriticalRatio)
  const seniorityPenalty = Math.max(0, requiredExperience - experienceYears - 1) * 2.5
  const titleMismatchPenalty =
    /\b(senior|lead|principal|staff|manager|architect)\b/.test(title) && experienceYears < 2 ? 4 : 0

  return Math.min(25, Math.max(0, semanticPenalty + seniorityPenalty + titleMismatchPenalty))
}

export const getWeights = (profile, signalContext = {}) => {
  if (!ENABLE_ADAPTIVE_SCORING) {
    const experienceYears = Number(profile?.experienceYears || 0)

    // Fresher / junior profiles: emphasize transferable skill fit.
    if (experienceYears <= 1) {
      return {
        semantic: 0.25,
        skills: 0.40,
        experience: 0.12,
        location: 0.12,
        salary: 0.11,
      }
    }

    // Mid/senior profiles: semantic role fit + experience alignment matter more.
    if (experienceYears > 3) {
      return {
        semantic: 0.40,
        skills: 0.25,
        experience: 0.18,
        location: 0.09,
        salary: 0.08,
      }
    }

    // Balanced defaults for early-mid profiles.
    return {
      semantic: 0.35,
      skills: 0.30,
      experience: 0.15,
      location: 0.10,
      salary: 0.10,
    }
  }

  const experienceYears = Number(profile?.experienceYears || 0)
  const hasLocationPreference =
    Boolean(String(profile?.locationPreference || '').trim()) || Boolean(profile?.remotePreference)
  const salaryExpectation = profile?.salaryExpectation || {}
  const hasSalaryPreference =
    Number(salaryExpectation.min || 0) > 0 || Number(salaryExpectation.max || 0) > 0
  const hasSkillsSignal = Boolean(signalContext?.hasSkillsSignal)
  const hasExperienceSignal = Boolean(signalContext?.requiredExperience)

  const dynamicWeights = {
    semantic: 0.34,
    skills: hasSkillsSignal ? 0.34 : 0.24,
    experience: hasExperienceSignal ? 0.14 : 0.08,
    location: hasLocationPreference ? 0.10 : 0,
    salary: hasSalaryPreference ? 0.08 : 0,
  }

  // Junior profile: emphasize skills more strongly.
  if (experienceYears <= 1) {
    dynamicWeights.skills += 0.04
    dynamicWeights.semantic -= 0.02
    dynamicWeights.experience -= 0.02
  }

  // Senior profile: semantics + experience carry more weight.
  if (experienceYears >= 5) {
    dynamicWeights.semantic += 0.04
    dynamicWeights.experience += 0.02
    dynamicWeights.skills -= 0.04
    dynamicWeights.salary -= 0.02
  }

  return normalizeWeights(dynamicWeights)
}

export const scoreJobForProfile = async (job, profile, options = {}) => {
  const normalizedJobSkills = extractJobSkills(job)
  const normalizedPrimarySkills = (profile.primarySkills || []).map((skill) => normalizeSkill(skill))
  const normalizedSecondarySkills = (profile.secondarySkills || []).map((skill) => normalizeSkill(skill))

  const semanticScore = Number.isFinite(Number(options.semanticScore))
    ? clamp01(options.semanticScore)
    : await semanticTitleSimilarity(job, profile, options)
  const calibratedSemanticScore = calibrateSemanticScore(
    semanticScore,
    options.semanticCalibrationContext || {},
  )
  const primarySkillsScore = skillMatchPercentage(normalizedPrimarySkills, normalizedJobSkills, {
    primary: true,
  })
  const secondarySkillsScore = skillMatchPercentage(
    normalizedSecondarySkills,
    normalizedJobSkills,
    { primary: false },
  )
  const requiredExperience =
    parseRequiredExperience(job?.title || '') ?? parseRequiredExperience(job?.description || '')
  const experienceScore = experienceAlignment(job, profile)
  const locationScore = locationAlignment(job, profile)
  const salaryScore = salaryAlignment(job, profile)
  const weights = getWeights(profile, {
    hasSkillsSignal: normalizedPrimarySkills.length > 0 || normalizedSecondarySkills.length > 0,
    requiredExperience,
  })
  const combinedSkillScore =
    ENABLE_ADAPTIVE_SCORING && normalizedSecondarySkills.length === 0
      ? primarySkillsScore
      : primarySkillsScore * 0.85 + secondarySkillsScore * 0.15
  const penalty = getPenaltyScore({
    job,
    profile,
    normalizedJobSkills,
    normalizedPrimarySkills,
    semanticScore,
  })

  const finalScoreRaw =
    calibratedSemanticScore * weights.semantic * 100 +
    combinedSkillScore * weights.skills * 100 +
    experienceScore * weights.experience * 100 +
    locationScore * weights.location * 100 +
    salaryScore * weights.salary * 100 -
    penalty

  const legacyNormalizedScore =
    finalScoreRaw < 40 ? finalScoreRaw * 1.2 : finalScoreRaw < 70 ? finalScoreRaw * 1.1 : finalScoreRaw
  const preDistributionScore = ENABLE_ADAPTIVE_SCORING ? finalScoreRaw : legacyNormalizedScore
  const normalizedScore = normalizeScoreWithDistribution(
    preDistributionScore,
    options.scoreDistribution || [],
  )

  const finalScore = Math.round(clampScore(normalizedScore))

  if (isScoringDebugEnabled && ENABLE_VERBOSE_SCORE_DEBUG) {
    const skillScore = combinedSkillScore
    console.log({
      semanticScore,
      calibratedSemanticScore,
      skillScore,
      penalty,
      preDistributionScore,
      finalScore,
    })
  }

  const {
    [JOB_EMBEDDING_VECTOR]: _dropVec,
    [JOB_EMBEDDING_TEXT_KEY]: _dropKey,
    ...jobPublic
  } = job

  return {
    ...jobPublic,
    skillsRequired: normalizedJobSkills.slice(0, 20),
    matchScore: finalScore,
    matchReasons: [
      `Role similarity: ${Math.round(semanticScore * 100)}%`,
      `Primary skill overlap: ${Math.round(primarySkillsScore * 100)}%`,
      `Secondary skill overlap: ${Math.round(secondarySkillsScore * 100)}%`,
      `Experience alignment: ${Math.round(experienceScore * 100)}%`,
      `Location alignment: ${Math.round(locationScore * 100)}%`,
      `Salary alignment: ${Math.round(salaryScore * 100)}%`,
      `Penalty applied: -${Math.round(penalty)}`,
    ],
  }
}

const buildScoredJobsWithSemanticContext = async (jobs, profile, context = {}) => {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    logScoringBatchSummary({
      label: context.label || 'score-batch-empty',
      semanticScores: [],
      preliminaryScores: [],
      finalScores: [],
    })
    return []
  }

  const profileText = buildProfileText(profile)
  const profileEmbedding = await getEmbedding(profileText)
  const semanticScores = await Promise.all(
    jobs.map((job) => semanticTitleSimilarity(job, profile, { profileEmbedding })),
  )
  const semanticCalibrationContext = { semanticScores }

  const preliminarilyScored = await Promise.all(
    jobs.map((job, index) =>
      scoreJobForProfile(job, profile, {
        profileEmbedding,
        semanticScore: semanticScores[index],
        semanticCalibrationContext,
      }),
    ),
  )

  if (!ENABLE_ADAPTIVE_SCORING) {
    logScoringBatchSummary({
      label: context.label || 'score-batch-legacy',
      semanticScores,
      preliminaryScores: preliminarilyScored.map((job) => Number(job.matchScore || 0)),
      finalScores: preliminarilyScored.map((job) => Number(job.matchScore || 0)),
    })
    return preliminarilyScored
  }

  const distribution = preliminarilyScored.map((job) => Number(job.matchScore || 0))
  const normalized = preliminarilyScored.map((job) => ({
    ...job,
    matchScore: Math.round(normalizeScoreWithDistribution(job.matchScore, distribution)),
  }))

  logScoringBatchSummary({
    label: context.label || 'score-batch-adaptive',
    semanticScores,
    preliminaryScores: distribution,
    finalScores: normalized.map((job) => Number(job.matchScore || 0)),
  })

  return normalized
}

export const rankJobsForProfile = async (jobs, profile) => {
  const scored = await buildScoredJobsWithSemanticContext(jobs, profile, { label: 'rank-jobs' })
  const averageScore =
    scored.length > 0
      ? scored.reduce((sum, job) => sum + Number(job.matchScore || 0), 0) / scored.length
      : MATCH_THRESHOLD
  const dynamicThreshold = Math.max(35, Math.round(percentile(scored.map((job) => job.matchScore), 60)))
  const threshold = ENABLE_ADAPTIVE_THRESHOLD
    ? dynamicThreshold
    : Math.max(40, Math.round(averageScore - 5))

  let shortlisted = scored
    .filter((job) => job.matchScore >= threshold)
    .sort((left, right) => right.matchScore - left.matchScore)

  if (ENABLE_ADAPTIVE_THRESHOLD && shortlisted.length < Math.min(5, scored.length)) {
    shortlisted = [...scored].sort((left, right) => right.matchScore - left.matchScore).slice(0, 5)
  }

  logScoringBatchSummary({
    label: 'rank-jobs-final',
    semanticScores: [],
    preliminaryScores: scored.map((job) => Number(job.matchScore || 0)),
    finalScores: shortlisted.map((job) => Number(job.matchScore || 0)),
    threshold,
    shortlistedCount: shortlisted.length,
  })

  return shortlisted
}

export const scoreAllJobs = async (jobs, profile) => {
  const scored = await buildScoredJobsWithSemanticContext(jobs, profile, { label: 'score-all-jobs' })
  return scored.sort((left, right) => right.matchScore - left.matchScore)
}

export const matchThreshold = MATCH_THRESHOLD

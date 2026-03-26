import { getEmbedding, normalizeEmbeddingInput } from '../../utils/embedding.js'
import { cosineSimilarity as vectorCosineSimilarity } from '../../utils/similarity.js'

const MATCH_THRESHOLD = 50
const clampScore = (value) => Math.max(0, Math.min(100, Number(value) || 0))

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
    .filter((part) => part.length > 2)

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

  const currencyToInr = (amount, currency) => {
    if (!amount) return null
    if (currency === 'usd') return amount * 83
    if (currency === 'eur') return amount * 90
    if (currency === 'gbp') return amount * 105
    return amount
  }

  const convertYearlyForeignToLpa = (match, currency) => {
    if (!match) return null
    const yearlyAmount = normalizeLargeUnit(match[2], match[4])
    const inrAmount = currencyToInr(yearlyAmount, currency)
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

  return joinTextParts([
    roleText,
    seniorityText,
    `primary skills ${primarySkillsText}`,
    `secondary skills ${secondarySkillsText}`,
    experienceText,
  ])
}

export const buildJobText = (job) => {
  if (!job) return ''

  const titleText = joinTextParts([job.title, job.role])
  const descriptionText = joinTextParts([job.description, job.summary, job.responsibilities])
  const requiredSkillsText = joinTextParts(job.skillsRequired || job.requiredSkills || [])

  return joinTextParts([
    titleText,
    descriptionText,
    `required skills ${requiredSkillsText}`,
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

const calibrateSemanticScore = (semanticScore) => {
  if (!Number.isFinite(semanticScore) || semanticScore <= 0) return 0
  if (semanticScore < 0.3) return semanticScore * 0.5
  if (semanticScore < 0.5) return semanticScore * 1.2
  return semanticScore * 1.5
}

const experienceAlignment = (job, profile) => {
  const requiredExperience =
    parseRequiredExperience(job.title) ?? parseRequiredExperience(job.description)
  const candidateExperience = Number(profile.experienceYears || 0)
  if (!requiredExperience) return 0.6
  if (candidateExperience >= requiredExperience) return 1
  if (candidateExperience + 1 >= requiredExperience) return 0.8
  if (candidateExperience + 2 >= requiredExperience) return 0.6
  return 0.2
}

const locationAlignment = (job, profile) => {
  const jobLocation = String(job.location || '').toLowerCase()
  const preference = String(profile.locationPreference || '').toLowerCase()
  const remotePreference = Boolean(profile.remotePreference)

  if (!preference && !remotePreference) return 0.6
  if (remotePreference && /remote|anywhere|work from home/.test(jobLocation)) return 1
  if (preference && jobLocation.includes(preference)) return 1
  if (!remotePreference && /hybrid|onsite|on-site/.test(jobLocation)) return 0.7
  return 0.3
}

const salaryAlignment = (job, profile) => {
  const expected = profile.salaryExpectation || {}
  const expectedMin = Number(expected.min || 0)
  const expectedMax = Number(expected.max || 0)
  if (!expectedMin && !expectedMax) return 0.6

  const offered = parseSalaryLpa(job.salary)
  if (!offered) return 0.55

  if (expectedMin && offered < expectedMin * 0.8) return 0.2
  if (expectedMax && offered > expectedMax * 1.35) return 0.6
  if (expectedMin && offered >= expectedMin) return 1
  if (expectedMin && offered >= expectedMin * 0.9) return 0.85
  return 0.6
}

const getPenaltyScore = ({
  job,
  profile,
  normalizedJobSkills,
  normalizedPrimarySkills,
  semanticScore,
}) => {
  let penalty = 0

  const title = String(job?.title || '').toLowerCase()
  const experienceYears = Number(profile?.experienceYears || 0)

  // Case 1: Senior role but low experience.
  if (/\b(senior|lead|principal|staff|manager|architect)\b/.test(title) && experienceYears < 2) {
    penalty += 15
  }

  // Case 2: Missing critical skills from user's primary skill set.
  const primarySet = new Set((normalizedPrimarySkills || []).filter(Boolean))
  const missingCriticalSkills = [...primarySet].filter((skill) => {
    return !normalizedJobSkills.some(
      (jobSkill) => jobSkill === skill || jobSkill.includes(skill) || skill.includes(jobSkill),
    )
  })
  if (primarySet.size > 0 && missingCriticalSkills.length > 0) {
    const missRatio = missingCriticalSkills.length / primarySet.size
    penalty += Math.min(14, Math.round(10 * missRatio + 2))
  }

  // Case 3: Completely unrelated domain.
  if (semanticScore < 0.15) {
    penalty += 20
  }

  return penalty
}

export const getWeights = (profile) => {
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

export const scoreJobForProfile = async (job, profile, options = {}) => {
  const normalizedJobSkills = extractJobSkills(job)
  const normalizedPrimarySkills = (profile.primarySkills || []).map((skill) => normalizeSkill(skill))
  const normalizedSecondarySkills = (profile.secondarySkills || []).map((skill) => normalizeSkill(skill))

  const semanticScore = await semanticTitleSimilarity(job, profile, options)
  const calibratedSemanticScore = calibrateSemanticScore(semanticScore)
  const primarySkillsScore = skillMatchPercentage(normalizedPrimarySkills, normalizedJobSkills, {
    primary: true,
  })
  const secondarySkillsScore = skillMatchPercentage(
    normalizedSecondarySkills,
    normalizedJobSkills,
    { primary: false },
  )
  const experienceScore = experienceAlignment(job, profile)
  const locationScore = locationAlignment(job, profile)
  const salaryScore = salaryAlignment(job, profile)
  const weights = getWeights(profile)
  const combinedSkillScore = primarySkillsScore * 0.85 + secondarySkillsScore * 0.15
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

  const normalizedScore =
    finalScoreRaw < 40 ? finalScoreRaw * 1.2 : finalScoreRaw < 70 ? finalScoreRaw * 1.1 : finalScoreRaw

  const finalScore = Math.round(clampScore(normalizedScore))

  if (process.env.NODE_ENV === 'development') {
    const skillScore = combinedSkillScore
    console.log({
      semanticScore,
      calibratedSemanticScore,
      skillScore,
      penalty,
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

export const rankJobsForProfile = async (jobs, profile) => {
  const profileText = buildProfileText(profile)
  const profileEmbedding = await getEmbedding(profileText)
  const scored = await Promise.all(
    jobs.map((job) => scoreJobForProfile(job, profile, { profileEmbedding })),
  )
  const averageScore =
    scored.length > 0
      ? scored.reduce((sum, job) => sum + Number(job.matchScore || 0), 0) / scored.length
      : MATCH_THRESHOLD
  const threshold = Math.max(40, Math.round(averageScore - 5))

  return scored
    .filter((job) => job.matchScore >= threshold)
    .sort((left, right) => right.matchScore - left.matchScore)
}

export const scoreAllJobs = async (jobs, profile) => {
  const profileText = buildProfileText(profile)
  const profileEmbedding = await getEmbedding(profileText)
  const scored = await Promise.all(
    jobs.map((job) => scoreJobForProfile(job, profile, { profileEmbedding })),
  )
  return scored.sort((left, right) => right.matchScore - left.matchScore)
}

export const matchThreshold = MATCH_THRESHOLD

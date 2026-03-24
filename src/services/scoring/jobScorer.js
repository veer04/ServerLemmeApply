const MATCH_THRESHOLD = 70

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

const cosineSimilarity = (leftText, rightText) => {
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

const skillMatchPercentage = (candidateSkills, jobSkills) => {
  if (candidateSkills.length === 0) {
    // Keep neutral when profile is sparse, but avoid a hard fixed floor.
    const richness = Math.min(1, (jobSkills.length || 0) / 16)
    return 0.35 + richness * 0.3
  }

  const jobSkillSet = new Set(jobSkills.map((skill) => skill.toLowerCase()))
  const matches = candidateSkills.filter((skill) =>
    jobSkillSet.has(String(skill).toLowerCase()),
  )
  return matches.length / candidateSkills.length
}

const extractJobSkills = (job) => {
  const textTokens = tokenize(
    `${job.title} ${job.description} ${(job.skillsRequired || []).join(' ')}`,
  )
  return [...new Set(textTokens)]
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

export const scoreJobForProfile = (job, profile) => {
  const normalizedJobSkills = extractJobSkills(job)

  const titleSimilarity = cosineSimilarity(
    `${profile.role} ${profile.seniorityLevel}`,
    `${job.title} ${job.description}`,
  )
  const primarySkillsScore = skillMatchPercentage(profile.primarySkills || [], normalizedJobSkills)
  const secondarySkillsScore = skillMatchPercentage(
    profile.secondarySkills || [],
    normalizedJobSkills,
  )
  const experienceScore = experienceAlignment(job, profile)
  const locationScore = locationAlignment(job, profile)
  const salaryScore = salaryAlignment(job, profile)

  const weightedTotal =
    titleSimilarity * 30 +
    primarySkillsScore * 30 +
    secondarySkillsScore * 10 +
    experienceScore * 10 +
    locationScore * 10 +
    salaryScore * 10

  const finalScore = Math.round(Math.max(0, Math.min(100, weightedTotal)))

  return {
    ...job,
    skillsRequired: normalizedJobSkills.slice(0, 20),
    matchScore: finalScore,
    matchReasons: [
      `Role similarity: ${Math.round(titleSimilarity * 100)}%`,
      `Primary skill overlap: ${Math.round(primarySkillsScore * 100)}%`,
      `Secondary skill overlap: ${Math.round(secondarySkillsScore * 100)}%`,
      `Experience alignment: ${Math.round(experienceScore * 100)}%`,
      `Location alignment: ${Math.round(locationScore * 100)}%`,
      `Salary alignment: ${Math.round(salaryScore * 100)}%`,
    ],
  }
}

export const rankJobsForProfile = (jobs, profile) => {
  return jobs
    .map((job) => scoreJobForProfile(job, profile))
    .filter((job) => job.matchScore >= MATCH_THRESHOLD)
    .sort((left, right) => right.matchScore - left.matchScore)
}

export const scoreAllJobs = (jobs, profile) => {
  return jobs
    .map((job) => scoreJobForProfile(job, profile))
    .sort((left, right) => right.matchScore - left.matchScore)
}

export const matchThreshold = MATCH_THRESHOLD

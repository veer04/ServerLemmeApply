const ROLE_SIGNAL_REGEX =
  /\b(engineer|developer|architect|analyst|designer|manager|scientist|intern|devops|qa|sre|product|software|frontend|backend|full[\s-]?stack)\b/i

const NOISY_TITLE_REGEX =
  /help (center|centre)|skip to main content|sign in|join now|homehome|jobsjobs|studentsstudents|search results/i

const NOISY_LINK_REGEX =
  /linkedin\.com\/jobs\/search|glassdoor\..*\/Job\/.*SRCH_|careers\.google\.com\/jobs\/results\/?\?|\/help|\/support|\/privacy|\/terms|\/login|\/signup|\/register/i

const rounded = (value, precision = 3) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(numeric.toFixed(precision))
}

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))

const getHostFromUrl = (value) => {
  try {
    return new URL(String(value || '')).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

const hasRoleSignal = (job) => {
  const title = String(job?.title || '')
  const description = String(job?.description || '')
  return ROLE_SIGNAL_REGEX.test(title) || ROLE_SIGNAL_REGEX.test(description)
}

const computeQualityScore = (job) => {
  const title = String(job?.title || '').trim()
  const description = String(job?.description || '').trim()
  const applyLink = String(job?.applyLink || '').trim()
  const source = String(job?.source || '').trim()
  const location = String(job?.location || '').trim().toLowerCase()
  const salary = String(job?.salary || '').trim().toLowerCase()
  const roleSignal = hasRoleSignal(job)

  let score = 0
  if (title.length >= 4 && title.length <= 140) score += 0.22
  if (roleSignal) score += 0.22
  if (/^https?:\/\//i.test(applyLink)) score += 0.16
  if (description.length >= 180) score += 0.2
  else if (description.length >= 80) score += 0.12
  else if (description.length >= 30) score += 0.06
  if (location && location !== 'not specified') score += 0.08
  if (salary && salary !== 'not disclosed') score += 0.05
  if (source && getHostFromUrl(source)) score += 0.04

  if (NOISY_TITLE_REGEX.test(title)) score -= 0.4
  if (NOISY_LINK_REGEX.test(applyLink)) score -= 0.4
  if (!roleSignal) score -= 0.2

  return clamp01(score)
}

const buildDistribution = (scores) => {
  const sorted = (Array.isArray(scores) ? scores : [])
    .map((score) => Number(score))
    .filter((score) => Number.isFinite(score))
    .sort((left, right) => left - right)
  if (sorted.length === 0) {
    return {
      min: 0,
      median: 0,
      max: 0,
      mean: 0,
    }
  }

  const middle = sorted[Math.floor(sorted.length / 2)]
  const total = sorted.reduce((sum, score) => sum + score, 0)
  return {
    min: rounded(sorted[0]),
    median: rounded(middle),
    max: rounded(sorted[sorted.length - 1]),
    mean: rounded(total / sorted.length),
  }
}

const percentile = (scores, percentileValue) => {
  const sorted = (Array.isArray(scores) ? scores : [])
    .map((score) => Number(score))
    .filter((score) => Number.isFinite(score))
    .sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]

  const boundedPercentile = Math.max(0, Math.min(100, Number(percentileValue) || 0))
  const rank = (boundedPercentile / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]
  const weight = rank - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

export const preFilterJobsForScoring = (jobs, options = {}) => {
  const list = Array.isArray(jobs) ? jobs : []
  const configuredThreshold = Number(options.minQualityScore)
  const hasConfiguredThreshold = Number.isFinite(configuredThreshold)

  if (list.length === 0) {
    return {
      acceptedJobs: [],
      rejectedJobs: [],
      summary: {
        inputCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        fallbackApplied: false,
        minQualityScore: Math.max(0.2, Math.min(0.75, configuredThreshold || 0.36)),
        acceptedQuality: buildDistribution([]),
        rejectedQuality: buildDistribution([]),
      },
    }
  }

  const scoredEntries = list.map((job) => {
    const qualityScore = computeQualityScore(job)
    const hasTitle = String(job?.title || '').trim().length > 0
    const hasApplyLink = /^https?:\/\//i.test(String(job?.applyLink || '').trim())
    return {
      job,
      qualityScore,
      hasTitle,
      hasApplyLink,
    }
  })

  const qualityScores = scoredEntries.map((entry) => entry.qualityScore)
  const dynamicThreshold =
    qualityScores.length >= 10 ? percentile(qualityScores, 35) : percentile(qualityScores, 30)
  const minQualityScore = hasConfiguredThreshold
    ? Math.max(0.2, Math.min(0.75, configuredThreshold))
    : Math.max(0.26, Math.min(0.56, dynamicThreshold))

  const evaluated = scoredEntries.map((entry) => ({
    ...entry,
    accepted: entry.qualityScore >= minQualityScore && entry.hasTitle && entry.hasApplyLink,
  }))

  let acceptedEntries = evaluated.filter((entry) => entry.accepted)
  const rejectedEntries = evaluated.filter((entry) => !entry.accepted)
  let fallbackApplied = false

  const minimumRetained =
    list.length <= 6
      ? Math.max(1, Math.ceil(list.length * 0.5))
      : Math.min(list.length, Math.max(8, Math.floor(list.length * 0.4)))
  if (acceptedEntries.length < minimumRetained) {
    fallbackApplied = true
    acceptedEntries = [...evaluated]
      .sort((left, right) => right.qualityScore - left.qualityScore)
      .slice(0, minimumRetained)
  }

  return {
    acceptedJobs: acceptedEntries.map((entry) => entry.job),
    rejectedJobs: rejectedEntries.map((entry) => entry.job),
    summary: {
      inputCount: list.length,
      acceptedCount: acceptedEntries.length,
      rejectedCount: Math.max(0, list.length - acceptedEntries.length),
      fallbackApplied,
      minQualityScore,
      acceptedQuality: buildDistribution(acceptedEntries.map((entry) => entry.qualityScore)),
      rejectedQuality: buildDistribution(rejectedEntries.map((entry) => entry.qualityScore)),
    },
  }
}


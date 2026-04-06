import { filterJobsWithAI, rankJobsWithAI } from '../gemini/geminiService.js'
import { normalizeScrapedJobs } from '../matching/jobNormalizer.js'
import { preFilterJobsForScoring } from '../matching/jobPreFilter.js'
import { scoreAllJobs } from '../scoring/jobScorer.js'
import { recordSourceSuccess } from '../scraping/sourceMemoryStore.js'
import { env } from '../../config/environment.js'

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[match-pipeline] ${message}`, context)
}

const dedupeJobs = (jobs) => {
  const seen = new Set()
  const unique = []

  for (const job of jobs) {
    const key = String(job.jobHash || `${job.externalId}-${job.applyLink}-${job.title}`).toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(job)
  }

  return unique
}

const averageScore = (jobs) => {
  if (!jobs.length) return 0
  const total = jobs.reduce((sum, job) => sum + Number(job.matchScore || 0), 0)
  return Math.round(total / jobs.length)
}

const ratio = (count, total) => {
  if (!total || total <= 0) return 0
  return Number((count / total).toFixed(3))
}

const toSortedFiniteNumbers = (values) =>
  (Array.isArray(values) ? values : [])
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .sort((left, right) => left - right)

const percentile = (values, percentileValue) => {
  const sorted = toSortedFiniteNumbers(values)
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]

  const boundedPercentile = Math.max(0, Math.min(100, Number(percentileValue) || 0))
  const rank = (boundedPercentile / 100) * (sorted.length - 1)
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  if (lowerIndex === upperIndex) return sorted[lowerIndex]
  const weight = rank - lowerIndex
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight
}

const rounded = (value, precision = 2) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(numeric.toFixed(precision))
}

const buildScoreDistribution = (scores) => {
  const sorted = toSortedFiniteNumbers(scores)
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

const getHostFromUrl = (urlValue) => {
  try {
    return new URL(String(urlValue || '')).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return String(urlValue || '').toLowerCase().trim()
  }
}

const buildScrapeQualitySnapshot = (jobs) => {
  const total = Array.isArray(jobs) ? jobs.length : 0
  if (total === 0) {
    return {
      total: 0,
      descriptionCoverage: 0,
      locationCoverage: 0,
      salaryCoverage: 0,
      uniqueSourceHosts: 0,
      uniqueCompanies: 0,
      topSourceHosts: [],
    }
  }

  const withDescription = jobs.filter((job) => String(job?.description || '').trim().length >= 80).length
  const withLocation = jobs.filter((job) => {
    const location = String(job?.location || '').trim().toLowerCase()
    return location && location !== 'not specified'
  }).length
  const withSalary = jobs.filter((job) => {
    const salary = String(job?.salary || '').trim().toLowerCase()
    return salary && salary !== 'not disclosed'
  }).length
  const sourceHostCounts = new Map()
  for (const job of jobs) {
    const host = getHostFromUrl(job?.source || job?.applyLink || '')
    if (!host) continue
    sourceHostCounts.set(host, (sourceHostCounts.get(host) || 0) + 1)
  }
  const uniqueCompanies = new Set(
    jobs
      .map((job) => String(job?.company || '').trim().toLowerCase())
      .filter((company) => company && company !== 'hiring company not disclosed'),
  ).size

  return {
    total,
    descriptionCoverage: ratio(withDescription, total),
    locationCoverage: ratio(withLocation, total),
    salaryCoverage: ratio(withSalary, total),
    uniqueSourceHosts: sourceHostCounts.size,
    uniqueCompanies,
    topSourceHosts: [...sourceHostCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([host, count]) => ({ host, count })),
  }
}

const isMeaningfulMatchedJob = (job) => {
  const title = String(job?.title || '').trim()
  const source = String(job?.source || '')
  const applyLink = String(job?.applyLink || '')
  const description = String(job?.description || '')
  const combined = `${title} ${description}`.toLowerCase()

  if (!title) return false
  if (/[^\x00-\x7F]/.test(title)) return false
  if (
    /help (center|centre)|article du centre|hilfe|centro de ayuda|skip to main content|sign in|join now|studentsstudents|jobsjobs|homehome/i.test(
      combined,
    )
  ) {
    return false
  }

  if (
    /linkedin\.com\/jobs\/search/i.test(applyLink) ||
    /glassdoor\..*\/Job\/.*SRCH_/i.test(applyLink) ||
    /careers\.google\.com\/jobs\/results\/?\?/i.test(applyLink)
  ) {
    return false
  }

  if (!/\b(engineer|developer|architect|analyst|designer|manager|scientist|intern|devops|qa|sre|product|software|frontend|backend)\b/i.test(title)) {
    return false
  }

  if (!source || !applyLink) return false
  return Number(job?.matchScore || 0) >= 20
}

export const buildMatchedJobs = async ({ rawJobs, profile }) => {
  const normalizedJobs = normalizeScrapedJobs(rawJobs)
  const preFiltered = preFilterJobsForScoring(normalizedJobs)
  debugLog('scrape quality snapshot', {
    quality: buildScrapeQualitySnapshot(normalizedJobs),
    preFilter: preFiltered.summary,
  })

  const scoredJobs = await scoreAllJobs(preFiltered.acceptedJobs, profile)
  debugLog('score distribution', {
    distribution: buildScoreDistribution(scoredJobs.map((job) => Number(job.matchScore || 0))),
  })

  const shortlistLimit = Math.min(60, Math.max(24, Math.round(scoredJobs.length * 0.72)))
  const shortScored = scoredJobs.slice(0, shortlistLimit)
  const aiFiltered = await filterJobsWithAI({
    profile,
    jobs: shortScored,
  })

  const relevantCandidates =
    aiFiltered.relevantJobs.length > 0 ? aiFiltered.relevantJobs : shortScored.slice(0, 20)
  const reranked = await rankJobsWithAI({
    profile,
    jobs: relevantCandidates,
  })

  const filteredJobs = dedupeJobs(reranked).filter(isMeaningfulMatchedJob).slice(0, 12)
  debugLog('post-ai pipeline summary', {
    scoredJobs: scoredJobs.length,
    shortlistLimit,
    shortScored: shortScored.length,
    relevantCandidates: relevantCandidates.length,
    reranked: reranked.length,
    filteredJobs: filteredJobs.length,
    aiReasoning: String(aiFiltered.reasoning || '').slice(0, 220),
    filteredDistribution: buildScoreDistribution(filteredJobs.map((job) => Number(job.matchScore || 0))),
  })

  await recordSourceSuccess({
    profile,
    jobs: filteredJobs,
  })

  return {
    normalizedJobs,
    scoredJobs,
    filteredJobs,
    averageMatchScore: averageScore(filteredJobs),
    aiFilteringReasoning: aiFiltered.reasoning,
    preFilterSummary: preFiltered.summary,
  }
}

import { filterJobsWithAI, rankJobsWithAI } from '../gemini/geminiService.js'
import { normalizeScrapedJobs } from '../matching/jobNormalizer.js'
import { scoreAllJobs } from '../scoring/jobScorer.js'
import { recordSourceSuccess } from '../scraping/sourceMemoryStore.js'

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
  const scoredJobs = await scoreAllJobs(normalizedJobs, profile)
  const shortScored = scoredJobs.slice(0, 40)
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
  }
}

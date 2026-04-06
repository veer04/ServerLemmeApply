import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFilePath)
// Keep non-json extension so nodemon (watching *.json) doesn't restart server mid-session.
const storeFilePath = path.resolve(currentDir, '../../..', 'data', 'source-memory.cache')

let storeLoaded = false
let memory = {
  sources: [],
}

let writeQueue = Promise.resolve()

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const round = (value, precision = 4) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(numeric.toFixed(precision))
}

const normalizeUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!/^https?:$/i.test(parsed.protocol)) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

const getHostFromUrl = (value) => {
  try {
    return new URL(String(value || '').trim()).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

const ATS_PATTERNS = [/greenhouse/i, /lever\.co/i, /workdayjobs/i, /ashbyhq/i, /smartrecruiters/i]
const JOB_BOARD_PATTERNS = [
  /linkedin\.com\/jobs/i,
  /indeed/i,
  /naukri/i,
  /monster/i,
  /timesjobs/i,
  /glassdoor/i,
  /workindia/i,
  /wellfound/i,
  /angel\.co/i,
  /internshala/i,
  /hirist/i,
  /instahyre/i,
]

const inferSourceTypeFromUrl = (url) => {
  const value = String(url || '').toLowerCase()
  if (!value) return 'job_board'
  if (ATS_PATTERNS.some((pattern) => pattern.test(value))) return 'ats'
  if (JOB_BOARD_PATTERNS.some((pattern) => pattern.test(value))) return 'job_board'
  return 'career_page'
}

const normalizeSourceType = (value, url = '') => {
  const text = String(value || '')
    .trim()
    .toLowerCase()
  if (text === 'career_page') return 'career_page'
  if (text === 'job_board') return 'job_board'
  if (text === 'ats' || text === 'ats_system') return 'ats'
  return inferSourceTypeFromUrl(url)
}

const getSourceTypeWeight = (sourceType) => {
  if (sourceType === 'career_page') return 1
  if (sourceType === 'ats' || sourceType === 'ats_system') return 0.86
  return 0.72
}

const buildProfileTags = (profile) => {
  const tags = new Set()
  const roleParts = String(profile.role || '')
    .toLowerCase()
    .split(/[^a-z0-9+.-]/)
    .filter((token) => token.length > 2)

  roleParts.forEach((token) => tags.add(token))
  ;[...(profile.primarySkills || []), ...(profile.secondarySkills || [])]
    .map((entry) => String(entry).toLowerCase().trim())
    .filter(Boolean)
    .forEach((entry) => tags.add(entry))

  const location = String(profile.locationPreference || '').toLowerCase().trim()
  if (location) tags.add(location)
  if (profile.remotePreference) tags.add('remote')
  if (/intern|fresher|entry|new grad/i.test(`${profile.role} ${profile.seniorityLevel}`)) {
    tags.add('entry-level')
  }

  return [...tags].slice(0, 20)
}

const createDefaultSourceEntry = (url) => ({
  url,
  host: getHostFromUrl(url),
  sourceType: inferSourceTypeFromUrl(url),
  tags: [],
  successCount: 0,
  attemptCount: 0,
  failureCount: 0,
  timeoutCount: 0,
  blockedCount: 0,
  totalJobsFound: 0,
  totalJobsAccepted: 0,
  totalQualityJobs: 0,
  totalFinalJobs: 0,
  relevantHitCount: 0,
  relevantScoreSum: 0,
  meanMatchScore: 0,
  avgElapsedMs: 0,
  telemetrySamples: 0,
  successRate: 0,
  avgJobsPerVisit: 0,
  lastAttemptAt: '',
  lastSuccessAt: '',
  lastSuccessfulAt: '',
  lastFailureAt: '',
  lastTimeoutAt: '',
  lastBlockedAt: '',
  lastRelevantAt: '',
})

const normalizeSourceEntry = (rawEntry) => {
  const url = normalizeUrl(rawEntry?.url || '')
  if (!url) return null

  const entry = {
    ...createDefaultSourceEntry(url),
    ...rawEntry,
  }

  entry.url = url
  entry.host = getHostFromUrl(url)
  entry.sourceType = normalizeSourceType(rawEntry?.sourceType, url)
  entry.tags = [...new Set((Array.isArray(rawEntry?.tags) ? rawEntry.tags : []).map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 40)
  entry.successCount = Math.max(0, Number(rawEntry?.successCount || 0))
  entry.attemptCount = Math.max(0, Number(rawEntry?.attemptCount || 0))
  entry.failureCount = Math.max(0, Number(rawEntry?.failureCount || 0))
  entry.timeoutCount = Math.max(0, Number(rawEntry?.timeoutCount || 0))
  entry.blockedCount = Math.max(0, Number(rawEntry?.blockedCount || 0))
  entry.totalJobsFound = Math.max(0, Number(rawEntry?.totalJobsFound || 0))
  entry.totalJobsAccepted = Math.max(0, Number(rawEntry?.totalJobsAccepted || 0))
  entry.totalQualityJobs = Math.max(0, Number(rawEntry?.totalQualityJobs || 0))
  entry.totalFinalJobs = Math.max(0, Number(rawEntry?.totalFinalJobs || 0))
  entry.relevantHitCount = Math.max(0, Number(rawEntry?.relevantHitCount || 0))
  entry.relevantScoreSum = Math.max(0, Number(rawEntry?.relevantScoreSum || 0))
  entry.meanMatchScore = Math.max(
    0,
    Number(
      rawEntry?.meanMatchScore ||
        (entry.relevantHitCount > 0 ? entry.relevantScoreSum / entry.relevantHitCount : 0),
    ),
  )
  entry.avgElapsedMs = Math.max(0, Number(rawEntry?.avgElapsedMs || 0))
  entry.telemetrySamples = Math.max(0, Number(rawEntry?.telemetrySamples || 0))
  entry.successRate = clamp01(
    Number(
      rawEntry?.successRate ||
        (entry.attemptCount > 0 ? entry.successCount / entry.attemptCount : 0),
    ),
  )
  entry.avgJobsPerVisit = Math.max(
    0,
    Number(
      rawEntry?.avgJobsPerVisit ||
        (entry.successCount > 0 ? entry.totalJobsAccepted / entry.successCount : 0),
    ),
  )
  entry.lastAttemptAt = String(rawEntry?.lastAttemptAt || '').trim()
  entry.lastSuccessAt = String(rawEntry?.lastSuccessAt || '').trim()
  entry.lastSuccessfulAt = String(
    rawEntry?.lastSuccessfulAt || rawEntry?.lastSuccessAt || '',
  ).trim()
  entry.lastFailureAt = String(rawEntry?.lastFailureAt || '').trim()
  entry.lastTimeoutAt = String(rawEntry?.lastTimeoutAt || '').trim()
  entry.lastBlockedAt = String(rawEntry?.lastBlockedAt || '').trim()
  entry.lastRelevantAt = String(rawEntry?.lastRelevantAt || '').trim()

  return entry
}

const refreshEntryAggregateMetrics = (entry) => {
  const attempts = Math.max(0, Number(entry?.attemptCount || 0))
  const successes = Math.max(0, Number(entry?.successCount || 0))
  const acceptedJobs = Math.max(0, Number(entry?.totalJobsAccepted || 0))
  entry.successRate = clamp01(attempts > 0 ? successes / attempts : 0)
  entry.avgJobsPerVisit = round(successes > 0 ? acceptedJobs / successes : 0, 2)
  if (!entry.lastSuccessfulAt && entry.lastSuccessAt) {
    entry.lastSuccessfulAt = entry.lastSuccessAt
  }
}

const deriveEntrySignals = (entry) => {
  const attempts = Math.max(
    1,
    Number(entry.attemptCount || 0),
    Number(entry.successCount || 0) +
      Number(entry.failureCount || 0) +
      Number(entry.timeoutCount || 0) +
      Number(entry.blockedCount || 0),
  )
  const successRate = clamp01(Number(entry.successCount || 0) / attempts)
  const failureRate = clamp01(
    (Number(entry.failureCount || 0) + Number(entry.blockedCount || 0) * 0.75) / attempts,
  )
  const timeoutRate = clamp01(Number(entry.timeoutCount || 0) / attempts)
  const precision =
    Number(entry.totalJobsFound || 0) > 0
      ? clamp01(Number(entry.totalJobsAccepted || 0) / Number(entry.totalJobsFound || 0))
      : successRate
  const qualityRate =
    Number(entry.totalJobsAccepted || 0) > 0
      ? clamp01(Number(entry.totalQualityJobs || 0) / Number(entry.totalJobsAccepted || 0))
      : 0
  const finalRate =
    Number(entry.totalQualityJobs || 0) > 0
      ? clamp01(Number(entry.totalFinalJobs || 0) / Number(entry.totalQualityJobs || 0))
      : 0
  const relevanceRate =
    Number(entry.totalFinalJobs || 0) > 0
      ? clamp01(Number(entry.relevantHitCount || 0) / Number(entry.totalFinalJobs || 0))
      : Number(entry.totalJobsAccepted || 0) > 0
        ? clamp01(Number(entry.relevantHitCount || 0) / Number(entry.totalJobsAccepted || 0))
        : 0
  const matchSignal = clamp01(Number(entry.meanMatchScore || 0) / 100)

  return {
    attempts,
    successRate,
    failureRate,
    timeoutRate,
    precision,
    qualityRate,
    finalRate,
    relevanceRate,
    matchSignal,
  }
}

const computeSourceReliability = ({ entry, overlap, ageDays }) => {
  const boundedOverlap = Math.max(0, Number(overlap || 0))
  const boundedAgeDays = Math.max(0, Number(ageDays || 999))
  const signals = deriveEntrySignals(entry)

  // Blend precision + downstream relevance, then discount flaky/slow sources.
  const overlapSignal = Math.min(1, boundedOverlap / 8)
  const recencySignal = Math.max(0, 1 - boundedAgeDays / 45)
  const sourceTypeWeight = getSourceTypeWeight(entry?.sourceType)
  const blended =
    signals.successRate * 0.2 +
    signals.precision * 0.16 +
    signals.qualityRate * 0.12 +
    signals.finalRate * 0.08 +
    signals.relevanceRate * 0.16 +
    signals.matchSignal * 0.1 +
    overlapSignal * 0.1 +
    recencySignal * 0.08 -
    signals.failureRate * 0.11 -
    signals.timeoutRate * 0.07
  return round(clamp01(blended) * sourceTypeWeight)
}

const ensureStoreLoaded = async () => {
  if (storeLoaded) return

  try {
    const raw = await fs.readFile(storeFilePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.sources)) {
      memory = {
        sources: parsed.sources
          .map((entry) => normalizeSourceEntry(entry))
          .filter(Boolean),
      }
    }
  } catch {
    memory = { sources: [] }
  } finally {
    storeLoaded = true
  }
}

const persistStore = async () => {
  await fs.mkdir(path.dirname(storeFilePath), { recursive: true })
  await fs.writeFile(storeFilePath, JSON.stringify(memory, null, 2), 'utf8')
}

const queuePersist = () => {
  writeQueue = writeQueue.then(() => persistStore()).catch(() => {})
  return writeQueue
}

const ensureSourceEntry = (url, tags = []) => {
  const normalized = normalizeUrl(url)
  if (!normalized) return null
  const found = memory.sources.find((entry) => entry.url === normalized)
  if (found) {
    found.tags = [...new Set([...(found.tags || []), ...tags])].slice(0, 40)
    return found
  }

  const created = createDefaultSourceEntry(normalized)
  created.tags = [...new Set(tags)].slice(0, 40)
  memory.sources.push(created)
  return created
}

const sortAndPruneStore = () => {
  memory.sources = (Array.isArray(memory.sources) ? memory.sources : [])
    .map((entry) => normalizeSourceEntry(entry))
    .filter(Boolean)
    .sort((left, right) => {
      const leftSignals = deriveEntrySignals(left)
      const rightSignals = deriveEntrySignals(right)
      refreshEntryAggregateMetrics(left)
      refreshEntryAggregateMetrics(right)
      const leftScore =
        leftSignals.successRate * 4.2 +
        leftSignals.relevanceRate * 4 +
        leftSignals.precision * 3 +
        clamp01((left.avgJobsPerVisit || 0) / 6) * 1.4 +
        leftSignals.matchSignal * 2 -
        leftSignals.failureRate * 3 -
        leftSignals.timeoutRate * 2 +
        getSourceTypeWeight(left.sourceType) * 1.1
      const rightScore =
        rightSignals.successRate * 4.2 +
        rightSignals.relevanceRate * 4 +
        rightSignals.precision * 3 +
        clamp01((right.avgJobsPerVisit || 0) / 6) * 1.4 +
        rightSignals.matchSignal * 2 -
        rightSignals.failureRate * 3 -
        rightSignals.timeoutRate * 2 +
        getSourceTypeWeight(right.sourceType) * 1.1
      return rightScore - leftScore
    })
    .slice(0, 1200)
}

export const getLearnedSourcesForProfile = async (profile, limit = 10) => {
  await ensureStoreLoaded()
  if (!Array.isArray(memory.sources) || memory.sources.length === 0) return []

  const tags = buildProfileTags(profile)
  const tagSet = new Set(tags)
  const now = Date.now()

  return memory.sources
    .map((entry) => {
      const overlap = (entry.tags || []).filter((tag) => tagSet.has(tag)).length
      const ageDays =
        entry.lastSuccessAt && Number.isFinite(new Date(entry.lastSuccessAt).getTime())
          ? (now - new Date(entry.lastSuccessAt).getTime()) / (1000 * 60 * 60 * 24)
          : 365
      const reliability = computeSourceReliability({
        entry,
        overlap,
        ageDays,
      })
      const score = reliability * 100 + overlap * 2
      return { ...entry, score, reliability }
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => normalizeUrl(entry.url))
    .filter(Boolean)
}

export const getLearnedSourceMetrics = async (profile, urls = []) => {
  await ensureStoreLoaded()

  const tags = buildProfileTags(profile)
  const tagSet = new Set(tags)
  const now = Date.now()
  const byHost = new Map()

  for (const entry of Array.isArray(memory.sources) ? memory.sources : []) {
    const host = getHostFromUrl(entry.url)
    if (!host) continue

    const overlap = (entry.tags || []).filter((tag) => tagSet.has(tag)).length
    const ageDays = entry.lastSuccessAt
      ? (now - new Date(entry.lastSuccessAt).getTime()) / (1000 * 60 * 60 * 24)
      : 365
    const reliability = computeSourceReliability({
      entry,
      overlap,
      ageDays,
    })
    const signals = deriveEntrySignals(entry)
    refreshEntryAggregateMetrics(entry)

    const current = byHost.get(host)
    if (!current || reliability > current.reliability) {
      byHost.set(host, {
        reliability,
        sourceType: normalizeSourceType(entry.sourceType, entry.url),
        successCount: Number(entry.successCount || 0),
        attemptCount: Number(entry.attemptCount || 0),
        successRate: round(entry.successRate || signals.successRate),
        avgJobsPerVisit: round(entry.avgJobsPerVisit || 0, 2),
        precision: round(signals.precision),
        relevanceRate: round(signals.relevanceRate),
        failureRate: round(signals.failureRate),
        timeoutRate: round(signals.timeoutRate),
        meanMatchScore: round(entry.meanMatchScore || 0, 2),
        lastSuccessfulAt: entry.lastSuccessfulAt || entry.lastSuccessAt || '',
        overlap,
        ageDays: Number(ageDays.toFixed(2)),
      })
    }
  }

  const requestedHosts = [...new Set((Array.isArray(urls) ? urls : []).map((url) => getHostFromUrl(url)))]
  const metrics = {}
  requestedHosts.forEach((host) => {
    if (!host) return
    const hostMetrics = byHost.get(host) || {
      reliability: 0,
      sourceType: normalizeSourceType('', host),
      successCount: 0,
      attemptCount: 0,
      successRate: 0,
      avgJobsPerVisit: 0,
      precision: 0,
      relevanceRate: 0,
      failureRate: 0,
      timeoutRate: 0,
      meanMatchScore: 0,
      lastSuccessfulAt: '',
      overlap: 0,
      ageDays: 365,
    }
    metrics[host] = hostMetrics
  })

  return metrics
}

export const recordSourceTelemetryBatch = async ({ profile, outcomes = [] }) => {
  await ensureStoreLoaded()
  if (!Array.isArray(outcomes) || outcomes.length === 0) return

  const tags = buildProfileTags(profile)
  const nowIso = new Date().toISOString()

  for (const rawOutcome of outcomes) {
    const sourceUrl = normalizeUrl(rawOutcome?.sourceUrl || rawOutcome?.url || '')
    if (!sourceUrl) continue

    const entry = ensureSourceEntry(sourceUrl, tags)
    if (!entry) continue

    const attemptCount = Math.max(0, Number(rawOutcome?.attemptCount || 0))
    const successCount = Math.max(0, Number(rawOutcome?.successCount || 0))
    const failureCount = Math.max(0, Number(rawOutcome?.failureCount || 0))
    const timeoutCount = Math.max(0, Number(rawOutcome?.timeoutCount || 0))
    const blockedCount = Math.max(0, Number(rawOutcome?.blockedCount || 0))
    const jobsFound = Math.max(0, Number(rawOutcome?.jobsFound || 0))
    const jobsAccepted = Math.max(0, Number(rawOutcome?.jobsAccepted || 0))
    const qualityJobs = Math.max(0, Number(rawOutcome?.qualityJobs || 0))
    const finalJobs = Math.max(0, Number(rawOutcome?.finalJobs || 0))
    const elapsedMs = Math.max(0, Number(rawOutcome?.elapsedMs || 0))
    const sourceType = normalizeSourceType(rawOutcome?.sourceType, sourceUrl)

    entry.attemptCount += attemptCount
    entry.successCount += successCount
    entry.failureCount += failureCount
    entry.timeoutCount += timeoutCount
    entry.blockedCount += blockedCount
    entry.totalJobsFound += jobsFound
    entry.totalJobsAccepted += jobsAccepted
    entry.totalQualityJobs += qualityJobs
    entry.totalFinalJobs += finalJobs
    entry.sourceType = sourceType
    entry.lastAttemptAt = nowIso

    if (successCount > 0) {
      entry.lastSuccessAt = nowIso
      entry.lastSuccessfulAt = nowIso
    }
    if (failureCount > 0) {
      entry.lastFailureAt = nowIso
    }
    if (timeoutCount > 0) {
      entry.lastTimeoutAt = nowIso
    }
    if (blockedCount > 0) {
      entry.lastBlockedAt = nowIso
    }

    if (elapsedMs > 0) {
      const samples = Math.max(0, Number(entry.telemetrySamples || 0))
      const prevAvg = Math.max(0, Number(entry.avgElapsedMs || 0))
      const nextSamples = samples + 1
      entry.avgElapsedMs = round((prevAvg * samples + elapsedMs) / nextSamples, 2)
      entry.telemetrySamples = nextSamples
    }

    refreshEntryAggregateMetrics(entry)
  }

  sortAndPruneStore()
  await queuePersist()
}

export const recordSourceSuccess = async ({ profile, jobs }) => {
  await ensureStoreLoaded()
  if (!Array.isArray(jobs) || jobs.length === 0) return

  const grouped = new Map()
  for (const job of jobs) {
    const url = normalizeUrl(job?.source || '')
    if (!url) continue

    const current = grouped.get(url) || { count: 0, scoreSum: 0, sourceType: '' }
    current.count += 1
    current.scoreSum += Math.max(0, Number(job?.matchScore || 0))
    if (!current.sourceType && job?.sourceType) {
      current.sourceType = normalizeSourceType(job.sourceType, url)
    }
    grouped.set(url, current)
  }
  if (grouped.size === 0) return

  const tags = buildProfileTags(profile)
  const nowIso = new Date().toISOString()

  grouped.forEach((snapshot, url) => {
    const entry = ensureSourceEntry(url, tags)
    if (!entry) return

    entry.successCount += 1
    entry.relevantHitCount += snapshot.count
    entry.relevantScoreSum += snapshot.scoreSum
    entry.meanMatchScore = round(
      entry.relevantHitCount > 0 ? entry.relevantScoreSum / entry.relevantHitCount : 0,
      2,
    )
    entry.totalFinalJobs += snapshot.count
    entry.sourceType = normalizeSourceType(snapshot.sourceType, url)
    entry.lastRelevantAt = nowIso
    entry.lastSuccessAt = nowIso
    entry.lastSuccessfulAt = nowIso
    entry.lastAttemptAt = nowIso
    entry.tags = [...new Set([...(entry.tags || []), ...tags])].slice(0, 40)
    refreshEntryAggregateMetrics(entry)
  })

  sortAndPruneStore()

  await queuePersist()
}

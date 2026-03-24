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

const normalizeUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!/^https?:$/i.test(parsed.protocol)) return ''
    return parsed.toString()
  } catch {
    return ''
  }
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

const ensureStoreLoaded = async () => {
  if (storeLoaded) return

  try {
    const raw = await fs.readFile(storeFilePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.sources)) {
      memory = {
        sources: parsed.sources,
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

export const getLearnedSourcesForProfile = async (profile, limit = 10) => {
  await ensureStoreLoaded()
  if (!Array.isArray(memory.sources) || memory.sources.length === 0) return []

  const tags = buildProfileTags(profile)
  const tagSet = new Set(tags)
  const now = Date.now()

  return memory.sources
    .map((entry) => {
      const overlap = (entry.tags || []).filter((tag) => tagSet.has(tag)).length
      const freshnessPenalty =
        entry.lastSuccessAt && Number.isFinite(new Date(entry.lastSuccessAt).getTime())
          ? Math.floor((now - new Date(entry.lastSuccessAt).getTime()) / (1000 * 60 * 60 * 24 * 10))
          : 6

      const score = Number(entry.successCount || 0) * 3 + overlap * 5 - freshnessPenalty
      return { ...entry, score }
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => normalizeUrl(entry.url))
    .filter(Boolean)
}

export const recordSourceSuccess = async ({ profile, jobs }) => {
  await ensureStoreLoaded()
  if (!Array.isArray(jobs) || jobs.length === 0) return

  const urls = [...new Set(jobs.map((job) => normalizeUrl(job.source)).filter(Boolean))]
  if (urls.length === 0) return

  const tags = buildProfileTags(profile)
  const nowIso = new Date().toISOString()

  urls.forEach((url) => {
    const existing = memory.sources.find((entry) => entry.url === url)
    if (existing) {
      existing.successCount = Number(existing.successCount || 0) + 1
      existing.lastSuccessAt = nowIso
      existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 30)
      return
    }

    memory.sources.push({
      url,
      successCount: 1,
      lastSuccessAt: nowIso,
      tags,
    })
  })

  memory.sources = memory.sources
    .sort((left, right) => Number(right.successCount || 0) - Number(left.successCount || 0))
    .slice(0, 800)

  await queuePersist()
}

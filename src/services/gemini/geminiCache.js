import crypto from 'node:crypto'

const DEFAULT_TTL_MS = 1000 * 60 * 30

const cacheStore = new Map()

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `"${key}":${stableStringify(value[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

export const buildGeminiCacheKey = (namespace, payload) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${namespace}:${stableStringify(payload)}`)
    .digest('hex')

  return `${namespace}:${hash}`
}

export const getGeminiCache = (key) => {
  const record = cacheStore.get(key)
  if (!record) return null

  if (record.expiresAt <= Date.now()) {
    cacheStore.delete(key)
    return null
  }

  return record.value
}

export const setGeminiCache = (key, value, ttlMs = DEFAULT_TTL_MS) => {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

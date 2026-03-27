import crypto from 'node:crypto'
import { createClient } from 'redis'
import { env } from '../../config/environment.js'

export const REDIS_CHANNEL_STREAM = 'aaply:stream-events'
export const REDIS_CHANNEL_CONTROL = 'aaply:session-control'

const nodeId = process.env.INSTANCE_ID || `node-${crypto.randomUUID()}`
const redisUrl = String(env.redisUrl || '').trim()
const isRedisConfigured = Boolean(redisUrl)

let pubClient = null
let subClient = null
let kvClient = null
let initialized = false
let initializingPromise = null

const channelHandlers = new Map()
const subscribedChannels = new Set()

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[redis-realtime] ${message}`, context)
}

const ensureHandlerSet = (channel) => {
  if (!channelHandlers.has(channel)) {
    channelHandlers.set(channel, new Set())
  }
  return channelHandlers.get(channel)
}

const dispatchChannelMessage = (channel, envelope) => {
  const handlers = channelHandlers.get(channel)
  if (!handlers || handlers.size === 0) return

  for (const handler of handlers) {
    try {
      handler(envelope)
    } catch {
      // Ignore handler errors to avoid breaking message fanout.
    }
  }
}

const safeParseMessage = (rawValue) => {
  try {
    return JSON.parse(String(rawValue || ''))
  } catch {
    return null
  }
}

const closeClient = async (client) => {
  if (!client) return
  if (!client.isOpen) return
  try {
    await client.quit()
  } catch {
    // Ignore shutdown errors during fallback.
  }
}

const teardownClients = async () => {
  await Promise.all([closeClient(pubClient), closeClient(subClient), closeClient(kvClient)])
  pubClient = null
  subClient = null
  kvClient = null
  subscribedChannels.clear()
  initialized = false
}

const ensureSubscribedChannel = async (channel) => {
  if (!subClient?.isOpen) return false
  if (subscribedChannels.has(channel)) return true

  try {
    await subClient.subscribe(channel, (rawMessage) => {
      const envelope = safeParseMessage(rawMessage)
      if (!envelope || typeof envelope !== 'object') return
      dispatchChannelMessage(channel, envelope)
    })
    subscribedChannels.add(channel)
    return true
  } catch (error) {
    debugLog('subscribe failed', {
      channel,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return false
  }
}

const ensureInitialSubscriptions = async () => {
  const channels = [...channelHandlers.keys()]
  if (channels.length === 0) return
  await Promise.all(channels.map((channel) => ensureSubscribedChannel(channel)))
}

export const initRedisRealtime = async () => {
  if (!isRedisConfigured) {
    return {
      enabled: false,
      nodeId,
      reason: 'REDIS_URL is not configured.',
    }
  }

  if (initialized && pubClient?.isOpen && subClient?.isOpen && kvClient?.isOpen) {
    return { enabled: true, nodeId }
  }

  if (initializingPromise) {
    return initializingPromise
  }

  initializingPromise = (async () => {
    try {
      pubClient = createClient({ url: redisUrl })
      subClient = createClient({ url: redisUrl })
      kvClient = createClient({ url: redisUrl })

      ;[pubClient, subClient, kvClient].forEach((client) => {
        client.on('error', (error) => {
          debugLog('redis client error', {
            reason: error instanceof Error ? error.message : 'unknown',
          })
        })
      })

      await Promise.all([pubClient.connect(), subClient.connect(), kvClient.connect()])
      initialized = true
      await ensureInitialSubscriptions()
      debugLog('redis realtime initialized', { nodeId })
      return { enabled: true, nodeId }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown'
      debugLog('redis realtime unavailable', { reason })
      await teardownClients()
      return { enabled: false, nodeId, reason }
    } finally {
      initializingPromise = null
    }
  })()

  return initializingPromise
}

export const registerRedisMessageHandler = (channel, handler) => {
  const handlers = ensureHandlerSet(channel)
  handlers.add(handler)

  void initRedisRealtime().then((status) => {
    if (!status.enabled) return
    void ensureSubscribedChannel(channel)
  })

  return () => {
    const currentHandlers = channelHandlers.get(channel)
    if (!currentHandlers) return
    currentHandlers.delete(handler)
  }
}

export const publishRedisMessage = async (channel, payload) => {
  const status = await initRedisRealtime()
  if (!status.enabled || !pubClient?.isOpen) return false

  try {
    const envelope = {
      originNodeId: nodeId,
      emittedAt: new Date().toISOString(),
      payload,
    }
    await pubClient.publish(channel, JSON.stringify(envelope))
    return true
  } catch (error) {
    debugLog('publish failed', {
      channel,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return false
  }
}

export const setRedisJson = async (key, value, { ttlSeconds = 0 } = {}) => {
  const status = await initRedisRealtime()
  if (!status.enabled || !kvClient?.isOpen) return false

  try {
    const payload = JSON.stringify(value)
    if (ttlSeconds > 0) {
      await kvClient.set(key, payload, { EX: ttlSeconds })
    } else {
      await kvClient.set(key, payload)
    }
    return true
  } catch (error) {
    debugLog('set redis json failed', {
      key,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return false
  }
}

export const getRedisJson = async (key) => {
  const status = await initRedisRealtime()
  if (!status.enabled || !kvClient?.isOpen) return null

  try {
    const rawValue = await kvClient.get(key)
    if (!rawValue) return null
    return safeParseMessage(rawValue)
  } catch (error) {
    debugLog('get redis json failed', {
      key,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return null
  }
}

export const getRedisNodeId = () => nodeId


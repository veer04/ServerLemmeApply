import IORedis from 'ioredis'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { env } from '../../config/environment.js'
import { processSessionInBackground } from './sessionProcessor.js'

let producerConnection
let workerConnection
let producerQueue
let queueEvents
let queueWorker

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[session-queue] ${message}`, context)
}

const normalizeSessionId = (value) => String(value || '').trim()

const isQueueDispatchEnabled = () => env.sessionDispatchMode === 'queue'
const hasRedisConfig = () => Boolean(String(env.redisUrl || '').trim())

const createRedisConnection = () =>
  new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  })

const ensureProducerQueue = () => {
  if (producerQueue) return producerQueue
  if (!hasRedisConfig()) return null

  producerConnection = producerConnection || createRedisConnection()
  producerConnection.on('error', (error) => {
    debugLog('producer redis error', {
      reason: error instanceof Error ? error.message : 'unknown',
    })
  })

  producerQueue = new Queue(env.sessionQueueName, {
    connection: producerConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 200,
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    },
  })
  return producerQueue
}

const ensureQueueEvents = () => {
  if (queueEvents) return queueEvents
  if (!hasRedisConfig()) return null

  producerConnection = producerConnection || createRedisConnection()
  queueEvents = new QueueEvents(env.sessionQueueName, {
    connection: producerConnection,
  })

  queueEvents.on('failed', (event) => {
    debugLog('job failed', event || {})
  })
  queueEvents.on('completed', (event) => {
    debugLog('job completed', event || {})
  })

  return queueEvents
}

export const enqueueSessionProcessing = async (payload) => {
  const sessionId = normalizeSessionId(payload?.sessionId)
  if (!sessionId) {
    return {
      queued: false,
      reason: 'Missing sessionId for queue dispatch.',
    }
  }
  if (!isQueueDispatchEnabled()) {
    return {
      queued: false,
      reason: 'Session dispatch mode is inline.',
    }
  }
  if (!hasRedisConfig()) {
    return {
      queued: false,
      reason: 'REDIS_URL is not configured.',
    }
  }

  try {
    const queue = ensureProducerQueue()
    ensureQueueEvents()
    const normalizedProfileSeed =
      payload?.profileSeed && typeof payload.profileSeed === 'object'
        ? payload.profileSeed
        : null
    const job = await queue.add(
      'process-session',
      {
        sessionId,
        prompt: String(payload?.prompt || ''),
        resumeText: String(payload?.resumeText || ''),
        profileSeed: normalizedProfileSeed,
      },
      {
        jobId: sessionId,
      },
    )
    debugLog('session enqueued', {
      sessionId,
      jobId: job.id,
      queueName: env.sessionQueueName,
    })
    return {
      queued: true,
      jobId: job.id,
    }
  } catch (error) {
    debugLog('queue dispatch failed', {
      sessionId,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return {
      queued: false,
      reason: error instanceof Error ? error.message : 'Queue dispatch failed.',
    }
  }
}

export const dispatchSessionProcessing = async (payload) => {
  const queuedResult = await enqueueSessionProcessing(payload)
  if (queuedResult.queued) {
    return {
      mode: 'queue',
      queued: true,
      jobId: queuedResult.jobId,
    }
  }

  // Safe fallback for local/dev operation or queue outages.
  void processSessionInBackground(payload)
  return {
    mode: 'inline',
    queued: false,
    reason: queuedResult.reason,
  }
}

export const startSessionQueueWorker = async ({ force = false } = {}) => {
  if (queueWorker) {
    return {
      started: true,
      queueName: env.sessionQueueName,
      reason: 'Worker already running.',
    }
  }
  if (!force && !env.sessionWorkerEnabled) {
    return {
      started: false,
      queueName: env.sessionQueueName,
      reason: 'SESSION_WORKER_ENABLED is false.',
    }
  }
  if (!hasRedisConfig()) {
    return {
      started: false,
      queueName: env.sessionQueueName,
      reason: 'REDIS_URL is not configured.',
    }
  }

  workerConnection = workerConnection || createRedisConnection()
  workerConnection.on('error', (error) => {
    debugLog('worker redis error', {
      reason: error instanceof Error ? error.message : 'unknown',
    })
  })

  queueWorker = new Worker(
    env.sessionQueueName,
    async (job) => {
      const data = job?.data || {}
      const normalizedProfileSeed =
        data.profileSeed && typeof data.profileSeed === 'object' ? data.profileSeed : null
      await processSessionInBackground({
        sessionId: String(data.sessionId || ''),
        prompt: String(data.prompt || ''),
        resumeText: String(data.resumeText || ''),
        profileSeed: normalizedProfileSeed,
      })
    },
    {
      connection: workerConnection,
      concurrency: Math.max(1, Number(env.sessionQueueConcurrency || 2)),
    },
  )

  queueWorker.on('active', (job) => {
    debugLog('worker job active', {
      sessionId: String(job?.data?.sessionId || ''),
      jobId: job?.id,
    })
  })
  queueWorker.on('completed', (job) => {
    debugLog('worker job completed', {
      sessionId: String(job?.data?.sessionId || ''),
      jobId: job?.id,
    })
  })
  queueWorker.on('failed', (job, error) => {
    debugLog('worker job failed', {
      sessionId: String(job?.data?.sessionId || ''),
      jobId: job?.id,
      reason: error instanceof Error ? error.message : 'unknown',
    })
  })

  debugLog('session queue worker started', {
    queueName: env.sessionQueueName,
    concurrency: Math.max(1, Number(env.sessionQueueConcurrency || 2)),
  })

  return {
    started: true,
    queueName: env.sessionQueueName,
  }
}

export const getSessionDispatchMode = () => {
  if (isQueueDispatchEnabled() && hasRedisConfig()) return 'queue'
  return 'inline'
}


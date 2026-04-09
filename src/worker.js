import { connectDatabase } from './config/database.js'
import { env } from './config/environment.js'
import { initRedisRealtime } from './services/infrastructure/redisRealtime.js'
import { startSessionQueueWorker } from './services/session/sessionQueue.js'

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || './src/config/gcp-key.json'

const startWorker = async () => {
  await connectDatabase()
  await initRedisRealtime()

  const workerStatus = await startSessionQueueWorker({ force: true })
  if (!workerStatus.started) {
    throw new Error(
      workerStatus.reason || 'Session queue worker could not be started.',
    )
  }

  // eslint-disable-next-line no-console
  console.log(
    `LemmeApply session worker started. queue=${workerStatus.queueName} concurrency=${Math.max(1, Number(env.sessionQueueConcurrency || 2))}`,
  )
}

startWorker().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start LemmeApply session worker:', error)
  process.exit(1)
})


import { app } from './app.js'
import { connectDatabase } from './config/database.js'
import { env } from './config/environment.js'
import { initRedisRealtime } from './services/infrastructure/redisRealtime.js'
import {
  getSessionDispatchMode,
  startSessionQueueWorker,
} from './services/session/sessionQueue.js'

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || './src/config/gcp-key.json'

const startServer = async () => {
  if (env.nodeEnv === 'production' && env.jwtSecret === 'dev_jwt_secret_change_me') {
    throw new Error('JWT_SECRET must be configured in production.')
  }

  await connectDatabase()
  const redisStatus = await initRedisRealtime()
  const workerStatus = await startSessionQueueWorker()

  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Aaply API running on http://localhost:${env.port}`)
    // eslint-disable-next-line no-console
    console.log(`Session processing dispatch mode: ${getSessionDispatchMode()}`)
    if (redisStatus.enabled) {
      // eslint-disable-next-line no-console
      console.log('Redis realtime bus enabled.')
    } else if (env.redisUrl) {
      // eslint-disable-next-line no-console
      console.warn(`Redis realtime bus unavailable. Falling back to in-memory mode. (${redisStatus.reason || 'unknown reason'})`)
    }
    if (workerStatus.started) {
      // eslint-disable-next-line no-console
      console.log(`Session queue worker running in API process. queue=${workerStatus.queueName}`)
    } else if (env.sessionWorkerEnabled || env.sessionDispatchMode === 'queue') {
      // eslint-disable-next-line no-console
      console.warn(`Session queue worker not started in API process. (${workerStatus.reason || 'unknown reason'})`)
    }
  })
}

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start Aaply API:', error)
  process.exit(1)
})

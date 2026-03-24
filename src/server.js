import { app } from './app.js'
import { connectDatabase } from './config/database.js'
import { env } from './config/environment.js'

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || './src/config/gcp-key.json'

const startServer = async () => {
  await connectDatabase()

  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Aaply API running on http://localhost:${env.port}`)
  })
}

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start Aaply API:', error)
  process.exit(1)
})

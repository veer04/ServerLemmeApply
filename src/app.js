import path from 'node:path'
import cors from 'cors'
import express from 'express'
import { env } from './config/environment.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFoundHandler } from './middleware/notFound.js'
import { authRouter } from './routes/authRoutes.js'
import { chatRouter } from './routes/chatRoutes.js'
import { profileRouter } from './routes/profileRoutes.js'
import { streamRouter } from './routes/streamRoutes.js'

export const app = express()

const allowedOrigins = new Set(env.clientOrigins)
const resolveRequestOrigin = (origin) => {
  try {
    const parsed = new URL(String(origin || '').trim())
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}
{/*
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true)
        return
      }
      const normalizedOrigin = resolveRequestOrigin(origin)
      callback(null, Boolean(normalizedOrigin && allowedOrigins.has(normalizedOrigin)))
    },
  }),
)
*/}
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)

      const normalizedOrigin = resolveRequestOrigin(origin)

      if (normalizedOrigin && allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true)
      }

      console.log(" Blocked by CORS:", origin)
      return callback(new Error("Not allowed by CORS"))
    },
    credentials: true,
  })
)

// ✅ handle preflight requests
app.options(/.*/, (req, res, next) => {
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)

      const normalizedOrigin = resolveRequestOrigin(origin)

      if (normalizedOrigin && allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true)
      }

      return callback(new Error("Not allowed by CORS"))
    },
    credentials: true,
  })(req, res, next)
})

app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')))

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'LemmeApply Hiring Assistant API',
  })
})

app.use('/api/auth', authRouter)
app.use('/api/chat', chatRouter)
app.use('/api/jobs', streamRouter)
app.use('/api/profile', profileRouter)

app.use(notFoundHandler)
app.use(errorHandler)

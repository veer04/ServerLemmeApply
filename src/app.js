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

app.use(
  cors({
    origin: env.clientOrigin,
  }),
)

app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')))

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'Aaply Hiring Assistant API',
  })
})

app.use('/api/auth', authRouter)
app.use('/api/chat', chatRouter)
app.use('/api/jobs', streamRouter)
app.use('/api/profile', profileRouter)

app.use(notFoundHandler)
app.use(errorHandler)

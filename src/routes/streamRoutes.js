import { Router } from 'express'
import { refineJobs } from '../controllers/jobRefineController.js'
import {
  stopSessionProcessing,
  streamSessionJobs,
} from '../controllers/streamController.js'
import { requireAuthOrGuest } from '../middleware/requireAuth.js'
import { tokenLimitMiddleware } from '../middleware/tokenLimitMiddleware.js'

export const streamRouter = Router()

streamRouter.use(requireAuthOrGuest)

streamRouter.get('/stream/:sessionId', streamSessionJobs)
streamRouter.post('/stop/:sessionId', stopSessionProcessing)
streamRouter.post('/refine', tokenLimitMiddleware, refineJobs)

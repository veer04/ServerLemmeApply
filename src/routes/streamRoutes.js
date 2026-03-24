import { Router } from 'express'
import { refineJobs } from '../controllers/jobRefineController.js'
import {
  stopSessionProcessing,
  streamSessionJobs,
} from '../controllers/streamController.js'

export const streamRouter = Router()

streamRouter.get('/stream/:sessionId', streamSessionJobs)
streamRouter.post('/stop/:sessionId', stopSessionProcessing)
streamRouter.post('/refine', refineJobs)

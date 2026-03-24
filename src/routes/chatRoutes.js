import { Router } from 'express'
import {
  createChatSession,
  getChatSessionById,
  listChatSessions,
} from '../controllers/chatController.js'
import { upload } from '../middleware/upload.js'

export const chatRouter = Router()

chatRouter.get('/sessions', listChatSessions)
chatRouter.get('/sessions/:sessionId', getChatSessionById)
chatRouter.post('/sessions', upload.single('resume'), createChatSession)

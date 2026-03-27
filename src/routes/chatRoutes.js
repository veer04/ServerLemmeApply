import { Router } from 'express'
import {
  createChatSession,
  getChatSessionById,
  listChatSessions,
  migrateGuestChats,
} from '../controllers/chatController.js'
import { requireAuth, requireAuthOrGuest } from '../middleware/requireAuth.js'
import { upload } from '../middleware/upload.js'

export const chatRouter = Router()

chatRouter.get('/sessions', requireAuthOrGuest, listChatSessions)
chatRouter.get('/sessions/:sessionId', requireAuthOrGuest, getChatSessionById)
chatRouter.post('/sessions', requireAuthOrGuest, upload.single('resume'), createChatSession)
chatRouter.post('/migrate-guest', requireAuth, migrateGuestChats)

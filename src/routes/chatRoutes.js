import { Router } from 'express'
import {
  createChatSession,
  getTokenUsage,
  getChatSessionById,
  listChatSessions,
  migrateGuestChats,
} from '../controllers/chatController.js'
import { requireAuth, requireAuthOrGuest } from '../middleware/requireAuth.js'
import { tokenLimitMiddleware } from '../middleware/tokenLimitMiddleware.js'
import { upload } from '../middleware/upload.js'

export const chatRouter = Router()

chatRouter.get('/sessions', requireAuthOrGuest, listChatSessions)
chatRouter.get('/sessions/:sessionId', requireAuthOrGuest, getChatSessionById)
chatRouter.get('/token-usage', requireAuthOrGuest, getTokenUsage)
chatRouter.post(
  '/sessions',
  requireAuthOrGuest,
  tokenLimitMiddleware,
  upload.single('resume'),
  createChatSession,
)
chatRouter.post('/migrate-guest', requireAuth, migrateGuestChats)

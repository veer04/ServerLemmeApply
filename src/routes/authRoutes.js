import { Router } from 'express'
import {
  getCurrentUser,
  googleAuth,
  login,
  resendOtp,
  signup,
  updateCurrentUser,
  verifyOtp,
} from '../controllers/authController.js'
import { requireAuth } from '../middleware/requireAuth.js'

export const authRouter = Router()

authRouter.post('/signup', signup)
authRouter.post('/resend-otp', resendOtp)
authRouter.post('/verify-otp', verifyOtp)
authRouter.post('/login', login)
authRouter.post('/google', googleAuth)
authRouter.get('/me', requireAuth, getCurrentUser)
authRouter.patch('/me', requireAuth, updateCurrentUser)

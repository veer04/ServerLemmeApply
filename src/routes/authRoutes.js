import { Router } from 'express'
import {
  forgotPassword,
  getCurrentUser,
  googleAuth,
  login,
  resendOtp,
  resetPassword,
  sendOtpForLogin,
  sendOtpForSignup,
  signup,
  updateCurrentUser,
  verifyOtpLogin,
  verifyOtp,
  verifyOtpSignup,
} from '../controllers/authController.js'
import { requireAuth } from '../middleware/requireAuth.js'

export const authRouter = Router()

authRouter.post('/signup', signup)
authRouter.post('/resend-otp', resendOtp)
authRouter.post('/verify-otp', verifyOtp)
authRouter.post('/login', login)
authRouter.post('/send-otp-signup', sendOtpForSignup)
authRouter.post('/verify-otp-signup', verifyOtpSignup)
authRouter.post('/send-otp-login', sendOtpForLogin)
authRouter.post('/verify-otp-login', verifyOtpLogin)
authRouter.post('/forgot-password', forgotPassword)
authRouter.post('/reset-password', resetPassword)
authRouter.post('/google', googleAuth)
authRouter.get('/me', requireAuth, getCurrentUser)
authRouter.patch('/me', requireAuth, updateCurrentUser)

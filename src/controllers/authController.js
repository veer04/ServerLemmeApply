import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { OAuth2Client } from 'google-auth-library'
import { env } from '../config/environment.js'
import { OtpChallenge } from '../models/Otp.js'
import { User, toSafeUser } from '../models/User.js'
import { UserProfile } from '../models/UserProfile.js'
import { sendOtpEmail } from '../services/auth/otpMailer.js'
import { generateOtpCode as generateOtpCodeUtil } from '../utils/auth/generateOtp.js'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const otpPattern = /^\d{6}$/
const OTP_PURPOSE = {
  SIGNUP: 'signup',
  LOGIN: 'login',
  PASSWORD_RESET: 'password_reset',
}
const OTP_RESEND_COOLDOWN_SECONDS = 20
const OTP_MAX_ATTEMPTS = 5

const googleOauthClient = env.googleClientId ? new OAuth2Client(env.googleClientId) : null

const throwHttpError = (message, statusCode = 400) => {
  const error = new Error(message)
  error.statusCode = statusCode
  throw error
}

const normalizeEmail = (value) => String(value || '').trim().toLowerCase()
const normalizeName = (value) => String(value || '').trim()

const hashOtp = (otpCode) => {
  return crypto.createHash('sha256').update(String(otpCode)).digest('hex')
}

const generateOtpCode = () => {
  const random = crypto.randomInt(0, 1000000)
  return String(random).padStart(6, '0')
}

const createAuthToken = (user) => {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      name: user.name,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  )
}

const ensureLinkedUserProfile = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(String(userId || ''))) return

  const objectId = new mongoose.Types.ObjectId(String(userId))
  await UserProfile.findOneAndUpdate(
    { userId: objectId },
    { $setOnInsert: { userId: objectId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
}

const validateSignupPayload = ({ name, email, password, confirmPassword }) => {
  if (!normalizeName(name)) {
    throwHttpError('Name is required.')
  }

  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
    throwHttpError('Valid email is required.')
  }

  if (String(password || '').length < 8) {
    throwHttpError('Password must be at least 8 characters.')
  }

  if (String(password || '').length > 72) {
    throwHttpError('Password must be at most 72 characters.')
  }

  if (String(password) !== String(confirmPassword)) {
    throwHttpError('Password and confirm password do not match.')
  }
}

const validateLoginPayload = ({ email, password }) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
    throwHttpError('Valid email is required.')
  }

  if (!String(password || '')) {
    throwHttpError('Password is required.')
  }
}

const validatePasswordResetPayload = ({ password, confirmPassword }) => {
  if (String(password || '').length < 8) {
    throwHttpError('Password must be at least 8 characters.')
  }

  if (String(password || '').length > 72) {
    throwHttpError('Password must be at most 72 characters.')
  }

  if (String(password || '') !== String(confirmPassword || '')) {
    throwHttpError('Password and confirm password do not match.')
  }
}

const issueOtpChallenge = async ({ email, purpose, name = '', metadata = null }) => {
  const normalizedEmail = normalizeEmail(email)
  const existing = await OtpChallenge.findOne({
    email: normalizedEmail,
    purpose,
  }).select('createdAt')

  if (existing?.createdAt) {
    const ageSeconds = Math.floor((Date.now() - new Date(existing.createdAt).getTime()) / 1000)
    if (ageSeconds >= 0 && ageSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
      throwHttpError(
        `Please wait ${OTP_RESEND_COOLDOWN_SECONDS - ageSeconds}s before requesting another OTP.`,
        429,
      )
    }
  }

  const otpCode = generateOtpCodeUtil()
  const otpHash = await bcrypt.hash(otpCode, 12)
  const expiresAt = new Date(Date.now() + env.otpExpiryMinutes * 60 * 1000)

  await OtpChallenge.findOneAndUpdate(
    { email: normalizedEmail, purpose },
    {
      $set: {
        otpHash,
        expiresAt,
        attemptCount: 0,
        metadata: metadata || null,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  )

  await sendOtpEmail({
    name,
    email: normalizedEmail,
    otpCode,
    expiresInMinutes: env.otpExpiryMinutes,
  })

  return {
    expiresAt,
    otpDebugCode: env.nodeEnv !== 'production' ? otpCode : '',
  }
}

const verifyOtpChallenge = async ({ email, purpose, otpCode }) => {
  const normalizedEmail = normalizeEmail(email)
  const challenge = await OtpChallenge.findOne({
    email: normalizedEmail,
    purpose,
  })

  if (!challenge) {
    throwHttpError('No OTP is pending for this email and action.')
  }

  if (new Date(challenge.expiresAt).getTime() < Date.now()) {
    await OtpChallenge.deleteOne({ _id: challenge._id })
    throwHttpError('OTP has expired. Please request a new code.')
  }

  const isOtpValid = await bcrypt.compare(String(otpCode || ''), challenge.otpHash)
  if (!isOtpValid) {
    const nextAttempts = Number(challenge.attemptCount || 0) + 1
    if (nextAttempts >= OTP_MAX_ATTEMPTS) {
      await OtpChallenge.deleteOne({ _id: challenge._id })
      throwHttpError('OTP attempts exceeded. Please request a new code.', 429)
    }
    challenge.attemptCount = nextAttempts
    await challenge.save()
    throwHttpError('Invalid OTP code.')
  }

  await OtpChallenge.deleteOne({ _id: challenge._id })
  return challenge
}

export const sendOtpForSignup = async (request, response, next) => {
  try {
    const { name, email, password, confirmPassword } = request.body || {}
    validateSignupPayload({ name, email, password, confirmPassword })

    const normalizedEmail = normalizeEmail(email)
    const normalizedName = normalizeName(name)

    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser?.isVerified && existingUser.authProviders?.emailPassword) {
      throwHttpError('An account with this email already exists.', 409)
    }
    if (
      existingUser?.isVerified &&
      !existingUser.authProviders?.emailPassword &&
      existingUser.authProviders?.google
    ) {
      throwHttpError('This email is already registered with Google login. Use Google sign in.', 409)
    }

    const passwordHash = await bcrypt.hash(String(password), 12)
    const challenge = await issueOtpChallenge({
      email: normalizedEmail,
      purpose: OTP_PURPOSE.SIGNUP,
      name: normalizedName,
      metadata: {
        name: normalizedName,
        passwordHash,
      },
    })

    response.status(200).json({
      message: 'OTP sent for signup verification.',
      email: normalizedEmail,
      otpExpiresInSeconds: env.otpExpiryMinutes * 60,
      ...(challenge.otpDebugCode ? { otpDebugCode: challenge.otpDebugCode } : {}),
    })
  } catch (error) {
    next(error)
  }
}

export const verifyOtpSignup = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    const otpCode = String(request.body?.otp || '').trim()

    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }
    if (!otpPattern.test(otpCode)) {
      throwHttpError('OTP must be a 6-digit code.')
    }

    const challenge = await verifyOtpChallenge({
      email: normalizedEmail,
      purpose: OTP_PURPOSE.SIGNUP,
      otpCode,
    })

    const signupMetadata = challenge.metadata || {}
    const name = normalizeName(signupMetadata.name)
    const passwordHash = String(signupMetadata.passwordHash || '').trim()
    if (!name || !passwordHash) {
      throwHttpError('Signup session expired. Please restart signup.', 400)
    }

    const existingUser = await User.findOne({ email: normalizedEmail })
    if (
      existingUser?.isVerified &&
      !existingUser.authProviders?.emailPassword &&
      existingUser.authProviders?.google
    ) {
      throwHttpError('This email is already registered with Google login. Use Google sign in.', 409)
    }
    if (existingUser?.isVerified && existingUser.authProviders?.emailPassword) {
      throwHttpError('An account with this email already exists.', 409)
    }

    const user = existingUser || new User({ email: normalizedEmail, name })
    user.name = name
    user.passwordHash = passwordHash
    user.isVerified = true
    user.authProviders = {
      emailPassword: true,
      google: Boolean(existingUser?.authProviders?.google),
    }
    user.lastLoginAt = new Date()
    await user.save()
    await ensureLinkedUserProfile(user._id)

    const token = createAuthToken(user)
    response.status(201).json({
      message: 'Signup verified successfully.',
      token,
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const sendOtpForLogin = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user || !user.isVerified) {
      throwHttpError('Account not found or not verified.', 404)
    }

    const challenge = await issueOtpChallenge({
      email: normalizedEmail,
      purpose: OTP_PURPOSE.LOGIN,
      name: user.name,
    })

    response.status(200).json({
      message: 'OTP sent for login.',
      email: normalizedEmail,
      otpExpiresInSeconds: env.otpExpiryMinutes * 60,
      ...(challenge.otpDebugCode ? { otpDebugCode: challenge.otpDebugCode } : {}),
    })
  } catch (error) {
    next(error)
  }
}

export const verifyOtpLogin = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    const otpCode = String(request.body?.otp || '').trim()

    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }
    if (!otpPattern.test(otpCode)) {
      throwHttpError('OTP must be a 6-digit code.')
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user || !user.isVerified) {
      throwHttpError('Account not found or not verified.', 404)
    }

    await verifyOtpChallenge({
      email: normalizedEmail,
      purpose: OTP_PURPOSE.LOGIN,
      otpCode,
    })

    user.lastLoginAt = new Date()
    await user.save()
    await ensureLinkedUserProfile(user._id)

    const token = createAuthToken(user)
    response.status(200).json({
      message: 'Login verified successfully.',
      token,
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const forgotPassword = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      response.status(200).json({
        message: 'If an account exists with this email, OTP has been sent.',
        email: normalizedEmail,
      })
      return
    }

    const challenge = await issueOtpChallenge({
      email: normalizedEmail,
      purpose: OTP_PURPOSE.PASSWORD_RESET,
      name: user.name,
    })

    response.status(200).json({
      message: 'Password reset OTP sent to your email.',
      email: normalizedEmail,
      otpExpiresInSeconds: env.otpExpiryMinutes * 60,
      ...(challenge.otpDebugCode ? { otpDebugCode: challenge.otpDebugCode } : {}),
    })
  } catch (error) {
    next(error)
  }
}

export const resetPassword = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    const otpCode = String(request.body?.otp || '').trim()
    const password = String(request.body?.password || '')
    const confirmPassword = String(request.body?.confirmPassword || '')

    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }
    if (!otpPattern.test(otpCode)) {
      throwHttpError('OTP must be a 6-digit code.')
    }
    validatePasswordResetPayload({ password, confirmPassword })

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      throwHttpError('No account found for this email.', 404)
    }

    await verifyOtpChallenge({
      email: normalizedEmail,
      purpose: OTP_PURPOSE.PASSWORD_RESET,
      otpCode,
    })

    user.passwordHash = await bcrypt.hash(password, 12)
    user.isVerified = true
    user.authProviders = {
      emailPassword: true,
      google: Boolean(user.authProviders?.google),
    }
    user.lastLoginAt = new Date()
    await user.save()
    await ensureLinkedUserProfile(user._id)

    const token = createAuthToken(user)
    response.status(200).json({
      message: 'Password reset successful.',
      token,
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const signup = async (request, response, next) => {
  try {
    const { name, email, password, confirmPassword } = request.body || {}
    validateSignupPayload({ name, email, password, confirmPassword })

    const normalizedEmail = normalizeEmail(email)
    const normalizedName = normalizeName(name)

    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser?.isVerified && existingUser.authProviders?.emailPassword) {
      throwHttpError('An account with this email already exists.', 409)
    }
    if (
      existingUser?.isVerified &&
      !existingUser.authProviders?.emailPassword &&
      existingUser.authProviders?.google
    ) {
      throwHttpError('This email is already registered with Google login. Use Google sign in.', 409)
    }

    const passwordHash = await bcrypt.hash(String(password), 12)
    const otpCode = generateOtpCode()
    const otpExpiry = new Date(Date.now() + env.otpExpiryMinutes * 60 * 1000)
    const otpHash = hashOtp(otpCode)

    const user = existingUser || new User({ email: normalizedEmail, name: normalizedName })
    user.name = normalizedName
    user.passwordHash = passwordHash
    user.isVerified = false
    user.otpHash = otpHash
    user.otpExpiry = otpExpiry
    user.authProviders = {
      emailPassword: true,
      google: Boolean(existingUser?.authProviders?.google),
    }

    await user.save()

    await sendOtpEmail({
      name: normalizedName,
      email: normalizedEmail,
      otpCode,
      expiresInMinutes: env.otpExpiryMinutes,
    })

    response.status(201).json({
      message: 'Signup started. Verification OTP sent to your email.',
      email: normalizedEmail,
      otpExpiresInSeconds: env.otpExpiryMinutes * 60,
    })
  } catch (error) {
    if (error?.code === 11000) {
      error.statusCode = 409
      error.message = 'An account with this email already exists.'
    }
    next(error)
  }
}

export const resendOtp = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      throwHttpError('No account found for this email.', 404)
    }
    if (user.isVerified) {
      throwHttpError('This account is already verified. Please log in.')
    }

    const otpCode = generateOtpCode()
    user.otpHash = hashOtp(otpCode)
    user.otpExpiry = new Date(Date.now() + env.otpExpiryMinutes * 60 * 1000)
    await user.save()

    await sendOtpEmail({
      name: user.name,
      email: user.email,
      otpCode,
      expiresInMinutes: env.otpExpiryMinutes,
    })

    response.json({
      message: 'A new OTP has been sent to your email.',
      email: user.email,
      otpExpiresInSeconds: env.otpExpiryMinutes * 60,
    })
  } catch (error) {
    next(error)
  }
}

export const verifyOtp = async (request, response, next) => {
  try {
    const normalizedEmail = normalizeEmail(request.body?.email)
    const otpCode = String(request.body?.otp || '').trim()

    if (!normalizedEmail || !emailPattern.test(normalizedEmail)) {
      throwHttpError('Valid email is required.')
    }
    if (!otpPattern.test(otpCode)) {
      throwHttpError('OTP must be a 6-digit code.')
    }

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      throwHttpError('No account found for this email.', 404)
    }
    if (user.isVerified) {
      const token = createAuthToken(user)
      await ensureLinkedUserProfile(user._id)
      response.json({
        message: 'Account already verified.',
        token,
        user: toSafeUser(user),
      })
      return
    }

    const hasOtp = Boolean(user.otpHash && user.otpExpiry)
    if (!hasOtp) {
      throwHttpError('No OTP is pending for this account.')
    }
    if (new Date(user.otpExpiry).getTime() < Date.now()) {
      throwHttpError('OTP has expired. Please request a new code.')
    }

    const providedOtpHash = hashOtp(otpCode)
    if (providedOtpHash !== user.otpHash) {
      throwHttpError('Invalid OTP code.')
    }

    user.isVerified = true
    user.otpHash = ''
    user.otpExpiry = null
    user.lastLoginAt = new Date()
    await user.save()
    await ensureLinkedUserProfile(user._id)

    const token = createAuthToken(user)
    response.json({
      message: 'Account verified successfully.',
      token,
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const login = async (request, response, next) => {
  try {
    const { email, password } = request.body || {}
    validateLoginPayload({ email, password })
    const normalizedEmail = normalizeEmail(email)

    const user = await User.findOne({ email: normalizedEmail })
    if (!user) {
      throwHttpError('Invalid email or password.', 401)
    }
    if (!user.passwordHash) {
      throwHttpError('This account uses Google sign in. Continue with Google instead.', 400)
    }

    const passwordMatches = await bcrypt.compare(String(password), user.passwordHash)
    if (!passwordMatches) {
      throwHttpError('Invalid email or password.', 401)
    }
    if (!user.isVerified) {
      throwHttpError('Please verify your email with OTP before logging in.', 403)
    }

    user.lastLoginAt = new Date()
    await user.save()
    await ensureLinkedUserProfile(user._id)

    const token = createAuthToken(user)
    response.json({
      message: 'Login successful.',
      token,
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const googleAuth = async (request, response, next) => {
  try {
    const idToken = String(request.body?.token || request.body?.credential || '').trim()
    if (!idToken) {
      throwHttpError('Google credential token is required.')
    }
    if (!googleOauthClient) {
      throwHttpError('Google login is not configured on server.', 503)
    }

    const ticket = await googleOauthClient.verifyIdToken({
      idToken,
      audience: env.googleClientId,
    })
    const payload = ticket.getPayload()

    const email = normalizeEmail(payload?.email)
    if (!email || !emailPattern.test(email)) {
      throwHttpError('Google account email is unavailable.', 400)
    }
    if (!payload?.email_verified) {
      throwHttpError('Google account email is not verified.', 400)
    }

    const name = normalizeName(payload?.name || email.split('@')[0] || 'User')
    const googleId = String(payload?.sub || '').trim()
    if (!googleId) {
      throwHttpError('Google account identifier is unavailable.', 400)
    }

    let user = await User.findOne({ email })
    if (!user) {
      user = await User.create({
        name,
        email,
        isVerified: true,
        googleId,
        avatarUrl: String(payload?.picture || ''),
        authProviders: {
          emailPassword: false,
          google: true,
        },
        lastLoginAt: new Date(),
      })
    } else {
      user.googleId = googleId
      user.isVerified = true
      user.authProviders = {
        emailPassword: Boolean(user.authProviders?.emailPassword || user.passwordHash),
        google: true,
      }
      if (!user.name) user.name = name
      if (!user.avatarUrl && payload?.picture) {
        user.avatarUrl = String(payload.picture)
      }
      user.lastLoginAt = new Date()
      user.otpHash = ''
      user.otpExpiry = null
      await user.save()
    }

    await ensureLinkedUserProfile(user._id)

    const token = createAuthToken(user)
    response.json({
      message: 'Google login successful.',
      token,
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const getCurrentUser = async (request, response, next) => {
  try {
    const userId = String(request.user?.userId || '').trim()
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throwHttpError('Invalid authentication token.', 401)
    }

    const user = await User.findById(userId)
    if (!user) {
      throwHttpError('User not found.', 404)
    }

    response.json({
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

export const updateCurrentUser = async (request, response, next) => {
  try {
    const userId = String(request.user?.userId || '').trim()
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throwHttpError('Invalid authentication token.', 401)
    }

    const nextName = normalizeName(request.body?.name)
    if (!nextName) {
      throwHttpError('Name is required.')
    }
    if (nextName.length > 120) {
      throwHttpError('Name must be at most 120 characters.')
    }

    const user = await User.findById(userId)
    if (!user) {
      throwHttpError('User not found.', 404)
    }

    user.name = nextName
    await user.save()

    response.json({
      message: 'Profile updated successfully.',
      user: toSafeUser(user),
    })
  } catch (error) {
    next(error)
  }
}

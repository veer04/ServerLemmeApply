import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { env } from '../config/environment.js'

const resolveToken = (request) => {
  const authorizationHeader = String(request.headers.authorization || '').trim()
  if (authorizationHeader.toLowerCase().startsWith('bearer ')) {
    return authorizationHeader.slice(7).trim()
  }

  const queryToken = String(request.query?.token || '').trim()
  if (queryToken) return queryToken

  const fallbackHeaderToken = String(request.headers['x-access-token'] || '').trim()
  if (fallbackHeaderToken) return fallbackHeaderToken

  return ''
}

const resolveGuestId = (request) => {
  const headerGuestId = String(request.headers['x-guest-id'] || '').trim()
  if (headerGuestId) return headerGuestId
  const headerSessionId = String(request.headers['x-session-id'] || '').trim()
  if (headerSessionId) return headerSessionId
  const queryGuestId = String(request.query?.guestId || '').trim()
  if (queryGuestId) return queryGuestId
  const querySessionId = String(request.query?.sessionId || '').trim()
  if (querySessionId) return querySessionId
  return ''
}

export const requireAuth = (request, _response, next) => {
  try {
    const token = resolveToken(request)
    if (!token) {
      const error = new Error('Authentication required.')
      error.statusCode = 401
      throw error
    }

    const decoded = jwt.verify(token, env.jwtSecret)
    const userId = String(decoded?.sub || '').trim()
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      const error = new Error('Invalid authentication token.')
      error.statusCode = 401
      throw error
    }

    request.user = {
      userId,
      email: String(decoded?.email || '').trim(),
      name: String(decoded?.name || '').trim(),
    }
    next()
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 401
      error.message = 'Invalid or expired authentication token.'
    }
    next(error)
  }
}

export const requireAuthOrGuest = (request, _response, next) => {
  try {
    const token = resolveToken(request)
    if (token) {
      const decoded = jwt.verify(token, env.jwtSecret)
      const userId = String(decoded?.sub || '').trim()
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        const error = new Error('Invalid authentication token.')
        error.statusCode = 401
        throw error
      }

      request.user = {
        userId,
        email: String(decoded?.email || '').trim(),
        name: String(decoded?.name || '').trim(),
        isGuest: false,
      }
      next()
      return
    }

    const guestId = resolveGuestId(request)
    if (!guestId) {
      const error = new Error('Authentication or guest session required.')
      error.statusCode = 401
      throw error
    }

    if (!mongoose.Types.ObjectId.isValid(guestId)) {
      const error = new Error('Invalid guest session.')
      error.statusCode = 401
      throw error
    }

    request.user = {
      userId: guestId,
      email: '',
      name: 'Guest',
      isGuest: true,
    }
    next()
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 401
      error.message = 'Invalid authentication or guest session.'
    }
    next(error)
  }
}

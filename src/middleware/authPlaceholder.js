import mongoose from 'mongoose'

const normalizeCandidate = (value) => {
  const normalized = String(value || '').trim()
  return normalized || ''
}

const isValidUserId = (value) => mongoose.Types.ObjectId.isValid(String(value || '').trim())

/**
 * Production-safety auth placeholder:
 * - requires an explicit user id (header/query/body/params)
 * - validates ObjectId format
 * - rejects mismatched ids across multiple sources
 */
export const authPlaceholder = (request, _response, next) => {
  const headerUserId = normalizeCandidate(request.headers['x-user-id'])
  const queryUserId = normalizeCandidate(request.query?.userId)
  const bodyUserId = normalizeCandidate(request.body?.userId)
  const paramUserId = normalizeCandidate(request.params?.userId)

  const candidates = [headerUserId, queryUserId, bodyUserId, paramUserId].filter(Boolean)
  if (candidates.length === 0) {
    const error = new Error('Authentication required: x-user-id is missing.')
    error.statusCode = 401
    next(error)
    return
  }

  const normalizedCandidates = candidates.map((candidate) => String(candidate).toLowerCase())
  const uniqueCandidates = [...new Set(normalizedCandidates)]
  if (uniqueCandidates.length > 1) {
    const error = new Error('Conflicting user identity in request.')
    error.statusCode = 403
    next(error)
    return
  }

  const resolvedUserId = candidates[0]
  if (!isValidUserId(resolvedUserId)) {
    const error = new Error('Invalid user identity. Expected a valid ObjectId.')
    error.statusCode = 401
    next(error)
    return
  }

  request.user = {
    userId: resolvedUserId,
  }

  next()
}

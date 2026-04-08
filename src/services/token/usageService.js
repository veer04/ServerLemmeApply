import mongoose from 'mongoose'
import { GUEST_LIMITS, USER_LIMITS } from '../../config/limits.js'
import { UserUsage } from '../../models/UserUsage.js'
import { getISTTime } from '../../utils/time.js'

const normalizeObjectId = (value) => {
  const normalized = String(value || '').trim()
  if (!normalized || !mongoose.Types.ObjectId.isValid(normalized)) return null
  return normalized
}

export const extractIpAddress = (request) => {
  const forwardedFor = String(request?.headers?.['x-forwarded-for'] || '').trim()
  const firstForwardedIp = forwardedFor ? forwardedFor.split(',')[0].trim() : ''
  const remoteAddress = String(request?.socket?.remoteAddress || '').trim()
  const resolved = firstForwardedIp || remoteAddress || 'unknown'
  return resolved.replace(/^::ffff:/i, '')
}

export const resolveUsageIdentityFromRequest = (request) => {
  const candidateUserId = normalizeObjectId(request?.user?.userId)
  const explicitlyGuest = Boolean(request?.user?.isGuest)
  const isGuest = explicitlyGuest || !candidateUserId

  return {
    isGuest,
    userId: isGuest ? null : candidateUserId,
    ipAddress: extractIpAddress(request),
  }
}

export const normalizeUsageMeta = (value) => {
  const payload = value && typeof value === 'object' ? value : {}
  const normalizedUserId = normalizeObjectId(payload.userId)
  const isGuest = Boolean(payload.isGuest) || !normalizedUserId

  return {
    isGuest,
    userId: isGuest ? null : normalizedUserId,
    ipAddress: String(payload.ipAddress || '').trim() || 'unknown',
    inputText: String(payload.inputText || '').trim(),
  }
}

export const getLimitsForIdentity = (identity) => {
  return identity?.isGuest ? GUEST_LIMITS : USER_LIMITS
}

const getNextHourlyReset = (fromDate = new Date()) => {
  const next = new Date(fromDate)
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  return next
}

const getNextDailyReset = (fromDate = new Date()) => {
  const next = new Date(fromDate)
  next.setHours(24, 0, 0, 0)
  return next
}

const buildUsageQuery = (identity) => {
  if (identity?.isGuest) {
    return {
      userId: null,
      ipAddress: String(identity?.ipAddress || '').trim() || 'unknown',
    }
  }
  return {
    userId: new mongoose.Types.ObjectId(identity.userId),
  }
}

const buildUsageWindowStage = ({ identity, now, nextHourlyReset, nextDailyReset }) => {
  const resetHourlyExpr = {
    $lte: [{ $ifNull: ['$hourlyResetAt', now] }, now],
  }
  const resetDailyExpr = {
    $lte: [{ $ifNull: ['$dailyResetAt', now] }, now],
  }

  return {
    $set: {
      userId: identity?.isGuest ? null : new mongoose.Types.ObjectId(identity.userId),
      ipAddress: String(identity?.ipAddress || '').trim() || 'unknown',
      hourlyTokensUsed: {
        $cond: [resetHourlyExpr, 0, { $ifNull: ['$hourlyTokensUsed', 0] }],
      },
      dailyTokensUsed: {
        $cond: [resetDailyExpr, 0, { $ifNull: ['$dailyTokensUsed', 0] }],
      },
      hourlyResetAt: {
        $cond: [resetHourlyExpr, nextHourlyReset, { $ifNull: ['$hourlyResetAt', nextHourlyReset] }],
      },
      dailyResetAt: {
        $cond: [resetDailyExpr, nextDailyReset, { $ifNull: ['$dailyResetAt', nextDailyReset] }],
      },
      lastRequestAt: now,
    },
  }
}

export const syncUsageWindow = async (identity) => {
  const normalizedIdentity = normalizeUsageMeta(identity)
  const now = new Date()
  const nextHourlyReset = getNextHourlyReset(now)
  const nextDailyReset = getNextDailyReset(now)

  return UserUsage.findOneAndUpdate(
    buildUsageQuery(normalizedIdentity),
    [
      buildUsageWindowStage({
        identity: normalizedIdentity,
        now,
        nextHourlyReset,
        nextDailyReset,
      }),
    ],
    {
      upsert: true,
      new: true,
    },
  )
}

export const incrementUsageTokensAtomic = async (identity, tokensToAdd = 0) => {
  const normalizedIdentity = normalizeUsageMeta(identity)
  const now = new Date()
  const nextHourlyReset = getNextHourlyReset(now)
  const nextDailyReset = getNextDailyReset(now)
  const safeIncrement = Math.max(0, Math.round(Number(tokensToAdd || 0)))

  return UserUsage.findOneAndUpdate(
    buildUsageQuery(normalizedIdentity),
    [
      buildUsageWindowStage({
        identity: normalizedIdentity,
        now,
        nextHourlyReset,
        nextDailyReset,
      }),
      {
        $set: {
          hourlyTokensUsed: {
            $add: [{ $ifNull: ['$hourlyTokensUsed', 0] }, safeIncrement],
          },
          dailyTokensUsed: {
            $add: [{ $ifNull: ['$dailyTokensUsed', 0] }, safeIncrement],
          },
          lastRequestAt: now,
        },
      },
    ],
    {
      upsert: true,
      new: true,
    },
  )
}

export const buildTokenUsagePayload = ({ usage, limits }) => {
  const safeLimits = limits || GUEST_LIMITS
  const hourlyLimit = Math.max(1, Number(safeLimits.hourly || 0))
  const dailyLimit = Math.max(1, Number(safeLimits.daily || 0))
  const hourlyUsed = Math.max(0, Number(usage?.hourlyTokensUsed || 0))
  const dailyUsed = Math.max(0, Number(usage?.dailyTokensUsed || 0))
  const hourlyRemaining = Math.max(0, hourlyLimit - hourlyUsed)
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed)
  const hourlyRatio = hourlyUsed / hourlyLimit
  const dailyRatio = dailyUsed / dailyLimit
  const activeScope = dailyRatio > hourlyRatio ? 'daily' : 'hourly'

  const used = activeScope === 'daily' ? dailyUsed : hourlyUsed
  const limit = activeScope === 'daily' ? dailyLimit : hourlyLimit
  const remaining = Math.max(0, limit - used)
  const resetDate = activeScope === 'daily' ? usage?.dailyResetAt : usage?.hourlyResetAt

  return {
    used,
    limit,
    remaining,
    resetAt: getISTTime(resetDate || new Date()),
    resetAtIso: resetDate ? new Date(resetDate).toISOString() : null,
    scope: activeScope,
    hourly: {
      used: hourlyUsed,
      limit: hourlyLimit,
      remaining: hourlyRemaining,
      resetAt: getISTTime(usage?.hourlyResetAt || new Date()),
      resetAtIso: usage?.hourlyResetAt
        ? new Date(usage.hourlyResetAt).toISOString()
        : null,
    },
    daily: {
      used: dailyUsed,
      limit: dailyLimit,
      remaining: dailyRemaining,
      resetAt: getISTTime(usage?.dailyResetAt || new Date()),
      resetAtIso: usage?.dailyResetAt ? new Date(usage.dailyResetAt).toISOString() : null,
    },
  }
}

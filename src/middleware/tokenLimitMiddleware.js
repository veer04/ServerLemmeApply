import {
  buildTokenUsagePayload,
  getLimitsForIdentity,
  resolveUsageIdentityFromRequest,
  syncUsageWindow,
} from '../services/token/usageService.js'
import { getISTTime } from '../utils/time.js'

export const tokenLimitMiddleware = async (request, response, next) => {
  try {
    const identity = resolveUsageIdentityFromRequest(request)
    const limits = getLimitsForIdentity(identity)
    const usage = await syncUsageWindow(identity)
    const hourlyExceeded = Number(usage.hourlyTokensUsed || 0) >= Number(limits.hourly || 0)
    const dailyExceeded = Number(usage.dailyTokensUsed || 0) >= Number(limits.daily || 0)

    request.usage = usage
    request.usageContext = {
      ...identity,
      limits,
      tokenUsage: buildTokenUsagePayload({ usage, limits }),
    }

    if (hourlyExceeded || dailyExceeded) {
      const isHourlyBlock = hourlyExceeded
      const retryDate = isHourlyBlock ? usage.hourlyResetAt : usage.dailyResetAt
      const baseMessage = isHourlyBlock ? 'Hourly limit reached' : 'Daily limit reached'
      const message = identity.isGuest ? `${baseMessage}. Login to continue.` : baseMessage

      response.status(429).json({
        success: false,
        message,
        retryAt: getISTTime(retryDate),
        tokenUsage: request.usageContext?.tokenUsage || null,
      })
      return
    }

    next()
  } catch (error) {
    next(error)
  }
}

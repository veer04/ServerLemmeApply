import mongoose from 'mongoose'

const getNextHourlyReset = () => {
  const now = new Date()
  now.setMinutes(0, 0, 0)
  now.setHours(now.getHours() + 1)
  return now
}

const getNextDailyReset = () => {
  const now = new Date()
  now.setHours(24, 0, 0, 0)
  return now
}

const userUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    ipAddress: {
      type: String,
      required: true,
      trim: true,
      default: '',
    },
    hourlyTokensUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    dailyTokensUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    hourlyResetAt: {
      type: Date,
      default: getNextHourlyReset,
    },
    dailyResetAt: {
      type: Date,
      default: getNextDailyReset,
    },
    lastRequestAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
)

userUsageSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $type: 'objectId' } },
  },
)
userUsageSchema.index({ userId: 1, ipAddress: 1 }, { unique: true })
userUsageSchema.index({ ipAddress: 1 })

export const UserUsage = mongoose.model('UserUsage', userUsageSchema)

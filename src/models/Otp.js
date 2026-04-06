import mongoose from 'mongoose'

const otpChallengeSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    purpose: {
      type: String,
      required: true,
      enum: ['signup', 'login', 'password_reset'],
    },
    otpHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true },
)

// Ensure there is only one active challenge per email + purpose.
otpChallengeSchema.index({ email: 1, purpose: 1 }, { unique: true })
// Auto-delete expired OTP docs.
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const OtpChallenge = mongoose.model('OtpChallenge', otpChallengeSchema)

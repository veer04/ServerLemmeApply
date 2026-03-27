import mongoose from 'mongoose'

const integrationSchema = new mongoose.Schema(
  {
    connected: { type: Boolean, default: false },
    accountEmail: { type: String, default: '' },
    accountId: { type: String, default: '' },
    connectedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
)

const automationPreferenceSchema = new mongoose.Schema(
  {
    preferredRole: { type: String, default: '' },
    preferredLocation: { type: String, default: '' },
    preferredSalaryRange: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 0 },
      currency: { type: String, default: 'INR' },
    },
    preferredSkills: { type: [String], default: [] },
  },
  { _id: false },
)

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, default: '' },
    isVerified: { type: Boolean, default: false },
    otpHash: { type: String, default: '' },
    otpExpiry: { type: Date, default: null },
    googleId: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    authProviders: {
      emailPassword: { type: Boolean, default: false },
      google: { type: Boolean, default: false },
    },
    automationPreferences: {
      type: automationPreferenceSchema,
      default: () => ({}),
    },
    integrations: {
      gmail: { type: integrationSchema, default: () => ({}) },
      whatsapp: { type: integrationSchema, default: () => ({}) },
      linkedin: { type: integrationSchema, default: () => ({}) },
    },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
)

const sanitize = (document) => {
  if (!document) return null

  const source = typeof document.toObject === 'function' ? document.toObject() : document
  return {
    id: String(source._id || ''),
    name: source.name || '',
    email: source.email || '',
    isVerified: Boolean(source.isVerified),
    avatarUrl: source.avatarUrl || '',
    authProviders: source.authProviders || { emailPassword: false, google: false },
    createdAt: source.createdAt || null,
    lastLoginAt: source.lastLoginAt || null,
  }
}

export const toSafeUser = sanitize

export const User = mongoose.model('User', userSchema)

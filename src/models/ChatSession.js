import mongoose from 'mongoose'

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
)

const attachmentSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    filePath: { type: String, required: true },
  },
  { _id: false },
)

const jobSchema = new mongoose.Schema(
  {
    source: { type: String, default: 'unknown' },
    externalId: { type: String, default: '' },
    jobHash: { type: String, default: '' },
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: String, default: 'Not specified' },
    salary: { type: String, default: 'Not disclosed' },
    description: { type: String, default: '' },
    applyLink: { type: String, default: '#' },
    matchScore: { type: Number, default: 0 },
    matchReasons: { type: [String], default: [] },
    scrapedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const profileSchema = new mongoose.Schema(
  {
    role: { type: String, default: '' },
    primarySkills: { type: [String], default: [] },
    secondarySkills: { type: [String], default: [] },
    experienceYears: { type: Number, default: 0 },
    locationPreference: { type: String, default: '' },
    remotePreference: { type: Boolean, default: false },
    salaryExpectation: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 0 },
      currency: { type: String, default: 'INR' },
      type: { type: String, default: 'LPA' },
    },
    seniorityLevel: { type: String, default: '' },
  },
  { _id: false },
)

const chatSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    prompt: {
      type: String,
      required: true,
      trim: true,
    },
    resumeText: {
      type: String,
      default: '',
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    preferenceProfile: {
      type: profileSchema,
      default: () => ({}),
    },
    messages: {
      type: [messageSchema],
      default: [],
    },
    conversationHistory: {
      type: [messageSchema],
      default: [],
    },
    structuredProfile: {
      type: profileSchema,
      default: () => ({}),
    },
    jobs: {
      type: [jobSchema],
      default: [],
    },
    lastScrapedJobs: {
      type: [jobSchema],
      default: [],
    },
    filteredJobs: {
      type: [jobSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
    },
    errorMessage: {
      type: String,
      default: '',
    },
  },
  { timestamps: true },
)

export const ChatSession = mongoose.model('ChatSession', chatSessionSchema)

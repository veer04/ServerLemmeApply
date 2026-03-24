import mongoose from 'mongoose'

const compensationSchema = new mongoose.Schema(
  {
    min: { type: Number, default: 0 },
    max: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    type: { type: String, default: 'LPA' },
  },
  { _id: false },
)

const userProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    resumeUrl: { type: String, default: '' },
    skills: { type: [String], default: [] },
    experience: { type: String, default: '' },
    package: {
      type: compensationSchema,
      default: () => ({}),
    },
    bookmarks: {
      type: [
        {
          externalId: { type: String, default: '' },
          title: { type: String, required: true },
          company: { type: String, default: '' },
          location: { type: String, default: 'Not specified' },
          salary: { type: String, default: 'Not disclosed' },
          source: { type: String, default: '' },
          applyLink: { type: String, default: '#' },
          matchScore: { type: Number, default: 0 },
          bookmarkedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
)

export const UserProfile = mongoose.model('UserProfile', userProfileSchema)

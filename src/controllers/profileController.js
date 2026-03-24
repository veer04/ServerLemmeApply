import path from 'node:path'
import mongoose from 'mongoose'
import { UserProfile } from '../models/UserProfile.js'

const allowedExperience = [
  'Fresher / College Student',
  '1+ Years',
  '2+ Years',
  '3+ Years',
  '5+ Years',
  '7+ Years',
  '10+ Years',
]

const allowedCurrencies = ['INR', 'USD', 'EUR']
const allowedPackageTypes = ['LPA', 'CTC', 'Monthly', 'Yearly']

const toObjectId = (value, fieldName) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    const error = new Error(`${fieldName} must be a valid ObjectId.`)
    error.statusCode = 400
    throw error
  }

  return new mongoose.Types.ObjectId(value)
}

const sanitizeSkills = (skills) => {
  if (!Array.isArray(skills)) return []

  return [...new Set(skills.map((item) => String(item).trim()).filter(Boolean))].slice(0, 50)
}

const serializeProfile = (profileDocument) => {
  const packageData = profileDocument.package || {}
  const bookmarks = Array.isArray(profileDocument.bookmarks) ? profileDocument.bookmarks : []

  return {
    userId: profileDocument.userId.toString(),
    resumeUrl: profileDocument.resumeUrl || '',
    skills: profileDocument.skills || [],
    experience: profileDocument.experience || '',
    package: {
      min: Number(packageData.min || 0),
      max: Number(packageData.max || 0),
      currency: packageData.currency || 'INR',
      type: packageData.type || 'LPA',
    },
    bookmarks: bookmarks
      .map((bookmark) => ({
        externalId: bookmark.externalId || '',
        title: bookmark.title,
        company: bookmark.company || '',
        location: bookmark.location || 'Not specified',
        salary: bookmark.salary || 'Not disclosed',
        source: bookmark.source || '',
        applyLink: bookmark.applyLink || '#',
        matchScore: Number(bookmark.matchScore || 0),
        bookmarkedAt: bookmark.bookmarkedAt || profileDocument.updatedAt,
      }))
      .sort((left, right) => new Date(right.bookmarkedAt) - new Date(left.bookmarkedAt)),
    createdAt: profileDocument.createdAt,
    updatedAt: profileDocument.updatedAt,
  }
}

const getOrCreateProfile = async (userIdObjectId) => {
  return UserProfile.findOneAndUpdate(
    { userId: userIdObjectId },
    { $setOnInsert: { userId: userIdObjectId } },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  )
}

export const getUserProfile = async (request, response, next) => {
  try {
    const userId = toObjectId(request.params.userId, 'userId')
    const profile = await getOrCreateProfile(userId)

    response.json({
      profile: serializeProfile(profile),
    })
  } catch (error) {
    next(error)
  }
}

export const uploadResume = async (request, response, next) => {
  try {
    if (!request.file) {
      const error = new Error('Resume file is required.')
      error.statusCode = 400
      throw error
    }

    const userId = toObjectId(request.user.userId, 'userId')
    const resumeUrl = `/uploads/${path.basename(request.file.path)}`

    const profile = await UserProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          resumeUrl,
        },
        $setOnInsert: {
          userId,
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    )

    response.status(201).json({
      message: 'Resume uploaded successfully.',
      profile: serializeProfile(profile),
      fileName: request.file.originalname,
    })
  } catch (error) {
    next(error)
  }
}

export const saveSkills = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user.userId, 'userId')
    const skills = sanitizeSkills(request.body.skills)

    const profile = await UserProfile.findOneAndUpdate(
      { userId },
      {
        $set: { skills },
        $setOnInsert: { userId },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    )

    response.json({
      message: 'Skills saved successfully.',
      profile: serializeProfile(profile),
    })
  } catch (error) {
    next(error)
  }
}

export const saveExperience = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user.userId, 'userId')
    const experience = String(request.body.experience || '').trim()

    if (!allowedExperience.includes(experience)) {
      const error = new Error('Invalid experience value.')
      error.statusCode = 400
      throw error
    }

    const profile = await UserProfile.findOneAndUpdate(
      { userId },
      {
        $set: { experience },
        $setOnInsert: { userId },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    )

    response.json({
      message: 'Experience saved successfully.',
      profile: serializeProfile(profile),
    })
  } catch (error) {
    next(error)
  }
}

export const savePackage = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user.userId, 'userId')
    const payload = request.body.package || request.body

    const min = Number(payload.min)
    const max = Number(payload.max)
    const currency = String(payload.currency || '').trim().toUpperCase()
    const type = String(payload.type || '').trim()

    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) {
      const error = new Error('Invalid package range. Ensure min/max are valid and min <= max.')
      error.statusCode = 400
      throw error
    }

    if (!allowedCurrencies.includes(currency)) {
      const error = new Error('Invalid currency.')
      error.statusCode = 400
      throw error
    }

    if (!allowedPackageTypes.includes(type)) {
      const error = new Error('Invalid package type.')
      error.statusCode = 400
      throw error
    }

    const profile = await UserProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          package: { min, max, currency, type },
        },
        $setOnInsert: { userId },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    )

    response.json({
      message: 'Package expectation saved successfully.',
      profile: serializeProfile(profile),
    })
  } catch (error) {
    next(error)
  }
}

export const clearProfileInputs = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user.userId, 'userId')

    const profile = await UserProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          resumeUrl: '',
          skills: [],
          experience: '',
          package: {
            min: 0,
            max: 0,
            currency: 'INR',
            type: 'LPA',
          },
        },
        $setOnInsert: { userId },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    )

    response.json({
      message: 'Profile input data cleared successfully.',
      profile: serializeProfile(profile),
    })
  } catch (error) {
    next(error)
  }
}

export const toggleBookmark = async (request, response, next) => {
  try {
    const userId = toObjectId(request.user.userId, 'userId')
    const job = request.body.job || {}
    const externalId = String(job.externalId || '').trim()
    const title = String(job.title || '').trim()
    const applyLink = String(job.applyLink || '#').trim()
    const company = String(job.company || '').trim()
    const location = String(job.location || 'Not specified').trim()
    const salary = String(job.salary || 'Not disclosed').trim()
    const source = String(job.source || '').trim()
    const matchScore = Number(job.matchScore || 0)
    const shouldBookmark = Boolean(request.body.shouldBookmark)

    if (!title) {
      const error = new Error('Job title is required to bookmark.')
      error.statusCode = 400
      throw error
    }

    const bookmarkKey = externalId || `${title}-${company}-${applyLink}`

    const profile = await getOrCreateProfile(userId)
    const currentBookmarks = Array.isArray(profile.bookmarks) ? profile.bookmarks : []
    const withoutBookmark = currentBookmarks.filter((bookmark) => {
      const key = bookmark.externalId || `${bookmark.title}-${bookmark.company}-${bookmark.applyLink}`
      return key !== bookmarkKey
    })

    const nextBookmarks = shouldBookmark
      ? [
          {
            externalId,
            title,
            company,
            location,
            salary,
            source,
            applyLink,
            matchScore,
            bookmarkedAt: new Date(),
          },
          ...withoutBookmark,
        ]
      : withoutBookmark

    profile.bookmarks = nextBookmarks.slice(0, 50)
    await profile.save()

    response.json({
      message: shouldBookmark ? 'Job bookmarked successfully.' : 'Bookmark removed.',
      profile: serializeProfile(profile),
    })
  } catch (error) {
    next(error)
  }
}

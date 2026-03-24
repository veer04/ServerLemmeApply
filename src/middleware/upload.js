import { mkdirSync } from 'node:fs'
import path from 'node:path'
import multer from 'multer'

const uploadsDirectory = path.resolve(process.cwd(), 'uploads')
mkdirSync(uploadsDirectory, { recursive: true })

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    callback(null, uploadsDirectory)
  },
  filename: (_request, file, callback) => {
    const timestamp = Date.now()
    const safeOriginalName = file.originalname.replace(/\s+/g, '-')
    callback(null, `${timestamp}-${safeOriginalName}`)
  },
})

export const upload = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
})

const allowedResumeMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
])

const allowedResumeExtensions = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg'])

const resumeFileFilter = (_request, file, callback) => {
  const extension = path.extname(file.originalname || '').toLowerCase()
  const isAllowedMime = allowedResumeMimeTypes.has(file.mimetype)
  const isAllowedExtension = allowedResumeExtensions.has(extension)

  if (isAllowedMime || isAllowedExtension) {
    callback(null, true)
    return
  }

  callback(
    new Error('Unsupported resume format. Use pdf/doc/docx/png/jpg/jpeg files only.'),
  )
}

export const profileResumeUpload = multer({
  storage,
  fileFilter: resumeFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
})

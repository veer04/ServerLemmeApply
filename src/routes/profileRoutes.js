import { Router } from 'express'
import {
  clearProfileInputs,
  getUserProfile,
  saveExperience,
  savePackage,
  saveSkills,
  toggleBookmark,
  uploadResume,
} from '../controllers/profileController.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { profileResumeUpload } from '../middleware/upload.js'

export const profileRouter = Router()

profileRouter.use(requireAuth)

profileRouter.post('/resume-upload', profileResumeUpload.single('resume'), uploadResume)
profileRouter.post('/save-skills', saveSkills)
profileRouter.post('/save-experience', saveExperience)
profileRouter.post('/save-package', savePackage)
profileRouter.post('/clear-inputs', clearProfileInputs)
profileRouter.post('/bookmarks/toggle', toggleBookmark)
profileRouter.get('/me', getUserProfile)

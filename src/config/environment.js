import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'

dotenv.config()

const defaultGcpCredentialsPath = path.resolve(process.cwd(), 'src/config/gcp-key.json')
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(defaultGcpCredentialsPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = defaultGcpCredentialsPath
}

const inferProjectIdFromCredentials = () => {
  try {
    const credentialPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
    if (!credentialPath || !fs.existsSync(credentialPath)) return ''
    const rawCredentials = fs.readFileSync(credentialPath, 'utf8')
    const parsed = JSON.parse(rawCredentials)
    return String(parsed.project_id || '').trim()
  } catch {
    return ''
  }
}

const parseTargets = (rawTargets) => {
  if (!rawTargets) return []

  return rawTargets
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongoDbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aaply',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  vertexProject:
    process.env.VERTEX_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    inferProjectIdFromCredentials(),
  vertexLocation: process.env.VERTEX_LOCATION || 'us-central1',
  geminiModel: process.env.VERTEX_MODEL || process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 35000),
  jobDebugEnabled: parseBoolean(process.env.JOB_DEBUG_ENABLED, process.env.NODE_ENV !== 'production'),
  scrapeTargets: parseTargets(process.env.SCRAPE_TARGETS),
}

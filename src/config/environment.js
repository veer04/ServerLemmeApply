import dotenv from 'dotenv'
import fs from 'node:fs'

dotenv.config()

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

const parseOrigins = (rawOrigins) => {
  return [...new Set(
    parseTargets(rawOrigins)
      .map((origin) => {
        try {
          const parsed = new URL(String(origin || '').trim())
          if (!/^https?:$/i.test(parsed.protocol)) return ''
          return `${parsed.protocol}//${parsed.host}`
        } catch {
          return ''
        }
      })
      .filter(Boolean),
  )]
}

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

const parseNumber = (value, fallback) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const defaultClientOrigin = 'http://localhost:5173'
const clientOrigins = parseOrigins(process.env.CLIENT_ORIGIN || defaultClientOrigin)

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongoDbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aaply',
  redisUrl: process.env.REDIS_URL || '',
  sessionDispatchMode: String(process.env.SESSION_DISPATCH_MODE || 'inline')
    .toLowerCase()
    .trim(),
  sessionQueueName: String(process.env.SESSION_QUEUE_NAME || 'aaply-session-processing').trim(),
  sessionQueueConcurrency: parseNumber(process.env.SESSION_QUEUE_CONCURRENCY, 2),
  sessionWorkerEnabled: parseBoolean(process.env.SESSION_WORKER_ENABLED, false),
  clientOrigins,
  clientOrigin: clientOrigins[0] || '',
  jwtSecret: String(process.env.JWT_SECRET || 'dev_jwt_secret_change_me').trim(),
  jwtExpiresIn: String(process.env.JWT_EXPIRES_IN || '7d').trim(),
  otpExpiryMinutes: parseNumber(process.env.OTP_EXPIRY_MINUTES, 5),
  sendgridApiKey: String(process.env.SENDGRID_API_KEY || '').trim(),
  emailFrom: String(process.env.EMAIL_FROM || process.env.SENDGRID_FROM || '').trim(),
  smtpHost: String(process.env.SMTP_HOST || '').trim(),
  smtpPort: parseNumber(process.env.SMTP_PORT, 587),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, false),
  smtpUser: String(process.env.SMTP_USER || '').trim(),
  smtpPass: String(process.env.SMTP_PASS || '').trim(),
  smtpFrom: String(process.env.SMTP_FROM || '').trim(),
  googleClientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  vertexProject:
    process.env.VERTEX_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    inferProjectIdFromCredentials(),
  vertexLocation: process.env.VERTEX_LOCATION || 'us-central1',
  geminiModel: process.env.VERTEX_MODEL || process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 35000),
  jobDebugEnabled: parseBoolean(process.env.JOB_DEBUG_ENABLED, process.env.NODE_ENV !== 'production'),
  resumeExtractTimeoutMs: parseNumber(process.env.RESUME_EXTRACT_TIMEOUT_MS, 30000),
  resumeOcrTimeoutMs: parseNumber(process.env.RESUME_OCR_TIMEOUT_MS, 45000),
  resumeOcrEnabled: parseBoolean(process.env.RESUME_OCR_ENABLED, true),
  scrapeTargets: parseTargets(process.env.SCRAPE_TARGETS),
}

const assertProductionEnvironment = (resolvedEnv) => {
  if (resolvedEnv.nodeEnv !== 'production') return

  const missing = []
  if (!String(process.env.MONGODB_URI || '').trim()) {
    missing.push('MONGODB_URI')
  }
  if (!String(process.env.CLIENT_ORIGIN || '').trim()) {
    missing.push('CLIENT_ORIGIN')
  }
  if (!String(process.env.JWT_SECRET || '').trim() || resolvedEnv.jwtSecret === 'dev_jwt_secret_change_me') {
    missing.push('JWT_SECRET')
  }
  if (!String(process.env.VERTEX_PROJECT_ID || process.env.GCP_PROJECT_ID || '').trim()) {
    missing.push('VERTEX_PROJECT_ID (or GCP_PROJECT_ID)')
  }

  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`)
  }

  if (!['inline', 'queue'].includes(resolvedEnv.sessionDispatchMode)) {
    throw new Error('SESSION_DISPATCH_MODE must be either "inline" or "queue".')
  }

  if (resolvedEnv.clientOrigins.length === 0) {
    throw new Error('CLIENT_ORIGIN must include at least one valid http/https origin.')
  }

  if (resolvedEnv.sessionDispatchMode === 'queue' && !resolvedEnv.redisUrl) {
    throw new Error('REDIS_URL is required when SESSION_DISPATCH_MODE=queue.')
  }
}

assertProductionEnvironment(env)

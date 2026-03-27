import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/environment.js'

const MAX_EXTRACTED_CHARS = 120000
const MAX_OCR_FILE_SIZE_BYTES = 6 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[resume-extractor] ${message}`, context)
}

const cleanText = (value) => {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS)
}

const withTimeout = async (promise, timeoutMs, label) => {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

const parsePdfResume = async (file) => {
  const { default: pdfParse } = await import('pdf-parse')
  const buffer = await readFile(file.path)
  const parsed = await pdfParse(buffer)
  return cleanText(parsed.text || '')
}

const parsePlainTextResume = async (file) => {
  const text = await readFile(file.path, 'utf8')
  return cleanText(text)
}

const parseDocxResume = async (file) => {
  const { default: mammoth } = await import('mammoth')
  const parsed = await mammoth.extractRawText({ path: file.path })
  return cleanText(parsed.value || '')
}

const parseDocResume = async (file) => {
  const { default: WordExtractor } = await import('word-extractor')
  const extractor = new WordExtractor()
  const parsed = await extractor.extract(file.path)
  const merged = [
    parsed?.getBody?.(),
    parsed?.getFootnotes?.(),
    parsed?.getHeaders?.(),
    parsed?.getAnnotations?.(),
  ]
    .map((segment) => String(segment || '').trim())
    .filter(Boolean)
    .join(' ')
  return cleanText(merged)
}

const parseImageResumeWithOcr = async (file) => {
  if (!env.resumeOcrEnabled) return ''
  if (Number(file.size || 0) > MAX_OCR_FILE_SIZE_BYTES) {
    debugLog('skipping OCR due to file size', {
      size: Number(file.size || 0),
      maxAllowed: MAX_OCR_FILE_SIZE_BYTES,
    })
    return ''
  }

  const { createWorker } = await import('tesseract.js')
  const worker = await withTimeout(
    createWorker('eng'),
    env.resumeOcrTimeoutMs,
    'OCR worker initialization',
  )

  try {
    const result = await withTimeout(
      worker.recognize(file.path),
      env.resumeOcrTimeoutMs,
      'Image OCR',
    )
    return cleanText(result?.data?.text || '')
  } finally {
    await worker.terminate().catch(() => {})
  }
}

const runExtractorSafely = async (label, extractor, file) => {
  const startedAt = Date.now()
  try {
    const result = await withTimeout(
      extractor(file),
      env.resumeExtractTimeoutMs,
      `${label} extraction`,
    )
    const cleaned = cleanText(result)
    debugLog('extractor completed', {
      label,
      chars: cleaned.length,
      elapsedMs: Date.now() - startedAt,
    })
    return cleaned
  } catch (error) {
    debugLog('extractor failed', {
      label,
      elapsedMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return ''
  }
}

export const extractResumeText = async (file) => {
  if (!file) return ''

  const mimeType = String(file.mimetype || '').toLowerCase()
  const extension = path.extname(file.originalname || file.path || '').toLowerCase()
  const isPdf = mimeType.includes('pdf') || extension === '.pdf'
  const isDocx =
    mimeType.includes('vnd.openxmlformats-officedocument.wordprocessingml.document') ||
    extension === '.docx'
  const isDoc = mimeType.includes('msword') || extension === '.doc'
  const isText = mimeType.startsWith('text/')
  const isImage = mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)

  const extractionPlan = []
  if (isPdf) extractionPlan.push(['pdf', parsePdfResume])
  if (isDocx) extractionPlan.push(['docx', parseDocxResume])
  if (isDoc) extractionPlan.push(['doc', parseDocResume])
  if (isText) extractionPlan.push(['text', parsePlainTextResume])
  if (isImage) extractionPlan.push(['image-ocr', parseImageResumeWithOcr])

  // Conservative fallback for uncertain MIME types but known extensions.
  if (extractionPlan.length === 0) {
    if (extension === '.docx') extractionPlan.push(['docx', parseDocxResume])
    if (extension === '.doc') extractionPlan.push(['doc', parseDocResume])
    if (IMAGE_EXTENSIONS.has(extension)) extractionPlan.push(['image-ocr', parseImageResumeWithOcr])
  }

  for (const [label, extractor] of extractionPlan) {
    const extracted = await runExtractorSafely(label, extractor, file)
    if (extracted) return extracted
  }

  return ''
}

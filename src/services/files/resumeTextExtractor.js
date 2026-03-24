import { readFile } from 'node:fs/promises'

const cleanText = (value) => {
  return value.replace(/\s+/g, ' ').trim()
}

export const extractResumeText = async (file) => {
  if (!file) return ''

  const mimeType = file.mimetype || ''

  if (mimeType.includes('pdf')) {
    try {
      const { default: pdfParse } = await import('pdf-parse')
      const buffer = await readFile(file.path)
      const parsed = await pdfParse(buffer)
      return cleanText(parsed.text || '')
    } catch {
      return ''
    }
  }

  if (mimeType.startsWith('text/')) {
    try {
      const text = await readFile(file.path, 'utf8')
      return cleanText(text)
    } catch {
      return ''
    }
  }

  return ''
}

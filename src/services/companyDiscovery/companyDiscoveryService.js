import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { VertexAI } from '@google-cloud/vertexai'
import { env } from '../../config/environment.js'

const DISCOVERY_CACHE_TTL_MS = 1000 * 60 * 45
const DISCOVERY_MAX_COMPANIES = 26
const CAREER_VALIDATE_TIMEOUT_MS = 12000
const VALIDATION_CONCURRENCY = 4
const KEYWORD_SIGNAL_REGEX = /\b(job|jobs|career|careers|opening|openings|position|vacancy|hiring)\b/i
const ATS_SIGNAL_REGEX = /(greenhouse|lever|workdayjobs|ashbyhq|smartrecruiters)/i
const CAREER_PATH_HINTS = ['/careers', '/jobs', '/careers/jobs', '/join-us', '/work-with-us']

const discoveryCache = new Map()

const modelName = env.geminiModel
const vertexClient = env.vertexProject
  ? new VertexAI({
      project: env.vertexProject,
      location: env.vertexLocation,
    })
  : null

const knownCompanyCareerMap = {
  google: 'https://careers.google.com',
  alphabet: 'https://careers.google.com',
  amazon: 'https://www.amazon.jobs',
  microsoft: 'https://jobs.careers.microsoft.com',
  meta: 'https://www.metacareers.com',
  apple: 'https://www.apple.com/careers',
  openai: 'https://openai.com/careers',
  anthropic: 'https://www.anthropic.com/careers',
  netflix: 'https://jobs.netflix.com',
  adobe: 'https://careers.adobe.com',
  uber: 'https://www.uber.com/us/en/careers',
  airbnb: 'https://careers.airbnb.com',
  atlassian: 'https://www.atlassian.com/company/careers',
  stripe: 'https://stripe.com/jobs/search',
  swiggy: 'https://careers.swiggy.com',
  zomato: 'https://www.zomato.com/careers',
  meesho: 'https://meesho.io/jobs',
  flipkart: 'https://www.flipkartcareers.com',
  razorpay: 'https://razorpay.com/jobs',
  cred: 'https://careers.cred.club',
  phonepe: 'https://www.phonepe.com/careers',
  paytm: 'https://paytm.com/careers',
  tcs: 'https://www.tcs.com/careers',
  infosys: 'https://www.infosys.com/careers',
  wipro: 'https://careers.wipro.com',
  accenture: 'https://www.accenture.com/in-en/careers/jobsearch',
}

const staticCompanyCatalog = [
  'Google',
  'Amazon',
  'Microsoft',
  'Meta',
  'Apple',
  'OpenAI',
  'Anthropic',
  'Adobe',
  'Atlassian',
  'Stripe',
  'Uber',
  'Airbnb',
  'Swiggy',
  'Zomato',
  'Meesho',
  'Flipkart',
  'Razorpay',
  'PhonePe',
  'Paytm',
  'CRED',
  'TCS',
  'Infosys',
  'Wipro',
  'Accenture',
  'Juspay',
  'Navi',
  'Groww',
  'Freshworks',
]

const normalize = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

const normalizeUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!/^https?:$/i.test(parsed.protocol)) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim()

const buildCacheKey = ({ role, skills, location }) => {
  const stablePayload = JSON.stringify({
    role: normalize(role).toLowerCase(),
    skills: (Array.isArray(skills) ? skills : [])
      .map((skill) => normalize(skill).toLowerCase())
      .filter(Boolean)
      .slice(0, 12),
    location: normalize(location).toLowerCase(),
  })
  return crypto.createHash('sha256').update(stablePayload).digest('hex')
}

const getCachedDiscovery = (cacheKey) => {
  const cached = discoveryCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    discoveryCache.delete(cacheKey)
    return null
  }
  return cached.urls
}

const setCachedDiscovery = (cacheKey, urls) => {
  discoveryCache.set(cacheKey, {
    urls,
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
  })
}

const buildDiscoveryQueries = ({ role, skills, location }) => {
  const roleValue = normalize(role) || 'software engineer'
  const topSkills = (Array.isArray(skills) ? skills : [])
    .map((skill) => normalize(skill))
    .filter(Boolean)
    .slice(0, 3)
  const locationValue = normalize(location) || 'global'
  const skillText = topSkills.length > 0 ? ` ${topSkills.join(' ')}` : ''

  return [
    `top product companies hiring ${roleValue}${skillText}`,
    `top startups in ${locationValue} tech hiring ${roleValue}`,
    `companies hiring remote ${roleValue}`,
    `${roleValue} jobs direct company careers`,
  ]
}

const getVertexModel = () => {
  if (!vertexClient) return null
  return vertexClient.getGenerativeModel({ model: modelName })
}

const parseGeminiJson = (text) => {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

const discoverCompaniesWithGemini = async ({ role, skills, location, queries }) => {
  const model = getVertexModel()
  if (!model) return []

  const prompt = `
You are discovering company hiring sources for job scraping.
Return ONLY valid JSON:
{
  "companies": [
    { "name": "", "careerUrl": "", "domain": "" }
  ]
}

Rules:
- Focus on direct company career pages.
- Include India + global + remote friendly companies.
- Avoid job board domains.
- Include at most ${DISCOVERY_MAX_COMPANIES} entries.

Input role: ${role}
Input skills: ${JSON.stringify(skills)}
Input location: ${location}
Search query hints: ${JSON.stringify(queries)}
`

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    })
    const text = result?.response?.candidates?.[0]?.content?.parts
      ?.map((part) => String(part?.text || ''))
      ?.join('\n')
    const parsed = parseGeminiJson(text)
    const companies = Array.isArray(parsed?.companies) ? parsed.companies : []
    return companies.slice(0, DISCOVERY_MAX_COMPANIES)
  } catch {
    return []
  }
}

const buildCareerUrlsForCompany = (company) => {
  const name = normalize(company?.name || '')
  const domain = normalize(company?.domain || '')
  const careerUrl = normalizeUrl(company?.careerUrl || '')

  const urls = []
  if (careerUrl) urls.push(careerUrl)

  const nameKey = slugify(name).replace(/-/g, '')
  if (nameKey && knownCompanyCareerMap[nameKey]) {
    urls.push(knownCompanyCareerMap[nameKey])
  }

  const normalizedDomain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .trim()

  if (normalizedDomain) {
    urls.push(`https://${normalizedDomain}`)
    urls.push(`https://www.${normalizedDomain}`)
    CAREER_PATH_HINTS.forEach((pathHint) => {
      urls.push(`https://${normalizedDomain}${pathHint}`)
      urls.push(`https://www.${normalizedDomain}${pathHint}`)
    })
  } else if (name) {
    const slug = slugify(name)
    if (slug) {
      urls.push(`https://www.${slug}.com`)
      CAREER_PATH_HINTS.forEach((pathHint) => {
        urls.push(`https://www.${slug}.com${pathHint}`)
      })
    }
  }

  return [...new Set(urls.map((url) => normalizeUrl(url)).filter(Boolean))]
}

const buildFallbackCompanyCandidates = ({ role, skills, location }) => {
  const roleText = normalize(role).toLowerCase()
  const locationText = normalize(location).toLowerCase()
  const skillText = (Array.isArray(skills) ? skills : []).join(' ').toLowerCase()

  const prioritized = [...staticCompanyCatalog]
  if (/ai|ml|genai|llm/.test(`${roleText} ${skillText}`)) {
    prioritized.unshift('OpenAI', 'Anthropic', 'Google', 'Microsoft')
  }
  if (/india|bangalore|bengaluru|pune|hyderabad|noida|gurgaon|mumbai|delhi/.test(locationText)) {
    prioritized.unshift('Swiggy', 'Zomato', 'Meesho', 'Razorpay', 'PhonePe')
  }

  return [...new Set(prioritized)].slice(0, DISCOVERY_MAX_COMPANIES)
}

const validateCareerUrls = async (urls, options = {}) => {
  const candidates = [...new Set((Array.isArray(urls) ? urls : []).map((url) => normalizeUrl(url)).filter(Boolean))]
  if (candidates.length === 0) return []

  const timeoutMs = Math.max(8000, Math.min(15000, Number(options.timeoutMs || CAREER_VALIDATE_TIMEOUT_MS)))
  const concurrency = Math.max(1, Math.min(VALIDATION_CONCURRENCY, Number(options.concurrency || VALIDATION_CONCURRENCY)))

  const providedBrowser = options.browser || null
  const browser = providedBrowser || (await chromium.launch({ headless: true }))
  const validated = []
  let cursor = 0

  const worker = async () => {
    while (cursor < candidates.length) {
      const currentIndex = cursor
      cursor += 1
      const candidateUrl = candidates[currentIndex]
      const page = await browser.newPage()

      try {
        const response = await page.goto(candidateUrl, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        })
        const status = Number(response?.status?.() || 0)
        if (status >= 400) continue

        await page.waitForTimeout(650)
        const signal = await page.evaluate(() => {
          const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim()
          const topLinks = Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 120)
            .map((anchor) => `${anchor.textContent || ''} ${anchor.getAttribute('href') || ''}`)
            .join(' ')
          return `${bodyText.slice(0, 5000)} ${topLinks.slice(0, 3000)}`
        })

        if (!KEYWORD_SIGNAL_REGEX.test(signal) && !ATS_SIGNAL_REGEX.test(candidateUrl)) continue
        validated.push(candidateUrl)
      } catch {
        // ignore invalid candidates
      } finally {
        await page.close().catch(() => {})
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  if (!providedBrowser) {
    await browser.close().catch(() => {})
  }

  return [...new Set(validated)]
}

export const discoverCompanyCareerPages = async (
  { role = '', skills = [], location = '' } = {},
  options = {},
) => {
  const cacheKey = buildCacheKey({ role, skills, location })
  const cached = getCachedDiscovery(cacheKey)
  if (cached) return cached

  const queries = buildDiscoveryQueries({ role, skills, location })
  const llmCompanies = await discoverCompaniesWithGemini({
    role,
    skills,
    location,
    queries,
  })

  const fallbackCompanies = buildFallbackCompanyCandidates({ role, skills, location }).map((name) => ({
    name,
    careerUrl: '',
    domain: '',
  }))

  const candidates = [...llmCompanies, ...fallbackCompanies]
    .slice(0, DISCOVERY_MAX_COMPANIES)
    .flatMap((company) => buildCareerUrlsForCompany(company))

  const validated = await validateCareerUrls(candidates, {
    browser: options.browser,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
  })

  const bounded = validated.slice(0, Math.max(8, Number(options.maxUrls || 20)))
  setCachedDiscovery(cacheKey, bounded)
  return bounded
}

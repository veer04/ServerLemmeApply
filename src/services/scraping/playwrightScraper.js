import { chromium } from 'playwright'
import { env } from '../../config/environment.js'
import { discoverJobSourcesWithGemini } from '../gemini/geminiService.js'
import { getLearnedSourcesForProfile } from './sourceMemoryStore.js'

const debugLog = (message, context = {}) => {
  if (!env.jobDebugEnabled) return
  // eslint-disable-next-line no-console
  console.log(`[playwright-scraper] ${message}`, context)
}

const defaultTargets = [
  // Global hiring platforms
  'https://www.linkedin.com/jobs/search/?keywords={query}',
  'https://wellfound.com/jobs?query={query}',
  'https://angel.co/jobs?query={query}',
  'https://www.naukri.com/{query}-jobs',
  'https://www.instahyre.com/search-jobs/?q={query}',
  'https://www.indeed.com/jobs?q={query}',
  'https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords={query}',
  'https://www.glassdoor.com/Job/jobs.htm?sc.keyword={query}',
  'https://www.workindia.in/jobs?q={query}',
  'https://www.hirist.tech/search/{query}',
  'https://unstop.com/jobs?search={query}',
  'https://internshala.com/jobs/{query}',

  // MAANG / Bigtech
  'https://www.apple.com/careers/us/search?search={query}',
  'https://www.amazon.jobs/en/search?base_query={query}',
  'https://careers.google.com/jobs/results/?q={query}',
  'https://jobs.careers.microsoft.com/global/en/search?q={query}',
  'https://www.metacareers.com/jobs/?q={query}',
  'https://www.oracle.com/careers/search/?keyword={query}',
  'https://www.paypal.com/us/webapps/mpp/jobs/search?keywords={query}',
  'https://careers.walmart.com/results?q={query}',
  'https://www.nokia.com/about-us/careers/jobs/?q={query}',
  'https://careers.rubrik.com/jobs?search={query}',
  'https://www.ibm.com/careers/search?keyword={query}',
  'https://careers.honeywell.com/en/sites/Honeywell',
  'https://jobs.cisco.com/jobs/SearchJobs/?keyword={query}',
  'https://search.jobs.barclays/job-search-results/?keywords={query}',
  'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced?q={query}',

  // Indian IT / Enterprise
  'https://www.tcs.com/careers/search-results?q={query}',
  'https://www.infosys.com/careers/job-opportunities/?keyword={query}',
  'https://www.ericsson.com/en/careers/job-search?q={query}',
  'https://careers.optum.com/search-results?keywords={query}',
  'https://careers.telusdigital.com/search-results?keywords={query}',
  'https://careers.expediagroup.com/jobs?keyword={query}',
  'https://jobs.intuit.com/search-jobs?keyword={query}',
  'https://www.atlassian.com/company/careers/all-jobs?query={query}',
  'https://jobs.visa.com/jobs/search?q={query}',
  'https://careers.mastercard.com/us/en/search-results?keywords={query}',
  'https://careers.qualcomm.com/search-jobs?keyword={query}',
  'https://careers.jpmorgan.com/global/en/search-results?keywords={query}',
  'https://www.goldmansachs.com/careers/students/programs/search?keyword={query}',
  'https://careers.mahindra.com/search?q={query}',
  'https://careers.larsentoubro.com/search/?q={query}',
  'https://www.genpact.com/careers/search-jobs?keyword={query}',

  // Indian tech startups
  'https://careers.swiggy.com/#/jobs?search={query}',
  'https://www.zomato.com/careers',
  'https://meesho.io/jobs?search={query}',
  'https://careers.jar.com/jobs?search={query}',
  'https://juspay.io/careers#jobs',

  // Global tech
  'https://openai.com/careers/search?query={query}',
  'https://www.anthropic.com/careers',
  'https://www.tesla.com/careers/search/?query={query}',
  'https://www.bmwgroup.jobs/en/jobfinder/jobfinder.html?search={query}',
  'https://www.volvogroup.com/en/careers/job-search.html?search={query}',

  // Existing high-signal fallback
  'https://www.ycombinator.com/jobs',
  'https://remoteok.com/remote-dev-jobs',
  'https://www.monsterindia.com/srp/results?query={query}',
]

const targetMatchers = {
  remote: [/remoteok/i, /linkedin\.com\/jobs/i, /wellfound/i, /angel\.co/i],
  india: [
    /naukri/i,
    /instahyre/i,
    /timesjobs/i,
    /workindia/i,
    /hirist/i,
    /internshala/i,
    /swiggy/i,
    /zomato/i,
    /meesho/i,
    /mahindra/i,
    /larsentoubro/i,
    /genpact/i,
    /infosys/i,
    /tcs/i,
    /\.in\//i,
  ],
  bigtech: [
    /apple/i,
    /amazon/i,
    /google/i,
    /microsoft/i,
    /meta/i,
    /oracle/i,
    /paypal/i,
    /walmart/i,
    /nokia/i,
    /ibm/i,
    /cisco/i,
    /adobe/i,
    /atlassian/i,
    /visa/i,
    /mastercard/i,
    /qualcomm/i,
    /jpmorgan/i,
    /goldmansachs/i,
    /openai/i,
    /anthropic/i,
    /tesla/i,
  ],
  intern: [/internshala/i, /unstop/i],
  startup: [/wellfound/i, /angel\.co/i, /ycombinator/i, /swiggy/i, /zomato/i, /meesho/i],
}

const getConfiguredTargets = () => {
  return env.scrapeTargets.length > 0 ? env.scrapeTargets : defaultTargets
}

const dedupeUrls = (urls) => {
  const deduped = []
  const seen = new Set()
  for (const item of urls) {
    try {
      const normalized = new URL(String(item || '').trim()).toString()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      deduped.push(normalized)
    } catch {
      // Ignore invalid URLs
    }
  }
  return deduped
}

const getHostFromUrl = (value) => {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return String(value || '').toLowerCase()
  }
}

const buildSearchQuery = (profile) => {
  const terms = [
    profile.role || '',
    ...(profile.primarySkills || []),
    ...(profile.secondarySkills || []),
    profile.locationPreference || '',
    profile.remotePreference ? 'remote' : '',
    profile.seniorityLevel || '',
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)

  if (terms.length === 0) return 'software engineer'
  return terms.slice(0, 6).join(' ')
}

const getSourceGroup = (targetUrl) => {
  if (targetMatchers.india.some((matcher) => matcher.test(targetUrl))) return 'india'
  if (targetMatchers.remote.some((matcher) => matcher.test(targetUrl))) return 'remote'
  if (targetMatchers.bigtech.some((matcher) => matcher.test(targetUrl))) return 'bigtech'
  if (targetMatchers.startup.some((matcher) => matcher.test(targetUrl))) return 'startup'
  return 'other'
}

const diversifyTargetOrder = (urls) => {
  const grouped = {
    remote: [],
    india: [],
    bigtech: [],
    startup: [],
    other: [],
  }

  urls.forEach((url) => {
    grouped[getSourceGroup(url)].push(url)
  })

  const orderedGroups = ['india', 'remote', 'bigtech', 'startup', 'other']
  const diversified = []
  const seenHosts = new Set()
  let hasRemaining = true

  while (hasRemaining) {
    hasRemaining = false

    for (const group of orderedGroups) {
      const queue = grouped[group]
      if (!queue || queue.length === 0) continue
      hasRemaining = true

      let selectedUrl = ''
      const maxAttempts = queue.length
      for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
        const candidate = queue.shift()
        const host = getHostFromUrl(candidate)
        if (!seenHosts.has(host)) {
          selectedUrl = candidate
          seenHosts.add(host)
          break
        }
        queue.push(candidate)
      }

      if (!selectedUrl && queue.length > 0) {
        selectedUrl = queue.shift()
      }

      if (selectedUrl) diversified.push(selectedUrl)
    }
  }

  return [...new Set(diversified)]
}

const resolveTargetsForProfile = (profile) => {
  const encodedQuery = encodeURIComponent(buildSearchQuery(profile))
  const profileSignals = [
    profile.role,
    ...(profile.primarySkills || []),
    ...(profile.secondarySkills || []),
    profile.seniorityLevel,
  ]
    .join(' ')
    .toLowerCase()

  const withQuery = getConfiguredTargets().map((target) =>
    target.replaceAll('{query}', encodedQuery),
  )

  const scoreTarget = (targetUrl) => {
    let score = 0

    if (targetMatchers.remote.some((matcher) => matcher.test(targetUrl))) score += 8
    if (targetMatchers.bigtech.some((matcher) => matcher.test(targetUrl))) score += 6
    if (targetMatchers.startup.some((matcher) => matcher.test(targetUrl))) score += 4

    if (
      /intern|fresher|college|student|entry/i.test(profileSignals) &&
      targetMatchers.intern.some((matcher) => matcher.test(targetUrl))
    ) {
      score += 22
    }

    if (
      profile.remotePreference &&
      targetMatchers.remote.some((matcher) => matcher.test(targetUrl))
    ) {
      score += 28
    }

    if (
      /india|bangalore|bengaluru|pune|hyderabad|noida|gurgaon|gurugram|mumbai|delhi/i.test(
        String(profile.locationPreference || ''),
      ) &&
      targetMatchers.india.some((matcher) => matcher.test(targetUrl))
    ) {
      score += 26
    }

    if (/ai|ml|machine learning|data science|llm|genai/i.test(profileSignals)) {
      if (/openai|anthropic|google|tesla/i.test(targetUrl)) score += 20
    }

    if (/product/i.test(profileSignals) && targetMatchers.bigtech.some((matcher) => matcher.test(targetUrl))) {
      score += 12
    }

    return score
  }

  const prioritized = withQuery
    .map((url) => ({ url, score: scoreTarget(url) }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.url)

  return diversifyTargetOrder([...new Set(prioritized)])
}

export const getDynamicTargets = async (profile, options = {}) => {
  const startedAt = Date.now()
  const requestedMaxTargets = Math.max(8, Math.min(30, Number(options.maxTargets || 18)))
  // 1) Reuse learned successful sources.
  // 2) Ask Gemini for fresh dynamic targets.
  // 3) Keep static targets as deterministic fallback.
  const fallbackTargets = resolveTargetsForProfile(profile)
  const learnedTargets = await getLearnedSourcesForProfile(profile, 12)
  debugLog('source pools prepared', {
    fallbackCount: fallbackTargets.length,
    learnedCount: learnedTargets.length,
    requestedMaxTargets,
  })

  const discoveredTargets = await discoverJobSourcesWithGemini({
    profile,
    fallbackTargets: [...learnedTargets, ...fallbackTargets].slice(0, 35),
    maxTargets: Math.min(28, requestedMaxTargets + 4),
  })
  debugLog('gemini discovery completed', {
    discoveredCount: discoveredTargets.length,
  })

  const merged = dedupeUrls([
    ...discoveredTargets,
    ...learnedTargets,
    ...fallbackTargets,
  ])

  const diversified = diversifyTargetOrder(merged)
  const bounded = diversified.slice(0, requestedMaxTargets)

  if (bounded.length >= Math.min(12, requestedMaxTargets)) {
    debugLog('dynamic targets resolved', {
      selectedCount: bounded.length,
      elapsedMs: Date.now() - startedAt,
    })
    return bounded
  }

  const fallbackResolved = diversifyTargetOrder(
    dedupeUrls([...bounded, ...fallbackTargets]),
  ).slice(0, requestedMaxTargets)
  debugLog('dynamic targets fallback resolved', {
    selectedCount: fallbackResolved.length,
    elapsedMs: Date.now() - startedAt,
  })
  return fallbackResolved
}

const guessCompanyName = (url) => {
  try {
    const hostname = new URL(url).hostname.replace('www.', '')
    return hostname.split('.').slice(0, 2).join('.')
  } catch {
    return 'Unknown company'
  }
}

const sanitizeText = (value) => {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

const sanitizeLocation = (value) => {
  const cleaned = sanitizeText(value)
    .replace(/^text\s+/i, '')
    .replace(/^clear\s+text\s+/i, '')
    .replace(/\s+\|\s+/g, ' ')
    .replace(/\s{2,}/g, ' ')
  if (!cleaned) return 'Not specified'
  if (/^(job|jobs|career|careers|apply)$/i.test(cleaned)) return 'Not specified'
  return cleaned
}

const sanitizeSalary = (value) => {
  const cleaned = sanitizeText(value)
  if (!cleaned) return 'Not disclosed'
  if (/^(na|n\/a|not disclosed|not specified)$/i.test(cleaned)) return 'Not disclosed'
  return cleaned
}

const roleKeywordRegex =
  /\b(engineer|developer|architect|analyst|designer|manager|scientist|consultant|specialist|intern|sre|devops|qa|product|full[-\s]?stack|frontend|backend)\b/i

const noisyTitlePatterns = [
  /skip to main content/i,
  /^sign in$/i,
  /^join now$/i,
  /^linkedin$/i,
  /^log in$/i,
  /^login$/i,
  /^register$/i,
  /^apply$/i,
  /^home$/i,
  /^jobs$/i,
  /^students$/i,
  /^search$/i,
  /^help$/i,
  /help (center|link|article)/i,
  /^contact us$/i,
  /upload your resume/i,
  /find salaries/i,
  /create job alert/i,
  /how we work|how we hire|your career/i,
  /homehome|jobsjobs|studentsstudents/i,
  /help (center|centre|centrum)/i,
  /artikel/i,
  /article du centre/i,
  /centro de ayuda/i,
  /hilfe[-\s]?center/i,
  /sign in to create job alert/i,
  /create job alert/i,
  /^skip to main content$/i,
]

const noisyLinkPatterns = [
  /linkedin\.com\/(feed|checkpoint|uas|authwall|learning|in\/)/i,
  /indeed\.com\/(career-advice|hire|career\/|account|profile)/i,
  /glassdoor\..*\/(about|about-us|blog|member|index\.htm)/i,
  /google\.com\/about/i,
  /\/help/i,
  /\/support/i,
  /\/about/i,
  /\/privacy/i,
  /\/terms/i,
  /\/login/i,
  /\/signup/i,
  /\/register/i,
  /linkedin\.com\/jobs\/search/i,
  /glassdoor\..*\/Job\/.*SRCH_/i,
  /careers\.google\.com\/jobs\/results\/?\?/i,
  /help-center/i,
]

const hasRepeatedTokenNoise = (title) => {
  const tokens = String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (tokens.length < 3) return false
  const first = tokens[0]
  const repeats = tokens.filter((token) => token === first).length
  return repeats >= Math.max(2, Math.floor(tokens.length * 0.6))
}

const platformCompanyPatterns = [
  /linkedin(\.com)?/i,
  /indeed(\.com)?/i,
  /glassdoor/i,
  /ycombinator/i,
  /wellfound/i,
  /naukri/i,
  /monster/i,
  /timesjobs/i,
  /workindia/i,
]

const nonEnglishTitlePatterns = [
  /article du centre d['’]?aide/i,
  /hilfe[-\s]?center[-\s]?artikel/i,
  /helpcentrum[-\s]?artikel/i,
  /art[ií]culo del centro de ayuda/i,
  /\bcentre d['’]?aide\b/i,
]

const locationSuffixPattern =
  /(remote|hybrid|on[-\s]?site|[a-z][a-z\s.'-]{1,40},\s*[A-Z]{2}|[a-z][a-z\s.'-]{1,40},\s*[a-z]{2,30}|new york|san francisco|london|berlin|singapore)$/i

const isEnglishLikeTitle = (title) => {
  const cleaned = sanitizeText(title)
  if (!cleaned) return false
  if (/[^\x00-\x7F]/.test(cleaned)) return false
  if (nonEnglishTitlePatterns.some((pattern) => pattern.test(cleaned))) return false

  const tokens = cleaned.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const englishishTokens = tokens.filter((token) => /[A-Za-z]/.test(token)).length
  return englishishTokens >= Math.max(1, Math.floor(tokens.length * 0.5))
}

const hasStrongJobTitleSignal = (title) => {
  const cleaned = sanitizeText(title)
  if (!cleaned) return false
  if (roleKeywordRegex.test(cleaned)) return true
  return /\b(software|engineering|internship|intern|principal|staff|lead|associate)\b/i.test(
    cleaned,
  )
}

const inferCompanyFromJob = (job) => {
  const title = sanitizeText(job.title)
  const description = sanitizeText(job.description)
  const location = sanitizeText(job.location)

  const fromTitleAt = title.match(
    /\bat\s+([A-Z][A-Za-z0-9&.'-]{1,40}(?:\s+[A-Z][A-Za-z0-9&.'-]{1,40}){0,2})$/,
  )
  if (fromTitleAt?.[1]) return sanitizeText(fromTitleAt[1])

  const fromDescriptionAt = description.match(
    /\bat\s+([A-Z][A-Za-z0-9&.'-]{1,40}(?:\s+[A-Z][A-Za-z0-9&.'-]{1,40}){0,2})\b/,
  )
  if (fromDescriptionAt?.[1]) return sanitizeText(fromDescriptionAt[1])

  const locationPrefix = location.match(
    /^([A-Z][A-Za-z0-9&.'-]{1,30}(?:\s+[A-Z][A-Za-z0-9&.'-]{1,30}){0,2})\s+(.+)$/,
  )
  if (locationPrefix?.[1] && locationSuffixPattern.test(locationPrefix[2])) {
    return sanitizeText(locationPrefix[1])
  }

  return ''
}

const normalizeCompanyAndLocation = (job) => {
  const sourceHost = getHostFromUrl(job.source || '')
  const rawCompany = sanitizeText(job.company)
  const rawLocation = sanitizeLocation(job.location)
  const isPlatformCompany =
    !rawCompany ||
    rawCompany.toLowerCase() === sourceHost ||
    platformCompanyPatterns.some((pattern) => pattern.test(rawCompany))

  const inferredCompany = inferCompanyFromJob(job)
  const company = isPlatformCompany
    ? inferredCompany || 'Hiring company not disclosed'
    : rawCompany

  const locationParts = rawLocation.match(
    /^([A-Z][A-Za-z0-9&.'-]{1,30}(?:\s+[A-Z][A-Za-z0-9&.'-]{1,30}){0,2})\s+(.+)$/,
  )
  const location =
    locationParts &&
    company !== 'Hiring company not disclosed' &&
    sanitizeText(locationParts[1]).toLowerCase() === company.toLowerCase() &&
    locationSuffixPattern.test(locationParts[2])
      ? sanitizeLocation(locationParts[2])
      : rawLocation

  return {
    company,
    location,
  }
}

const isLikelyNoiseJob = (job) => {
  const title = sanitizeText(job.title)
  const link = sanitizeText(job.applyLink)
  const description = sanitizeText(job.description)
  const sourceHost = getHostFromUrl(job.source || '')
  const combined = `${title} ${description}`.toLowerCase()

  if (!title || title.length < 4) return true
  if (!isEnglishLikeTitle(title)) return true
  if (!hasStrongJobTitleSignal(title)) return true
  if (noisyTitlePatterns.some((pattern) => pattern.test(title))) return true
  if (hasRepeatedTokenNoise(title)) return true
  if (noisyLinkPatterns.some((pattern) => pattern.test(link))) return true
  if (/help center|help centre|article du centre|hilfe|centro de ayuda/i.test(combined)) {
    return true
  }
  if (/sign in|join now|create job alert|help center|troubleshooting|contact us/i.test(description)) {
    return true
  }
  if (/^([a-z]+){3,}$/i.test(title.replace(/\s+/g, ''))) return true

  if (!roleKeywordRegex.test(title) && !roleKeywordRegex.test(description)) {
    return true
  }

  if (sourceHost.includes('linkedin.com') && !/\/jobs\/view/i.test(link)) {
    return true
  }

  if (
    sourceHost.includes('careers.google.com') &&
    !/\/jobs\/results\/\d+/i.test(link)
  ) {
    return true
  }

  if (sourceHost.includes('indeed.com') && !/\/viewjob/i.test(link)) {
    return true
  }

  if (sourceHost.includes('glassdoor') && !/job-listing|\/partner\/joblisting/i.test(link)) {
    return true
  }

  return false
}

const scrapePageJobs = async (page, sourceUrl) => {
  const company = guessCompanyName(sourceUrl)

  const extracted = await page.evaluate(
    ({ fallbackCompany }) => {
      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim()
      const stopWords = new Set([
        'jobs',
        'job',
        'careers',
        'our opportunity',
        'life at stripe',
        'benefits',
        'startup jobs',
        'apply',
        'see open roles',
        'read more',
        '...read more',
        'skip to job results',
      ])

      const isLikelyJobLink = (href) => {
        if (!href) return false
        const currentUrl = window.location.href
        if (href === currentUrl) return false
        if (
          /linkedin\.com\/jobs\/search/i.test(href) ||
          /glassdoor\..*\/Job\/.*SRCH_/i.test(href) ||
          /careers\.google\.com\/jobs\/results\/?\?/i.test(href) ||
          /\/help(-center)?\//i.test(href) ||
          /\/(login|signup|register|about|privacy|terms)(\/|$)/i.test(href)
        ) {
          return false
        }

        if (
          /linkedin\.com\/jobs\/view/i.test(href) ||
          /\/viewjob/i.test(href) ||
          /job-listing/i.test(href) ||
          /\/job-detail/i.test(href) ||
          /\/careers?\//i.test(href) ||
          /\/positions?\//i.test(href) ||
          /\/openings?\//i.test(href) ||
          /job-listings/i.test(href) ||
          /remote-jobs/i.test(href) ||
          /gh_jid=/i.test(href) ||
          /naukri\.com\/job-listings/i.test(href) ||
          /monsterindia\.com\/.*job/i.test(href) ||
          /indeed\.com\/viewjob/i.test(href) ||
          /instahyre\.com\/job/i.test(href) ||
          /glassdoor\..*\/job-listing/i.test(href) ||
          /timesjobs\.com\/job-detail/i.test(href) ||
          /workindia\.in\/jobs\//i.test(href) ||
          /wellfound\.com\/company\/.*\/jobs/i.test(href) ||
          /ycombinator\.com\/companies\/.*\/jobs/i.test(href) ||
          /\/companies\/.+\/jobs\//i.test(href)
        ) {
          return true
        }

        try {
          const parsed = new URL(href)
          const signal = `${parsed.pathname} ${parsed.search}`
          if (
            /(job|career|position|opening|vacancy|opportunit)/i.test(signal) &&
            /\/jobs?\/|\/careers?\/|\/positions?\/|\/openings?\/|\/viewjob|job-listing|job-detail/i.test(
              signal,
            )
          ) {
            return true
          }
          if (/(privacy|terms|cookie|login|signup|register|about|blog)/i.test(signal)) return false
          return false
        } catch {
          return false
        }
      }

      const isLikelyJobTitle = (title) => {
        const text = normalize(title)
        if (text.length < 4 || text.length > 140) return false
        if (stopWords.has(text.toLowerCase())) return false
        if (/read more/i.test(text)) return false
        if (/[^\x00-\x7F]/.test(text)) return false
        if (/help (center|centre)|article du centre|hilfe|centro de ayuda|skip to main content/i.test(text)) {
          return false
        }
        if (
          !/\b(engineer|developer|architect|analyst|designer|manager|scientist|intern|devops|qa|sre|product|software|frontend|backend)\b/i.test(
            text,
          )
        ) {
          return false
        }
        if (!/[a-z]/i.test(text)) return false
        return true
      }

      const jobs = []

      const salaryRegex =
        /((\$|usd|eur|gbp|inr|₹|€|£)\s?\d[\d,]*(\.\d+)?(\s?[-to]+\s?(\$|usd|eur|gbp|inr|₹|€|£)?\s?\d[\d,]*(\.\d+)?)?\s?(per\s?(year|month|hour)|\/\s?(year|month|hour)|yearly|monthly|hourly|annually|pa|lpa|lac|lakhs?)?)/i
      const salaryAltRegex =
        /(\d[\d,]*(\.\d+)?\s?(-|to)\s?\d[\d,]*(\.\d+)?\s?(lpa|lakhs?|k|m|million|crore|ctc))/i
      const locationRegex =
        /\b(remote|hybrid|on[-\s]?site|work from home|[a-z]+(?:\s+[a-z]+){0,2},\s*[a-z]{2}|bangalore|bengaluru|pune|hyderabad|mumbai|delhi|gurgaon|gurugram|noida|chennai|kolkata|new york|san francisco|london|berlin|singapore)\b/i

      const formatJsonLdSalary = (baseSalary) => {
        if (!baseSalary) return ''

        const currency = normalize(baseSalary.currency || baseSalary?.value?.currency)
        const salaryValue = baseSalary.value || {}
        const minValue = Number(
          salaryValue.minValue ?? salaryValue.value ?? salaryValue?.[0]?.value ?? 0,
        )
        const maxValue = Number(salaryValue.maxValue ?? 0)
        const unit = normalize(salaryValue.unitText || '')

        if (!minValue && !maxValue) return ''

        const withCurrency = (amount) => {
          if (!amount) return ''
          const rounded = Number(amount).toLocaleString('en-US')
          return currency ? `${currency} ${rounded}` : rounded
        }

        if (minValue && maxValue) {
          return `${withCurrency(minValue)} - ${withCurrency(maxValue)}${unit ? ` ${unit}` : ''}`
        }

        return `${withCurrency(minValue || maxValue)}${unit ? ` ${unit}` : ''}`
      }

      const inferSalaryFromText = (text) => {
        const normalizedText = normalize(text)
        if (!normalizedText) return ''
        const salaryMatch = normalizedText.match(salaryRegex) || normalizedText.match(salaryAltRegex)
        return salaryMatch ? normalize(salaryMatch[0]) : ''
      }

      const inferLocationFromText = (text) => {
        const normalizedText = normalize(text)
        if (!normalizedText) return ''
        const locationMatch = normalizedText.match(locationRegex)
        return locationMatch ? normalize(locationMatch[0]) : ''
      }

      const pushJob = (job) => {
        if (!isLikelyJobTitle(job.title) || !isLikelyJobLink(job.applyLink)) return
        const mergedContext = normalize(
          `${job.location || ''} ${job.salary || ''} ${job.description || ''}`,
        )

        jobs.push({
          title: normalize(job.title),
          company: normalize(job.company) || fallbackCompany,
          location: normalize(job.location) || inferLocationFromText(mergedContext) || 'Not specified',
          salary: normalize(job.salary) || inferSalaryFromText(mergedContext) || 'Not disclosed',
          description: normalize(job.description),
          applyLink: job.applyLink,
        })
      }

      document.querySelectorAll('.opening').forEach((opening, index) => {
        const anchor = opening.querySelector('a')
        if (!anchor) return
        pushJob({
          title: anchor.textContent,
          company: fallbackCompany,
          location: opening.querySelector('.location')?.textContent,
          applyLink: anchor.href,
          description: opening.textContent?.slice(0, 280),
        })
        if (index > 20) return
      })

      document.querySelectorAll('.posting').forEach((posting, index) => {
        const anchor = posting.querySelector('a')
        if (!anchor) return
        pushJob({
          title:
            posting.querySelector('.posting-title h5')?.textContent || anchor.textContent,
          company: fallbackCompany,
          location: posting.querySelector('.posting-categories span')?.textContent,
          applyLink: anchor.href,
          description: posting.textContent?.slice(0, 280),
        })
        if (index > 20) return
      })

      document.querySelectorAll('a[href*="/companies/"][href*="/jobs/"]').forEach((anchor) => {
        const cardText = anchor.closest('article, li, div')?.textContent || ''
        pushJob({
          title: anchor.textContent,
          company: fallbackCompany,
          location: inferLocationFromText(cardText),
          salary: inferSalaryFromText(cardText),
          applyLink: anchor.href,
          description: cardText.slice(0, 420),
        })
      })

      document.querySelectorAll('tr.job').forEach((row) => {
        const anchor =
          row.querySelector('a[itemprop="url"]') ||
          row.querySelector('a[href*="remote-jobs"]') ||
          row.querySelector('a')
        if (!anchor) return

        pushJob({
          title:
            row.querySelector('h2')?.textContent ||
            row.querySelector('[itemprop="title"]')?.textContent ||
            anchor.textContent,
          company: row.querySelector('h3')?.textContent || fallbackCompany,
          location: row.querySelector('.location')?.textContent || row.textContent,
          applyLink: anchor.href,
          description: row.textContent?.slice(0, 280),
        })
      })

      document.querySelectorAll('script[type="application/ld+json"]').forEach((scriptTag) => {
        try {
          const parsed = JSON.parse(scriptTag.textContent || '{}')
          const items = Array.isArray(parsed) ? parsed : [parsed]
          items.forEach((item) => {
            if (item['@type'] !== 'JobPosting') return
            const locationText =
              item.jobLocation?.address?.addressLocality ||
              item.jobLocation?.address?.addressRegion ||
              item.jobLocation?.address?.addressCountry ||
              item.jobLocationType

            pushJob({
              title: item.title,
              company: item.hiringOrganization?.name || fallbackCompany,
              location: locationText,
              salary: formatJsonLdSalary(item.baseSalary) || inferSalaryFromText(item.description),
              description: item.description,
              applyLink: item.url,
            })
          })
        } catch {
          // Ignore malformed structured data.
        }
      })

      if (jobs.length === 0) {
        const anchors = Array.from(document.querySelectorAll('a[href]'))
        anchors
          .filter((anchor) => isLikelyJobLink(anchor.href))
          .slice(0, 40)
          .forEach((anchor) => {
            pushJob({
              title: anchor.textContent || anchor.getAttribute('aria-label'),
              company: fallbackCompany,
              location: inferLocationFromText(anchor.closest('article, li, div')?.textContent || ''),
              salary: inferSalaryFromText(anchor.closest('article, li, div')?.textContent || ''),
              applyLink: anchor.href,
              description: anchor.closest('article, li, div')?.textContent?.slice(0, 420),
            })
          })
      }

      return jobs
    },
    { fallbackCompany: company },
  )

  return extracted
}

export const scrapeJobsWithPlaywright = async (profile, options = {}) => {
  const safeNotify = async (callback, ...args) => {
    try {
      await callback?.(...args)
    } catch {
      // Do not fail scraping due to observer callback errors.
    }
  }

  const onStatus = options.onStatus
  const onTargetJobs = options.onTargetJobs
  const abortSignal = options.abortSignal || null
  const maxTargetsToScan = Math.max(6, Math.min(30, Number(options.maxTargetsToScan || 18)))
  const stopAfterJobs = Math.max(8, Math.min(90, Number(options.stopAfterJobs || 24)))
  const perSourceCap = Math.max(2, Math.min(10, Number(options.perSourceCap || 6)))
  const finalDiversifiedLimit = Math.max(10, Math.min(60, Number(options.finalDiversifiedLimit || 24)))
  const scrapeStartedAt = Date.now()
  const throwIfAborted = () => {
    if (!abortSignal?.aborted) return
    const abortError = new Error(String(abortSignal.reason || 'Search cancelled by user.'))
    abortError.name = 'AbortError'
    throw abortError
  }

  throwIfAborted()

  const resolvedTargets = await Promise.race([
    getDynamicTargets(profile, { maxTargets: maxTargetsToScan }),
    new Promise((resolve) => {
      setTimeout(() => {
        const fallbackTargets = resolveTargetsForProfile(profile).slice(0, maxTargetsToScan)
        debugLog('dynamic target generation timeout fallback', {
          fallbackCount: fallbackTargets.length,
        })
        resolve(fallbackTargets)
      }, 40000)
    }),
  ])
  const targets = dedupeUrls(resolvedTargets).slice(0, maxTargetsToScan)
  const targetTimeoutMs = targets.length > 20 ? 12000 : 20000
  const scraped = []
  const jobsPerHost = new Map()
  let browser

  throwIfAborted()

  await safeNotify(
    onStatus,
    `Discovered ${targets.length} sources in current batch. Starting live scraping...`,
  )

  try {
    throwIfAborted()
    browser = await chromium.launch({ headless: true })
    debugLog('browser launched', {
      targets: targets.length,
      timeoutMs: targetTimeoutMs,
      stopAfterJobs,
      perSourceCap,
    })

    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      throwIfAborted()
      const targetUrl = targets[targetIndex]
      const targetHost = getHostFromUrl(targetUrl)
      const targetStartedAt = Date.now()
      await safeNotify(
        onStatus,
        `Scanning ${targetHost} (${targetIndex + 1}/${targets.length})...`,
      )

      const page = await browser.newPage()

      try {
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: targetTimeoutMs,
        })
        await page.waitForTimeout(1200)

        const jobs = await scrapePageJobs(page, targetUrl)
        const sourceHost = getHostFromUrl(targetUrl)
        const currentCount = jobsPerHost.get(sourceHost) || 0
        const remainingSlots = Math.max(0, perSourceCap - currentCount)
        const cappedJobs = remainingSlots > 0 ? jobs.slice(0, remainingSlots) : []
        const preparedJobs = cappedJobs.map((job, index) => ({
          source: targetUrl,
          externalId: `${targetUrl}-${index}-${job.title}`,
          ...job,
        }))

        jobsPerHost.set(sourceHost, currentCount + preparedJobs.length)
        preparedJobs.forEach((job) => {
          scraped.push(job)
        })

        if (preparedJobs.length > 0) {
          await safeNotify(onTargetJobs, preparedJobs, {
            sourceUrl: targetUrl,
            sourceHost,
            targetIndex,
            totalTargets: targets.length,
            totalScraped: scraped.length,
          })
        }
        debugLog('target processed', {
          targetHost,
          targetIndex: targetIndex + 1,
          jobsFound: jobs.length,
          jobsAccepted: preparedJobs.length,
          elapsedMs: Date.now() - targetStartedAt,
        })

        await safeNotify(
          onStatus,
          `Scanned ${targetIndex + 1}/${targets.length} sources. ${scraped.length} jobs captured so far.`,
        )

        const uniqueSources = new Set(scraped.map((entry) => getHostFromUrl(entry.source))).size
        if (scraped.length >= stopAfterJobs) {
          await safeNotify(
            onStatus,
            `Captured ${scraped.length} jobs across ${uniqueSources} sources in this batch.`,
          )
          break
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        // Skip failing sources and continue with remaining URLs.
        debugLog('target failed', {
          targetHost,
          targetIndex: targetIndex + 1,
          elapsedMs: Date.now() - targetStartedAt,
        })
        await safeNotify(onStatus, `Skipping source ${targetHost} due to access/parsing issues.`)
      } finally {
        await page.close()
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    // Browser launch issues are surfaced as scrape failure below.
    debugLog('browser launch failed', {})
    await safeNotify(onStatus, 'Browser launch failed while scraping sources.')
  } finally {
    if (browser) {
      await browser.close()
      debugLog('browser closed', {
        elapsedMs: Date.now() - scrapeStartedAt,
      })
    }
  }

  const deduped = []
  const seen = new Set()
  for (const job of scraped) {
    const key = sanitizeText(`${job.title}-${job.company}-${job.applyLink}`).toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const normalizedBase = {
      ...job,
      title: sanitizeText(job.title),
      company: sanitizeText(job.company) || '',
      location: sanitizeLocation(job.location),
      salary: sanitizeSalary(job.salary),
      description: sanitizeText(job.description),
      applyLink: sanitizeText(job.applyLink),
    }
    const normalizedCompanyAndLocation = normalizeCompanyAndLocation(normalizedBase)

    deduped.push({
      ...normalizedBase,
      company: normalizedCompanyAndLocation.company,
      location: normalizedCompanyAndLocation.location,
    })
  }

  const qualityFiltered = deduped.filter((job) => !isLikelyNoiseJob(job))

  if (qualityFiltered.length === 0) {
    throw new Error(
      'No live jobs were scraped. Verify Playwright browser install and SCRAPE_TARGETS URLs.',
    )
  }
  await safeNotify(
    onStatus,
    `Scraping complete. ${qualityFiltered.length} quality jobs found (from ${deduped.length} raw unique).`,
  )

  // Keep final set diverse so one source cannot dominate.
  const groupedBySource = new Map()
  for (const job of qualityFiltered) {
    const sourceHost = getHostFromUrl(job.source)
    if (!groupedBySource.has(sourceHost)) {
      groupedBySource.set(sourceHost, [])
    }
    groupedBySource.get(sourceHost).push(job)
  }

  const sourceQueues = [...groupedBySource.values()].map((items) => items.slice(0, 4))
  const diversifiedJobs = []
  let keepIterating = true
  while (keepIterating && diversifiedJobs.length < finalDiversifiedLimit) {
    keepIterating = false
    for (const queue of sourceQueues) {
      if (queue.length === 0) continue
      keepIterating = true
      diversifiedJobs.push(queue.shift())
      if (diversifiedJobs.length >= finalDiversifiedLimit) break
    }
  }
  await safeNotify(
    onStatus,
    `Prepared ${diversifiedJobs.length} jobs from ${groupedBySource.size} sources.`,
  )
  debugLog('scrape completed', {
    rawCount: scraped.length,
    dedupedCount: deduped.length,
    qualityCount: qualityFiltered.length,
    finalCount: diversifiedJobs.length,
    sourceCount: groupedBySource.size,
    elapsedMs: Date.now() - scrapeStartedAt,
  })

  return diversifiedJobs
}

export const scrapeJobs = async (profile) => {
  return scrapeJobsWithPlaywright(profile)
}

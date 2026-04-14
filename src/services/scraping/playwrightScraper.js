import { chromium } from 'playwright'
import { env } from '../../config/environment.js'
import { discoverJobSourcesWithGemini } from '../gemini/geminiService.js'
import { discoverCompanyCareerPages } from '../companyDiscovery/companyDiscoveryService.js'
import {
  detectAtsType,
  isAtsUrl,
  scrapeJobsFromAts,
} from '../scraper/atsHandler.js'
import {
  getLearnedSourceMetrics,
  getLearnedSourcesForProfile,
  recordSourceTelemetryBatch,
} from './sourceMemoryStore.js'

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
  'https://jobs.iqvia.com/en/jobs?search={query}',
  'https://jobs.ashbyhq.com/netgear',
  'https://careers.gehealthcare.com/global/en/search-results',
  'https://clearwateranalytics.wd1.myworkdayjobs.com/en-US/Clearwater_Analytics_Careers?source=LinkedIn',
  'https://ibqbjb.fa.ocs.oraclecloud.com/en/sites/HoneywellCareerSite/jobs?mode=location',
  'https://kla.wd1.myworkdayjobs.com/Search?_ga=2.97096991.1275030734.1775459302-9188483.1775459302&_gl=1*p2flcc*_gcl_au*MTMyNjY2Njk4Ni4xNzc1NDU5MzAy*_ga*OTE4ODQ4My4xNzc1NDU5MzAy*_ga_TZPEFM1MF5*czE3NzU0NTkzMDIkbzEkZzAkdDE3NzU0NTkzMDIkajYwJGwwJGgw',
  'https://www.merck.com/careers/search-results?keywords={query}',
  'https://www.roche.com/careers/search-results?keywords={query}',
  'https://www.pfizer.com/careers/search-results?keywords={query}',
  'https://www.novartis.com/careers/search-results?keywords={query}',
  'https://www.sanofi.com/careers/search-results?keywords={query}',
  'https://www.astrazeneca.com/careers/search-results?keywords={query}',
  'https://www.boehringer-ingelheim.com/careers/search-results?keywords={query}',
  'https://www.bayer.com/careers/search-results?keywords={query}',
 'https://clients.njoyn.com/corp/xweb/xweb.asp?NTKN=c&page=jobmatches&txtJobId=J0326-1434&clid=21001&jid=1460276',
 'https://jobs.njoyn.com/search?q={query}',
 'https://jobs.standardchartered.com/go/Experienced-Professional-jobs/9783657/?&feedid=363857',
 'https://jobs.standardchartered.com/go/Early-careers-Jobs/9783557/?&feedid=363857',
 'https://careers.micron.com/careers?utm_source=linkedin&domain=micron.com&src=JB-12600&start=0&pid=40535385&sort_by=hot',

 'https://careers.netapp.com/search-jobs',
 'https://silabs.wd1.myworkdayjobs.com/en-US/SiliconlabsCareers?source=LinkedIn',
 'https://careers.pypl.com/home/',
 'https://www.accenture.com/in-en/careers/jobsearch',
 'https://www.accenture.com/in-en/careers/jobsearch?jt=Experience%3A%205-10%20years',
 'https://www.accenture.com/in-en/careers/jobsearch?jt=Experience%3A%2010-12%20years%7CExperience%3A%2012-14%20years',
 'https://careers.mphasis.com/home/hot-jobs/location-search/india.html',
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=Business%20Process%20Services%20(BPS)&geo=IND',
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=Infrastructure%20Services&geo=IND',
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=IT%20Application%20Services&geo=USA',
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=Infrastructure%20Services&geo=USA',  
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=Business%20Process%20Services%20(BPS)&geo=USA',    
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=IT%20Application%20Services&geo=EUR',
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=Infrastructure%20Services&geo=EUR',
 'https://mphasis.ripplehire.com/candidate/?token=ty4DfyWddnOrtpclQeia&source=CAREERSITE#list/function=Business%20Process%20Services%20(BPS)&geo=EUR',
 'https://higher.gs.com/results?&page=1&search=software%20engineering&sort=RELEVANCE',
 'https://higher.gs.com/results?&page=1&sort=RELEVANCE',
 'https://careers.swiggy.com/#/careers?career_page_category=Technology',
 'https://www.globallogic.com/careers/search-results?keywords={query}',
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States',
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=5-10%20years',
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years',
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE   ',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=2',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=3',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=4',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=5',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=6',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=7',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=8',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=9',  
 'https://www.globallogic.com/careers/search-results?keywords={query}&location=United%20States&experience=10-12%20years%7Cexperience=12-14%20years&job_type=Full-time&sort_by=RELEVANCE&page=10',  
 'https://dth.avature.net/en_US/careers/',
 'https://careers.wipro.com/go/Engineering/9369255/',
 'https://careers.wipro.com/go/Data-and-Analytics/9369055/',
 'https://careers.wipro.com/go/Cyber-Security/9368955/',
 'https://careers.wipro.com/go/Consulting/9368855/',
 'https://careers.wipro.com/go/Cloud/9368755/',
 'https://careers.wipro.com/go/Corporate-Functions/9369455/',
 'https://careers.wipro.com/go/Corporate-Functions/9369455/',
 'https://jobs.pyjamahr.com/hexa-solutions',
 'https://careers.tesco.com/en_GB/careers/SearchJobs',
 'https://careers.quest-global.com/global/en/c/hitech-jobs',
 'https://careers.cisco.com/global/en/c/product-and-engineering-jobs',
 'https://careers.cisco.com/global/en/search-results?category=Internships%2C%20Apprenticeships%2C%20and%20Co-Ops',
 'https://careers.cisco.com/global/en/c/project-and-program-management-jobs',
 'https://careers.cisco.com/global/en/c/business-development-and-strategy-jobs',
 'https://careers.cisco.com/global/en/c/marketing-and-communications-jobs',

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

const ATS_HOST_PATTERNS = [
  /greenhouse/i,
  /boards\.greenhouse\.io/i,
  /lever\.co/i,
  /workdayjobs/i,
  /ashbyhq/i,
  /smartrecruiters/i,
]

const JOB_BOARD_PATTERNS = [
  /linkedin\.com\/jobs/i,
  /indeed/i,
  /naukri/i,
  /monster/i,
  /timesjobs/i,
  /glassdoor/i,
  /workindia/i,
  /wellfound/i,
  /angel\.co/i,
  /internshala/i,
  /hirist/i,
  /instahyre/i,
  /remoteok/i,
  /ycombinator\.com\/jobs/i,
]

const detectSourceType = (targetUrl = '') => {
  const value = String(targetUrl || '').toLowerCase()
  if (!value) return 'job_board'
  if (ATS_HOST_PATTERNS.some((pattern) => pattern.test(value))) return 'ats_system'
  if (JOB_BOARD_PATTERNS.some((pattern) => pattern.test(value))) return 'job_board'
  return 'career_page'
}

const getSourceTypeBoost = (sourceType) => {
  if (sourceType === 'career_page') return 0.25
  if (sourceType === 'ats_system') return 0.15
  return 0
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

const tokenizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9+.#-]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)

const overlapRatio = (leftTokens, rightTokens) => {
  const leftSet = new Set(leftTokens || [])
  const rightSet = new Set(rightTokens || [])
  if (leftSet.size === 0 || rightSet.size === 0) return 0
  let overlap = 0
  rightSet.forEach((token) => {
    if (leftSet.has(token)) overlap += 1
  })
  return overlap / Math.max(leftSet.size, rightSet.size, 1)
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
  const withQuery = getConfiguredTargets().map((target) =>
    target.replaceAll('{query}', encodedQuery),
  )
  return diversifyTargetOrder([...new Set(withQuery)])
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

  let discoveredCareerTargets = []
  try {
    discoveredCareerTargets = await discoverCompanyCareerPages(
      {
        role: profile?.role || '',
        skills: [...(profile?.primarySkills || []), ...(profile?.secondarySkills || [])],
        location: profile?.locationPreference || (profile?.remotePreference ? 'remote' : ''),
      },
      {
        maxUrls: Math.min(24, requestedMaxTargets + 8),
      },
    )
  } catch {
    discoveredCareerTargets = []
  }

  const discoveredTargets = await discoverJobSourcesWithGemini({
    profile,
    fallbackTargets: [...discoveredCareerTargets, ...learnedTargets, ...fallbackTargets].slice(0, 40),
    maxTargets: Math.min(28, requestedMaxTargets + 4),
  })
  debugLog('gemini discovery completed', {
    discoveredCount: discoveredTargets.length,
    discoveredCareerCount: discoveredCareerTargets.length,
  })

  const merged = dedupeUrls([
    ...discoveredCareerTargets,
    ...discoveredTargets,
    ...learnedTargets,
    ...fallbackTargets,
  ])

  const sourceMetrics = await getLearnedSourceMetrics(profile, merged)
  const queryTokens = tokenizeText(buildSearchQuery(profile))
  const profileSignalTokens = tokenizeText([
    profile?.role || '',
    ...(profile?.primarySkills || []),
    ...(profile?.secondarySkills || []),
    profile?.seniorityLevel || '',
    profile?.locationPreference || '',
    profile?.remotePreference ? 'remote' : '',
  ].join(' '))
  const roleSignalText = `${profile?.role || ''} ${profile?.seniorityLevel || ''}`.toLowerCase()
  const locationText = String(profile?.locationPreference || '').toLowerCase()

  const sourcePreferences = {
    remote: profile?.remotePreference ? 1 : 0.5,
    india: /(india|bangalore|bengaluru|pune|hyderabad|noida|gurgaon|gurugram|mumbai|delhi)/i.test(
      locationText,
    )
      ? 1
      : 0.55,
    startup: /\b(intern|fresher|entry|junior|new grad)\b/i.test(roleSignalText) ? 0.9 : 0.65,
    bigtech: /\b(senior|staff|principal|lead|architect|manager)\b/i.test(roleSignalText) ? 0.88 : 0.62,
    other: 0.58,
  }

  const scored = merged.map((url, index) => {
    const host = getHostFromUrl(url)
    const sourceGroup = getSourceGroup(url)
    const sourceType = detectSourceType(url)
    const urlTokens = tokenizeText(url)
    const profileOverlap = overlapRatio(profileSignalTokens, urlTokens)
    const queryOverlap = overlapRatio(queryTokens, urlTokens)
    const hostMetrics = sourceMetrics?.[host] || {}
    const learnedReliability = Number(hostMetrics.reliability || 0)
    const attemptCount = Number(hostMetrics.attemptCount || 0)
    const precision = Number(hostMetrics.precision || 0)
    const relevanceRate = Number(hostMetrics.relevanceRate || 0)
    const failureRate = Number(hostMetrics.failureRate || 0)
    const timeoutRate = Number(hostMetrics.timeoutRate || 0)
    const meanMatchSignal = Math.max(0, Math.min(1, Number(hostMetrics.meanMatchScore || 0) / 100))
    const sourcePreference = Number(sourcePreferences[sourceGroup] ?? sourcePreferences.other)
    const sourceTypeBoost = getSourceTypeBoost(
      hostMetrics?.sourceType === 'ats'
        ? 'ats_system'
        : hostMetrics?.sourceType || sourceType,
    )
    const discoveryBias = index < discoveredCareerTargets.length
      ? 0.05
      : index < discoveredCareerTargets.length + discoveredTargets.length
        ? 0.03
        : 0

    // Data-driven blend: reliability/precision/relevance plus semantic overlap, with penalties for flaky hosts.
    const score =
      learnedReliability * 0.3 +
      precision * 0.22 +
      relevanceRate * 0.16 +
      profileOverlap * 0.14 +
      queryOverlap * 0.08 +
      sourcePreference * 0.06 +
      meanMatchSignal * 0.06 -
      failureRate * 0.08 -
      timeoutRate * 0.06 +
      sourceTypeBoost +
      discoveryBias
    return { url, score, sourceType, attemptCount, failureRate, relevanceRate }
  })

  const filteredScored = scored.filter((entry) => {
    const repeatedlyFailing =
      entry.attemptCount >= 4 && entry.failureRate >= 0.78 && entry.relevanceRate <= 0.05
    return !repeatedlyFailing
  })

  const prioritized = filteredScored
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.url)

  const diversified = diversifyTargetOrder(prioritized)
  const bounded = diversified.slice(0, requestedMaxTargets)

  if (bounded.length >= Math.min(12, requestedMaxTargets)) {
    debugLog('dynamic targets resolved', {
      selectedCount: bounded.length,
      scoredCandidates: filteredScored.length,
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

const TECH_STACK_KEYWORDS = [
  'react',
  'next.js',
  'nextjs',
  'node',
  'node.js',
  'express',
  'nestjs',
  'typescript',
  'javascript',
  'python',
  'java',
  'golang',
  'go',
  'rust',
  'c++',
  'c#',
  'mongodb',
  'postgresql',
  'mysql',
  'redis',
  'docker',
  'kubernetes',
  'aws',
  'gcp',
  'azure',
  'graphql',
  'rest',
  'microservices',
  'terraform',
  'jenkins',
  'pytorch',
  'tensorflow',
]

const extractExperience = (textValue) => {
  const text = sanitizeText(textValue).toLowerCase()
  if (!text) return 'Not specified'
  if (/\b(fresher|freshers|entry level|new grad|intern)\b/i.test(text)) return '0-1 years'

  const rangeMatch = text.match(
    /(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*\+?\s*(years?|yrs?)/i,
  )
  if (rangeMatch) return `${rangeMatch[1]}-${rangeMatch[2]} years`

  const plusMatch = text.match(/(\d{1,2})\s*\+?\s*(years?|yrs?)/i)
  if (plusMatch) return `${plusMatch[1]}+ years`

  return 'Not specified'
}

const extractTechStack = (textValue) => {
  const text = sanitizeText(textValue).toLowerCase()
  if (!text) return []
  const hits = new Set()
  TECH_STACK_KEYWORDS.forEach((keyword) => {
    const normalizedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matcher = new RegExp(`\\b${normalizedKeyword}\\b`, 'i')
    if (matcher.test(text)) hits.add(keyword)
  })
  return [...hits].slice(0, 10)
}

const extractJobType = (textValue) => {
  const text = sanitizeText(textValue).toLowerCase()
  if (!text) return 'Not specified'
  if (/\b(intern|internship)\b/i.test(text)) return 'Internship'
  if (/\b(contract|freelance|temporary)\b/i.test(text)) return 'Contract'
  if (/\b(part[-\s]?time)\b/i.test(text)) return 'Part-time'
  if (/\b(full[-\s]?time|permanent)\b/i.test(text)) return 'Full-time'
  return 'Not specified'
}

const enrichJobRecord = (job = {}, sourceUrl = '') => {
  const sourceType = detectSourceType(sourceUrl)
  const context = sanitizeText(
    `${job.title || ''} ${job.description || ''} ${job.location || ''} ${job.salary || ''}`,
  )
  return {
    ...job,
    sourceType,
    experience: sanitizeText(job.experience) || extractExperience(context),
    techStack: Array.isArray(job.techStack) && job.techStack.length > 0
      ? job.techStack.map((item) => sanitizeText(item)).filter(Boolean).slice(0, 10)
      : extractTechStack(context),
    jobType: sanitizeText(job.jobType) || extractJobType(context),
  }
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

const buildDiversifiedJobsBySource = (jobs, limit = 24) => {
  const groupedBySource = new Map()
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const sourceHost = getHostFromUrl(job?.source || '')
    if (!sourceHost) continue
    if (!groupedBySource.has(sourceHost)) {
      groupedBySource.set(sourceHost, [])
    }
    groupedBySource.get(sourceHost).push(job)
  }

  const sourceQueues = [...groupedBySource.values()].map((items) => items.slice(0, 4))
  const diversifiedJobs = []
  let keepIterating = true
  while (keepIterating && diversifiedJobs.length < limit) {
    keepIterating = false
    for (const queue of sourceQueues) {
      if (queue.length === 0) continue
      keepIterating = true
      diversifiedJobs.push(queue.shift())
      if (diversifiedJobs.length >= limit) break
    }
  }

  return {
    diversifiedJobs,
    sourceCount: groupedBySource.size,
  }
}

const scrapePageJobs = async (page, sourceUrl) => {
  const company = guessCompanyName(sourceUrl)
  const atsType = detectAtsType(sourceUrl)

  if (atsType || isAtsUrl(sourceUrl)) {
    const atsJobs = await scrapeJobsFromAts(page, {
      sourceUrl,
      fallbackCompany: company,
    })
    if (atsJobs.length > 0) {
      return atsJobs.map((job) => enrichJobRecord(job, sourceUrl))
    }
  }

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
          description: opening.textContent?.slice(0, 1400),
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
          description: posting.textContent?.slice(0, 1400),
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
          description: cardText.slice(0, 1600),
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
          description: row.textContent?.slice(0, 1400),
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
              description: anchor.closest('article, li, div')?.textContent?.slice(0, 1600),
            })
          })
      }

      return jobs
    },
    { fallbackCompany: company },
  )

  return extracted.map((job) => enrichJobRecord(job, sourceUrl))
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
  const maxParallelPages = Math.max(1, Math.min(5, Number(options.maxParallelPages || 5)))
  const maxSourceRetries = Math.max(0, Math.min(2, Number(options.maxSourceRetries ?? 1)))
  const finalDiversifiedLimit = Math.max(10, Math.min(60, Number(options.finalDiversifiedLimit || 24)))
  const scrapeRound = Math.max(1, Number(options.scrapeRound || 1))
  const useDynamicTargets = options.useDynamicTargets !== false
  const dynamicTargetTimeoutMs = Math.max(
    3000,
    Math.min(40000, Number(options.dynamicTargetTimeoutMs || 40000)),
  )
  const maxAutoRounds = Math.max(
    scrapeRound,
    Math.min(3, Number(options.maxAutoRounds || 2)),
  )
  const scrapeStartedAt = Date.now()
  const throwIfAborted = () => {
    if (!abortSignal?.aborted) return
    const abortError = new Error(String(abortSignal.reason || 'Search cancelled by user.'))
    abortError.name = 'AbortError'
    throw abortError
  }

  throwIfAborted()

  const resolvedTargets = useDynamicTargets
    ? await Promise.race([
        getDynamicTargets(profile, { maxTargets: maxTargetsToScan }),
        new Promise((resolve) => {
          setTimeout(() => {
            const fallbackTargets = resolveTargetsForProfile(profile).slice(0, maxTargetsToScan)
            debugLog('dynamic target generation timeout fallback', {
              fallbackCount: fallbackTargets.length,
            })
            resolve(fallbackTargets)
          }, dynamicTargetTimeoutMs)
        }),
      ])
    : resolveTargetsForProfile(profile).slice(0, maxTargetsToScan)
  const targets = dedupeUrls(resolvedTargets).slice(0, maxTargetsToScan)
  if (!useDynamicTargets) {
    debugLog('dynamic target discovery skipped', {
      selectedCount: targets.length,
      maxTargetsToScan,
    })
  }
  const targetTimeoutMs = Math.max(
    10000,
    Math.min(25000, Number(options.targetTimeoutMs || (targets.length > 20 ? 11000 : 14000))),
  )
  const scraped = []
  const jobsPerHost = new Map()
  const sourceOutcomes = new Map()
  let browser
  let telemetryPersisted = false

  const ensureSourceOutcome = (sourceUrl, sourceHost = '') => {
    const key = String(sourceUrl || '').trim()
    if (!key) return null
    if (!sourceOutcomes.has(key)) {
      sourceOutcomes.set(key, {
        sourceUrl: key,
        sourceHost: sourceHost || getHostFromUrl(key),
        sourceType: detectSourceType(key),
        attemptCount: 0,
        successCount: 0,
        failureCount: 0,
        timeoutCount: 0,
        blockedCount: 0,
        jobsFound: 0,
        jobsAccepted: 0,
        qualityJobs: 0,
        finalJobs: 0,
        elapsedMs: 0,
      })
    }
    return sourceOutcomes.get(key)
  }

  const markSourceOutcome = (sourceUrl, sourceHost, patch = {}) => {
    const outcome = ensureSourceOutcome(sourceUrl, sourceHost)
    if (!outcome) return

    if (patch.sourceType) {
      outcome.sourceType = String(patch.sourceType).trim()
    }
    outcome.attemptCount += Math.max(0, Number(patch.attemptCount || 0))
    outcome.successCount += Math.max(0, Number(patch.successCount || 0))
    outcome.failureCount += Math.max(0, Number(patch.failureCount || 0))
    outcome.timeoutCount += Math.max(0, Number(patch.timeoutCount || 0))
    outcome.blockedCount += Math.max(0, Number(patch.blockedCount || 0))
    outcome.jobsFound += Math.max(0, Number(patch.jobsFound || 0))
    outcome.jobsAccepted += Math.max(0, Number(patch.jobsAccepted || 0))
    outcome.qualityJobs += Math.max(0, Number(patch.qualityJobs || 0))
    outcome.finalJobs += Math.max(0, Number(patch.finalJobs || 0))
    outcome.elapsedMs += Math.max(0, Number(patch.elapsedMs || 0))
  }

  const classifySourceError = (error) => {
    const message = String(error?.message || '').toLowerCase()
    if (
      /timeout|timed out|navigation timeout|err_timed_out|waituntil timeout|page\.goto/i.test(message)
    ) {
      return {
        timeoutCount: 1,
        failureCount: 0,
        blockedCount: 0,
      }
    }
    if (/403|forbidden|captcha|access denied|blocked|bot detection/i.test(message)) {
      return {
        timeoutCount: 0,
        failureCount: 0,
        blockedCount: 1,
      }
    }
    return {
      timeoutCount: 0,
      failureCount: 1,
      blockedCount: 0,
    }
  }

  const countJobsBySource = (jobs) => {
    const counts = new Map()
    for (const job of Array.isArray(jobs) ? jobs : []) {
      const key = String(job?.source || '').trim()
      if (!key) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }

  const persistTelemetry = async ({ qualityJobs = [], finalJobs = [] } = {}) => {
    if (telemetryPersisted) return
    telemetryPersisted = true

    const qualityBySource = countJobsBySource(qualityJobs)
    const finalBySource = countJobsBySource(finalJobs)

    qualityBySource.forEach((count, sourceUrl) => {
      const host = getHostFromUrl(sourceUrl)
      markSourceOutcome(sourceUrl, host, { qualityJobs: count })
    })
    finalBySource.forEach((count, sourceUrl) => {
      const host = getHostFromUrl(sourceUrl)
      markSourceOutcome(sourceUrl, host, { finalJobs: count })
    })

    const outcomes = [...sourceOutcomes.values()]
    if (outcomes.length === 0) return

    await recordSourceTelemetryBatch({
      profile,
      outcomes,
    })
  }

  throwIfAborted()

  await safeNotify(
    onStatus,
    `Discovered ${targets.length} sources in current batch. Starting live scraping${
      scrapeRound > 1 ? ` (deep round ${scrapeRound}/${maxAutoRounds})` : ''
    }...`,
  )

  try {
    throwIfAborted()
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    }
    const configuredExecutablePath = String(process.env.PLAYWRIGHT_EXECUTABLE_PATH || '').trim()
    if (configuredExecutablePath) {
      launchOptions.executablePath = configuredExecutablePath
    }
    browser = await chromium.launch(launchOptions)
    debugLog('browser launched', {
      targets: targets.length,
      timeoutMs: targetTimeoutMs,
      stopAfterJobs,
      perSourceCap,
      maxParallelPages,
      maxSourceRetries,
      dynamicTargetTimeoutMs,
      hasCustomExecutablePath: Boolean(configuredExecutablePath),
    })

    let queueCursor = 0
    let shouldStop = false

    const processTarget = async (targetUrl, targetIndex) => {
      const targetHost = getHostFromUrl(targetUrl)
      const sourceType = detectSourceType(targetUrl)
      const maxAttempts = maxSourceRetries + 1

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted()
        if (shouldStop) return
        const targetStartedAt = Date.now()
        markSourceOutcome(targetUrl, targetHost, {
          sourceType,
          attemptCount: 1,
        })

        if (attempt === 1) {
          await safeNotify(
            onStatus,
            `Scanning ${targetHost} (${targetIndex + 1}/${targets.length})...`,
          )
        } else {
          await safeNotify(
            onStatus,
            `Retrying ${targetHost} (${attempt}/${maxAttempts}) after transient failure...`,
          )
        }

        let page = null

        try {
          page = await browser.newPage()
          await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: targetTimeoutMs,
          })
          await page.waitForTimeout(1000)

          const jobs = await scrapePageJobs(page, targetUrl)
          const sourceHost = getHostFromUrl(targetUrl)
          const currentCount = jobsPerHost.get(sourceHost) || 0
          const remainingSlots = Math.max(0, perSourceCap - currentCount)
          const cappedJobs = remainingSlots > 0 ? jobs.slice(0, remainingSlots) : []
          const preparedJobs = cappedJobs.map((job, index) => ({
            source: targetUrl,
            sourceType: job.sourceType || sourceType,
            externalId: `${targetUrl}-${attempt}-${index}-${job.title}`,
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
            attempt,
            jobsFound: jobs.length,
            jobsAccepted: preparedJobs.length,
            elapsedMs: Date.now() - targetStartedAt,
          })
          markSourceOutcome(targetUrl, targetHost, {
            sourceType,
            successCount: 1,
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
            shouldStop = true
            await safeNotify(
              onStatus,
              `Captured ${scraped.length} jobs across ${uniqueSources} sources in this batch.`,
            )
          }
          return
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          const classified = classifySourceError(error)
          markSourceOutcome(targetUrl, targetHost, {
            sourceType,
            ...classified,
            elapsedMs: Date.now() - targetStartedAt,
          })
          debugLog('target failed', {
            targetHost,
            targetIndex: targetIndex + 1,
            attempt,
            elapsedMs: Date.now() - targetStartedAt,
            willRetry: attempt < maxAttempts,
          })

          if (attempt >= maxAttempts) {
            await safeNotify(onStatus, `Skipping source ${targetHost} due to access/parsing issues.`)
            return
          }
        } finally {
          await page?.close()
        }
      }
    }

    const worker = async () => {
      while (true) {
        if (shouldStop) return
        throwIfAborted()
        const targetIndex = queueCursor
        queueCursor += 1
        if (targetIndex >= targets.length) return
        const targetUrl = targets[targetIndex]
        await processTarget(targetUrl, targetIndex)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(maxParallelPages, targets.length) }, () => worker()),
    )
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    // Browser launch issues are surfaced as scrape failure below.
    const launchErrorMessage = String(error?.message || 'unknown browser launch error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220)
    debugLog('browser launch failed', {
      reason: launchErrorMessage,
    })
    await safeNotify(
      onStatus,
      `Browser launch failed while scraping sources. ${launchErrorMessage}`,
    )
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
      sourceType: sanitizeText(job.sourceType) || detectSourceType(job.source),
      experience: sanitizeText(job.experience) || extractExperience(job.description || job.title),
      techStack:
        Array.isArray(job.techStack) && job.techStack.length > 0
          ? job.techStack.map((item) => sanitizeText(item)).filter(Boolean).slice(0, 10)
          : extractTechStack(`${job.title || ''} ${job.description || ''}`),
      jobType: sanitizeText(job.jobType) || extractJobType(`${job.title || ''} ${job.description || ''}`),
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
    const shouldRetryDeeper = scrapeRound < maxAutoRounds
    if (shouldRetryDeeper) {
      await persistTelemetry({
        qualityJobs: [],
        finalJobs: [],
      })
      await safeNotify(
        onStatus,
        "We searched on the internet but didn't find the relevant jobs as per your requirement, searching deeper now, sorry for your inconvenience.",
      )
      debugLog('quality filter empty - retrying deeper round', {
        scrapeRound,
        maxAutoRounds,
        dedupedCount: deduped.length,
      })
      return scrapeJobsWithPlaywright(profile, {
        ...options,
        scrapeRound: scrapeRound + 1,
        maxAutoRounds,
        maxTargetsToScan: Math.min(30, maxTargetsToScan + 8),
        stopAfterJobs: Math.min(90, stopAfterJobs + 12),
        perSourceCap: Math.min(10, perSourceCap + 2),
        targetTimeoutMs: Math.max(20000, targetTimeoutMs),
        maxSourceRetries: Math.min(2, maxSourceRetries + 1),
        finalDiversifiedLimit: Math.min(60, finalDiversifiedLimit + 10),
      })
    }

    if (deduped.length > 0) {
      const fallbackResult = buildDiversifiedJobsBySource(deduped, finalDiversifiedLimit)
      await safeNotify(
        onStatus,
        `Deep search completed with strict-match misses. Returning ${fallbackResult.diversifiedJobs.length} best available jobs.`,
      )
      await persistTelemetry({
        qualityJobs: deduped,
        finalJobs: fallbackResult.diversifiedJobs,
      })
      return fallbackResult.diversifiedJobs
    }

    await persistTelemetry({
      qualityJobs: [],
      finalJobs: [],
    })
    await safeNotify(
      onStatus,
      "We searched on the internet but couldn't find relevant jobs for this exact requirement yet. Please tweak the query or ask me to move further.",
    )
    return []
  }
  await safeNotify(
    onStatus,
    `Scraping complete. ${qualityFiltered.length} quality jobs found (from ${deduped.length} raw unique).`,
  )

  // Keep final set diverse so one source cannot dominate.
  const { diversifiedJobs, sourceCount } = buildDiversifiedJobsBySource(
    qualityFiltered,
    finalDiversifiedLimit,
  )
  await safeNotify(
    onStatus,
    `Prepared ${diversifiedJobs.length} jobs from ${sourceCount} sources.`,
  )
  debugLog('scrape completed', {
    rawCount: scraped.length,
    dedupedCount: deduped.length,
    qualityCount: qualityFiltered.length,
    finalCount: diversifiedJobs.length,
    sourceCount,
    elapsedMs: Date.now() - scrapeStartedAt,
  })

  await persistTelemetry({
    qualityJobs: qualityFiltered,
    finalJobs: diversifiedJobs,
  })

  return diversifiedJobs
}

export const scrapeJobs = async (profile) => {
  return scrapeJobsWithPlaywright(profile)
}

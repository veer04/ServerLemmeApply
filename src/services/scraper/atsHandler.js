const ATS_TYPES = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  workday: 'workday',
  ashby: 'ashby',
  smartrecruiters: 'smartrecruiters',
}

const normalize = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

const uniqueByKey = (items, keyGetter) => {
  const seen = new Set()
  const unique = []

  for (const item of Array.isArray(items) ? items : []) {
    const key = keyGetter(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }

  return unique
}

export const detectAtsType = (urlValue = '') => {
  const value = String(urlValue || '').toLowerCase()
  if (!value) return ''
  if (/greenhouse|boards\.greenhouse\.io/.test(value)) return ATS_TYPES.greenhouse
  if (/lever\.co|jobs\.lever\.co/.test(value)) return ATS_TYPES.lever
  if (/workdayjobs|wd\d+\.myworkdayjobs/.test(value)) return ATS_TYPES.workday
  if (/ashbyhq|jobs\.ashbyhq/.test(value)) return ATS_TYPES.ashby
  if (/smartrecruiters/.test(value)) return ATS_TYPES.smartrecruiters
  return ''
}

export const isAtsUrl = (urlValue = '') => Boolean(detectAtsType(urlValue))

const evaluateAtsJobs = async (page, { atsType, fallbackCompany = '' }) => {
  return page.evaluate(
    ({ injectedAtsType, injectedFallbackCompany }) => {
      const normalizeText = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()

      const absolutizeHref = (href) => {
        const raw = normalizeText(href)
        if (!raw) return ''
        try {
          return new URL(raw, window.location.href).toString()
        } catch {
          return ''
        }
      }

      const pushJob = (accumulator, payload) => {
        const title = normalizeText(payload?.title)
        const applyLink = absolutizeHref(payload?.applyLink)
        if (!title || !applyLink) return

        accumulator.push({
          title,
          company: normalizeText(payload?.company) || injectedFallbackCompany,
          location: normalizeText(payload?.location) || 'Not specified',
          applyLink,
          description: normalizeText(payload?.description),
          salary: normalizeText(payload?.salary),
        })
      }

      const jobs = []

      if (injectedAtsType === 'greenhouse') {
        document.querySelectorAll('.opening').forEach((opening) => {
          const anchor = opening.querySelector('a[href]')
          if (!anchor) return
          pushJob(jobs, {
            title: anchor.textContent,
            company: injectedFallbackCompany,
            location: opening.querySelector('.location')?.textContent,
            applyLink: anchor.getAttribute('href'),
            description: opening.textContent,
          })
        })
      }

      if (injectedAtsType === 'lever') {
        document.querySelectorAll('.posting').forEach((posting) => {
          const anchor = posting.querySelector('a[href]')
          if (!anchor) return
          pushJob(jobs, {
            title:
              posting.querySelector('.posting-title h5')?.textContent ||
              anchor.textContent,
            company: injectedFallbackCompany,
            location: posting.querySelector('.posting-categories span')?.textContent,
            applyLink: anchor.getAttribute('href'),
            description: posting.textContent,
          })
        })
      }

      if (injectedAtsType === 'workday') {
        const titleNodes = Array.from(
          document.querySelectorAll(
            '[data-automation-id="jobTitle"], [data-automation-id="jobTitleLink"], [data-automation-id="jobPostingHeader"]',
          ),
        )

        titleNodes.forEach((titleNode) => {
          const container = titleNode.closest('article, li, div, tr') || titleNode.parentElement
          const anchor =
            titleNode.closest('a[href]') ||
            titleNode.querySelector?.('a[href]') ||
            container?.querySelector?.('a[href]')
          const locationNode =
            container?.querySelector?.('[data-automation-id="locations"]') ||
            container?.querySelector?.('[data-automation-id="location"]')

          pushJob(jobs, {
            title: titleNode.textContent,
            company: injectedFallbackCompany,
            location: locationNode?.textContent || container?.textContent,
            applyLink: anchor?.getAttribute?.('href') || anchor?.href,
            description: container?.textContent,
          })
        })
      }

      if (injectedAtsType === 'ashby') {
        document
          .querySelectorAll('a[href*="/jobs/"], a[href*="/job/"]')
          .forEach((anchor) => {
            const container = anchor.closest('article, li, div')
            pushJob(jobs, {
              title: anchor.textContent || anchor.getAttribute('aria-label'),
              company: injectedFallbackCompany,
              location:
                container?.querySelector?.('[data-testid*="location"]')?.textContent ||
                container?.textContent,
              applyLink: anchor.getAttribute('href') || anchor.href,
              description: container?.textContent,
            })
          })
      }

      if (injectedAtsType === 'smartrecruiters') {
        document.querySelectorAll('a[href*="/job/"]').forEach((anchor) => {
          const container = anchor.closest('article, li, div')
          pushJob(jobs, {
            title:
              container?.querySelector?.('[data-testid*="job-title"]')?.textContent ||
              anchor.textContent,
            company: injectedFallbackCompany,
            location:
              container?.querySelector?.('[data-testid*="location"]')?.textContent ||
              container?.textContent,
            applyLink: anchor.getAttribute('href') || anchor.href,
            description: container?.textContent,
          })
        })
      }

      return jobs
    },
    {
      injectedAtsType: atsType,
      injectedFallbackCompany: fallbackCompany,
    },
  )
}

export const scrapeJobsFromAts = async (page, { sourceUrl, fallbackCompany = '' } = {}) => {
  const atsType = detectAtsType(sourceUrl)
  if (!atsType) return []

  const extracted = await evaluateAtsJobs(page, {
    atsType,
    fallbackCompany,
  })

  const cleaned = (Array.isArray(extracted) ? extracted : [])
    .map((job) => ({
      title: normalize(job.title),
      company: normalize(job.company) || fallbackCompany || 'Hiring company not disclosed',
      location: normalize(job.location) || 'Not specified',
      applyLink: normalize(job.applyLink),
      description: normalize(job.description),
      salary: normalize(job.salary) || 'Not disclosed',
      atsType,
    }))
    .filter((job) => Boolean(job.title && job.applyLink))

  return uniqueByKey(cleaned, (job) => `${job.title.toLowerCase()}|${job.applyLink.toLowerCase()}`)
}

export { ATS_TYPES }

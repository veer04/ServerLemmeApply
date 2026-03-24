import crypto from 'node:crypto'

const knownSkills = [
  'react',
  'next.js',
  'typescript',
  'javascript',
  'html',
  'css',
  'tailwind',
  'redux',
  'node.js',
  'node',
  'express',
  'mongodb',
  'mysql',
  'postgresql',
  'redis',
  'aws',
  'docker',
  'kubernetes',
  'ci/cd',
  'python',
  'java',
  'dsa',
  'system design',
  'ai/ml',
]

const sanitize = (value) => String(value || '').replace(/\s+/g, ' ').trim()

const buildJobHash = (job) => {
  const signature = [
    sanitize(job.title).toLowerCase(),
    sanitize(job.company).toLowerCase(),
    sanitize(job.applyLink || job.applyUrl).toLowerCase(),
    sanitize(job.location).toLowerCase(),
  ].join('|')

  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24)
}

const inferSkills = (title, description) => {
  const haystack = `${title} ${description}`.toLowerCase()
  const matched = knownSkills.filter((skill) => haystack.includes(skill.toLowerCase()))
  return [...new Set(matched)]
}

export const normalizeScrapedJobs = (jobs) => {
  return jobs.map((job) => {
    const title = sanitize(job.title)
    const company = sanitize(job.company)
    const description = sanitize(job.description)
    const location = sanitize(job.location) || 'Not specified'
    const salary = sanitize(job.salary) || 'Not disclosed'
    const source = sanitize(job.source) || 'unknown'
    const applyUrl = sanitize(job.applyUrl || job.applyLink || '#')

    return {
      ...job,
      title,
      company,
      skillsRequired: inferSkills(title, description),
      description,
      location,
      salary,
      source,
      applyUrl,
      applyLink: applyUrl,
      externalId: sanitize(job.externalId) || `${source}-${title}-${company}`,
      jobHash: buildJobHash({
        ...job,
        title,
        company,
        applyLink: applyUrl,
        location,
      }),
    }
  })
}

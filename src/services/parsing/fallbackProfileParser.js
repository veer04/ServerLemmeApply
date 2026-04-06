const rolePatterns = [
  { role: 'MERN Stack Developer', pattern: /\bmern\b/i },
  { role: 'Full Stack Developer', pattern: /\bfull\s*stack\b/i },
  { role: 'Frontend Engineer', pattern: /\bfront\s*end|frontend|react\b/i },
  { role: 'Backend Engineer', pattern: /\bback\s*end|backend|node(\.js)?\b/i },
  { role: 'Software Engineer', pattern: /\bsoftware\s+engineer\b/i },
  { role: 'DevOps Engineer', pattern: /\bdevops|platform engineer|site reliability|sre\b/i },
  { role: 'Data Engineer', pattern: /\bdata engineer|etl|spark|warehouse\b/i },
  { role: 'Machine Learning Engineer', pattern: /\bmachine learning|ml engineer|llm|genai|ai\b/i },
  { role: 'Product Engineer', pattern: /\bproduct engineer|product developer\b/i },
  { role: 'QA Engineer', pattern: /\bqa|quality assurance|test automation\b/i },
]

const skillList = [
  'react',
  'node.js',
  'node',
  'express',
  'mongodb',
  'javascript',
  'typescript',
  'next.js',
  'nextjs',
  'api',
  'sql',
  'nestjs',
  'graphql',
  'microservices',
  'aws',
  'gcp',
  'azure',
  'docker',
  'kubernetes',
  'terraform',
  'jenkins',
  'redis',
  'python',
  'java',
  'go',
  'golang',
  'spring boot',
  'pytorch',
  'tensorflow',
  'llm',
  'genai',
  'machine learning',
]

const extractExperienceYears = (input) => {
  const matched = input.match(/(\d+)\s*\+?\s*(years?|yrs?)/i)
  return matched ? Number(matched[1]) : 0
}

const extractExpectedPackage = (input) => {
  const matched = input.match(/(\d+)\s*\+?\s*(lpa|lakh|lakhs)/i)
  return matched ? Number(matched[1]) : 0
}

const extractWorkMode = (input) => {
  if (/\bremote\b/i.test(input)) return 'remote'
  if (/\bhybrid\b/i.test(input)) return 'hybrid'
  if (/\bonsite\b|on-site/i.test(input)) return 'onsite'
  return ''
}

const extractLocations = (input) => {
  const locationMatch = input.match(/\b(in|at|location)\s+([a-z][a-z\s,-]{2,})/i)
  if (!locationMatch) return []

  return locationMatch[2]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3)
}

export const buildFallbackProfile = (prompt, resumeText = '') => {
  const combined = `${prompt} ${resumeText}`.trim()

  const roles = rolePatterns
    .filter((candidate) => candidate.pattern.test(combined))
    .map((candidate) => candidate.role)

  const skills = skillList
    .filter((skill) => new RegExp(`\\b${skill.replace('.', '\\.')}\\b`, 'i').test(combined))
    .map((skill) => (skill === 'node' ? 'node.js' : skill))

  return {
    roles: [...new Set(roles)],
    locations: extractLocations(combined),
    skills: [...new Set(skills)],
    workMode: extractWorkMode(combined),
    experienceYears: extractExperienceYears(combined),
    expectedPackageLpa: extractExpectedPackage(combined),
    keywords: combined
      .split(/[^a-zA-Z0-9+.#]/)
      .filter((token) => token.length > 2)
      .slice(0, 20),
  }
}

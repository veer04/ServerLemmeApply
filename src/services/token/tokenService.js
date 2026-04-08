const toWordCount = (value) => {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

const toJobCount = (jobsReturned) => {
  return Array.isArray(jobsReturned) ? jobsReturned.length : 0
}

export const calculateTokensUsed = ({
  inputText = '',
  jobsReturned = [],
  aiEnrichmentUsed = false,
} = {}) => {
  const inputTokens = Math.ceil(toWordCount(inputText) * 1.2)
  const outputTokens = Math.max(0, toJobCount(jobsReturned) * 50)
  const enrichmentBonus = aiEnrichmentUsed ? 100 : 0
  const totalTokens = inputTokens + outputTokens + enrichmentBonus

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  }
}

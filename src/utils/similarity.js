export const cosineSimilarity = (vecA, vecB) => {
  if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0
  if (vecA.length === 0 || vecB.length === 0) return 0
  if (vecA.length !== vecB.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let index = 0; index < vecA.length; index += 1) {
    const a = Number(vecA[index])
    const b = Number(vecB[index])

    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0

    dot += a * b
    normA += a * a
    normB += b * b
  }

  if (normA === 0 || normB === 0) return 0

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}


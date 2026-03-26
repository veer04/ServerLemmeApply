import { VertexAI } from '@google-cloud/vertexai'
import { env } from '../config/environment.js'

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || 'text-embedding-005'
const embeddingCache = new Map()

let embeddingModel

/** Same normalization used for cache keys — keep in sync with job fingerprint in jobScorer. */
export const normalizeEmbeddingInput = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const getEmbeddingModel = () => {
  if (embeddingModel) return embeddingModel
  if (!env.vertexProject) {
    return null
  }

  const vertexClient = new VertexAI({
    project: env.vertexProject,
    location: env.vertexLocation,
  })

  embeddingModel = vertexClient.getTextEmbeddingModel(EMBEDDING_MODEL)
  return embeddingModel
}

const extractVector = (result) => {
  const values =
    result?.embeddings?.[0]?.values ||
    result?.embedding?.values ||
    result?.values ||
    []

  if (!Array.isArray(values)) return []
  return values.filter((value) => Number.isFinite(value))
}

export const getEmbedding = async (text) => {
  const normalized = normalizeEmbeddingInput(text)
  if (!normalized) return []

  const cached = embeddingCache.get(normalized)
  if (cached) return cached

  try {
    const model = getEmbeddingModel()
    if (!model) return []

    const response = await model.getEmbeddings([normalized])
    const vector = extractVector(response)

    if (!Array.isArray(vector) || vector.length === 0) return []

    embeddingCache.set(normalized, vector)
    return vector
  } catch {
    // STEP 10: never throw — callers fall back to token-based similarity in jobScorer.
    return []
  }
}


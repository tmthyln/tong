/**
 * Semantic text chunking for markdown documents using marked lexer.
 *
 * Rules:
 * 1. Never break up code blocks, blockquotes, or tables regardless of length
 * 2. Chunks should not start or end with whitespace (gaps between chunks are allowed)
 * 3. Horizontal rules split chunks but are excluded from chunk content
 * 4. Headers start new chunks but can combine with following content
 * 5. Paragraph breaks are good split markers
 */

import { Lexer, Token } from 'marked'

interface ChunkIndex {
  startIndex: number
  endIndex: number
}

const MIN_CHUNK_SIZE = 100
const TARGET_MIN_SIZE = 200
const TARGET_MAX_SIZE = 700

/**
 * Generates semantic chunk indices for a markdown document.
 * Chunks may have gaps between them (whitespace is excluded).
 * Chunks do not overlap.
 *
 * @param content The markdown content to chunk
 * @returns Array of { startIndex, endIndex } with no overlaps
 */
export function generateChunkIndices(content: string): ChunkIndex[] {
  if (content.length === 0) {
    return []
  }

  // Tokenize using marked lexer
  const tokens = Lexer.lex(content)

  // Convert tokens to chunks based on semantic rules
  const initialChunks = tokensToChunks(tokens, content)

  // Merge small chunks
  const merged = mergeChunks(initialChunks)

  // Trim whitespace from chunk boundaries
  return trimChunkWhitespace(merged, content)
}

/**
 * Convert marked tokens to initial chunks based on semantic rules.
 */
function tokensToChunks(tokens: Token[], content: string): ChunkIndex[] {
  const chunks: ChunkIndex[] = []
  let currentChunk: ChunkIndex | null = null
  let pos = 0

  for (const token of tokens) {
    // Find where this token starts in the content
    const tokenStart = findTokenStart(content, token, pos)
    const tokenEnd = tokenStart + token.raw.length
    pos = tokenEnd

    // Skip space tokens - don't include in chunks
    if (token.type === 'space') {
      if (currentChunk) {
        chunks.push(currentChunk)
        currentChunk = null
      }
      continue
    }

    // Horizontal rules force a split but are excluded from chunks
    if (token.type === 'hr') {
      if (currentChunk) {
        chunks.push(currentChunk)
        currentChunk = null
      }
      // HR is not included in any chunk
      continue
    }

    // Headers start new chunks
    if (token.type === 'heading') {
      if (currentChunk) {
        chunks.push(currentChunk)
      }
      currentChunk = { startIndex: tokenStart, endIndex: tokenEnd }
      continue
    }

    // Code blocks, blockquotes, and tables are atomic - add to current chunk or start new one
    if (token.type === 'code' || token.type === 'blockquote' || token.type === 'table') {
      if (currentChunk) {
        currentChunk.endIndex = tokenEnd
      } else {
        currentChunk = { startIndex: tokenStart, endIndex: tokenEnd }
      }
      continue
    }

    // All other tokens (paragraph, list, blockquote, etc.)
    if (currentChunk) {
      currentChunk.endIndex = tokenEnd
    } else {
      currentChunk = { startIndex: tokenStart, endIndex: tokenEnd }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk)
  }

  return chunks
}

/**
 * Find where a token starts in the content.
 * Tokens have a `raw` property with the exact text.
 */
function findTokenStart(content: string, token: Token, searchFrom: number): number {
  // The token's raw text should be at or after searchFrom
  const idx = content.indexOf(token.raw, searchFrom)
  if (idx !== -1) {
    return idx
  }
  // Fallback: return searchFrom if not found (shouldn't happen with valid tokens)
  return searchFrom
}

/**
 * Merge chunks that are too small.
 */
function mergeChunks(chunks: ChunkIndex[]): ChunkIndex[] {
  if (chunks.length <= 1) {
    return chunks
  }

  const result: ChunkIndex[] = []
  let i = 0

  while (i < chunks.length) {
    const current = { ...chunks[i] }
    let currentLength = current.endIndex - current.startIndex

    // Merge while under minimum size
    while (currentLength < MIN_CHUNK_SIZE && i + 1 < chunks.length) {
      i++
      current.endIndex = chunks[i].endIndex
      currentLength = current.endIndex - current.startIndex
    }

    // Merge while under target size if won't exceed max
    while (
      currentLength < TARGET_MIN_SIZE &&
      i + 1 < chunks.length &&
      currentLength + (chunks[i + 1].endIndex - chunks[i + 1].startIndex) <= TARGET_MAX_SIZE
    ) {
      i++
      current.endIndex = chunks[i].endIndex
      currentLength = current.endIndex - current.startIndex
    }

    result.push(current)
    i++
  }

  // Merge last chunk if too small
  if (
    result.length > 1 &&
    result[result.length - 1].endIndex - result[result.length - 1].startIndex < MIN_CHUNK_SIZE
  ) {
    const last = result.pop()!
    result[result.length - 1].endIndex = last.endIndex
  }

  return result
}

/**
 * Trim leading and trailing whitespace from each chunk.
 * Filters out chunks that become empty after trimming.
 */
function trimChunkWhitespace(chunks: ChunkIndex[], content: string): ChunkIndex[] {
  const result: ChunkIndex[] = []

  for (const chunk of chunks) {
    let { startIndex, endIndex } = chunk

    // Trim leading whitespace
    while (startIndex < endIndex && /\s/.test(content[startIndex])) {
      startIndex++
    }

    // Trim trailing whitespace
    while (endIndex > startIndex && /\s/.test(content[endIndex - 1])) {
      endIndex--
    }

    // Only include non-empty chunks
    if (startIndex < endIndex) {
      result.push({ startIndex, endIndex })
    }
  }

  return result
}
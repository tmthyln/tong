// Self-tools for the translation agent: AI-SDK tool() wrappers over the shared
// server/lib functions. These execute immediately and return data to the model
// (as opposed to user-facing tools, which surface suggestions — added later).
//
// Built via a factory that closes over the agent's env + identity so the model
// never has to pass credentials or guess the user.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { searchDictionary } from './dictionary-search'
import { searchChunksByText } from './semantic-search'
import { searchEntities } from './entities'
import { userKnowsTerms } from './lexicon-knowledge'

export interface SelfToolDeps {
  env: Env
  userId: string
  /** The document the user is currently focused on, if any. */
  documentId?: number
}

export function createSelfTools(deps: SelfToolDeps): ToolSet {
  const { env, userId } = deps

  return {
    dictionarySearch: tool({
      description:
        'Search the CEDICT Chinese-English dictionary by Chinese characters, pinyin (e.g. "ni3 hao3"), or English meaning. Returns entries with pinyin and definitions.',
      inputSchema: z.object({
        query: z.string().describe('Chinese text, pinyin, or an English keyword'),
        limit: z.number().int().min(1).max(50).optional().describe('Max entries (default 20)'),
      }),
      execute: async ({ query, limit }) => searchDictionary(env, { q: query, limit: limit ?? 20 }),
    }),

    semanticChunkSearch: tool({
      description:
        'Find passages (chunks) semantically similar to a query. Use to locate where a concept or term is discussed.',
      inputSchema: z.object({
        query: z.string().describe('Natural-language or Chinese query'),
        scopeToCurrentDocument: z
          .boolean()
          .optional()
          .describe('Restrict to the document the user is reading (default false)'),
        topK: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, scopeToCurrentDocument, topK }) =>
        searchChunksByText(env, {
          query,
          documentId: scopeToCurrentDocument ? deps.documentId : undefined,
          topK: topK ?? 8,
        }),
    }),

    entitySearch: tool({
      description:
        'Search named entities already extracted for a document (people, places, organizations, etc.).',
      inputSchema: z.object({
        documentId: z.number().int().describe('Document to search entities in'),
        query: z.string().optional().describe('Optional substring to filter entity labels'),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ documentId, query, limit }) =>
        searchEntities(env, { documentId, query, limit }),
    }),

    userKnowsTerms: tool({
      description:
        'Check whether the current user already knows specific Chinese characters/terms (from their lexicon learn/fail history). Use to decide what needs explaining.',
      inputSchema: z.object({
        terms: z.array(z.string()).min(1).describe('Terms/characters to check'),
      }),
      execute: async ({ terms }) => userKnowsTerms(env, userId, terms),
    }),
  }
}

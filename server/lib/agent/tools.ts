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
import type { SuggestionPayload } from './suggestions'

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

export interface UserFacingToolDeps {
  /** Adds a suggestion to the agent's state and returns its id. */
  addSuggestion: (payload: SuggestionPayload) => string
}

/**
 * User-facing tools. Unlike self-tools, these do NOT mutate anything — they
 * surface a suggestion the user must approve. The real mutation happens later in
 * the agent's resolveSuggestion RPC. Each returns a short confirmation so the
 * model knows the suggestion was queued.
 */
export function createUserFacingTools(deps: UserFacingToolDeps): ToolSet {
  return {
    suggestTranslation: tool({
      description:
        'Propose a translation for a specific chunk. The user reviews and accepts/dismisses it — it is NOT applied automatically.',
      inputSchema: z.object({
        documentId: z.number().int(),
        chunkId: z.number().int(),
        translation: z.string().describe('The proposed English translation'),
        rationale: z.string().optional().describe('Brief reason, shown to the user'),
      }),
      execute: async ({ documentId, chunkId, translation, rationale }) => {
        const id = deps.addSuggestion({ kind: 'translation', documentId, chunkId, translation, rationale })
        return `Surfaced translation suggestion ${id}; awaiting the user's response.`
      },
    }),

    askUser: tool({
      description: 'Ask the user a question when you need input or a decision. Optionally offer choices.',
      inputSchema: z.object({
        question: z.string(),
        options: z.array(z.string()).optional().describe('Optional answer choices'),
      }),
      execute: async ({ question, options }) => {
        const id = deps.addSuggestion({ kind: 'question', question, options })
        return `Asked the user question ${id}; awaiting their answer.`
      },
    }),

    suggestCreateEntity: tool({
      description:
        'Suggest creating a named entity from text in a chunk (e.g. a person/place the user missed). The user approves before it is created.',
      inputSchema: z.object({
        documentId: z.number().int(),
        chunkId: z.number().int(),
        text: z.string().describe('Exact text of the entity as it appears in the chunk'),
        entityType: z.string().describe('Entity type name (must be a configured node type)'),
        rationale: z.string().optional(),
      }),
      execute: async ({ documentId, chunkId, text, entityType, rationale }) => {
        const id = deps.addSuggestion({ kind: 'entity-create', documentId, chunkId, text, entityType, rationale })
        return `Surfaced entity-create suggestion ${id}; awaiting the user's response.`
      },
    }),

    suggestDeleteEntity: tool({
      description: 'Suggest deleting an entity that looks wrong or spurious. The user approves before deletion.',
      inputSchema: z.object({
        documentId: z.number().int(),
        entityId: z.number().int(),
        label: z.string().optional().describe('Entity label, for display'),
        rationale: z.string().optional(),
      }),
      execute: async ({ documentId, entityId, label, rationale }) => {
        const id = deps.addSuggestion({ kind: 'entity-delete', documentId, entityId, label, rationale })
        return `Surfaced entity-delete suggestion ${id}; awaiting the user's response.`
      },
    }),
  }
}

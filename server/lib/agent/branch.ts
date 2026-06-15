// Branch investigation: the tools a branch fiber uses (self-tools plus the
// ability to record findings and propose suggestions) and the prompt that seeds
// it with the shared/ancestor context. The fiber orchestration itself lives in
// the agent (it needs runFiber); these pieces are pure/testable.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { createSelfTools } from './tools'
import { formatFindings, type BranchView, type FindingPayload } from './context-tree'

const suggestionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('translation'),
    documentId: z.number().int(),
    chunkId: z.number().int(),
    translation: z.string(),
    rationale: z.string().optional(),
  }),
  z.object({
    kind: z.literal('entity-create'),
    documentId: z.number().int(),
    chunkId: z.number().int(),
    text: z.string(),
    entityType: z.string(),
    rationale: z.string().optional(),
  }),
  z.object({
    kind: z.literal('entity-delete'),
    documentId: z.number().int(),
    entityId: z.number().int(),
    label: z.string().optional(),
    rationale: z.string().optional(),
  }),
  z.object({
    kind: z.literal('question'),
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
])

export interface BranchToolDeps {
  env: Env
  userId: string
  documentId?: number
  /** Persist a finding produced by the branch. */
  recordFinding: (payload: FindingPayload, shared: boolean) => void
}

/** Self-tools + recordFinding + proposeSuggestion, for a branch's focused loop. */
export function createBranchTools(deps: BranchToolDeps): ToolSet {
  return {
    ...createSelfTools({ env: deps.env, userId: deps.userId, documentId: deps.documentId }),

    recordFinding: tool({
      description:
        'Record a fact or observation you discovered. Set shared=true (default) so the root and other branches can see it.',
      inputSchema: z.object({
        kind: z.enum(['fact', 'observation']),
        text: z.string(),
        shared: z.boolean().optional(),
      }),
      execute: async ({ kind, text, shared }) => {
        deps.recordFinding({ kind, text }, shared ?? true)
        return 'Recorded.'
      },
    }),

    proposeSuggestion: tool({
      description:
        'Propose a suggestion for the user (translation, entity create/delete, or a question) based on your findings. It is reviewed/recombined before reaching the user.',
      inputSchema: z.object({
        suggestion: suggestionPayloadSchema,
        rationale: z.string().optional(),
      }),
      execute: async ({ suggestion, rationale }) => {
        deps.recordFinding({ kind: 'candidate-suggestion', suggestion, rationale }, true)
        return 'Proposed.'
      },
    }),
  }
}

export function buildBranchSystemPrompt(view: BranchView): string {
  return `You are an investigation branch of a collaborative Chinese (Mandarin) translation assistant.

Your goal:
${view.goal}

Findings available to you so far:
${formatFindings(view.visibleFindings)}

Investigate the goal using the lookup tools (dictionarySearch, semanticChunkSearch, entitySearch, userKnowsTerms). Record concrete conclusions with recordFinding (shared=true). When you have something actionable for the user, call proposeSuggestion. Be concise and stop once the goal is addressed.`
}

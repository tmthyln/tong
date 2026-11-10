/**
 * Declarative extraction schema, in the spirit of GLiNER / GLiNER2: callers
 * describe *what* to extract (entity labels, relation labels, classification
 * tasks) and one generic prompt builder + parser does the rest. Any subset of
 * tasks can be composed into a single LLM call.
 */

export interface EntityLabel {
  name: string
  description?: string
  examples?: string[]
}

export interface RelationLabel {
  name: string
  description?: string
  /** Examples formatted as "head → tail". */
  examples?: string[]
  /** Optional allowed head / tail entity labels (soft constraint in prompt, hard filter in parse). */
  headLabels?: string[]
  tailLabels?: string[]
}

export interface ClassificationTask {
  name: string
  labels: Array<{ name: string; description?: string }>
  multiLabel?: boolean
}

export interface ExtractionSchema {
  entities?: EntityLabel[]
  relations?: RelationLabel[]
  classifications?: ClassificationTask[]
  /** Free-form domain guidance appended to the rules (e.g. language, genre). */
  instructions?: string
}

/** An entity that is already known and may be used as a relation argument. */
export interface KnownEntity {
  text: string
  label: string
}

export interface PromptOptions {
  /** Ask for a short evidence/explanation string per relation. Costs output tokens. */
  relationEvidence?: boolean
  /**
   * When relations are requested without entity extraction, restrict relation
   * arguments to this list (closed-world). Rendered in the user message so the
   * system prompt stays cacheable.
   */
  knownEntities?: KnownEntity[]
}

function bulletLabel(name: string, description?: string, examples?: string[]): string {
  let line = `- ${name}`
  if (description) line += `: ${description.trim()}`
  if (examples && examples.length > 0) line += ` (e.g. ${examples.join(', ')})`
  return line
}

/**
 * Build the system prompt. It depends only on the schema + options (not on
 * the input text or known entities), so it is identical across calls and
 * benefits from provider prefix caching.
 */
export function buildSystemPrompt(schema: ExtractionSchema, opts: PromptOptions = {}): string {
  const parts: string[] = [
    'You are a precise information extraction engine. Read the user\'s text and extract exactly what the schema below asks for. Output a single JSON object and nothing else.',
  ]
  const shape: string[] = []
  const rules: string[] = []
  const extractEntities = (schema.entities?.length ?? 0) > 0
  const extractRelations = (schema.relations?.length ?? 0) > 0

  if (extractEntities) {
    parts.push(`## Entity types\n${schema.entities!.map((e) => bulletLabel(e.name, e.description, e.examples)).join('\n')}`)
    shape.push('"entities": {"<TYPE>": ["<mention>", ...], ...}')
    rules.push(
      'Each mention must be copied verbatim from the text — an exact substring, never translated, normalized, or shortened.',
      'List each distinct mention string once per type, even if it occurs many times. Give every string exactly one type: the best fit.',
      'Use the most complete name span (e.g. a full name rather than a fragment), without surrounding particles or punctuation.',
      'Follow each type\'s definition strictly, including its exclusions. Do not extract generic common nouns, pronouns, or unnamed references.',
      'Omit types with no mentions.',
    )
  }

  if (extractRelations) {
    const rels = schema.relations!.map((r) => {
      let line = bulletLabel(r.name, r.description, r.examples)
      if (r.headLabels?.length || r.tailLabels?.length) {
        line += ` [${(r.headLabels ?? ['any']).join('|')} → ${(r.tailLabels ?? ['any']).join('|')}]`
      }
      return line
    })
    parts.push(`## Relation types (directed: head → tail)\n${rels.join('\n')}`)
    shape.push(
      opts.relationEvidence
        ? '"relations": [["<head>", "<RELATION>", "<tail>", "<brief evidence>"], ...]'
        : '"relations": [["<head>", "<RELATION>", "<tail>"], ...]',
    )
    const argSource = extractEntities
      ? 'Relation heads and tails must be entity mentions you listed under "entities".'
      : 'Relation heads and tails must be copied exactly from the "Entities" list in the user message.'
    rules.push(
      argSource,
      'Only output relations the text explicitly states or directly implies. Do not use outside knowledge. Mind the direction.',
    )
    if (opts.relationEvidence) rules.push('Evidence is a short phrase (under 15 words) quoting or paraphrasing the supporting text.')
  }

  for (const task of schema.classifications ?? []) {
    parts.push(
      `## Classification: ${task.name}${task.multiLabel ? ' (choose all that apply)' : ' (choose one)'}\n${task.labels
        .map((l) => bulletLabel(l.name, l.description))
        .join('\n')}`,
    )
    shape.push(`"${task.name}": ${task.multiLabel ? '["<label>", ...]' : '"<label>"'}`)
  }

  if (schema.instructions) rules.push(schema.instructions.trim())
  parts.push(`## Rules\n${rules.map((r) => `- ${r}`).join('\n')}`)
  parts.push(`## Output format\n{${shape.join(', ')}}`)
  return parts.join('\n\n')
}

export function buildUserPrompt(text: string, schema: ExtractionSchema, opts: PromptOptions = {}): string {
  const needsKnown = (schema.relations?.length ?? 0) > 0 && (schema.entities?.length ?? 0) === 0
  if (!needsKnown) return text
  const list = (opts.knownEntities ?? []).map((e) => `- ${e.text} (${e.label})`).join('\n')
  return `Entities:\n${list}\n\nText:\n${text}`
}

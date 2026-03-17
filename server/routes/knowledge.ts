import { Hono } from 'hono'

const knowledgeRoutes = new Hono<{ Bindings: Env }>()

// POST /api/knowledge/document-entity-summary
//
// Request body: { documentId: number, entityId: number }
// Returns: { summary: string }
knowledgeRoutes.post('/document-entity-summary', async (c) => {
  const body = await c.req.json<{ documentId: number; entityId: number }>()
  const { documentId, entityId } = body

  // 1. Fetch the chunk entity
  const entity = await c.env.DB
    .prepare(
      `SELECT entity_type, extracted_text, source_chunk_id, parent_id
       FROM extracted_entity WHERE id = ? AND scope = 'chunk'`
    )
    .bind(entityId)
    .first<{ entity_type: string; extracted_text: string | null; source_chunk_id: number; parent_id: number | null }>()

  if (!entity) return c.json({ error: 'Entity not found' }, 404)

  // 3. Determine relationship entity ID
  const relEntityId = entity.parent_id ?? entityId

  // 2 & 4. Fetch chunk content and relationships in parallel
  const [chunkRow, { results: relRows }] = await Promise.all([
    c.env.DB
      .prepare(`SELECT content FROM text_chunk WHERE id = ?`)
      .bind(entity.source_chunk_id)
      .first<{ content: string }>(),
    c.env.DB
      .prepare(
        `SELECT er.edge_type, er.explanation,
                fe.label AS from_label, fe.extracted_text AS from_text,
                te.label AS to_label, te.extracted_text AS to_text
         FROM extracted_relationship er
         JOIN extracted_entity fe ON fe.id = er.from_entity_id
         JOIN extracted_entity te ON te.id = er.to_entity_id
         WHERE (er.from_entity_id = ? OR er.to_entity_id = ?)
           AND er.source_document_id = ?`
      )
      .bind(relEntityId, relEntityId, documentId)
      .all<{
        edge_type: string
        explanation: string | null
        from_label: string | null
        from_text: string | null
        to_label: string | null
        to_text: string | null
      }>(),
  ])

  const chunkContent = chunkRow?.content ?? ''

  // 5. Format relationships
  const relLines = relRows.map((r) => {
    const from = r.from_label ?? r.from_text ?? '?'
    const to = r.to_label ?? r.to_text ?? '?'
    const explanation = r.explanation ? `: ${r.explanation}` : ''
    return `- ${from} ${r.edge_type} ${to}${explanation}`
  })

  const relSection = relLines.length > 0
    ? `\nKnown relationships:\n${relLines.join('\n')}`
    : ''

  // 6. LLM call
  const entityLabel = entity.extracted_text ?? '(unknown)'
  const messages = [
    {
      role: 'system' as const,
      content: 'You are a knowledge assistant for Chinese literature. Give direct, compact entity descriptions. Never use filler phrases like "In this passage", "Based on the text", "According to". Start immediately with the description.',
    },
    {
      role: 'user' as const,
      content: `Entity: "${entityLabel}" (${entity.entity_type})

Passage:
${chunkContent}${relSection}

In 2–3 sentences, describe who or what "${entityLabel}" is in the context of this document.`,
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
    messages,
    temperature: 0.3,
    max_tokens: 300,
  })

  const summary = (result as { response?: string }).response ?? ''

  return c.json({ summary })
})

export default knowledgeRoutes

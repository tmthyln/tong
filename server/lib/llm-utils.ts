/**
 * Strip markdown code fences from an LLM response string before JSON parsing.
 * Some models return ```json\n{...}\n``` even with response_format: json_object.
 */
export function stripJsonFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
}

/**
 * Extract a JSON object from an LLM response string, handling:
 * - Markdown code fences
 * - Prose before/after the JSON (e.g. "Since both... {"groups": [...]}")
 * - Multiple JSON objects (model self-corrects mid-response) — returns the last valid one
 * - Trailing commas before ] or } (common LLM mistake)
 */
export function extractJsonObject(s: string): string {
  // Strip fences and trailing commas first
  s = stripJsonFences(s).trim()
  s = s.replace(/,(\s*[}\]])/g, '$1')

  // Find all complete top-level JSON objects via brace-depth matching
  const candidates: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (depth === 0) start = i
      depth++
    } else if (s[i] === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        candidates.push(s.slice(start, i + 1))
        start = -1
      }
    }
  }

  // Return the last candidate that parses as valid JSON (models self-correct at the end)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      JSON.parse(candidates[i])
      return candidates[i]
    } catch {
      // try previous candidate
    }
  }

  return s // fallback: let the caller's JSON.parse produce the error
}

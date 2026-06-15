// "Does the user know these terms?" — reads the per-user Lexicon Durable Object
// so the agent can decide what needs explaining. Reuses Lexicon.getAll().

export interface TermKnowledge {
  term: string
  seen: boolean
  known: boolean
  learnCount: number
  failCount: number
}

/**
 * For each term, report whether the user has seen/learned it. `known` is a
 * heuristic (learnCount > 0); raw counts are included so callers can judge.
 */
export async function userKnowsTerms(
  env: Env,
  userId: string,
  terms: string[],
): Promise<TermKnowledge[]> {
  const stub = env.LEXICON.get(env.LEXICON.idFromName(userId))
  const all = await stub.getAll()
  const byTerm = new Map(all.map((e) => [e.term, e]))

  return terms.map((term) => {
    const entry = byTerm.get(term)
    return {
      term,
      seen: !!entry,
      known: !!entry && entry.learnCount > 0,
      learnCount: entry?.learnCount ?? 0,
      failCount: entry?.failCount ?? 0,
    }
  })
}

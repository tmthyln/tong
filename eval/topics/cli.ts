/**
 * Topic-label eval CLI. See README.md.
 *
 *   build                  corpus → data/corpus.json, document embeddings → data/vectors.json
 *   bridge [port]          local Workers AI bridge for container/topics.py (default 8790)
 *   judge [models…]        score results/runs/*.json → results/scores/*.json
 *   report                 results/report.html
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCorpus, DATA_DIR } from './corpus'
import { embedCached, serveBridge } from './bridge'

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'build') {
    const chunks = await buildCorpus()
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(join(DATA_DIR, 'corpus.json'), JSON.stringify(chunks))
    const byGroup = new Map<string, number>()
    for (const c of chunks) byGroup.set(c.group, (byGroup.get(c.group) ?? 0) + 1)
    console.log(`${chunks.length} chunks, ${chunks.reduce((n, c) => n + c.text.length, 0)} chars, ${new Set(chunks.map((c) => c.doc)).size} docs`)
    console.log([...byGroup].map(([g, n]) => `${g} ${n}`).join(' · '))
    const vectors = await embedCached(chunks.map((c) => c.text), 'document')
    writeFileSync(join(DATA_DIR, 'vectors.json'), JSON.stringify(vectors))
    console.log(`embedded ${vectors.length}`)
    return
  }
  if (cmd === 'bridge') {
    serveBridge(Number(args[0] ?? 8790))
    return
  }
  const mod = await import('./judge')
  if (cmd === 'judge') return mod.judgeAll(args)
  if (cmd === 'report') return mod.report()
  throw new Error(`unknown command ${cmd}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

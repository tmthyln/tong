/**
 * Eval corpus for topic labelling: a mixed "language learner's library".
 *
 * - zh Wikipedia articles (Simplified, expository) across six domains;
 * - classics from zh Wikisource (Traditional): novels and philosophy;
 * - 斗罗大陆 and 三國演義 chapters already used by eval/resolution.
 *
 * Everything is chunked with the app's chunker. The domain/work of each chunk is
 * kept as metadata — not used by toponymy, only for diagnostics. Downloads are
 * cached under data/download (gitignored, like all corpus text).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateChunkIndices } from '../../server/lib/chunking'
import { loadCorpus, sanguoRawDocs } from '../resolution/datasets'

export const DATA_DIR = join(process.cwd(), 'eval/topics/data')
const DL = join(DATA_DIR, 'download')
const UA = 'tong-eval/0.1 (local research script)'

export interface CorpusChunk {
  id: number
  doc: string
  /** Work (book) or Wikipedia domain — diagnostic metadata only. */
  group: string
  genre: 'wiki' | 'novel' | 'philosophy'
  text: string
}

export const WIKI: Record<string, string[]> = {
  science: ['光合作用', '黑洞', '量子力学', '脱氧核糖核酸', '板块构造论'],
  technology: ['人工智能', '互联网', '密码学', '半导体', '操作系统'],
  food: ['川菜', '饺子', '茶', '豆腐', '火锅'],
  sports: ['足球', '乒乓球', '围棋', '马拉松', '武术'],
  economics: ['通货膨胀', '股票', '供给和需求', '中央银行', '全球化'],
  'history-geography': ['唐朝', '丝绸之路', '长江', '青藏高原', '秦始皇'],
}

const pad = (n: number) => String(n).padStart(3, '0')
export const WIKISOURCE: Array<{ group: string; genre: CorpusChunk['genre']; pages: string[] }> = [
  { group: '西遊記', genre: 'novel', pages: [1, 2, 3, 4, 5, 6].map((n) => `西遊記/第${pad(n)}回`) },
  { group: '紅樓夢', genre: 'novel', pages: [1, 2, 3, 4, 5].map((n) => `紅樓夢/第${pad(n)}回`) },
  { group: '論語', genre: 'philosophy', pages: ['學而第一', '為政第二', '八佾第三', '里仁第四', '公冶長第五', '雍也第六', '述而第七'].map((p) => `論語/${p}`) },
  { group: '孫子兵法', genre: 'philosophy', pages: ['孫子兵法'] },
]

const WIKI_MAX_CHARS = 5000
const DROP_SECTIONS = /^(参考文献|参考资料|参见|外部链接|注释|脚注|延伸阅读|相关条目|引用|来源)$/

async function cachedFetch(name: string, url: string): Promise<string> {
  mkdirSync(DL, { recursive: true })
  const path = join(DL, name.replace(/[/\\]/g, '_') + '.json')
  if (existsSync(path)) return readFileSync(path, 'utf8')
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) {
      const body = await res.text()
      writeFileSync(path, body)
      await new Promise((r) => setTimeout(r, 1500))
      return body
    }
    if (res.status !== 429 || i >= 6) throw new Error(`${url}: HTTP ${res.status}`)
    await new Promise((r) => setTimeout(r, 5000 * 2 ** i))
  }
}

async function wikiArticle(title: string): Promise<string> {
  const url = `https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&variant=zh-cn&titles=${encodeURIComponent(title)}`
  const body = JSON.parse(await cachedFetch(`wiki-${title}`, url)) as { query: { pages: Array<{ extract?: string }> } }
  const raw = body.query.pages[0]?.extract ?? ''
  if (!raw) throw new Error(`empty Wikipedia article: ${title}`)
  // "== 历史 ==" → markdown headings; drop reference sections.
  const out: string[] = []
  let dropping = false
  for (const line of raw.split('\n')) {
    const h = /^(=+)\s*(.*?)\s*=+$/.exec(line.trim())
    if (h) {
      dropping = DROP_SECTIONS.test(h[2])
      if (!dropping) out.push(`${'#'.repeat(Math.min(h[1].length, 4))} ${h[2]}`)
      continue
    }
    if (!dropping && line.trim()) out.push(line.trim())
  }
  let text = ''
  for (const para of out) {
    if (text.length + para.length > WIKI_MAX_CHARS) break
    text += (text ? '\n\n' : '') + para
  }
  return text
}

async function wikisourcePage(page: string): Promise<string> {
  const url = `https://zh.wikisource.org/w/api.php?action=parse&prop=text&format=json&formatversion=2&page=${encodeURIComponent(page)}`
  const body = JSON.parse(await cachedFetch(`ws-${page}`, url)) as { parse?: { text: string } }
  const html = body.parse?.text ?? ''
  // Body text lives in <p> (and <dd> for verse); headers/navboxes are tables/divs.
  const paras = [...html.matchAll(/<(p|dd)[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((m) => m[2].replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/&[a-z]+;/g, '').trim())
    .filter((p) => p.length > 4 && !/作者：|姊妹計劃|姊妹计划|維基|维基|公有领域|公有領域|Public domain|上一回|回目录/.test(p))
  if (!paras.length) throw new Error(`empty Wikisource page: ${page}`)
  return paras.join('\n\n')
}

function chunk(content: string): string[] {
  return generateChunkIndices(content).map((ix) => content.slice(ix.startIndex, ix.endIndex)).filter((c) => c.trim().length >= 20)
}

export async function buildCorpus(): Promise<CorpusChunk[]> {
  const out: CorpusChunk[] = []
  const push = (doc: string, group: string, genre: CorpusChunk['genre'], texts: string[]) => {
    for (const text of texts) out.push({ id: out.length, doc, group, genre, text })
  }
  for (const [domain, titles] of Object.entries(WIKI)) {
    for (const t of titles) push(`wiki:${t}`, domain, 'wiki', chunk(await wikiArticle(t)))
  }
  for (const w of WIKISOURCE) {
    for (const p of w.pages) push(`ws:${p}`, w.group, w.genre, chunk(await wikisourcePage(p)))
  }
  for (const d of loadCorpus('douluo').docs) push(d.id, '斗罗大陆', 'novel', d.chunks.map((c) => c.content))
  for (const d of sanguoRawDocs(6)) push(d.id, '三國演義', 'novel', d.chunks.map((c) => c.content))
  return out
}

import { unzipSync } from 'fflate'

export interface CedictEntry {
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

export interface CedictMeta {
  epoch: number
  date: string // ISO date string from the file header
  source: string // "cedict:{epoch}"
}

const ENTRY_RE = /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.+)\/$/

export function extractCedictZip(buffer: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buffer))
  const file = Object.values(files)[0]
  if (!file) throw new Error('No file found in CEDICT zip')
  return new TextDecoder('utf-8').decode(file)
}

export function parseCedictText(text: string): { entries: CedictEntry[]; meta: CedictMeta } {
  const entries: CedictEntry[] = []
  let epoch = 0
  let date = ''

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#!')) {
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(2, eq).trim()
      const val = line.slice(eq + 1).trim()
      if (key === 'time') epoch = parseInt(val, 10)
      if (key === 'date') date = val
      continue
    }
    if (!line || line.startsWith('#')) continue

    const m = ENTRY_RE.exec(line)
    if (!m) continue

    entries.push({
      traditional: m[1],
      simplified: m[2],
      pinyin: m[3],
      definitions: m[4].split('/'),
    })
  }

  if (!epoch) throw new Error('Could not parse CEDICT epoch from file header')

  return {
    entries,
    meta: { epoch, date, source: `cedict:${epoch}` },
  }
}

export const TONE_MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à', 'a'],
  e: ['ē', 'é', 'ě', 'è', 'e'],
  i: ['ī', 'í', 'ǐ', 'ì', 'i'],
  o: ['ō', 'ó', 'ǒ', 'ò', 'o'],
  u: ['ū', 'ú', 'ǔ', 'ù', 'u'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
}

/**
 * Convert a single numbered-pinyin syllable to tone-marked form.
 * Placement rules (in priority order):
 *   1. 'a' or 'e' always takes the mark:            mai4 → mài, jie2 → jié
 *   2. 'ou' — mark goes on 'o':                     dou4 → dòu
 *   3. Otherwise mark the last vowel in the nucleus: liu2 → liú, gui4 → guì
 * Tone 5 (neutral) strips the number and returns the bare syllable: ma5 → ma
 * 'v' is treated as 'ü':                            lv4 → lǜ
 */
function syllableToMarked(syllable: string): string {
  const m = syllable.match(/^(.+?)([1-5])$/)
  if (!m) return syllable
  const syl = m[1]
  const toneStr = m[2]
  if (syl === undefined || toneStr === undefined) return syllable
  const tone = parseInt(toneStr) - 1
  const s = syl.replace(/v/g, 'ü')
  if (tone === 4) return s
  if (/[ae]/.test(s))
    return s.replace(/[ae]/, (ch) => TONE_MARKS[ch]?.[tone] ?? ch)
  if (s.includes('ou'))
    return s.replace('o', TONE_MARKS['o']?.[tone] ?? 'o')
  const match = s.match(/[iuüaeo](?=[^iuüaeo]*$)/)
  if (match && match.index !== undefined) {
    const ch = s[match.index]
    if (ch !== undefined)
      return s.slice(0, match.index) + (TONE_MARKS[ch]?.[tone] ?? ch) + s.slice(match.index + 1)
  }
  return s
}

export function pinyinToMarked(pinyin: string): string {
  return pinyin.split(' ').map(syllableToMarked).join(' ')
}

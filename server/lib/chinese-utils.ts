/**
 * Chinese character counting utilities
 */

/**
 * Checks if a character (code point) is a Chinese ideograph.
 *
 * Ranges included:
 * - U+4E00-U+9FFF: CJK Unified Ideographs
 * - U+3400-U+4DBF: CJK Unified Ideographs Extension A
 * - U+20000-U+2A6DF: CJK Unified Ideographs Extension B
 * - U+2A700-U+2B73F: CJK Unified Ideographs Extension C
 * - U+2B740-U+2B81F: CJK Unified Ideographs Extension D
 * - U+2B820-U+2CEAF: CJK Unified Ideographs Extension E
 * - U+2CEB0-U+2EBEF: CJK Unified Ideographs Extension F
 * - U+30000-U+3134F: CJK Unified Ideographs Extension G
 * - U+F900-U+FAFF: CJK Compatibility Ideographs
 */
function isChineseCharacter(codePoint: number): boolean {
  return (
    // CJK Unified Ideographs
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    // CJK Unified Ideographs Extension A
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    // CJK Unified Ideographs Extension B
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    // CJK Unified Ideographs Extension C
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    // CJK Unified Ideographs Extension D
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    // CJK Unified Ideographs Extension E
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    // CJK Unified Ideographs Extension F
    (codePoint >= 0x2ceb0 && codePoint <= 0x2ebef) ||
    // CJK Unified Ideographs Extension G
    (codePoint >= 0x30000 && codePoint <= 0x3134f) ||
    // CJK Compatibility Ideographs
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  )
}

/**
 * Counts Chinese characters in a string.
 *
 * @param text - The input string to analyze
 * @returns An object with charCount (total Chinese characters) and uniqueCharCount (distinct Chinese characters)
 */
export function countChineseCharacters(text: string): {
  charCount: number
  uniqueCharCount: number
} {
  const chars: string[] = []
  const uniqueChars = new Set<string>()

  // Iterate over code points to handle surrogate pairs correctly
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && isChineseCharacter(codePoint)) {
      chars.push(char)
      uniqueChars.add(char)
    }
  }

  return {
    charCount: chars.length,
    uniqueCharCount: uniqueChars.size,
  }
}
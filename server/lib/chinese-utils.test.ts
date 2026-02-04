import { describe, it, expect } from 'vitest'
import { countChineseCharacters } from './chinese-utils'

describe('countChineseCharacters', () => {
  describe('basic Chinese character counting', () => {
    it('counts basic Chinese characters', () => {
      const result = countChineseCharacters('你好世界')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('counts single character', () => {
      const result = countChineseCharacters('中')
      expect(result.charCount).toBe(1)
      expect(result.uniqueCharCount).toBe(1)
    })

    it('counts longer text', () => {
      const result = countChineseCharacters('学习中文很有趣')
      expect(result.charCount).toBe(7)
      expect(result.uniqueCharCount).toBe(7)
    })
  })

  describe('unique character counting', () => {
    it('counts repeated characters correctly', () => {
      const result = countChineseCharacters('你好你好')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(2)
    })

    it('counts all same character', () => {
      const result = countChineseCharacters('好好好好好')
      expect(result.charCount).toBe(5)
      expect(result.uniqueCharCount).toBe(1)
    })

    it('counts mixed repetition patterns', () => {
      // 你你好好世 - 你 appears 2x, 好 appears 2x, 世 appears 1x
      const result = countChineseCharacters('你你好好世')
      expect(result.charCount).toBe(5)
      expect(result.uniqueCharCount).toBe(3)
    })
  })

  describe('mixed content (Chinese + Latin + numbers + punctuation)', () => {
    it('excludes Latin alphabet', () => {
      const result = countChineseCharacters('Hello你好World世界')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes numbers', () => {
      const result = countChineseCharacters('第1章第2节')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(3) // 第 appears twice
    })

    it('excludes ASCII punctuation', () => {
      const result = countChineseCharacters('你好!世界.')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes whitespace', () => {
      const result = countChineseCharacters('你好 世界\t中文\n学习')
      expect(result.charCount).toBe(8)
      expect(result.uniqueCharCount).toBe(8)
    })

    it('handles complex mixed content', () => {
      const result = countChineseCharacters(
        'Chapter 1: 第一章 - Introduction 简介 (2024)'
      )
      // Chinese: 第一章简介 = 5 characters, all unique
      expect(result.charCount).toBe(5)
      expect(result.uniqueCharCount).toBe(5)
    })
  })

  describe('Chinese punctuation exclusion', () => {
    it('excludes Chinese comma and period', () => {
      const result = countChineseCharacters('你好，世界。')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes Chinese exclamation and question marks', () => {
      const result = countChineseCharacters('你好！世界？')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes Chinese quotation marks', () => {
      const result = countChineseCharacters('「你好」『世界』')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes Chinese parentheses and brackets', () => {
      const result = countChineseCharacters('（你好）【世界】')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes middle dot and other Chinese punctuation', () => {
      const result = countChineseCharacters('你·好、世；界：')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })

    it('excludes Chinese punctuation only string', () => {
      const result = countChineseCharacters('，。！？「」『』（）【】')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })
  })

  describe('empty string and no Chinese characters', () => {
    it('handles empty string', () => {
      const result = countChineseCharacters('')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('handles string with only Latin characters', () => {
      const result = countChineseCharacters('Hello World')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('handles string with only numbers', () => {
      const result = countChineseCharacters('1234567890')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('handles string with only ASCII punctuation', () => {
      const result = countChineseCharacters('!@#$%^&*()')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('handles string with only whitespace', () => {
      const result = countChineseCharacters('   \t\n\r')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })
  })

  describe('CJK Extension ranges', () => {
    it('counts CJK Unified Ideographs Extension A characters', () => {
      // U+3400 is the start of Extension A
      const result = countChineseCharacters('\u3400\u3401\u3402')
      expect(result.charCount).toBe(3)
      expect(result.uniqueCharCount).toBe(3)
    })

    it('counts CJK Compatibility Ideographs', () => {
      // U+F900-U+FAFF range
      const result = countChineseCharacters('\uF900\uF901\uF902')
      expect(result.charCount).toBe(3)
      expect(result.uniqueCharCount).toBe(3)
    })
  })

  describe('surrogate pairs (CJK Extension B+ characters)', () => {
    it('counts CJK Extension B character (U+20000)', () => {
      // U+20000 is 𠀀 - represented as surrogate pair \uD840\uDC00
      const char = '\uD840\uDC00' // 𠀀
      const result = countChineseCharacters(char)
      expect(result.charCount).toBe(1)
      expect(result.uniqueCharCount).toBe(1)
    })

    it('counts multiple Extension B characters', () => {
      // U+20000, U+20001, U+20002
      const text = '\uD840\uDC00\uD840\uDC01\uD840\uDC02'
      const result = countChineseCharacters(text)
      expect(result.charCount).toBe(3)
      expect(result.uniqueCharCount).toBe(3)
    })

    it('counts repeated Extension B characters correctly', () => {
      // Same character twice: U+20000
      const char = '\uD840\uDC00'
      const result = countChineseCharacters(char + char)
      expect(result.charCount).toBe(2)
      expect(result.uniqueCharCount).toBe(1)
    })

    it('handles mixed BMP and surrogate pair characters', () => {
      // 你 (BMP) + 𠀀 (Extension B) + 好 (BMP)
      const text = '你\uD840\uDC00好'
      const result = countChineseCharacters(text)
      expect(result.charCount).toBe(3)
      expect(result.uniqueCharCount).toBe(3)
    })

    it('counts CJK Extension C character', () => {
      // U+2A700 is in Extension C - represented as surrogate pair \uD869\uDF00
      const char = '\uD869\uDF00'
      const result = countChineseCharacters(char)
      expect(result.charCount).toBe(1)
      expect(result.uniqueCharCount).toBe(1)
    })

    it('counts CJK Extension G character', () => {
      // U+30000 is in Extension G - represented as surrogate pair \uD880\uDC00
      const char = '\uD880\uDC00'
      const result = countChineseCharacters(char)
      expect(result.charCount).toBe(1)
      expect(result.uniqueCharCount).toBe(1)
    })
  })

  describe('edge cases', () => {
    it('handles very long string', () => {
      const longText = '中'.repeat(10000)
      const result = countChineseCharacters(longText)
      expect(result.charCount).toBe(10000)
      expect(result.uniqueCharCount).toBe(1)
    })

    it('handles string with all unique Chinese characters', () => {
      // First 100 CJK Unified Ideographs
      let text = ''
      for (let i = 0x4e00; i < 0x4e64; i++) {
        text += String.fromCodePoint(i)
      }
      const result = countChineseCharacters(text)
      expect(result.charCount).toBe(100)
      expect(result.uniqueCharCount).toBe(100)
    })

    it('excludes Japanese hiragana', () => {
      // Hiragana should not be counted as Chinese characters
      const result = countChineseCharacters('こんにちは')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('excludes Japanese katakana', () => {
      // Katakana should not be counted as Chinese characters
      const result = countChineseCharacters('コンニチハ')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('counts kanji in mixed Japanese text', () => {
      // Only the kanji (Chinese characters) should be counted
      const result = countChineseCharacters('日本語を勉強する')
      // 日本語勉強 = 5 kanji, all unique
      expect(result.charCount).toBe(5)
      expect(result.uniqueCharCount).toBe(5)
    })

    it('excludes Korean hangul', () => {
      // Hangul should not be counted as Chinese characters
      const result = countChineseCharacters('안녕하세요')
      expect(result.charCount).toBe(0)
      expect(result.uniqueCharCount).toBe(0)
    })

    it('counts hanja in mixed Korean text', () => {
      // Only hanja (Chinese characters) should be counted
      const result = countChineseCharacters('大韓民國')
      expect(result.charCount).toBe(4)
      expect(result.uniqueCharCount).toBe(4)
    })
  })
})
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { translateAndStoreChunk } from './translation'

describe('translateAndStoreChunk', () => {
  let mockEnv: {
    AI: { run: ReturnType<typeof vi.fn> }
    DB: { prepare: ReturnType<typeof vi.fn> }
  }
  let mockBind: ReturnType<typeof vi.fn>
  let mockRun: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockRun = vi.fn().mockResolvedValue({})
    mockBind = vi.fn().mockReturnValue({ run: mockRun })

    mockEnv = {
      AI: {
        run: vi.fn().mockResolvedValue({ translated_text: 'Hello world' }),
      },
      DB: {
        prepare: vi.fn().mockReturnValue({ bind: mockBind }),
      },
    }
  })

  it('calls AI with correct model, text, source_lang, and target_lang', async () => {
    const chunkId = 42
    const content = '你好世界'

    await translateAndStoreChunk(chunkId, content, mockEnv as unknown as Env)

    expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/meta/m2m100-1.2b', {
      text: content,
      source_lang: 'chinese',
      target_lang: 'english',
    })
  })

  it('inserts translation into D1 with correct values', async () => {
    const chunkId = 123
    const content = '测试内容'
    const translatedText = 'Test content'

    mockEnv.AI.run.mockResolvedValue({ translated_text: translatedText })

    await translateAndStoreChunk(chunkId, content, mockEnv as unknown as Env)

    expect(mockEnv.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO translation_chunk')
    )
    expect(mockBind).toHaveBeenCalledWith(
      chunkId,
      translatedText,
      'ai:m2m100-1.2b',
      expect.any(String),
      expect.any(String)
    )
    expect(mockRun).toHaveBeenCalled()
  })

  it('sets translator field to "ai:m2m100-1.2b"', async () => {
    await translateAndStoreChunk(1, '内容', mockEnv as unknown as Env)

    const bindArgs = mockBind.mock.calls[0]
    expect(bindArgs[2]).toBe('ai:m2m100-1.2b')
  })

  it('uses ISO format for date_created and date_last_modified', async () => {
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/

    await translateAndStoreChunk(1, '内容', mockEnv as unknown as Env)

    const bindArgs = mockBind.mock.calls[0]
    const dateCreated = bindArgs[3]
    const dateLastModified = bindArgs[4]

    expect(dateCreated).toMatch(isoDatePattern)
    expect(dateLastModified).toMatch(isoDatePattern)
    expect(dateCreated).toBe(dateLastModified)
  })

  it('throws error when translation response is missing translated_text', async () => {
    mockEnv.AI.run.mockResolvedValue({})

    await expect(
      translateAndStoreChunk(1, '内容', mockEnv as unknown as Env)
    ).rejects.toThrow('Translation failed: no translated_text in response')
  })

  it('throws error when translated_text is undefined', async () => {
    mockEnv.AI.run.mockResolvedValue({ translated_text: undefined })

    await expect(
      translateAndStoreChunk(1, '内容', mockEnv as unknown as Env)
    ).rejects.toThrow('Translation failed: no translated_text in response')
  })

  it('throws error when translated_text is empty string', async () => {
    mockEnv.AI.run.mockResolvedValue({ translated_text: '' })

    await expect(
      translateAndStoreChunk(1, '内容', mockEnv as unknown as Env)
    ).rejects.toThrow('Translation failed: no translated_text in response')
  })
})
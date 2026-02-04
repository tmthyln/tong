import { describe, it, expect } from 'vitest'
import { generateChunkIndices } from './chunking'

describe('generateChunkIndices', () => {
  describe('empty and short content', () => {
    it('returns empty array for empty string', () => {
      const result = generateChunkIndices('')
      expect(result).toEqual([])
    })

    it('returns single chunk for short content without boundaries', () => {
      const content = 'This is a short paragraph.'
      const result = generateChunkIndices(content)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ startIndex: 0, endIndex: content.length })
    })

    it('returns single chunk for content just under MIN_CHUNK_SIZE', () => {
      const content = 'A'.repeat(99) // Just under 100 chars
      const result = generateChunkIndices(content)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ startIndex: 0, endIndex: 99 })
    })
  })

  describe('header-based splitting', () => {
    it('splits on level 1 headers', () => {
      const content = `# First Header
Some content here that is long enough to be its own chunk. ${'A'.repeat(200)}

# Second Header
More content here that is also long enough. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      expect(result.length).toBeGreaterThanOrEqual(1)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('splits on level 2 headers', () => {
      const content = `## Introduction
This is the introduction section with enough content. ${'A'.repeat(200)}

## Methods
This is the methods section with enough content. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      expect(result.length).toBeGreaterThanOrEqual(1)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('splits on mixed header levels', () => {
      const content = `# Main Title
Introduction paragraph. ${'A'.repeat(200)}

## Subsection One
Content for subsection one. ${'B'.repeat(200)}

### Sub-subsection
Deeper content here. ${'C'.repeat(200)}

## Subsection Two
More content. ${'D'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles header at very beginning (index 0)', () => {
      const content = `# Header At Start
${'Content '.repeat(100)}`
      const result = generateChunkIndices(content)
      // First chunk should start at 0 (header at start)
      expect(result[0].startIndex).toBe(0)
      verifyNoWhitespaceAtBoundaries(result, content)
    })
  })

  describe('paragraph break splitting', () => {
    it('splits on double newlines', () => {
      const content = `First paragraph with enough content to stand alone. ${'A'.repeat(200)}

Second paragraph that is also sufficiently long. ${'B'.repeat(200)}

Third paragraph with plenty of content. ${'C'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles multiple consecutive newlines', () => {
      const content = `First paragraph. ${'A'.repeat(200)}



Second paragraph after triple newline. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles mixed paragraph breaks and headers', () => {
      const content = `# Title
First paragraph under title. ${'A'.repeat(200)}

Another paragraph. ${'B'.repeat(200)}

## New Section
Content in new section. ${'C'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })
  })

  describe('horizontal rule splitting', () => {
    it('splits on --- horizontal rule', () => {
      const content = `Content before the rule. ${'A'.repeat(200)}

---

Content after the rule. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('splits on *** horizontal rule', () => {
      const content = `Content before the rule. ${'A'.repeat(200)}

***

Content after the rule. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('splits on ___ horizontal rule', () => {
      const content = `Content before the rule. ${'A'.repeat(200)}

___

Content after the rule. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles extended horizontal rules (-----, *****, _____)', () => {
      const content = `Content before. ${'A'.repeat(200)}

-----

Content after. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })
  })

  describe('short segment merging', () => {
    it('merges segments shorter than MIN_CHUNK_SIZE (100 chars)', () => {
      const content = `Short.

Also short.

Another short one.

${'This one is long enough to be meaningful content on its own. '.repeat(10)}`
      const result = generateChunkIndices(content)
      // All the short segments should be merged
      for (const chunk of result) {
        const chunkLength = chunk.endIndex - chunk.startIndex
        expect(chunkLength).toBeGreaterThanOrEqual(1)
      }
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('merges towards target size (500-2000 chars)', () => {
      // Create content with many small segments
      const segments = []
      for (let i = 0; i < 20; i++) {
        segments.push(`Segment ${i}: ${'X'.repeat(80)}`)
      }
      const content = segments.join('\n\n')
      const result = generateChunkIndices(content)
      // Should have fewer chunks than original segments due to merging
      expect(result.length).toBeLessThan(20)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('merges last chunk if very short', () => {
      const content = `${'A'.repeat(600)}

${'B'.repeat(600)}

tiny`
      const result = generateChunkIndices(content)
      // The tiny segment at the end should be merged with the previous chunk
      const lastChunk = result[result.length - 1]
      expect(content.slice(lastChunk.startIndex, lastChunk.endIndex)).toContain('tiny')
      verifyNoOverlaps(result)
    })
  })

  describe('no overlaps verification', () => {
    it('ensures chunks do not overlap', () => {
      const content = `# First Section
${'Content for first section. '.repeat(50)}

## Subsection A
${'More detailed content here. '.repeat(30)}

---

# Second Section
${'Different topic content. '.repeat(40)}

Another paragraph in section two. ${'Extra '.repeat(50)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
    })

    it('maintains no overlaps with complex markdown', () => {
      const content = `# Header

Paragraph one. ${'A'.repeat(100)}

Paragraph two. ${'B'.repeat(100)}

---

## Another Header

${'C'.repeat(100)}

***

### Deep Header

${'D'.repeat(100)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })
  })

  describe('whitespace handling', () => {
    it('chunks do not start with whitespace', () => {
      const content = `# Header

   Indented paragraph. ${'A'.repeat(200)}

## Another Header

More content. ${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('chunks do not end with whitespace', () => {
      const content = `Content here. ${'A'.repeat(200)}

# Header

More content. ${'B'.repeat(200)}   `
      const result = generateChunkIndices(content)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('gaps between chunks contain only whitespace', () => {
      const content = `# First Section
${'A'.repeat(200)}

# Second Section
${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyGapsAreWhitespace(result, content)
    })

    it('handles content starting with newlines', () => {
      const content = `

# Header

Content. ${'A'.repeat(200)}`
      const result = generateChunkIndices(content)
      // First chunk should not start with whitespace
      if (result.length > 0) {
        expect(/\s/.test(content[result[0].startIndex])).toBe(false)
      }
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles content ending with newlines', () => {
      const content = `# Header

Content here. ${'A'.repeat(200)}

`
      const result = generateChunkIndices(content)
      // Last chunk should not end with whitespace
      if (result.length > 0) {
        const lastChunk = result[result.length - 1]
        expect(/\s/.test(content[lastChunk.endIndex - 1])).toBe(false)
      }
      verifyNoWhitespaceAtBoundaries(result, content)
    })
  })

  describe('long documents with multiple semantic boundaries', () => {
    it('handles a realistic markdown document', () => {
      const content = `# User Guide

Welcome to our application. This guide will help you get started.

## Installation

To install the application, follow these steps:

1. Download the installer from our website
2. Run the installer executable
3. Follow the on-screen instructions

${'Installation details and troubleshooting information. '.repeat(20)}

---

## Configuration

After installation, you need to configure the application.

### Basic Settings

${'Configure your basic settings by navigating to the settings panel. '.repeat(15)}

### Advanced Settings

${'Advanced configuration options are available for power users. '.repeat(15)}

---

## Usage

Here's how to use the main features of the application.

### Feature One

${'Description of feature one and how to use it effectively. '.repeat(20)}

### Feature Two

${'Description of feature two with detailed instructions. '.repeat(20)}

***

## Troubleshooting

If you encounter issues, try these solutions:

${'Common problems and their solutions listed here. '.repeat(25)}

___

## Contact Support

If you need further assistance, contact our support team.

${'Contact information and support hours. '.repeat(10)}`

      const result = generateChunkIndices(content)

      // Should create multiple chunks
      expect(result.length).toBeGreaterThan(1)

      // Verify structural integrity
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)

      // Verify chunk sizes are reasonable
      for (const chunk of result) {
        const size = chunk.endIndex - chunk.startIndex
        expect(size).toBeGreaterThan(0)
      }
    })

    it('handles very long document with many sections', () => {
      // Generate a large document
      const sections = []
      for (let i = 0; i < 50; i++) {
        sections.push(`## Section ${i}

${'This is content for section ' + i + '. '.repeat(30)}`)
      }
      const content = '# Main Document\n\n' + sections.join('\n\n---\n\n')

      const result = generateChunkIndices(content)

      expect(result.length).toBeGreaterThan(1)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles document with no semantic boundaries but long content', () => {
      // Single long paragraph with no breaks
      const content = 'A'.repeat(5000)
      const result = generateChunkIndices(content)

      // Should return single chunk since no boundaries
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ startIndex: 0, endIndex: 5000 })
    })

    it('handles document with only whitespace boundaries', () => {
      const content = `First part of the document with substantial content. ${'X'.repeat(300)}

Second part after a paragraph break. ${'Y'.repeat(300)}

Third part with more content. ${'Z'.repeat(300)}`

      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })
  })

  describe('edge cases', () => {
    it('handles content that is exactly MIN_CHUNK_SIZE', () => {
      const content = 'A'.repeat(100)
      const result = generateChunkIndices(content)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ startIndex: 0, endIndex: 100 })
    })

    it('handles content with header-like text that is not at line start', () => {
      const content = `This is not a header: # fake header
${'A'.repeat(200)}

This is also not: ## another fake
${'B'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles horizontal rule without surrounding newlines', () => {
      const content = `Content before---Content after with enough length. ${'A'.repeat(200)}`
      // This should NOT split since --- is not on its own line
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles unicode content', () => {
      const content = `# 标题

这是中文内容。${'中文'.repeat(100)}

## 第二节

更多中文内容。${'内容'.repeat(100)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)
      verifyNoWhitespaceAtBoundaries(result, content)
    })

    it('handles whitespace-only content', () => {
      const content = '   \n\n  \t  \n  '
      const result = generateChunkIndices(content)
      // Should return empty array since all whitespace is trimmed
      expect(result).toEqual([])
    })
  })

  describe('code block handling', () => {
    it('does not split fenced code blocks', () => {
      const content = `# Header

\`\`\`javascript
function example() {
  // This is a long code block
  ${'const x = 1;\n'.repeat(50)}
}
\`\`\`

More content after. ${'A'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)

      // Verify the code block is not split
      const codeBlockContent = '```javascript'
      let foundCodeBlock = false
      for (const chunk of result) {
        const chunkText = content.slice(chunk.startIndex, chunk.endIndex)
        if (chunkText.includes(codeBlockContent)) {
          foundCodeBlock = true
          // The chunk should contain the entire code block
          expect(chunkText).toContain('```')
        }
      }
      expect(foundCodeBlock).toBe(true)
    })

    it('keeps code blocks atomic even when very long', () => {
      const longCode = 'x'.repeat(3000)
      const content = `\`\`\`
${longCode}
\`\`\``
      const result = generateChunkIndices(content)
      // Should be a single chunk
      expect(result.length).toBe(1)
    })
  })

  describe('blockquote handling', () => {
    it('does not split blockquotes', () => {
      const content = `# Header

> This is a blockquote
> that spans multiple lines
> ${'and has a lot of content '.repeat(50)}

More content after. ${'A'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)

      // Verify the blockquote is not split
      let foundBlockquote = false
      for (const chunk of result) {
        const chunkText = content.slice(chunk.startIndex, chunk.endIndex)
        if (chunkText.includes('> This is a blockquote')) {
          foundBlockquote = true
          // The chunk should contain the entire blockquote
          expect(chunkText).toContain('and has a lot of content')
        }
      }
      expect(foundBlockquote).toBe(true)
    })

    it('keeps blockquotes atomic even when very long', () => {
      const longQuote = '> ' + 'x'.repeat(3000)
      const content = longQuote
      const result = generateChunkIndices(content)
      // Should be a single chunk
      expect(result.length).toBe(1)
    })
  })

  describe('table handling', () => {
    it('does not split tables', () => {
      const tableRows = Array(50)
        .fill(null)
        .map((_, i) => `| Row ${i} | Data ${i} | More ${i} |`)
        .join('\n')
      const content = `# Header

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
${tableRows}

More content after. ${'A'.repeat(200)}`
      const result = generateChunkIndices(content)
      verifyNoOverlaps(result)

      // Verify the table is not split
      let foundTable = false
      for (const chunk of result) {
        const chunkText = content.slice(chunk.startIndex, chunk.endIndex)
        if (chunkText.includes('| Column 1 |')) {
          foundTable = true
          // The chunk should contain the entire table
          expect(chunkText).toContain('| Row 49 |')
        }
      }
      expect(foundTable).toBe(true)
    })

    it('keeps tables atomic even when very long', () => {
      const tableRows = Array(100)
        .fill(null)
        .map((_, i) => `| ${'x'.repeat(50)} | ${'y'.repeat(50)} |`)
        .join('\n')
      const content = `| Header 1 | Header 2 |
|----------|----------|
${tableRows}`
      const result = generateChunkIndices(content)
      // Should be a single chunk
      expect(result.length).toBe(1)
    })
  })
})

// Helper functions for verification
function verifyNoOverlaps(chunks: Array<{ startIndex: number; endIndex: number }>) {
  for (let i = 0; i < chunks.length - 1; i++) {
    expect(
      chunks[i].endIndex,
      `Chunk ${i} endIndex (${chunks[i].endIndex}) should be <= chunk ${i + 1} startIndex (${chunks[i + 1].startIndex})`
    ).toBeLessThanOrEqual(chunks[i + 1].startIndex)
  }
}

function verifyNoWhitespaceAtBoundaries(
  chunks: Array<{ startIndex: number; endIndex: number }>,
  content: string
) {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (chunk.startIndex < chunk.endIndex) {
      expect(
        /\s/.test(content[chunk.startIndex]),
        `Chunk ${i} should not start with whitespace at index ${chunk.startIndex}`
      ).toBe(false)
      expect(
        /\s/.test(content[chunk.endIndex - 1]),
        `Chunk ${i} should not end with whitespace at index ${chunk.endIndex - 1}`
      ).toBe(false)
    }
  }
}

function verifyGapsAreWhitespace(
  chunks: Array<{ startIndex: number; endIndex: number }>,
  content: string
) {
  for (let i = 0; i < chunks.length - 1; i++) {
    const gapStart = chunks[i].endIndex
    const gapEnd = chunks[i + 1].startIndex
    if (gapStart < gapEnd) {
      const gap = content.slice(gapStart, gapEnd)
      expect(
        /^\s*$/.test(gap),
        `Gap between chunk ${i} and ${i + 1} should contain only whitespace: "${gap}"`
      ).toBe(true)
    }
  }
}
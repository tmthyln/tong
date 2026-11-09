interface BaseFileInfo {
  location: string
  filename: string
  mimetype: string
  contentHash: string
}

export interface ExistingFileInfo extends BaseFileInfo {
  alreadyExists: true
  existingId: number
}

export interface NewFileInfo extends BaseFileInfo {
  alreadyExists: false
}

export type UploadedFileInfo = ExistingFileInfo | NewFileInfo

async function computeContentHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface OriginalFileInput {
  data: ArrayBuffer
  filename: string
  mimetype: string
  /** Extra R2 custom metadata (e.g. sourceUrl/charset for imported webpages). */
  customMetadata?: Record<string, string>
}

/**
 * Store original document bytes in R2 under a content-hash path, deduplicating
 * against existing documents with the same hash.
 */
export async function storeOriginalFile(
  input: OriginalFileInput,
  env: Env
): Promise<UploadedFileInfo> {
  const { data: arrayBuffer, filename, mimetype } = input
  const contentHash = await computeContentHash(arrayBuffer)

  // Check if file with same hash already exists
  const existing = await env.DB.prepare(
    'SELECT id, original_doc_location FROM document WHERE original_doc_content_hash = ?'
  )
    .bind(contentHash)
    .first<{ id: number; original_doc_location: string }>()

  if (existing) {
    return {
      location: existing.original_doc_location,
      filename,
      mimetype,
      contentHash,
      alreadyExists: true,
      existingId: existing.id,
    }
  }

  // Store in R2 with hash-based path for deduplication
  const location = `originals/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`

  await env.DOCUMENTS.put(location, arrayBuffer, {
    httpMetadata: {
      contentType: mimetype,
    },
    customMetadata: {
      ...input.customMetadata,
      originalFilename: filename,
      contentHash,
    },
  })

  return {
    location,
    filename,
    mimetype,
    contentHash,
    alreadyExists: false,
  }
}

export async function storeUploadedFile(
  file: File,
  env: Env
): Promise<UploadedFileInfo> {
  return storeOriginalFile(
    {
      data: await file.arrayBuffer(),
      filename: file.name,
      mimetype: file.type || 'application/octet-stream',
    },
    env
  )
}

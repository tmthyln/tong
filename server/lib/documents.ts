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

export async function storeUploadedFile(
  file: File,
  env: Env
): Promise<UploadedFileInfo> {
  const arrayBuffer = await file.arrayBuffer()
  const contentHash = await computeContentHash(arrayBuffer)
  const filename = file.name
  const mimetype = file.type || 'application/octet-stream'

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
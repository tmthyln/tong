export interface Entity {
  id: number
  entityType: string
  extractedText: string | null
  startIndex: number | null
  endIndex: number | null
  label: string | null
  scope: string
  parentId: number | null
  preferredTranslation: string | null
}

export interface Chunk {
  id: number
  order: number
  startIndex: number
  endIndex: number
  content: string
  charCount: number
  uniqueCharCount: number
  entities: Entity[]
  translation: string | null
  translationDraftNumber: number | null
  translationTranslator: string | null
  translationDateLastModified: string | null
  availableTranslationDrafts: number[]
}

export interface Relationship {
  id: number
  fromEntityId: number
  toEntityId: number
  edgeType: string
  edgeReverseName: string | null
  explanation: string | null
  fromLabel: string | null
  toLabel: string | null
}

export interface ChunkRelationship {
  id: number
  fromEntityId: number
  toEntityId: number
  edgeType: string
  edgeReverseName: string | null
  explanation: string | null
  fromText: string | null
  toText: string | null
}

export interface Document {
  id: number
  title: string | null
  filename: string
  mimetype: string
  dateUploaded: string
  dateLastAccessed: string | null
  dateLastModified: string | null
  charCount: number
  uniqueCharCount: number
  parentId: number | null
  extractedContent: string
  entities: Entity[]
  chunks: Chunk[]
  relationships: Relationship[]
  chunkRelationships: ChunkRelationship[]
}

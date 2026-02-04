<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { marked } from 'marked'

interface Entity {
  id: number
  entityType: string
  extractedText: string | null
  startIndex: number | null
  endIndex: number | null
  label: string | null
  scope: string
}

interface Chunk {
  id: number
  order: number
  startIndex: number
  endIndex: number
  content: string
  charCount: number
  uniqueCharCount: number
  entities: Entity[]
}

interface Document {
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
  chunks: Chunk[]
}

const route = useRoute()
const document = ref<Document | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const translationMode = ref(false)
const translations = ref<Record<number, string>>({})

const documentTitle = computed(() => {
  if (!document.value) return ''
  return document.value.title || document.value.filename
})

const renderedContent = computed(() => {
  if (!document.value) return ''
  return marked(document.value.extractedContent)
})

function renderChunk(content: string): string {
  return marked(content) as string
}

function initTranslations() {
  if (!document.value) return
  for (const chunk of document.value.chunks) {
    if (!(chunk.id in translations.value)) {
      translations.value[chunk.id] = ''
    }
  }
}

function toggleTranslationMode() {
  translationMode.value = !translationMode.value
  if (translationMode.value) {
    initTranslations()
  }
}

async function fetchDocument() {
  const id = route.params.id
  if (!id) {
    error.value = 'No document ID provided'
    return
  }

  loading.value = true
  error.value = null

  try {
    const response = await fetch(`/api/library/document/${id}`)
    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to fetch document')
    }
    document.value = await response.json()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load document'
  } finally {
    loading.value = false
  }
}

onMounted(fetchDocument)
</script>

<template>
  <div class="w-100 pa-4">
    <v-progress-linear v-if="loading" indeterminate />

    <v-alert v-if="error" type="error" class="mb-4">
      {{ error }}
    </v-alert>

    <template v-if="document">
      <div class="d-flex align-center mb-4">
        <v-btn icon="mdi-arrow-left" variant="text" to="/library" />
        <h1 class="text-h4 ml-2">{{ documentTitle }}</h1>
      </div>

      <v-row class="mb-4" align="center">
        <v-col cols="auto">
          <v-chip variant="outlined">
            {{ document.charCount.toLocaleString() }} characters
          </v-chip>
        </v-col>
        <v-col cols="auto">
          <v-chip variant="outlined">
            {{ document.uniqueCharCount.toLocaleString() }} unique
          </v-chip>
        </v-col>
        <v-col cols="auto">
          <v-chip variant="outlined">
            {{ document.chunks.length }} chunks
          </v-chip>
        </v-col>
        <v-col cols="auto">
          <v-chip variant="outlined">
            Uploaded {{ new Date(document.dateUploaded).toLocaleDateString() }}
          </v-chip>
        </v-col>
        <v-spacer />
        <v-col cols="auto">
          <v-btn
            :prepend-icon="translationMode ? 'mdi-file-document' : 'mdi-translate'"
            :variant="translationMode ? 'flat' : 'outlined'"
            :color="translationMode ? 'primary' : undefined"
            @click="toggleTranslationMode"
          >
            {{ translationMode ? 'Exit Translation' : 'Translate' }}
          </v-btn>
        </v-col>
      </v-row>

      <!-- Normal reading view -->
      <v-card v-if="!translationMode">
        <v-card-text class="document-content" v-html="renderedContent" />
      </v-card>

      <!-- Side-by-side translation view -->
      <div v-else class="translation-view">
        <v-row class="translation-header mb-2">
          <v-col cols="6">
            <span class="text-subtitle-1 font-weight-medium">Original</span>
          </v-col>
          <v-col cols="6">
            <span class="text-subtitle-1 font-weight-medium">Translation</span>
          </v-col>
        </v-row>
        <div
          v-for="chunk in document.chunks"
          :key="chunk.id"
          class="chunk-row mb-4"
        >
          <v-row>
            <v-col cols="6">
              <v-card variant="outlined" class="h-100">
                <v-card-text class="document-content" v-html="renderChunk(chunk.content)" />
              </v-card>
            </v-col>
            <v-col cols="6">
              <v-textarea
                v-model="translations[chunk.id]"
                variant="outlined"
                hide-details
                auto-grow
                rows="3"
                placeholder="Enter translation..."
              />
            </v-col>
          </v-row>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.document-content {
  font-size: 1.1rem;
  line-height: 1.8;
}

.document-content :deep(p) {
  margin-bottom: 1em;
}

.document-content :deep(h1),
.document-content :deep(h2),
.document-content :deep(h3) {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}

.translation-view {
  max-width: 100%;
}

.translation-header {
  position: sticky;
  top: 0;
  background: rgb(var(--v-theme-background));
  z-index: 1;
  padding: 8px 0;
}

.chunk-row :deep(.v-textarea textarea) {
  font-size: 1rem;
  line-height: 1.6;
}
</style>
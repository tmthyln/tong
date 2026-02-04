<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface Document {
  id: number
  original_doc_filename: string
  original_doc_mimetype: string
  date_uploaded: string
  date_last_accessed: string | null
  extracted_doc_char_count: number
  extracted_doc_unique_char_count: number
}

const recommendedDocuments = ref([
  { id: 1, title: 'Getting Started Guide', description: 'Introduction to the platform' },
  { id: 2, title: 'Advanced Techniques', description: 'Deep dive into features' },
  { id: 3, title: 'Best Practices', description: 'Tips and recommendations' },
  { id: 4, title: 'API Reference', description: 'Complete API documentation' },
  { id: 5, title: 'Case Studies', description: 'Real-world examples' },
])

const documents = ref<Document[]>([])
const loading = ref(false)
const fetchError = ref<string | null>(null)

const headers = [
  { title: 'Filename', key: 'original_doc_filename', sortable: true },
  { title: 'Characters', key: 'extracted_doc_char_count', sortable: true },
  { title: 'Unique Chars', key: 'extracted_doc_unique_char_count', sortable: true },
  { title: 'Type', key: 'original_doc_mimetype', sortable: true },
  { title: 'Uploaded', key: 'date_uploaded', sortable: true },
  { title: 'Last Accessed', key: 'date_last_accessed', sortable: true },
  { title: 'Actions', key: 'actions', sortable: false },
]

function downloadDocument(doc: Document) {
  const link = document.createElement('a')
  link.href = `/api/library/document/${doc.id}/original`
  link.download = doc.original_doc_filename
  link.click()
}

async function fetchDocuments() {
  loading.value = true
  fetchError.value = null
  try {
    const response = await fetch('/api/library/document')
    if (!response.ok) {
      throw new Error('Failed to fetch documents')
    }
    const data = await response.json()
    documents.value = data.documents
  } catch (err) {
    fetchError.value = err instanceof Error ? err.message : 'Failed to load documents'
  } finally {
    loading.value = false
  }
}

onMounted(fetchDocuments)

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadError = ref<string | null>(null)
const uploadSuccess = ref<string | null>(null)

function triggerFileInput() {
  fileInput.value?.click()
}

async function handleFileUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  uploading.value = true
  uploadError.value = null
  uploadSuccess.value = null

  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch('/api/library/document', {
      method: 'POST',
      body: formData,
    })

    const result = await response.json()

    if (!response.ok) {
      throw new Error(result.error || 'Upload failed')
    }

    if (result.alreadyExists) {
      uploadSuccess.value = `Document already exists (ID: ${result.documentId})`
    } else {
      uploadSuccess.value = `Document uploaded successfully. Processing started.`
      // Refresh the document list after successful upload
      await fetchDocuments()
    }
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : 'Upload failed'
  } finally {
    uploading.value = false
    // Reset file input
    if (fileInput.value) {
      fileInput.value.value = ''
    }
  }
}
</script>

<template>
  <div class="w-100 pa-4">
    <h1 class="text-h4 mb-6">Library</h1>

    <!-- Recommended Documents Carousel -->
    <section class="mb-8">
      <h2 class="text-h5 mb-4">Recommended Documents</h2>
      <v-carousel
        height="200"
        show-arrows="hover"
        hide-delimiter-background
        cycle
      >
        <v-carousel-item
          v-for="i in Math.ceil(recommendedDocuments.length / 3)"
          :key="i"
        >
          <v-row class="h-100 ma-0" align="center">
            <v-col
              v-for="doc in recommendedDocuments.slice((i - 1) * 3, i * 3)"
              :key="doc.id"
              cols="4"
            >
              <v-card class="mx-2" height="160">
                <v-card-item>
                  <v-card-title>{{ doc.title }}</v-card-title>
                  <v-card-subtitle>{{ doc.description }}</v-card-subtitle>
                </v-card-item>
                <v-card-actions>
                  <v-btn variant="text" color="primary">Open</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>
          </v-row>
        </v-carousel-item>
      </v-carousel>
    </section>

    <!-- All Documents Table -->
    <section>
      <div class="d-flex justify-space-between align-center mb-4">
        <h2 class="text-h5">All Documents</h2>
        <div>
          <input
            ref="fileInput"
            type="file"
            hidden
            accept=".txt,.md,text/plain,text/markdown"
            @change="handleFileUpload"
          />
          <v-btn
            color="primary"
            prepend-icon="mdi-upload"
            :loading="uploading"
            @click="triggerFileInput"
          >
            Upload Document
          </v-btn>
        </div>
      </div>

      <v-alert v-if="uploadSuccess" type="success" closable class="mb-4" @click:close="uploadSuccess = null">
        {{ uploadSuccess }}
      </v-alert>

      <v-alert v-if="uploadError" type="error" closable class="mb-4" @click:close="uploadError = null">
        {{ uploadError }}
      </v-alert>

      <v-alert v-if="fetchError" type="error" closable class="mb-4" @click:close="fetchError = null">
        {{ fetchError }}
      </v-alert>

      <v-data-table
        :headers="headers"
        :items="documents"
        :items-per-page="10"
        :loading="loading"
        class="elevation-1"
      >
        <template #item.original_doc_filename="{ item }">
          <router-link :to="`/document/${item.id}`" class="text-decoration-none">
            {{ item.original_doc_filename }}
          </router-link>
        </template>
        <template #item.extracted_doc_char_count="{ item }">
          {{ item.extracted_doc_char_count.toLocaleString() }}
        </template>
        <template #item.extracted_doc_unique_char_count="{ item }">
          {{ item.extracted_doc_unique_char_count.toLocaleString() }}
        </template>
        <template #item.original_doc_mimetype="{ item }">
          <v-chip size="small" variant="outlined">
            {{ item.original_doc_mimetype.split('/').pop() }}
          </v-chip>
        </template>
        <template #item.date_uploaded="{ item }">
          {{ new Date(item.date_uploaded).toLocaleDateString() }}
        </template>
        <template #item.date_last_accessed="{ item }">
          {{ item.date_last_accessed ? new Date(item.date_last_accessed).toLocaleDateString() : '—' }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            icon="mdi-download"
            size="small"
            variant="text"
            @click="downloadDocument(item)"
          />
        </template>
      </v-data-table>
    </section>
  </div>
</template>
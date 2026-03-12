<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Document {
  id: number
  original_doc_filename: string
  original_doc_mimetype: string
  date_uploaded: string
  date_last_accessed: string | null
  extracted_doc_char_count: number
  extracted_doc_unique_char_count: number
}

interface TreeNode {
  id: string
  name: string
  type: 'folder' | 'document'
  groupType?: string
  children?: TreeNode[]
  documentId?: number
  charCount?: number
}

interface Folder {
  id: number
  name: string
  parentId: number | null
  groupType: string
}

const documents = ref<Document[]>([])

const recentDocuments = computed(() =>
  [...documents.value]
    .filter((d) => d.date_last_accessed)
    .sort(
      (a, b) =>
        new Date(b.date_last_accessed!).getTime() - new Date(a.date_last_accessed!).getTime(),
    )
    .slice(0, 9),
)
const loading = ref(false)
const fetchError = ref<string | null>(null)

const directoryTree = ref<TreeNode[]>([])
const treeLoading = ref(false)
const treeError = ref<string | null>(null)
const openFolders = ref<string[]>([])

// Create folder dialog
const createFolderDialog = ref(false)
const newFolderName = ref('')
const newFolderType = ref<string>('collection')
const folderTypes = [
  { title: 'Book', value: 'book' },
  { title: 'Series', value: 'series' },
  { title: 'Collection', value: 'collection' },
]
const creatingFolder = ref(false)
const createFolderError = ref<string | null>(null)

// Move to folder dialog
const moveToFolderDialog = ref(false)
const folders = ref<Folder[]>([])
const selectedDocument = ref<Document | null>(null)
const selectedFolderId = ref<number | null>(null)
const movingDocument = ref(false)
const moveError = ref<string | null>(null)

// Context menu state
const contextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuTarget = ref<TreeNode | null>(null)

// Rename folder dialog
const renameFolderDialog = ref(false)
const renameFolderName = ref('')
const renamingFolder = ref(false)
const renameFolderError = ref<string | null>(null)

// Upload to folder
const folderFileInput = ref<HTMLInputElement | null>(null)
const uploadTargetFolderId = ref<number | null>(null)

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

async function fetchDirectoryTree() {
  treeLoading.value = true
  treeError.value = null
  try {
    const response = await fetch('/api/library')
    if (!response.ok) {
      throw new Error('Failed to fetch directory tree')
    }
    const data = await response.json()
    directoryTree.value = data.tree
  } catch (err) {
    treeError.value = err instanceof Error ? err.message : 'Failed to load directory tree'
  } finally {
    treeLoading.value = false
  }
}

async function createFolder() {
  if (!newFolderName.value.trim()) {
    createFolderError.value = 'Folder name is required'
    return
  }

  creatingFolder.value = true
  createFolderError.value = null

  try {
    const response = await fetch('/api/library/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newFolderName.value.trim(),
        groupType: newFolderType.value,
      }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to create folder')
    }

    createFolderDialog.value = false
    newFolderName.value = ''
    newFolderType.value = 'collection'
    await fetchDirectoryTree()
  } catch (err) {
    createFolderError.value = err instanceof Error ? err.message : 'Failed to create folder'
  } finally {
    creatingFolder.value = false
  }
}

async function fetchFolders() {
  try {
    const response = await fetch('/api/library/folder')
    if (!response.ok) {
      throw new Error('Failed to fetch folders')
    }
    const data = await response.json()
    folders.value = data.folders
  } catch (err) {
    console.error('Failed to fetch folders:', err)
  }
}

function openMoveDialog(doc: Document) {
  selectedDocument.value = doc
  selectedFolderId.value = null
  moveError.value = null
  fetchFolders()
  moveToFolderDialog.value = true
}

async function moveDocumentToFolder() {
  if (!selectedDocument.value) return

  movingDocument.value = true
  moveError.value = null

  try {
    const response = await fetch(`/api/library/document/${selectedDocument.value.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: selectedFolderId.value }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to move document')
    }

    moveToFolderDialog.value = false
    selectedDocument.value = null
    await fetchDirectoryTree()
  } catch (err) {
    moveError.value = err instanceof Error ? err.message : 'Failed to move document'
  } finally {
    movingDocument.value = false
  }
}

// Context menu functions
function openContextMenu(event: MouseEvent, item: TreeNode) {
  event.preventDefault()
  contextMenuTarget.value = item
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenu.value = true
}

function openRenameFolderDialog() {
  if (!contextMenuTarget.value || contextMenuTarget.value.type !== 'folder') return
  const folderId = parseInt(contextMenuTarget.value.id.replace('group-', ''), 10)
  const folder = folders.value.find((f) => f.id === folderId)
  renameFolderName.value = folder?.name || contextMenuTarget.value.name
  renameFolderError.value = null
  renameFolderDialog.value = true
  contextMenu.value = false
}

async function renameFolder() {
  if (!contextMenuTarget.value) return
  const folderId = parseInt(contextMenuTarget.value.id.replace('group-', ''), 10)

  if (!renameFolderName.value.trim()) {
    renameFolderError.value = 'Folder name is required'
    return
  }

  renamingFolder.value = true
  renameFolderError.value = null

  try {
    const response = await fetch(`/api/library/folder/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renameFolderName.value.trim() }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to rename folder')
    }

    renameFolderDialog.value = false
    await fetchDirectoryTree()
    await fetchFolders()
  } catch (err) {
    renameFolderError.value = err instanceof Error ? err.message : 'Failed to rename folder'
  } finally {
    renamingFolder.value = false
  }
}

function triggerUploadToFolder() {
  if (!contextMenuTarget.value || contextMenuTarget.value.type !== 'folder') return
  uploadTargetFolderId.value = parseInt(contextMenuTarget.value.id.replace('group-', ''), 10)
  contextMenu.value = false
  folderFileInput.value?.click()
}

async function handleFolderFileUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file || uploadTargetFolderId.value === null) return

  uploading.value = true
  uploadError.value = null
  uploadSuccess.value = null

  try {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('folderId', uploadTargetFolderId.value.toString())

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
      uploadSuccess.value = `Document uploaded to folder successfully.`
      await fetchDocuments()
      await fetchDirectoryTree()
    }
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : 'Upload failed'
  } finally {
    uploading.value = false
    uploadTargetFolderId.value = null
    if (folderFileInput.value) {
      folderFileInput.value.value = ''
    }
  }
}

function downloadTreeDocument() {
  if (!contextMenuTarget.value || contextMenuTarget.value.type !== 'document') return
  const link = document.createElement('a')
  link.href = `/api/library/document/${contextMenuTarget.value.documentId}/original`
  link.download = contextMenuTarget.value.name
  link.click()
  contextMenu.value = false
}

function moveTreeDocument() {
  if (!contextMenuTarget.value || contextMenuTarget.value.type !== 'document') return
  // Create a minimal Document object for the move dialog
  const doc: Document = {
    id: contextMenuTarget.value.documentId!,
    original_doc_filename: contextMenuTarget.value.name,
    original_doc_mimetype: '',
    date_uploaded: '',
    date_last_accessed: null,
    extracted_doc_char_count: contextMenuTarget.value.charCount || 0,
    extracted_doc_unique_char_count: 0,
  }
  openMoveDialog(doc)
  contextMenu.value = false
}

onMounted(() => {
  fetchDocuments()
  fetchDirectoryTree()
})

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

    <!-- Recent Documents Carousel -->
    <section v-if="recentDocuments.length > 0" class="mb-8">
      <h2 class="text-h5 mb-4">Recent Documents</h2>
      <v-carousel
        height="200"
        show-arrows="hover"
        hide-delimiter-background
        cycle
      >
        <v-carousel-item
          v-for="i in Math.ceil(recentDocuments.length / 3)"
          :key="i"
        >
          <v-row class="h-100 ma-0" align="center">
            <v-col
              v-for="doc in recentDocuments.slice((i - 1) * 3, i * 3)"
              :key="doc.id"
              cols="4"
            >
              <v-card class="mx-2" height="160" :to="`/document/${doc.id}`">
                <v-card-item>
                  <v-card-title class="text-truncate">{{ doc.original_doc_filename }}</v-card-title>
                  <v-card-subtitle>
                    {{ new Date(doc.date_last_accessed!).toLocaleDateString() }}
                  </v-card-subtitle>
                </v-card-item>
                <v-card-actions>
                  <v-chip size="small" variant="text">
                    {{ doc.extracted_doc_char_count.toLocaleString() }} chars
                  </v-chip>
                </v-card-actions>
              </v-card>
            </v-col>
          </v-row>
        </v-carousel-item>
      </v-carousel>
    </section>

    <!-- Directory View -->
    <section class="mb-8">
      <div class="d-flex justify-space-between align-center mb-4">
        <h2 class="text-h5">Browse by Folder</h2>
        <v-btn
          variant="outlined"
          prepend-icon="mdi-folder-plus"
          @click="createFolderDialog = true"
        >
          Create Folder
        </v-btn>
      </div>

      <v-alert v-if="treeError" type="error" closable class="mb-4" @click:close="treeError = null">
        {{ treeError }}
      </v-alert>

      <v-card :loading="treeLoading">
        <v-card-text v-if="directoryTree.length === 0 && !treeLoading" class="text-medium-emphasis">
          No documents or folders yet.
        </v-card-text>
        <v-treeview
          v-else
          v-model:opened="openFolders"
          :items="directoryTree"
          item-value="id"
          item-title="name"
          item-children="children"
          activatable
          open-on-click
        >
          <template #prepend="{ item }">
            <template v-if="item.type === 'folder'">
              <v-icon v-if="item.groupType === 'book'" color="brown-darken-1">
                mdi-book
              </v-icon>
              <v-icon v-else-if="item.groupType === 'series'" color="deep-purple">
                mdi-bookshelf
              </v-icon>
              <v-icon v-else color="amber-darken-2">
                mdi-folder
              </v-icon>
            </template>
            <v-icon v-else color="blue-grey">
              mdi-file-document-outline
            </v-icon>
          </template>
          <template #title="{ item }">
            <div @contextmenu="openContextMenu($event, item)" class="tree-item-title">
              <router-link
                v-if="item.type === 'document'"
                :to="`/document/${item.documentId}`"
                class="text-decoration-none"
              >
                {{ item.name }}
              </router-link>
              <span v-else>{{ item.name }}</span>
            </div>
          </template>
          <template #append="{ item }">
            <v-chip v-if="item.type === 'document' && item.charCount" size="x-small" variant="text">
              {{ item.charCount.toLocaleString() }} chars
            </v-chip>
          </template>
        </v-treeview>
      </v-card>
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
            icon="mdi-folder-move"
            size="small"
            variant="text"
            title="Move to folder"
            @click="openMoveDialog(item)"
          />
          <v-btn
            icon="mdi-download"
            size="small"
            variant="text"
            title="Download"
            @click="downloadDocument(item)"
          />
        </template>
      </v-data-table>
    </section>

    <!-- Create Folder Dialog -->
    <v-dialog v-model="createFolderDialog" max-width="400">
      <v-card>
        <v-card-title>Create Folder</v-card-title>
        <v-card-text>
          <v-alert v-if="createFolderError" type="error" density="compact" class="mb-4">
            {{ createFolderError }}
          </v-alert>
          <v-text-field
            v-model="newFolderName"
            label="Folder Name"
            variant="outlined"
            autofocus
            class="mb-4"
            @keyup.enter="createFolder"
          />
          <v-select
            v-model="newFolderType"
            :items="folderTypes"
            label="Folder Type"
            variant="outlined"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createFolderDialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="creatingFolder"
            @click="createFolder"
          >
            Create
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Move to Folder Dialog -->
    <v-dialog v-model="moveToFolderDialog" max-width="400">
      <v-card>
        <v-card-title>Move to Folder</v-card-title>
        <v-card-text>
          <v-alert v-if="moveError" type="error" density="compact" class="mb-4">
            {{ moveError }}
          </v-alert>
          <p v-if="selectedDocument" class="text-body-2 mb-4">
            Moving: <strong>{{ selectedDocument.original_doc_filename }}</strong>
          </p>
          <v-autocomplete
            v-model="selectedFolderId"
            :items="folders"
            item-title="name"
            item-value="id"
            label="Select Folder"
            variant="outlined"
            clearable
            placeholder="No folder (root)"
          >
            <template #item="{ props, item }">
              <v-list-item v-bind="props">
                <template #append>
                  <v-chip size="x-small" variant="text">{{ item.raw.groupType }}</v-chip>
                </template>
              </v-list-item>
            </template>
          </v-autocomplete>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="moveToFolderDialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="movingDocument"
            @click="moveDocumentToFolder"
          >
            Move
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Rename Folder Dialog -->
    <v-dialog v-model="renameFolderDialog" max-width="400">
      <v-card>
        <v-card-title>Rename Folder</v-card-title>
        <v-card-text>
          <v-alert v-if="renameFolderError" type="error" density="compact" class="mb-4">
            {{ renameFolderError }}
          </v-alert>
          <v-text-field
            v-model="renameFolderName"
            label="Folder Name"
            variant="outlined"
            autofocus
            @keyup.enter="renameFolder"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="renameFolderDialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="renamingFolder"
            @click="renameFolder"
          >
            Rename
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Context Menu -->
    <v-menu
      v-model="contextMenu"
      :style="{ position: 'fixed', left: contextMenuX + 'px', top: contextMenuY + 'px' }"
      close-on-content-click
    >
      <v-list density="compact">
        <template v-if="contextMenuTarget?.type === 'folder'">
          <v-list-item prepend-icon="mdi-upload" @click="triggerUploadToFolder">
            <v-list-item-title>Upload to Folder</v-list-item-title>
          </v-list-item>
          <v-list-item prepend-icon="mdi-pencil" @click="openRenameFolderDialog">
            <v-list-item-title>Rename Folder</v-list-item-title>
          </v-list-item>
        </template>
        <template v-else-if="contextMenuTarget?.type === 'document'">
          <v-list-item prepend-icon="mdi-folder-move" @click="moveTreeDocument">
            <v-list-item-title>Move to Folder</v-list-item-title>
          </v-list-item>
          <v-list-item prepend-icon="mdi-download" @click="downloadTreeDocument">
            <v-list-item-title>Download</v-list-item-title>
          </v-list-item>
        </template>
      </v-list>
    </v-menu>

    <!-- Hidden file input for folder upload -->
    <input
      ref="folderFileInput"
      type="file"
      hidden
      accept=".txt,.md,text/plain,text/markdown"
      @change="handleFolderFileUpload"
    />
  </div>
</template>

<style scoped>
.tree-item-title {
  flex: 1;
  cursor: context-menu;
}
</style>
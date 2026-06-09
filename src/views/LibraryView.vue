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
  knowledgeScopeId: number | null
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
const newFolderScopeId = ref<number | null>(null)
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

// Assign to knowledge scope dialog
interface ScopeOption {
  id: number
  display: string
}
const assignScopeDialog = ref(false)
const scopeOptions = ref<ScopeOption[]>([])
const selectedScopeId = ref<number | null>(null)
const initialScopeId = ref<number | null>(null)
const assigningScope = ref(false)
const assignScopeError = ref<string | null>(null)
const scopeIsPermanent = computed(() => initialScopeId.value !== null)
const currentScopeLabel = computed(() => {
  const id = initialScopeId.value
  if (id === null) return ''
  return scopeOptions.value.find((s) => s.id === id)?.display.trim() ?? `Scope #${id}`
})

// Context menu state
const contextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuTarget = ref<TreeNode | null>(null)

// Rename folder dialog
const renameFolderDialog = ref(false)
const renameFolderName = ref('')
const renameFolderScopeId = ref<number | null>(null)
const renamingFolder = ref(false)
const renameFolderError = ref<string | null>(null)

// Upload to folder
const folderFileInput = ref<HTMLInputElement | null>(null)
const uploadTargetFolderId = ref<number | null>(null)

const headers = [
  { title: 'Filename', key: 'original_doc_filename', sortable: true },
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

async function openCreateFolderDialog() {
  newFolderName.value = ''
  newFolderType.value = 'collection'
  newFolderScopeId.value = null
  createFolderError.value = null
  await fetchScopes()
  createFolderDialog.value = true
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
        knowledgeScopeId: newFolderScopeId.value,
      }),
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to create folder')
    }

    createFolderDialog.value = false
    newFolderName.value = ''
    newFolderType.value = 'collection'
    newFolderScopeId.value = null
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

async function openRenameFolderDialog() {
  if (!contextMenuTarget.value || contextMenuTarget.value.type !== 'folder') return
  const folderId = parseInt(contextMenuTarget.value.id.replace('group-', ''), 10)
  renameFolderError.value = null
  contextMenu.value = false
  await Promise.all([fetchScopes(), fetchFolders()])
  const folder = folders.value.find((f) => f.id === folderId)
  renameFolderName.value = folder?.name || contextMenuTarget.value.name
  renameFolderScopeId.value = folder?.knowledgeScopeId ?? null
  renameFolderDialog.value = true
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
      body: JSON.stringify({
        name: renameFolderName.value.trim(),
        knowledgeScopeId: renameFolderScopeId.value,
      }),
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

function flattenScopeTree(
  nodes: { id: number; name: string; children: typeof nodes }[],
  depth: number,
  out: ScopeOption[],
) {
  for (const node of nodes) {
    out.push({ id: node.id, display: `${'  '.repeat(depth)}${node.name}` })
    flattenScopeTree(node.children, depth + 1, out)
  }
}

async function fetchScopes() {
  try {
    const res = await fetch('/api/knowledge-scope')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      tree: { id: number; name: string; children: never[] }[]
    }
    const flat: ScopeOption[] = []
    flattenScopeTree(data.tree, 0, flat)
    scopeOptions.value = flat
  } catch (err) {
    console.error('Failed to fetch knowledge scopes:', err)
  }
}

async function openAssignScopeDialog(doc: Document) {
  selectedDocument.value = doc
  selectedScopeId.value = null
  initialScopeId.value = null
  assignScopeError.value = null
  await fetchScopes()
  // Prefill with the document's current scope, if any.
  try {
    const res = await fetch(`/api/library/document/${doc.id}`)
    if (res.ok) {
      const data = (await res.json()) as { knowledgeScopeId: number | null }
      selectedScopeId.value = data.knowledgeScopeId
      initialScopeId.value = data.knowledgeScopeId
    }
  } catch {
    // non-fatal
  }
  assignScopeDialog.value = true
}

async function assignDocumentToScope() {
  if (!selectedDocument.value) return
  assigningScope.value = true
  assignScopeError.value = null
  try {
    const res = await fetch(`/api/library/document/${selectedDocument.value.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knowledgeScopeId: selectedScopeId.value }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error || 'Failed to assign scope')
    }
    assignScopeDialog.value = false
    selectedDocument.value = null
  } catch (err) {
    assignScopeError.value = err instanceof Error ? err.message : 'Failed to assign scope'
  } finally {
    assigningScope.value = false
  }
}

function assignTreeDocumentScope() {
  if (!contextMenuTarget.value || contextMenuTarget.value.type !== 'document') return
  const doc: Document = {
    id: contextMenuTarget.value.documentId!,
    original_doc_filename: contextMenuTarget.value.name,
    original_doc_mimetype: '',
    date_uploaded: '',
    date_last_accessed: null,
    extracted_doc_char_count: contextMenuTarget.value.charCount || 0,
    extracted_doc_unique_char_count: 0,
  }
  openAssignScopeDialog(doc)
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
          @click="openCreateFolderDialog"
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
            icon="mdi-layers-triple-outline"
            size="small"
            variant="text"
            title="Assign to knowledge scope"
            @click="openAssignScopeDialog(item)"
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
            class="mb-4"
          />
          <v-autocomplete
            v-model="newFolderScopeId"
            :items="scopeOptions"
            item-title="display"
            item-value="id"
            label="Knowledge scope affinity (optional)"
            variant="outlined"
            clearable
            placeholder="None"
            no-data-text="No knowledge scopes yet — create one in Knowledge Scopes"
          />
          <p class="text-caption text-medium-emphasis">
            Documents added to this folder without a scope of their own inherit this scope (nearest
            ancestor folder wins).
          </p>
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

    <!-- Assign to Knowledge Scope Dialog -->
    <v-dialog v-model="assignScopeDialog" max-width="420">
      <v-card>
        <v-card-title>Assign to Knowledge Scope</v-card-title>
        <v-card-text>
          <v-alert v-if="assignScopeError" type="error" density="compact" class="mb-4">
            {{ assignScopeError }}
          </v-alert>
          <p v-if="selectedDocument" class="text-body-2 mb-2">
            Document: <strong>{{ selectedDocument.original_doc_filename }}</strong>
          </p>
          <p class="text-caption text-medium-emphasis mb-4">
            The universe in which this document's entities and relationships are valid. Independent
            of its folder.
          </p>
          <template v-if="scopeIsPermanent">
            <v-text-field
              :model-value="currentScopeLabel"
              label="Knowledge scope"
              variant="outlined"
              readonly
            />
            <p class="text-caption text-medium-emphasis">
              Knowledge scope is permanent once set and cannot be changed.
            </p>
          </template>
          <v-autocomplete
            v-else
            v-model="selectedScopeId"
            :items="scopeOptions"
            item-title="display"
            item-value="id"
            label="Select knowledge scope"
            variant="outlined"
            clearable
            placeholder="No scope (document only)"
            no-data-text="No knowledge scopes yet — create one in Knowledge Scopes"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="assignScopeDialog = false">
            {{ scopeIsPermanent ? 'Close' : 'Cancel' }}
          </v-btn>
          <v-btn
            v-if="!scopeIsPermanent"
            color="primary"
            variant="flat"
            :loading="assigningScope"
            @click="assignDocumentToScope"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Rename Folder Dialog -->
    <v-dialog v-model="renameFolderDialog" max-width="400">
      <v-card>
        <v-card-title>Edit Folder</v-card-title>
        <v-card-text>
          <v-alert v-if="renameFolderError" type="error" density="compact" class="mb-4">
            {{ renameFolderError }}
          </v-alert>
          <v-text-field
            v-model="renameFolderName"
            label="Folder Name"
            variant="outlined"
            autofocus
            class="mb-4"
            @keyup.enter="renameFolder"
          />
          <v-autocomplete
            v-model="renameFolderScopeId"
            :items="scopeOptions"
            item-title="display"
            item-value="id"
            label="Knowledge scope affinity (optional)"
            variant="outlined"
            clearable
            placeholder="None"
            no-data-text="No knowledge scopes yet — create one in Knowledge Scopes"
          />
          <p class="text-caption text-medium-emphasis">
            Documents added to this folder without a scope of their own inherit this scope (nearest
            ancestor folder wins).
          </p>
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
            Save
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
            <v-list-item-title>Edit Folder</v-list-item-title>
          </v-list-item>
        </template>
        <template v-else-if="contextMenuTarget?.type === 'document'">
          <v-list-item prepend-icon="mdi-folder-move" @click="moveTreeDocument">
            <v-list-item-title>Move to Folder</v-list-item-title>
          </v-list-item>
          <v-list-item prepend-icon="mdi-layers-triple-outline" @click="assignTreeDocumentScope">
            <v-list-item-title>Assign to Knowledge Scope</v-list-item-title>
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
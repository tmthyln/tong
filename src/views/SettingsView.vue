<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface TypeExample {
  id: number
  example: string
}

interface NodeType {
  id: number
  name: string
  definition: string
  examples: TypeExample[]
}

interface EdgeType {
  id: number
  name: string
  reverseName: string | null
  definition: string
  examples: TypeExample[]
}

const nodeTypes = ref<NodeType[]>([])
const edgeTypes = ref<EdgeType[]>([])
const loading = ref(false)

// Node type editing
const nodeDialog = ref(false)
const editingNodeType = ref<NodeType | null>(null)
const nodeForm = ref({ name: '', definition: '' })
const newNodeExample = ref('')

// Edge type editing
const edgeDialog = ref(false)
const editingEdgeType = ref<EdgeType | null>(null)
const edgeForm = ref({ name: '', reverseName: '', definition: '' })
const newEdgeExample = ref('')

// Delete confirmation
const deleteDialog = ref(false)
const deleteTarget = ref<{ kind: 'node' | 'edge'; id: number; name: string } | null>(null)

async function fetchAll() {
  loading.value = true
  try {
    const [nodeRes, edgeRes] = await Promise.all([
      fetch('/api/graph-types/node-type'),
      fetch('/api/graph-types/edge-type'),
    ])
    nodeTypes.value = await nodeRes.json()
    edgeTypes.value = await edgeRes.json()
  } finally {
    loading.value = false
  }
}

// ── Node Types ──────────────────────────────────────────────

function openNewNodeType() {
  editingNodeType.value = null
  nodeForm.value = { name: '', definition: '' }
  newNodeExample.value = ''
  nodeDialog.value = true
}

function openEditNodeType(nt: NodeType) {
  editingNodeType.value = nt
  nodeForm.value = { name: nt.name, definition: nt.definition }
  newNodeExample.value = ''
  nodeDialog.value = true
}

async function saveNodeType() {
  if (!nodeForm.value.name.trim() || !nodeForm.value.definition.trim()) return

  if (editingNodeType.value) {
    await fetch(`/api/graph-types/node-type/${editingNodeType.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nodeForm.value),
    })
  } else {
    await fetch('/api/graph-types/node-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nodeForm.value),
    })
  }
  nodeDialog.value = false
  await fetchAll()
}

async function addNodeExample(nodeTypeId: number) {
  if (!newNodeExample.value.trim()) return
  await fetch(`/api/graph-types/node-type/${nodeTypeId}/example`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ example: newNodeExample.value }),
  })
  newNodeExample.value = ''
  await fetchAll()
}

async function removeNodeExample(exampleId: number) {
  await fetch(`/api/graph-types/node-type-example/${exampleId}`, { method: 'DELETE' })
  await fetchAll()
}

// ── Edge Types ──────────────────────────────────────────────

function openNewEdgeType() {
  editingEdgeType.value = null
  edgeForm.value = { name: '', reverseName: '', definition: '' }
  newEdgeExample.value = ''
  edgeDialog.value = true
}

function openEditEdgeType(et: EdgeType) {
  editingEdgeType.value = et
  edgeForm.value = { name: et.name, reverseName: et.reverseName || '', definition: et.definition }
  newEdgeExample.value = ''
  edgeDialog.value = true
}

async function saveEdgeType() {
  if (!edgeForm.value.name.trim() || !edgeForm.value.definition.trim()) return

  const payload = {
    name: edgeForm.value.name,
    reverseName: edgeForm.value.reverseName.trim() || null,
    definition: edgeForm.value.definition,
  }

  if (editingEdgeType.value) {
    await fetch(`/api/graph-types/edge-type/${editingEdgeType.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } else {
    await fetch('/api/graph-types/edge-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
  edgeDialog.value = false
  await fetchAll()
}

async function addEdgeExample(edgeTypeId: number) {
  if (!newEdgeExample.value.trim()) return
  await fetch(`/api/graph-types/edge-type/${edgeTypeId}/example`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ example: newEdgeExample.value }),
  })
  newEdgeExample.value = ''
  await fetchAll()
}

async function removeEdgeExample(exampleId: number) {
  await fetch(`/api/graph-types/edge-type-example/${exampleId}`, { method: 'DELETE' })
  await fetchAll()
}

// ── Delete ──────────────────────────────────────────────────

function confirmDelete(kind: 'node' | 'edge', id: number, name: string) {
  deleteTarget.value = { kind, id, name }
  deleteDialog.value = true
}

async function executeDelete() {
  if (!deleteTarget.value) return
  const { kind, id } = deleteTarget.value
  const path = kind === 'node' ? 'node-type' : 'edge-type'
  await fetch(`/api/graph-types/${path}/${id}`, { method: 'DELETE' })
  deleteDialog.value = false
  deleteTarget.value = null
  await fetchAll()
}

onMounted(fetchAll)
</script>

<template>
  <div class="w-100 pa-4">
    <h1 class="text-h4 mb-6">Settings</h1>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <!-- Node Types -->
    <div class="d-flex align-center mb-3">
      <h2 class="text-h5">Node Types</h2>
      <v-spacer />
      <v-btn prepend-icon="mdi-plus" variant="tonal" size="small" @click="openNewNodeType">
        Add Node Type
      </v-btn>
    </div>

    <v-card v-if="nodeTypes.length === 0 && !loading" variant="outlined" class="mb-6">
      <v-card-text class="text-center text-medium-emphasis">
        No node types defined
      </v-card-text>
    </v-card>

    <v-expansion-panels variant="accordion" class="mb-6">
      <v-expansion-panel v-for="nt in nodeTypes" :key="nt.id">
        <v-expansion-panel-title>
          <span class="font-weight-medium">{{ nt.name }}</span>
          <template #actions="{ expanded }">
            <v-btn
              icon="mdi-pencil"
              variant="text"
              size="x-small"
              class="mr-1"
              @click.stop="openEditNodeType(nt)"
            />
            <v-btn
              icon="mdi-delete"
              variant="text"
              size="x-small"
              color="error"
              class="mr-2"
              @click.stop="confirmDelete('node', nt.id, nt.name)"
            />
            <v-icon :icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
          </template>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div class="text-body-2 mb-3">{{ nt.definition }}</div>
          <div class="text-subtitle-2 mb-1">Examples</div>
          <v-chip
            v-for="ex in nt.examples"
            :key="ex.id"
            closable
            size="small"
            class="mr-1 mb-1"
            @click:close="removeNodeExample(ex.id)"
          >
            {{ ex.example }}
          </v-chip>
          <div v-if="nt.examples.length === 0" class="text-body-2 text-medium-emphasis mb-2">
            No examples
          </div>
          <div class="d-flex align-center mt-2" style="max-width: 400px">
            <v-text-field
              v-model="newNodeExample"
              density="compact"
              variant="outlined"
              placeholder="Add example..."
              hide-details
              @keydown.enter="addNodeExample(nt.id)"
            />
            <v-btn
              icon="mdi-plus"
              variant="text"
              size="small"
              class="ml-1"
              @click="addNodeExample(nt.id)"
            />
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <!-- Edge Types -->
    <div class="d-flex align-center mb-3">
      <h2 class="text-h5">Edge Types</h2>
      <v-spacer />
      <v-btn prepend-icon="mdi-plus" variant="tonal" size="small" @click="openNewEdgeType">
        Add Edge Type
      </v-btn>
    </div>

    <v-card v-if="edgeTypes.length === 0 && !loading" variant="outlined" class="mb-6">
      <v-card-text class="text-center text-medium-emphasis">
        No edge types defined
      </v-card-text>
    </v-card>

    <v-expansion-panels variant="accordion" class="mb-6">
      <v-expansion-panel v-for="et in edgeTypes" :key="et.id">
        <v-expansion-panel-title>
          <span class="font-weight-medium">{{ et.name }}</span>
          <span v-if="et.reverseName" class="text-medium-emphasis ml-2">
            (reverse: {{ et.reverseName }})
          </span>
          <template #actions="{ expanded }">
            <v-btn
              icon="mdi-pencil"
              variant="text"
              size="x-small"
              class="mr-1"
              @click.stop="openEditEdgeType(et)"
            />
            <v-btn
              icon="mdi-delete"
              variant="text"
              size="x-small"
              color="error"
              class="mr-2"
              @click.stop="confirmDelete('edge', et.id, et.name)"
            />
            <v-icon :icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
          </template>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div class="text-body-2 mb-3">{{ et.definition }}</div>
          <div class="text-subtitle-2 mb-1">Examples</div>
          <v-chip
            v-for="ex in et.examples"
            :key="ex.id"
            closable
            size="small"
            class="mr-1 mb-1"
            @click:close="removeEdgeExample(ex.id)"
          >
            {{ ex.example }}
          </v-chip>
          <div v-if="et.examples.length === 0" class="text-body-2 text-medium-emphasis mb-2">
            No examples
          </div>
          <div class="d-flex align-center mt-2" style="max-width: 400px">
            <v-text-field
              v-model="newEdgeExample"
              density="compact"
              variant="outlined"
              placeholder="Add example..."
              hide-details
              @keydown.enter="addEdgeExample(et.id)"
            />
            <v-btn
              icon="mdi-plus"
              variant="text"
              size="small"
              class="ml-1"
              @click="addEdgeExample(et.id)"
            />
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <!-- Node Type Dialog -->
    <v-dialog v-model="nodeDialog" max-width="500">
      <v-card>
        <v-card-title>{{ editingNodeType ? 'Edit' : 'New' }} Node Type</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="nodeForm.name"
            label="Name"
            variant="outlined"
            density="compact"
            class="mb-3"
          />
          <v-textarea
            v-model="nodeForm.definition"
            label="Definition"
            variant="outlined"
            density="compact"
            rows="3"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="nodeDialog = false">Cancel</v-btn>
          <v-btn
            variant="flat"
            color="primary"
            :disabled="!nodeForm.name.trim() || !nodeForm.definition.trim()"
            @click="saveNodeType"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Edge Type Dialog -->
    <v-dialog v-model="edgeDialog" max-width="500">
      <v-card>
        <v-card-title>{{ editingEdgeType ? 'Edit' : 'New' }} Edge Type</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="edgeForm.name"
            label="Name"
            variant="outlined"
            density="compact"
            class="mb-3"
          />
          <v-text-field
            v-model="edgeForm.reverseName"
            label="Reverse Name (optional)"
            variant="outlined"
            density="compact"
            class="mb-3"
          />
          <v-textarea
            v-model="edgeForm.definition"
            label="Definition"
            variant="outlined"
            density="compact"
            rows="3"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="edgeDialog = false">Cancel</v-btn>
          <v-btn
            variant="flat"
            color="primary"
            :disabled="!edgeForm.name.trim() || !edgeForm.definition.trim()"
            @click="saveEdgeType"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>Delete {{ deleteTarget?.kind === 'node' ? 'Node' : 'Edge' }} Type</v-card-title>
        <v-card-text>
          Delete <strong>{{ deleteTarget?.name }}</strong> and all its examples?
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">Cancel</v-btn>
          <v-btn variant="flat" color="error" @click="executeDelete">Delete</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
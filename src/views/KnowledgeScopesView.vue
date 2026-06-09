<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useUser } from '@/composables/useUser'

const { userType } = useUser()
const canEdit = computed(() => userType.value !== 'public')

interface ScopeDoc {
  id: number
  name: string
}

interface ScopeTreeNode {
  id: number
  name: string
  parentId: number | null
  children: ScopeTreeNode[]
  documents: ScopeDoc[]
}

const tree = ref<ScopeTreeNode[]>([])
const opened = ref<number[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const dialog = ref(false)
const dialogMode = ref<'create' | 'createChild' | 'rename'>('create')
const dialogName = ref('')
const dialogError = ref<string | null>(null)
const dialogTarget = ref<ScopeTreeNode | null>(null)
const saving = ref(false)

async function fetchTree() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/knowledge-scope')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { tree: ScopeTreeNode[] }
    tree.value = data.tree
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load knowledge scopes'
  } finally {
    loading.value = false
  }
}

onMounted(fetchTree)

function openCreateRoot() {
  dialogMode.value = 'create'
  dialogTarget.value = null
  dialogName.value = ''
  dialogError.value = null
  dialog.value = true
}

function openCreateChild(scope: ScopeTreeNode) {
  dialogMode.value = 'createChild'
  dialogTarget.value = scope
  dialogName.value = ''
  dialogError.value = null
  dialog.value = true
}

function openRename(scope: ScopeTreeNode) {
  dialogMode.value = 'rename'
  dialogTarget.value = scope
  dialogName.value = scope.name
  dialogError.value = null
  dialog.value = true
}

async function submitDialog() {
  const name = dialogName.value.trim()
  if (!name) {
    dialogError.value = 'Name is required'
    return
  }
  saving.value = true
  dialogError.value = null
  try {
    let res: Response
    if (dialogMode.value === 'rename' && dialogTarget.value) {
      res = await fetch(`/api/knowledge-scope/${dialogTarget.value.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    } else {
      const parentId = dialogMode.value === 'createChild' ? dialogTarget.value?.id ?? null : null
      res = await fetch('/api/knowledge-scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      })
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error || 'Request failed')
    }
    dialog.value = false
    await fetchTree()
  } catch (e) {
    dialogError.value = e instanceof Error ? e.message : 'Request failed'
  } finally {
    saving.value = false
  }
}

async function deleteScope(scope: ScopeTreeNode) {
  if (!confirm(`Delete knowledge scope "${scope.name}"? Child scopes and any scope-level entities are also removed; assigned documents are detached.`)) {
    return
  }
  try {
    const res = await fetch(`/api/knowledge-scope/${scope.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error || 'Failed to delete')
    }
    await fetchTree()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to delete'
  }
}
</script>

<template>
  <v-container>
    <div class="d-flex justify-space-between align-center mb-4">
      <div>
        <h1 class="text-h4">Knowledge Scopes</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">
          Universes in which entities and relationships are valid. Independent of document folders.
          Assign a document to a scope from the Library.
        </p>
      </div>
      <v-btn
        v-if="canEdit"
        color="primary"
        prepend-icon="mdi-plus"
        @click="openCreateRoot"
      >
        New scope
      </v-btn>
    </div>

    <v-alert v-if="!canEdit" type="info" variant="tonal" density="compact" class="mb-4">
      Sign in to create, rename, or delete knowledge scopes.
    </v-alert>

    <v-alert v-if="error" type="error" closable class="mb-4" @click:close="error = null">
      {{ error }}
    </v-alert>

    <v-card :loading="loading">
      <v-card-text v-if="tree.length === 0 && !loading" class="text-medium-emphasis">
        No knowledge scopes yet.<span v-if="canEdit"> Create one to start grouping documents into a shared universe.</span>
      </v-card-text>
      <v-treeview
        v-else
        v-model:opened="opened"
        :items="tree"
        item-value="id"
        item-title="name"
        item-children="children"
        open-on-click
      >
        <template #prepend>
          <v-icon color="indigo">mdi-layers-triple-outline</v-icon>
        </template>
        <template #append="{ item }">
          <v-chip
            v-if="(item as ScopeTreeNode).documents.length"
            size="x-small"
            variant="text"
            class="mr-2"
          >
            {{ (item as ScopeTreeNode).documents.length }} doc(s)
          </v-chip>
          <v-menu v-if="canEdit">
            <template #activator="{ props }">
              <v-btn icon="mdi-dots-vertical" variant="text" size="small" v-bind="props" @click.stop />
            </template>
            <v-list density="compact">
              <v-list-item
                prepend-icon="mdi-plus"
                title="Add child scope"
                @click="openCreateChild(item as ScopeTreeNode)"
              />
              <v-list-item
                prepend-icon="mdi-pencil"
                title="Rename"
                @click="openRename(item as ScopeTreeNode)"
              />
              <v-list-item
                prepend-icon="mdi-delete"
                title="Delete"
                base-color="error"
                @click="deleteScope(item as ScopeTreeNode)"
              />
            </v-list>
          </v-menu>
        </template>
      </v-treeview>
    </v-card>

    <v-dialog v-model="dialog" max-width="420">
      <v-card>
        <v-card-title>
          {{ dialogMode === 'rename' ? 'Rename scope' : dialogMode === 'createChild' ? 'Add child scope' : 'New knowledge scope' }}
        </v-card-title>
        <v-card-text>
          <p v-if="dialogMode === 'createChild' && dialogTarget" class="text-body-2 text-medium-emphasis mb-2">
            Parent: {{ dialogTarget.name }}
          </p>
          <v-text-field
            v-model="dialogName"
            label="Scope name"
            autofocus
            :error-messages="dialogError ? [dialogError] : []"
            @keyup.enter="submitDialog"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Cancel</v-btn>
          <v-btn color="primary" :loading="saving" @click="submitDialog">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

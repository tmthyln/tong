<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useLocalStorage } from '@vueuse/core'
import { marked } from 'marked'
import DictHeadword from '../components/DictHeadword.vue'
import DictPronunciation from '../components/DictPronunciation.vue'
import { useUser } from '../composables/useUser'
import { useTranslation } from '../composables/useTranslation'
import { useSelectionToolbar } from '../composables/useSelectionToolbar'
import type { Entity, Chunk, Document } from '../types/document'

type DocumentMode = 'reading' | 'translation' | 'reader'

const route = useRoute()
const { userId } = useUser()
const documentMode = useLocalStorage<DocumentMode>('pref:documentMode', 'reading')
const document = ref<Document | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let gridResizeObserver: ResizeObserver | null = null

const documentTitle = computed(() => {
  if (!document.value) return ''
  return document.value.title || document.value.filename
})

function translatorStatus(chunk: Chunk): 'none' | 'ai' | 'self' | 'other' {
  const t = chunk.translationTranslator
  if (!t) return 'none'
  if (t.startsWith('ai:') || t.startsWith('mt:')) return 'ai'
  if (t === userId.value) return 'self'
  return 'other'
}

const entityChips = computed<{ text: string; count: number; color: 'blue' | 'red' }[]>(() => {
  const doc = document.value
  if (!doc) return []

  // Document-scoped entities live at doc.entities; count = chunk entities with matching parentId
  const docEntities = new Map<number, { text: string; count: number; firstSeen: number }>()
  for (let i = 0; i < doc.entities.length; i++) {
    const e = doc.entities[i]!
    const label = e.label || e.extractedText || ''
    if (!label) continue
    docEntities.set(e.id, { text: label, count: 0, firstSeen: i })
  }
  for (const chunk of doc.chunks) {
    for (const e of chunk.entities) {
      if (e.parentId == null) continue
      const parent = docEntities.get(e.parentId)
      if (parent) parent.count++
    }
  }

  // Chunk-scoped orphans: chunk entities with no parentId, grouped by extractedText
  const chunkGroups = new Map<string, { text: string; count: number; firstSeen: number }>()
  for (const chunk of doc.chunks) {
    for (const e of chunk.entities) {
      if (e.parentId != null) continue
      const key = e.extractedText || e.label || ''
      if (!key) continue
      const pos = chunk.order * 100000 + (e.startIndex ?? 0)
      const existing = chunkGroups.get(key)
      if (existing) {
        existing.count++
        existing.firstSeen = Math.min(existing.firstSeen, pos)
      } else {
        chunkGroups.set(key, { text: key, count: 1, firstSeen: pos })
      }
    }
  }

  const docItems = [...docEntities.values()].sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)
  const chunkItems = [...chunkGroups.values()].sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)

  return [
    ...docItems.map(i => ({ ...i, color: 'blue' as const })),
    ...chunkItems.map(i => ({ ...i, color: 'red' as const })),
  ]
})

// Set of entity IDs that are the first occurrence of their identity key across all chunks
const firstOccurrenceEntityIds = computed<Set<number>>(() => {
  const doc = document.value
  if (!doc) return new Set()
  const seen = new Set<string>()
  const ids = new Set<number>()
  for (const chunk of doc.chunks) {
    for (const entity of chunk.entities) {
      const key = entity.parentId != null
        ? `parent:${entity.parentId}`
        : `orphan:${entity.extractedText}`
      if (!seen.has(key)) {
        seen.add(key)
        ids.add(entity.id)
      }
    }
  }
  return ids
})

// Map from entity id → entity, built from document-level and all chunks
const entityById = computed<Map<number, Entity>>(() => {
  const map = new Map<number, Entity>()
  for (const e of document.value?.entities ?? []) {
    map.set(e.id, e)
  }
  for (const chunk of document.value?.chunks ?? []) {
    for (const e of chunk.entities) {
      map.set(e.id, e)
    }
  }
  return map
})

function renderChunk(chunk: Chunk): string {
  const entities = chunk.entities
    .filter((e): e is Entity & { startIndex: number; endIndex: number; extractedText: string } =>
      e.startIndex != null && e.endIndex != null && e.extractedText != null
    )
    .sort((a, b) => a.startIndex - b.startIndex)

  if (entities.length === 0) {
    return marked(chunk.content) as string
  }

  // Build content with entity underline spans inserted
  // Process from end to start to preserve indices
  let content = chunk.content
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i]!
    const tooltip = e.label ? `${e.entityType}: ${e.label}` : e.entityType
    const before = content.slice(0, e.startIndex)
    const text = content.slice(e.startIndex, e.endIndex)
    const after = content.slice(e.endIndex)
    content = `${before}<span class="entity-underline" data-entity-id="${e.id}" title="${tooltip.replace(/"/g, '&quot;')}">${text}</span>${after}`
  }

  return marked(content) as string
}

// ── Scrollbar overview ────────────────────────────────────────────────────────

function resolveThemeColor(varName: string): string {
  const raw = getComputedStyle(window.document.documentElement).getPropertyValue(varName).trim()
  return `rgba(${raw}, 0.65)`
}

function updateScrollbarStyle(segments: Array<{ topPct: number; bottomPct: number; color: string }> | null) {
  const id = 'tong-chunk-scrollbar'
  let styleEl = window.document.getElementById(id) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = window.document.createElement('style')
    styleEl.id = id
    window.document.head.appendChild(styleEl)
  }
  if (!segments || segments.length === 0) {
    styleEl.textContent = ''
    return
  }
  const sorted = [...segments].sort((a, b) => a.topPct - b.topPct)
  const stops: string[] = []
  let lastEnd = 0
  for (const seg of sorted) {
    const start = Math.max(seg.topPct, lastEnd)
    if (start > lastEnd) stops.push(`transparent ${lastEnd.toFixed(3)}% ${start.toFixed(3)}%`)
    stops.push(`${seg.color} ${start.toFixed(3)}% ${seg.bottomPct.toFixed(3)}%`)
    lastEnd = seg.bottomPct
  }
  if (lastEnd < 100) stops.push(`transparent ${lastEnd.toFixed(3)}% 100%`)
  const gradient = `linear-gradient(to bottom, ${stops.join(', ')})`
  styleEl.textContent = [
    '::-webkit-scrollbar { width: 12px; }',
    `::-webkit-scrollbar-track { background: ${gradient}; }`,
    '::-webkit-scrollbar-thumb { background: rgba(100,100,100,0.9); border-radius: 6px; border: 2px solid rgba(255,255,255,0.35); }',
    '::-webkit-scrollbar-thumb:hover { background: rgba(60,60,60,0.95); border-radius: 6px; border: 2px solid rgba(255,255,255,0.35); }',
  ].join('\n')
}

// ── Composables ───────────────────────────────────────────────────────────────

const {
  translationMode,
  translations,
  currentDraftIndices,
  focusedChunkId,
  saveStatus,
  compareState,
  draftMenuOpen,
  diffEditorRefs,
  scheduleSave,
  flushSave,
  loadDraft,
  startCompare,
  exitCompare,
  onDiffInput,
} = useTranslation(document, computeOverview, documentMode)

const {
  toolbar,
  toolbarRef,
  toolbarStyle,
  activeEntityId,
  onHeaderPointerDown,
  onContentMouseUp,
  onContentClick,
  onContentDblClick,
  lookupInDictionary,
  explainInContext,
  disambiguate,
  summarizeEntity,
  openPrefTranslation,
  setPreferredTranslation,
  openEntityCreate,
  createEntity,
  deleteEntity,
} = useSelectionToolbar(document, entityById, fetchDocument)

// ── Document fetch ────────────────────────────────────────────────────────────

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
    if (translationMode.value) {
      await nextTick()
      computeOverview()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load document'
  } finally {
    loading.value = false
  }
}

function computeOverview() {
  if (!translationMode.value || !document.value) {
    updateScrollbarStyle(null)
    return
  }
  const totalHeight = window.document.documentElement.scrollHeight
  if (totalHeight === 0) return
  const segments: Array<{ topPct: number; bottomPct: number; color: string }> = []
  for (const chunk of document.value.chunks) {
    const status = translatorStatus(chunk)
    let colorVar: string
    if (status === 'ai') colorVar = '--v-theme-warning'
    else if (status === 'self') colorVar = '--v-theme-success'
    else if (status === 'other') colorVar = '--v-theme-primary'
    else continue
    const el = window.document.querySelector<HTMLElement>(`[data-chunk-id="${chunk.id}"]`)
    if (!el) continue
    const rect = el.getBoundingClientRect()
    const topPct = (rect.top + window.scrollY) / totalHeight * 100
    segments.push({ topPct, bottomPct: topPct + rect.height / totalHeight * 100, color: resolveThemeColor(colorVar) })
  }
  updateScrollbarStyle(segments)
}

watch(translationMode, async (val) => {
  if (!val) {
    updateScrollbarStyle(null)
    gridResizeObserver?.disconnect()
    gridResizeObserver = null
    return
  }
  await nextTick()
  computeOverview()
  const grid = window.document.querySelector<HTMLElement>('.translation-grid')
  if (grid) {
    gridResizeObserver = new ResizeObserver(computeOverview)
    gridResizeObserver.observe(grid)
  }
})

function clickAnnotation(chunkId: number, entityId: number) {
  const chunkEl = window.document.querySelector<HTMLElement>(`[data-chunk-id="${chunkId}"]`)
  if (!chunkEl) return
  const span = chunkEl.querySelector<HTMLElement>(`.entity-underline[data-entity-id="${entityId}"]`)
  span?.click()
}

onMounted(() => {
  window.addEventListener('resize', computeOverview)
  fetchDocument()
})

onUnmounted(() => {
  window.removeEventListener('resize', computeOverview)
  gridResizeObserver?.disconnect()
  window.document.getElementById('tong-chunk-scrollbar')?.remove()
})
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
        <v-spacer />
        <v-btn-toggle v-model="documentMode" mandatory variant="outlined" rounded="lg">
          <v-btn value="reading"     icon="mdi-book-open-variant"  title="Read" />
          <v-btn value="translation" icon="mdi-translate"          title="Translate" />
          <v-btn value="reader"      icon="mdi-card-text-outline"  title="Reader" />
        </v-btn-toggle>
      </div>

      <div class="mb-4">
        <v-chip
          v-for="(chip, i) in entityChips"
          :key="i"
          :color="chip.color"
          size="small"
          variant="tonal"
          class="mr-1 mb-1"
        >{{ chip.text }}<span v-if="chip.count > 1" class="ml-1 opacity-60">{{ chip.count }}</span></v-chip>
      </div>

      <!-- Reading / Translation view (unified) -->
      <div
        class="translation-layout"
        :class="{ 'translation-layout--reading': documentMode === 'reading' }"
        @mouseup="onContentMouseUp"
        @dblclick="onContentDblClick"
        @click="onContentClick"
      >
        <v-card class="translation-text-card" />
        <div class="translation-grid">
          <template v-for="chunk in document.chunks" :key="chunk.id">
            <div
              class="document-content translation-chunk-text"
              :class="{
                'translation-chunk-text--active': focusedChunkId === chunk.id,
                'translation-chunk-text--ai':    translationMode && translatorStatus(chunk) === 'ai',
                'translation-chunk-text--self':  translationMode && translatorStatus(chunk) === 'self',
                'translation-chunk-text--other': translationMode && translatorStatus(chunk) === 'other',
              }"
              :data-chunk-id="chunk.id"
              v-html="renderChunk(chunk)"
            />
            <div v-if="documentMode === 'translation'" class="translation-chunk-input">
              <!-- Compare mode: side-by-side diff -->
              <template v-if="compareState[chunk.id]">
                <div class="diff-view">
                  <div class="diff-panel">
                    <div class="diff-panel-header">Draft {{ compareState[chunk.id]!.draftIndex }}</div>
                    <div class="diff-content" v-html="compareState[chunk.id]!.oldHtml"></div>
                  </div>
                  <div class="diff-panel">
                    <div class="diff-panel-header">Draft {{ currentDraftIndices[chunk.id] }} (editing)</div>
                    <div
                      contenteditable="true"
                      class="diff-content diff-content--editable"
                      :ref="(el) => { diffEditorRefs[chunk.id] = el as HTMLElement | null }"
                      @input="onDiffInput(chunk.id, $event)"
                    />
                  </div>
                </div>
                <div class="diff-exit-row">
                  <v-btn size="small" variant="text" density="compact" @click="exitCompare(chunk.id)">Done</v-btn>
                </div>
              </template>

              <!-- Normal mode: textarea -->
              <template v-else>
                <v-textarea
                  v-model="translations[chunk.id]"
                  variant="outlined"
                  hide-details
                  auto-grow
                  rows="3"
                  placeholder="Translation…"
                  @focus="focusedChunkId = chunk.id"
                  @blur="focusedChunkId = null; flushSave(chunk.id)"
                  @input="scheduleSave(chunk.id)"
                />
              </template>

              <!-- Below-box meta row -->
              <div v-if="chunk.availableTranslationDrafts.length > 0 || chunk.translationTranslator || saveStatus[chunk.id]" class="translation-meta-row">
                <span v-if="chunk.translationTranslator" class="translation-draft-label">
                  {{ chunk.translationTranslator }}<template v-if="chunk.translationDateLastModified"> · {{ new Date(chunk.translationDateLastModified).toLocaleDateString() }}</template>
                </span>
                <span v-if="saveStatus[chunk.id] === 'saving'" class="translation-save-status">Saving…</span>
                <span v-else-if="saveStatus[chunk.id] === 'saved'" class="translation-save-status text-success">Saved</span>
                <span v-else-if="saveStatus[chunk.id] === 'error'" class="translation-save-status text-error">Error</span>
                <div v-if="chunk.availableTranslationDrafts.length > 0" class="translation-draft-label">
                  Draft
                  <v-menu v-model="draftMenuOpen[chunk.id]">
                    <template #activator="{ props }">
                      <span v-bind="props" class="draft-picker-trigger">{{ currentDraftIndices[chunk.id] }}</span>
                    </template>
                    <v-list density="compact" nav>
                      <v-list-item
                        v-for="i in chunk.availableTranslationDrafts.length"
                        :key="i"
                        :active="currentDraftIndices[chunk.id] === i"
                        @click="loadDraft(chunk, i); draftMenuOpen[chunk.id] = false"
                      >
                        <v-list-item-title>Draft {{ i }}</v-list-item-title>
                        <template #append>
                          <v-btn
                            icon="mdi-compare"
                            size="x-small"
                            variant="text"
                            title="Compare"
                            @click.stop="startCompare(chunk, i)"
                          />
                        </template>
                      </v-list-item>
                    </v-list>
                  </v-menu>
                  of {{ chunk.availableTranslationDrafts.length }}
                </div>
              </div>
            </div>
            <div v-else-if="documentMode === 'reader'" class="reader-chunk-annotation">
              <template v-if="chunk.entities.some(e => firstOccurrenceEntityIds.has(e.id))">
                <div
                  v-for="entity in chunk.entities.filter(e => firstOccurrenceEntityIds.has(e.id))"
                  :key="entity.id"
                  class="reader-annotation-item"
                  :data-entity-id="entity.id"
                  @click="clickAnnotation(chunk.id, entity.id)"
                >
                  <span class="reader-annotation-text">{{ entity.extractedText }}</span>
                  <span v-if="entity.label || entity.preferredTranslation" class="reader-annotation-label">
                    {{ entity.preferredTranslation || entity.label }}
                  </span>
                  <span class="reader-annotation-type">{{ entity.entityType }}</span>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>

  <!-- ── Selection toolbar (teleported to body) ───────────────────────────── -->
  <Teleport to="body">
    <div v-if="toolbar.show" ref="toolbarRef" class="selection-toolbar" :style="toolbarStyle">

      <!-- Actions mode: just the button row -->
      <v-card v-if="toolbar.mode === 'actions'" elevation="8" rounded="lg" class="pa-1">
        <v-btn
          size="small"
          variant="text"
          prepend-icon="mdi-book-search-outline"
          @click="lookupInDictionary"
        >
          Define
        </v-btn>
        <v-btn
          v-if="activeEntityId != null"
          size="small"
          variant="text"
          prepend-icon="mdi-information-outline"
          @click="summarizeEntity"
        >
          Summarize
        </v-btn>
        <v-btn
          v-if="activeEntityId != null"
          size="small"
          variant="text"
          prepend-icon="mdi-translate"
          @click="openPrefTranslation"
        >
          Set translation
        </v-btn>
        <v-btn
          v-if="activeEntityId == null && toolbar.chunkId != null && !toolbar.selectionOverlapsEntity"
          size="small"
          variant="text"
          prepend-icon="mdi-tag-plus-outline"
          @click="openEntityCreate"
        >
          Create entity
        </v-btn>
        <v-btn
          v-if="activeEntityId != null"
          size="small"
          variant="text"
          color="error"
          prepend-icon="mdi-delete-outline"
          :loading="toolbar.loading"
          @click="deleteEntity"
        >
          Delete entity
        </v-btn>
      </v-card>

      <!-- Entity-create mode: create entity from selected text -->
      <v-card v-else-if="toolbar.mode === 'entity-create'" elevation="8" rounded="lg" style="width: 320px;">
        <div class="d-flex align-center px-3 pt-2 pb-1 popup-header" @pointerdown="onHeaderPointerDown">
          <span class="text-body-1 font-weight-medium">{{ toolbar.text }}</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="x-small" @click="toolbar.show = false" @pointerdown.stop />
        </div>
        <v-divider />
        <div class="pa-3">
          <div v-if="toolbar.createEntityLoading && toolbar.createEntityTypes.length === 0" class="d-flex justify-center py-3">
            <v-progress-circular indeterminate color="primary" size="24" />
          </div>
          <v-select
            v-else
            v-model="toolbar.createEntityType"
            :items="toolbar.createEntityTypes"
            label="Entity type"
            density="compact"
            variant="outlined"
            hide-details
          />
          <div v-if="toolbar.error" class="text-caption text-error mt-2">{{ toolbar.error }}</div>
        </div>
        <v-divider />
        <div class="px-3 py-2 d-flex justify-end">
          <v-btn
            size="small"
            variant="text"
            :loading="toolbar.createEntityLoading"
            :disabled="!toolbar.createEntityType"
            @click="createEntity"
          >
            Create
          </v-btn>
        </div>
      </v-card>

      <!-- Entity-pref mode: set preferred translation -->
      <v-card v-else-if="toolbar.mode === 'entity-pref'" elevation="8" rounded="lg" style="width: 320px;">
        <div class="d-flex align-center px-3 pt-2 pb-1 popup-header" @pointerdown="onHeaderPointerDown">
          <span class="text-body-1 font-weight-medium">{{ toolbar.text }}</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="x-small" @click="toolbar.show = false" @pointerdown.stop />
        </div>
        <v-divider />
        <div class="pa-3">
          <v-text-field
            v-model="toolbar.prefTransInput"
            label="Preferred English translation"
            density="compact"
            variant="outlined"
            hide-details
            autofocus
            @keydown.enter="setPreferredTranslation"
          />
          <div v-if="toolbar.prefTransQueued != null" class="text-caption text-success mt-2">
            Saved. {{ toolbar.prefTransQueued }} chunk{{ toolbar.prefTransQueued === 1 ? '' : 's' }} queued for retranslation.
          </div>
          <div v-if="toolbar.error" class="text-caption text-error mt-2">{{ toolbar.error }}</div>
        </div>
        <v-divider />
        <div class="px-3 py-2 d-flex justify-end">
          <v-btn
            size="small"
            variant="text"
            :loading="toolbar.prefTransLoading"
            :disabled="!toolbar.prefTransInput.trim()"
            @click="setPreferredTranslation"
          >
            Save
          </v-btn>
        </div>
      </v-card>

      <!-- Entity mode: in-context entity summary -->
      <v-card v-else-if="toolbar.mode === 'entity'" elevation="8" rounded="lg" style="width: 320px;">
        <div class="d-flex align-center px-3 pt-2 pb-1 popup-header" @pointerdown="onHeaderPointerDown">
          <span class="text-body-1 font-weight-medium">{{ toolbar.text }}</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="x-small" @click="toolbar.show = false" @pointerdown.stop />
        </div>
        <v-divider />

        <div v-if="toolbar.entitySummaryLoading" class="d-flex justify-center py-5">
          <v-progress-circular indeterminate color="primary" size="24" />
        </div>

        <v-alert
          v-else-if="toolbar.error"
          type="error"
          variant="tonal"
          density="compact"
          class="ma-2"
          :text="toolbar.error"
        />

        <div v-else-if="toolbar.entitySummary" class="text-body-2 pa-3">
          {{ toolbar.entitySummary }}
        </div>
      </v-card>

      <!-- Dictionary mode: results inline -->
      <v-card v-else elevation="8" rounded="lg" style="width: 320px;">
        <div class="d-flex align-center px-3 pt-2 pb-1 popup-header" @pointerdown="onHeaderPointerDown">
          <span class="text-body-1 font-weight-medium">{{ toolbar.text }}</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="x-small" @click="toolbar.show = false" @pointerdown.stop />
        </div>
        <v-divider />

        <div style="max-height: 340px; overflow-y: auto;">
          <div v-if="toolbar.loading" class="d-flex justify-center py-5">
            <v-progress-circular indeterminate color="primary" size="24" />
          </div>

          <v-alert
            v-else-if="toolbar.error"
            type="error"
            variant="tonal"
            density="compact"
            class="ma-2"
            :text="toolbar.error"
          />

          <div
            v-else-if="toolbar.results.length === 0"
            class="text-center py-5 text-medium-emphasis text-body-2"
          >
            No entries found
          </div>

          <div
            v-for="entry in toolbar.results"
            :key="entry.id"
            class="dict-popup-entry"
            :class="{ 'dict-popup-entry--selected': entry.id === toolbar.disambiguatedEntryId }"
          >
            <div class="d-flex align-baseline ga-2 mb-1 flex-wrap">
              <DictHeadword :traditional="entry.traditional" :simplified="entry.simplified" :query-text="toolbar.text" v-slot="{ primary, secondary, swap }">
                <span class="text-h6 font-weight-light dict-primary" style="line-height: 1.1;" @click="swap">{{ primary }}</span>
                <span v-if="secondary" class="text-caption text-disabled dict-primary" @click="swap">{{ secondary }}</span>
              </DictHeadword>
              <DictPronunciation :pinyin="entry.pinyin" v-slot="{ text, all, cycle }">
                <span
                  class="text-body-2 text-primary font-weight-medium"
                  :style="all.length > 1 ? 'cursor: pointer' : ''"
                  @click.stop="cycle"
                >{{ text }}</span>
              </DictPronunciation>
            </div>
            <div class="text-body-2 text-medium-emphasis">
              <span v-for="(def, i) in entry.definitions" :key="i">
                <span class="text-disabled mr-1" style="font-size: 0.7rem;">{{ i + 1 }}.</span>{{ def
                }}<span v-if="i < entry.definitions.length - 1" class="mx-2 text-disabled">·</span>
              </span>
            </div>
          </div>
        </div>

        <template v-if="!toolbar.loading && !toolbar.error && toolbar.results.length > 0">
          <v-divider />
          <div class="px-3 py-2 d-flex ga-1">
            <v-btn
              size="small"
              variant="text"
              prepend-icon="mdi-lightbulb-outline"
              :disabled="toolbar.explainLoading || toolbar.disambiguateLoading"
              @click="explainInContext"
            >
              Explain
            </v-btn>
            <v-btn
              v-if="toolbar.results.length > 1"
              size="small"
              variant="text"
              prepend-icon="mdi-help-circle-outline"
              :disabled="toolbar.disambiguateLoading || toolbar.explainLoading"
              @click="disambiguate"
            >
              Disambiguate
            </v-btn>
          </div>
          <v-progress-linear v-if="toolbar.explainLoading || toolbar.disambiguateLoading" indeterminate color="primary" />
          <div v-if="toolbar.explanation" class="text-body-2 pa-3">
            {{ toolbar.explanation }}
          </div>
        </template>
      </v-card>

    </div>
  </Teleport>

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

.translation-layout {
  position: relative;
}

/* Card sits behind the left column, stretched to full height of the layout */
.translation-text-card {
  position: absolute !important;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(50% - 8px); /* left column of 1fr 1fr grid with 16px column-gap */
  pointer-events: none;
  z-index: 0;
}

.translation-layout--reading .translation-text-card {
  width: 100%;
}

.translation-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 16px;
  position: relative;
  z-index: 1;
}

.translation-layout--reading .translation-grid {
  grid-template-columns: 1fr;
}

.translation-chunk-text {
  padding: 0 20px 0 22px;
  position: relative;
}

.translation-chunk-text::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(var(--v-border-color), var(--v-border-opacity));
  transition: width 0.15s ease, background 0.15s ease;
}

.translation-chunk-text--active::before {
  width: 6px;
}

.translation-chunk-text--ai::before {
  background: rgb(var(--v-theme-warning));
}

.translation-chunk-text--self::before {
  background: rgb(var(--v-theme-success));
}

.translation-chunk-text--other::before {
  background: rgb(var(--v-theme-primary));
}

.translation-grid > :first-child {
  padding-top: 16px;
}

.translation-grid > :nth-last-child(2) {
  padding-bottom: 16px;
}

.translation-layout--reading .translation-grid > :nth-last-child(2) {
  padding-bottom: 0;
}

.translation-layout--reading .translation-grid > :last-child {
  padding-bottom: 16px;
}

.translation-chunk-input {
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.translation-meta-row {
  margin-top: 4px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.translation-draft-label {
  font-size: 0.85rem;
  color: rgba(var(--v-theme-on-surface), 0.5);
  padding-left: 2px;
}

.translation-save-status {
  font-size: 0.85rem;
  padding-left: 2px;
}

.draft-picker-trigger {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.diff-view {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 4px;
  overflow: hidden;
}

.diff-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.diff-panel + .diff-panel {
  border-left: 1px solid rgba(var(--v-theme-on-surface), 0.12);
}

.diff-panel-header {
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  padding: 4px 10px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.diff-content {
  padding: 10px;
  font-size: 1rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 80px;
}

.diff-content--editable {
  outline: none;
  cursor: text;
}

.diff-content--editable:focus {
  background: rgba(var(--v-theme-primary), 0.03);
}

.diff-content :deep(.diff-removed) {
  background: rgba(239, 68, 68, 0.15);
  text-decoration: line-through;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.diff-content :deep(.diff-added) {
  background: rgba(34, 197, 94, 0.18);
}

.diff-exit-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 2px;
}

.translation-chunk-input :deep(.v-textarea textarea) {
  font-size: 1rem;
  line-height: 1.6;
}

/* Selection toolbar */
.selection-toolbar {
  position: fixed;
  z-index: 1000;
  pointer-events: auto;
}

.popup-header {
  cursor: grab;
  user-select: none;
}

.popup-header:active {
  cursor: grabbing;
}

.dict-primary {
  cursor: pointer;
  user-select: none;
}

.dict-popup-entry {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.dict-popup-entry:last-child {
  border-bottom: none;
}

.dict-popup-entry--selected {
  background: rgba(var(--v-theme-primary), 0.08);
  border-radius: 4px;
}

.document-content :deep(.entity-underline) {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 5px;
}

.document-content :deep(.entity-underline--highlighted) {
  background: rgba(var(--v-theme-primary), 0.35);
  outline: 1px solid rgba(var(--v-theme-primary), 0.6);
  border-radius: 2px;
}

.document-content :deep(.entity-underline--highlighted-solo) {
  background: rgba(var(--v-theme-error), 0.25);
  outline: 1px solid rgba(var(--v-theme-error), 0.5);
  border-radius: 2px;
}

.reader-chunk-annotation {
  padding: 8px 0 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-self: start;
}

.reader-annotation-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 4px;
  border-left: 2px solid rgba(var(--v-border-color), var(--v-border-opacity));
  font-size: 0.9rem;
}

.reader-annotation-item:hover {
  background: rgba(var(--v-theme-primary), 0.06);
  border-left-color: rgb(var(--v-theme-primary));
}

.reader-annotation-text {
  font-weight: 500;
}

.reader-annotation-label {
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.85rem;
}

.reader-annotation-type {
  color: rgba(var(--v-theme-on-surface), 0.4);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-left: auto;
}

</style>

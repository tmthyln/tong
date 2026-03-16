<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
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
const focusedChunkId = ref<number | null>(null)

const documentTitle = computed(() => {
  if (!document.value) return ''
  return document.value.title || document.value.filename
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
    const e = entities[i]
    const tooltip = e.label ? `${e.entityType}: ${e.label}` : e.entityType
    const before = content.slice(0, e.startIndex)
    const text = content.slice(e.startIndex, e.endIndex)
    const after = content.slice(e.endIndex)
    content = `${before}<span class="entity-underline" data-entity-id="${e.id}" title="${tooltip.replace(/"/g, '&quot;')}">${text}</span>${after}`
  }

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

// ── Entity highlighting ───────────────────────────────────────────────────────

const activeEntityId   = ref<number | null>(null)
const activeEntityText = ref<string | null>(null)

function applyEntityHighlights() {
  window.document.querySelectorAll<HTMLElement>('.entity-underline').forEach((el) => {
    const matches =
      (activeEntityId.value != null && Number(el.dataset.entityId) === activeEntityId.value) ||
      (activeEntityText.value != null && el.textContent?.trim() === activeEntityText.value)
    el.classList.toggle('entity-underline--highlighted', matches)
  })
}

// ── Selection toolbar & inline dictionary lookup ──────────────────────────────

interface DictEntry {
  id: number
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

const TONE_MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à', 'a'], e: ['ē', 'é', 'ě', 'è', 'e'],
  i: ['ī', 'í', 'ǐ', 'ì', 'i'], o: ['ō', 'ó', 'ǒ', 'ò', 'o'],
  u: ['ū', 'ú', 'ǔ', 'ù', 'u'], ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
}

function pinyinToMarked(pinyin: string): string {
  return pinyin.split(' ').map((syl) => {
    const m = syl.match(/^(.+?)([1-5])$/)
    if (!m) return syl
    const [, s, t] = m
    const ti = parseInt(t) - 1
    const base = s.replace(/v/g, 'ü')
    if (ti === 4) return base
    if (/[ae]/.test(base)) return base.replace(/[ae]/, (c) => TONE_MARKS[c][ti])
    if (base.includes('ou')) return base.replace('o', TONE_MARKS['o'][ti])
    const mv = base.match(/[iuüaeo](?=[^iuüaeo]*$)/)
    if (mv && mv.index !== undefined)
      return base.slice(0, mv.index) + TONE_MARKS[base[mv.index]][ti] + base.slice(mv.index + 1)
    return base
  }).join(' ')
}

// Toolbar state
const toolbarRef = ref<HTMLElement | null>(null)
const toolbar = ref({
  show:           false,
  x:              0,   // fixed left of popup (px)
  y:              0,   // fixed top of popup (px)
  text:           '',
  mode:           'actions' as 'actions' | 'dictionary',
  results:        [] as DictEntry[],
  loading:        false,
  error:          null as string | null,
  chunkId:              null as number | null,
  explanation:          null as string | null,
  explainLoading:       false,
  disambiguateLoading:  false,
  disambiguatedEntryId: null as number | null,
})

const POPUP_W = 320

// x/y are the raw selection midpoint (viewport coords) until the user drags,
// at which point they become the popup's direct left/top.
const toolbarDragged = ref(false)

const toolbarStyle = computed(() => {
  if (toolbarDragged.value) {
    return { left: `${toolbar.value.x}px`, top: `${toolbar.value.y}px` }
  }
  // Natural placement: centered above the selection via transform.
  const cx = Math.max(4, Math.min(toolbar.value.x, window.innerWidth - 4))
  return {
    left:      `${cx}px`,
    top:       `${toolbar.value.y}px`,
    transform: 'translate(-50%, calc(-100% - 6px))',
  }
})

// Height of the fixed app bar — read from the DOM so it stays correct if
// Vuetify ever changes its default or the bar is resized.
function appBarHeight(): number {
  const bar = window.document.querySelector('.v-app-bar')
  return bar ? bar.getBoundingClientRect().height : 64
}

// Clamp the popup so it stays fully within the viewport and below the app bar.
function clampToViewport() {
  const el = toolbarRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  // Switch to direct coords so adjustments move the popup predictably.
  if (!toolbarDragged.value) {
    toolbarDragged.value = true
    toolbar.value.x = rect.left
    toolbar.value.y = rect.top
  }
  const margin = 8
  const topMin = appBarHeight() + margin
  if (rect.right > window.innerWidth - margin)
    toolbar.value.x -= rect.right - (window.innerWidth - margin)
  if (rect.left < margin)
    toolbar.value.x += margin - rect.left
  if (rect.bottom > window.innerHeight - margin)
    toolbar.value.y -= rect.bottom - (window.innerHeight - margin)
  if (rect.top < topMin)
    toolbar.value.y += topMin - rect.top
}

// Re-clamp whenever the explanation text loads (popup height grows).
watch(() => toolbar.value.explanation, async (val) => {
  if (!val) return
  await nextTick()
  clampToViewport()
})

// ── Drag ─────────────────────────────────────────────────────────────────────

const drag = { active: false, startMouseX: 0, startMouseY: 0, startLeft: 0, startTop: 0 }

function onHeaderPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const el = toolbarRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  // Switch to direct absolute positioning before drag begins.
  toolbarDragged.value = true
  toolbar.value.x = rect.left
  toolbar.value.y = rect.top
  drag.active      = true
  drag.startMouseX = e.clientX
  drag.startMouseY = e.clientY
  drag.startLeft   = rect.left
  drag.startTop    = rect.top
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup',   onDragEnd, { once: true })
}

function onDragMove(e: PointerEvent) {
  if (!drag.active) return
  toolbar.value.x = Math.max(8, Math.min(
    drag.startLeft + e.clientX - drag.startMouseX,
    window.innerWidth - POPUP_W - 8,
  ))
  toolbar.value.y = Math.max(8, drag.startTop + e.clientY - drag.startMouseY)
}

function onDragEnd() {
  drag.active = false
  window.removeEventListener('pointermove', onDragMove)
}

function onContentDblClick(e: MouseEvent) {
  const target = (e.target as Element).closest('.entity-underline')
  if (!target) return
  const sel = window.getSelection()
  if (!sel) return
  const range = window.document.createRange()
  range.selectNodeContents(target)
  sel.removeAllRanges()
  sel.addRange(range)
  activeEntityId.value   = Number((target as HTMLElement).dataset.entityId) || null
  activeEntityText.value = target.textContent?.trim() ?? null
  applyEntityHighlights()
}

function onContentMouseUp() {
  // Defer until after dblclick fires. On a double-click the event order is
  // mouseup → dblclick, so a setTimeout(0) lets onContentDblClick correct the
  // selection to the full entity span before we read it here.
  setTimeout(() => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return
  const text = sel.toString().trim()
  const selRect = sel.getRangeAt(0).getBoundingClientRect()

  const node = sel.getRangeAt(0).startContainer
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)
    ?.closest('[data-chunk-id]')
  const chunkId = el ? Number(el.getAttribute('data-chunk-id')) : null

  // Store raw selection midpoint; transform handles centering/placement above.
  const x = selRect.left + selRect.width / 2
  const y = selRect.top

  toolbarDragged.value = false
  toolbar.value = {
    show: true, x, y, text,
    mode: 'actions', results: [], loading: false, error: null,
    chunkId, explanation: null, explainLoading: false,
    disambiguateLoading: false, disambiguatedEntryId: null,
  }
  }, 0)
}

function onDocumentMouseDown(e: MouseEvent) {
  if (toolbarRef.value?.contains(e.target as Node)) return
  toolbar.value.show = false
  if (!(e.target as Element).closest?.('.entity-underline')) {
    activeEntityId.value   = null
    activeEntityText.value = null
    applyEntityHighlights()
  }
}

async function lookupInDictionary() {
  toolbar.value.mode = 'dictionary'
  toolbar.value.loading = true
  toolbar.value.error = null
  toolbar.value.results = []
  toolbar.value.explanation = null
  toolbar.value.explainLoading = false
  toolbar.value.disambiguateLoading = false
  toolbar.value.disambiguatedEntryId = null
  try {
    const res = await fetch(`/api/dictionary/search?q=${encodeURIComponent(toolbar.value.text)}&headwords=1`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { results: DictEntry[] }
    toolbar.value.results = data.results
  } catch (e) {
    toolbar.value.error = e instanceof Error ? e.message : 'Lookup failed'
  } finally {
    toolbar.value.loading = false
    await nextTick()
    clampToViewport()
  }
}

async function explainInContext() {
  const { text, results, chunkId } = toolbar.value
  if (!document.value || chunkId == null) return
  toolbar.value.explainLoading = true
  toolbar.value.error = null
  try {
    const res = await fetch('/api/dictionary/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: text, entries: results, documentId: document.value.id, chunkId }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { explanation: string }
    toolbar.value.explanation = data.explanation
  } catch (e) {
    toolbar.value.error = e instanceof Error ? e.message : 'Explain failed'
  } finally {
    toolbar.value.explainLoading = false
  }
}

async function disambiguate() {
  const { text, results, chunkId } = toolbar.value
  if (!document.value || chunkId == null) return
  toolbar.value.disambiguateLoading = true
  toolbar.value.error = null
  try {
    const res = await fetch('/api/dictionary/disambiguate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: text, entries: results, documentId: document.value.id, chunkId }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { explanation: string; entryId: number }
    toolbar.value.disambiguatedEntryId = data.entryId
    toolbar.value.explanation = data.explanation
  } catch (e) {
    toolbar.value.error = e instanceof Error ? e.message : 'Disambiguate failed'
  } finally {
    toolbar.value.disambiguateLoading = false
  }
}

onMounted(() => {
  window.document.addEventListener('mousedown', onDocumentMouseDown)
  fetchDocument()
})

onUnmounted(() => {
  window.document.removeEventListener('mousedown', onDocumentMouseDown)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
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
      <v-card v-if="!translationMode" @mouseup="onContentMouseUp" @dblclick="onContentDblClick">
        <v-card-text class="document-content">
          <div
            v-for="chunk in document.chunks"
            :key="chunk.id"
            :data-chunk-id="chunk.id"
            v-html="renderChunk(chunk)"
          />
        </v-card-text>
      </v-card>

      <!-- Translation view: card behind original text only, textareas float on right -->
      <div v-else class="translation-layout" @mouseup="onContentMouseUp" @dblclick="onContentDblClick">
        <v-card class="translation-text-card" />
        <div class="translation-grid">
          <template v-for="chunk in document.chunks" :key="chunk.id">
            <div
              class="document-content translation-chunk-text"
              :class="{ 'translation-chunk-text--active': focusedChunkId === chunk.id }"
              :data-chunk-id="chunk.id"
              v-html="renderChunk(chunk)"
            />
            <div class="translation-chunk-input">
              <v-textarea
                v-model="translations[chunk.id]"
                variant="outlined"
                hide-details
                auto-grow
                rows="3"
                placeholder="Translation…"
                @focus="focusedChunkId = chunk.id"
                @blur="focusedChunkId = null"
              />
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
              <span class="text-h6 font-weight-light" style="line-height: 1.1;">
                {{ entry.traditional }}
              </span>
              <span v-if="entry.traditional !== entry.simplified" class="text-caption text-disabled">
                {{ entry.simplified }}
              </span>
              <span class="text-body-2 text-primary font-weight-medium">
                {{ pinyinToMarked(entry.pinyin) }}
              </span>
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

.translation-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 16px;
  position: relative;
  z-index: 1;
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
  width: 4px;
  background: rgb(var(--v-theme-primary));
}

.translation-grid > :first-child {
  padding-top: 16px;
}

.translation-grid > :nth-last-child(2) {
  padding-bottom: 16px;
}

.translation-chunk-input {
  padding: 8px 0;
  display: flex;
  align-items: flex-start;
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
  cursor: help;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 5px;
}

.document-content :deep(.entity-underline--highlighted) {
  background: rgba(var(--v-theme-primary), 0.35);
  outline: 1px solid rgba(var(--v-theme-primary), 0.6);
  border-radius: 2px;
}
</style>
<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { marked } from 'marked'
import { diffWords } from 'diff'
import DictHeadword from '../components/DictHeadword.vue'
import { useUser } from '../composables/useUser'

interface Entity {
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

interface Chunk {
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
  entities: Entity[]
  chunks: Chunk[]
}

const route = useRoute()
const { userId } = useUser()
const document = ref<Document | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const translationMode = ref(false)
const translations = ref<Record<number, string>>({})
const currentDraftIndices = ref<Record<number, number>>({})
const focusedChunkId = ref<number | null>(null)

interface CompareEntry {
  draftIndex: number
  oldHtml: string
}
const compareState = ref<Record<number, CompareEntry | null>>({})
const draftMenuOpen = ref<Record<number, boolean>>({})
const diffEditorRefs: Record<number, HTMLElement | null> = {}

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
    const e = doc.entities[i]
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
      translations.value[chunk.id] = chunk.translation ?? ''
      currentDraftIndices.value[chunk.id] = chunk.availableTranslationDrafts.length || 1
    }
  }
}

async function loadDraft(chunk: Chunk, draftIndex: number) {
  delete compareState.value[chunk.id]
  const draftNumber = chunk.availableTranslationDrafts[draftIndex - 1]
  if (draftNumber === undefined) return
  const res = await fetch(`/api/library/chunk/${chunk.id}/translation?draft=${draftNumber}`)
  if (!res.ok) return
  const data = await res.json() as { content: string }
  translations.value[chunk.id] = data.content
  currentDraftIndices.value[chunk.id] = draftIndex
}

function buildDiffHtml(oldText: string, newText: string): { oldHtml: string; newHtml: string } {
  const changes = diffWords(oldText, newText)
  let oldHtml = ''
  let newHtml = ''
  for (const change of changes) {
    const esc = change.value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    if (change.removed) {
      oldHtml += `<span class="diff-removed">${esc}</span>`
    } else if (change.added) {
      newHtml += `<span class="diff-added">${esc}</span>`
    } else {
      oldHtml += esc
      newHtml += esc
    }
  }
  return { oldHtml, newHtml }
}

async function startCompare(chunk: Chunk, draftIndex: number) {
  const draftNumber = chunk.availableTranslationDrafts[draftIndex - 1]
  if (draftNumber === undefined) return
  const res = await fetch(`/api/library/chunk/${chunk.id}/translation?draft=${draftNumber}`)
  if (!res.ok) return
  const data = await res.json() as { content: string }
  const { oldHtml, newHtml } = buildDiffHtml(data.content, translations.value[chunk.id] ?? '')
  compareState.value[chunk.id] = { draftIndex, oldHtml }
  draftMenuOpen.value[chunk.id] = false
  await nextTick()
  const el = diffEditorRefs[chunk.id]
  if (el) el.innerHTML = newHtml
}

function exitCompare(chunkId: number) {
  const el = diffEditorRefs[chunkId]
  if (el) translations.value[chunkId] = el.textContent ?? ''
  delete compareState.value[chunkId]
}

function onDiffInput(chunkId: number, event: Event) {
  translations.value[chunkId] = (event.target as HTMLElement).textContent ?? ''
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
const activeParentId   = ref<number | null>(null)

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

function applyEntityHighlights() {
  window.document.querySelectorAll<HTMLElement>('.entity-underline').forEach((el) => {
    const id = Number(el.dataset.entityId)
    let primary = false
    let solo = false

    if (activeParentId.value != null) {
      // Has a document-level parent: highlight all siblings sharing that parent
      const entity = entityById.value.get(id)
      primary = entity?.parentId === activeParentId.value
    } else if (activeEntityText.value != null) {
      // No parent: highlight exact text matches with reddish style
      solo = el.textContent?.trim() === activeEntityText.value
    }

    el.classList.toggle('entity-underline--highlighted', primary)
    el.classList.toggle('entity-underline--highlighted-solo', solo)
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
  mode:           'actions' as 'actions' | 'dictionary' | 'entity' | 'entity-pref',
  results:        [] as DictEntry[],
  loading:        false,
  error:          null as string | null,
  chunkId:              null as number | null,
  explanation:          null as string | null,
  explainLoading:       false,
  disambiguateLoading:  false,
  disambiguatedEntryId: null as number | null,
  entitySummaryLoading: false as boolean,
  entitySummary:        null as string | null,
  prefTransInput:       '',
  prefTransLoading:     false,
  prefTransQueued:      null as number | null,
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

// Re-clamp whenever the explanation or entity summary loads (popup height grows).
watch(() => toolbar.value.explanation, async (val) => {
  if (!val) return
  await nextTick()
  clampToViewport()
})
watch(() => toolbar.value.entitySummary, async (val) => {
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
  const clickedId        = Number((target as HTMLElement).dataset.entityId) || null
  activeEntityId.value   = clickedId
  activeEntityText.value = target.textContent?.trim() ?? null
  activeParentId.value   = clickedId != null ? (entityById.value.get(clickedId)?.parentId ?? null) : null
  applyEntityHighlights()
}

function onContentMouseUp() {
  // Defer until after dblclick fires. On a double-click the event order is
  // mouseup → dblclick, so a setTimeout(0) lets onContentDblClick correct the
  // selection to the full entity span before we read it here.
  setTimeout(() => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return

  const node = sel.getRangeAt(0).startContainer
  const anchorEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element
  if (anchorEl?.closest('.translation-chunk-input')) return

  const text = sel.toString().trim()
  const selRect = sel.getRangeAt(0).getBoundingClientRect()

  const el = anchorEl?.closest('[data-chunk-id]')
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
    entitySummaryLoading: false, entitySummary: null,
  }
  }, 0)
}

function onDocumentMouseDown(e: MouseEvent) {
  if (toolbarRef.value?.contains(e.target as Node)) return
  if ((e.target as Element).closest?.('.entity-underline')) return  // onContentClick handles this
  toolbar.value.show = false
  activeEntityId.value   = null
  activeEntityText.value = null
  activeParentId.value   = null
  applyEntityHighlights()
}

function onContentClick(e: MouseEvent) {
  const target = (e.target as Element).closest('.entity-underline')
  if (!target) return
  const entityId = Number((target as HTMLElement).dataset.entityId) || null
  activeEntityId.value   = entityId
  activeEntityText.value = target.textContent?.trim() ?? null
  activeParentId.value   = entityId != null ? (entityById.value.get(entityId)?.parentId ?? null) : null
  applyEntityHighlights()
  const chunkEl = target.closest('[data-chunk-id]')
  const chunkId = chunkEl ? Number(chunkEl.getAttribute('data-chunk-id')) : null
  const rect = target.getBoundingClientRect()
  toolbarDragged.value = false
  toolbar.value = {
    show: true,
    x: rect.left + rect.width / 2,
    y: rect.top,
    text: activeEntityText.value ?? '',
    mode: 'actions', results: [], loading: false, error: null,
    chunkId, explanation: null, explainLoading: false,
    disambiguateLoading: false, disambiguatedEntryId: null,
    entitySummaryLoading: false, entitySummary: null,
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

async function summarizeEntity() {
  if (!document.value || activeEntityId.value == null) return
  toolbarDragged.value = false  // re-center on switch
  toolbar.value.mode = 'entity'
  toolbar.value.entitySummaryLoading = true
  toolbar.value.entitySummary = null
  toolbar.value.error = null
  try {
    const res = await fetch('/api/knowledge/document-entity-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: document.value.id, entityId: activeEntityId.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { summary: string }
    toolbar.value.entitySummary = data.summary
  } catch (e) {
    toolbar.value.error = e instanceof Error ? e.message : 'Summary failed'
  } finally {
    toolbar.value.entitySummaryLoading = false
  }
}

function openPrefTranslation() {
  if (activeEntityId.value == null) return
  const entity = entityById.value.get(activeEntityId.value)
  const prefEntity = entity?.parentId != null ? entityById.value.get(entity.parentId) : entity
  toolbarDragged.value = false
  toolbar.value = {
    ...toolbar.value,
    mode: 'entity-pref',
    prefTransInput: prefEntity?.preferredTranslation ?? '',
    prefTransLoading: false,
    prefTransQueued: null,
    error: null,
  }
}

async function setPreferredTranslation() {
  if (activeEntityId.value == null || !toolbar.value.prefTransInput.trim()) return
  toolbar.value.prefTransLoading = true
  toolbar.value.error = null
  toolbar.value.prefTransQueued = null
  try {
    const res = await fetch(`/api/knowledge/entity/${activeEntityId.value}/preferred-translation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredTranslation: toolbar.value.prefTransInput.trim() }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { queued: number }
    toolbar.value.prefTransQueued = data.queued
  } catch (e) {
    toolbar.value.error = e instanceof Error ? e.message : 'Save failed'
  } finally {
    toolbar.value.prefTransLoading = false
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
        <v-col>
          <v-chip
            v-for="(chip, i) in entityChips"
            :key="i"
            :color="chip.color"
            size="small"
            variant="tonal"
            class="mr-1 mb-1"
          >{{ chip.text }}<span v-if="chip.count > 1" class="ml-1 opacity-60">{{ chip.count }}</span></v-chip>
        </v-col>
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

      <!-- Reading / Translation view (unified) -->
      <div
        class="translation-layout"
        :class="{ 'translation-layout--reading': !translationMode }"
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
            <div v-if="translationMode" class="translation-chunk-input">
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
                  @blur="focusedChunkId = null"
                />
              </template>

              <!-- Below-box meta row -->
              <div v-if="chunk.availableTranslationDrafts.length > 0 || chunk.translationTranslator" class="translation-meta-row">
                <span v-if="chunk.translationTranslator" class="translation-draft-label">
                  {{ chunk.translationTranslator }}<template v-if="chunk.translationDateLastModified"> · {{ new Date(chunk.translationDateLastModified).toLocaleDateString() }}</template>
                </span>
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
</style>
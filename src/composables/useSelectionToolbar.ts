import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { Document, Entity } from '../types/document'

interface DictEntry {
  id: number
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

const POPUP_W = 320

export function useSelectionToolbar(
  document: Ref<Document | null>,
  entityById: ComputedRef<Map<number, Entity>>,
  onEntityCreated: () => Promise<void>,
) {
  const toolbarRef = ref<HTMLElement | null>(null)
  const toolbar = ref({
    show:                 false,
    x:                    0,
    y:                    0,
    text:                 '',
    mode:                 'actions' as 'actions' | 'dictionary' | 'entity' | 'entity-pref' | 'entity-create',
    results:              [] as DictEntry[],
    loading:              false,
    error:                null as string | null,
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
    createEntityTypes:        [] as string[],
    createEntityType:         '',
    createEntityLoading:      false,
    selectionOverlapsEntity:  false,
  })

  const toolbarDragged = ref(false)

  const activeEntityId   = ref<number | null>(null)
  const activeEntityText = ref<string | null>(null)
  const activeParentId   = ref<number | null>(null)

  const toolbarStyle = computed(() => {
    if (toolbarDragged.value) {
      return { left: `${toolbar.value.x}px`, top: `${toolbar.value.y}px` }
    }
    const halfW = POPUP_W / 2
    const leftMin = navDrawerRight() + halfW + 4
    const cx = Math.max(leftMin, Math.min(toolbar.value.x, window.innerWidth - halfW - 4))
    return {
      left:      `${cx}px`,
      top:       `${toolbar.value.y}px`,
      transform: 'translate(-50%, calc(-100% - 6px))',
    }
  })

  function appBarHeight(): number {
    const bar = window.document.querySelector('.v-app-bar')
    return bar ? bar.getBoundingClientRect().height : 64
  }

  function navDrawerRight(): number {
    const drawer = window.document.querySelector('.v-navigation-drawer')
    return drawer ? drawer.getBoundingClientRect().right : 0
  }

  function clampToViewport() {
    const el = toolbarRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!toolbarDragged.value) {
      toolbarDragged.value = true
      toolbar.value.x = rect.left
      toolbar.value.y = rect.top
    }
    const margin = 8
    const topMin = appBarHeight() + margin
    const leftMin = navDrawerRight() + margin
    if (rect.right > window.innerWidth - margin)
      toolbar.value.x -= rect.right - (window.innerWidth - margin)
    if (rect.left < leftMin)
      toolbar.value.x += leftMin - rect.left
    if (rect.bottom > window.innerHeight - margin)
      toolbar.value.y -= rect.bottom - (window.innerHeight - margin)
    if (rect.top < topMin)
      toolbar.value.y += topMin - rect.top
  }

  function applyEntityHighlights() {
    window.document.querySelectorAll<HTMLElement>('.entity-underline').forEach((el) => {
      const id = Number(el.dataset.entityId)
      let primary = false
      let solo = false

      if (activeParentId.value != null) {
        const entity = entityById.value.get(id)
        primary = entity?.parentId === activeParentId.value
      } else if (activeEntityText.value != null) {
        solo = el.textContent?.trim() === activeEntityText.value
      }

      el.classList.toggle('entity-underline--highlighted', primary)
      el.classList.toggle('entity-underline--highlighted-solo', solo)
    })
  }

  // ── Drag ───────────────────────────────────────────────────────────────────

  const drag = { active: false, startMouseX: 0, startMouseY: 0, startLeft: 0, startTop: 0 }

  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const el = toolbarRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
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

  // ── Mouse event handlers ──────────────────────────────────────────────────

  function onDocumentMouseDown(e: MouseEvent) {
    if (toolbarRef.value?.contains(e.target as Node)) return
    if ((e.target as Element).closest?.('.entity-underline')) return
    if ((e.target as Element).closest?.('.v-overlay')) return
    toolbar.value.show = false
    activeEntityId.value   = null
    activeEntityText.value = null
    activeParentId.value   = null
    applyEntityHighlights()
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

      const range = sel.getRangeAt(0)
      const entitySpans = el?.querySelectorAll<HTMLElement>('.entity-underline') ?? []
      const selectionOverlapsEntity = [...entitySpans].some(span => range.intersectsNode(span))

      const x = selRect.left + selRect.width / 2
      const y = selRect.top

      toolbarDragged.value = false
      toolbar.value = {
        show: true, x, y, text,
        mode: 'actions', results: [], loading: false, error: null,
        chunkId, explanation: null, explainLoading: false,
        disambiguateLoading: false, disambiguatedEntryId: null,
        entitySummaryLoading: false, entitySummary: null,
        prefTransInput: '', prefTransLoading: false, prefTransQueued: null,
        createEntityTypes: [], createEntityType: '', createEntityLoading: false,
        selectionOverlapsEntity,
      }
    }, 0)
  }

  function onContentClick(e: MouseEvent) {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
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
      prefTransInput: '', prefTransLoading: false, prefTransQueued: null,
      createEntityTypes: [], createEntityType: '', createEntityLoading: false,
      selectionOverlapsEntity: false,
    }
  }

  // ── API actions ───────────────────────────────────────────────────────────

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
    toolbarDragged.value = false
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

  async function openEntityCreate() {
    if (!toolbar.value.chunkId || !document.value) return
    toolbarDragged.value = false
    toolbar.value = {
      ...toolbar.value,
      mode: 'entity-create',
      createEntityTypes: [],
      createEntityType: '',
      createEntityLoading: true,
      error: null,
    }
    try {
      const res = await fetch('/api/graph-types/node-type')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as Array<{ name: string }>
      toolbar.value.createEntityTypes = data.map((t) => t.name)
      toolbar.value.createEntityType = data[0]?.name ?? ''
    } catch (e) {
      toolbar.value.error = e instanceof Error ? e.message : 'Failed to load types'
    } finally {
      toolbar.value.createEntityLoading = false
      await nextTick()
      clampToViewport()
    }
  }

  async function createEntity() {
    if (!toolbar.value.chunkId || !document.value || !toolbar.value.createEntityType || !toolbar.value.text) return
    toolbar.value.createEntityLoading = true
    toolbar.value.error = null
    try {
      const res = await fetch('/api/knowledge/entity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: toolbar.value.text,
          entityType: toolbar.value.createEntityType,
          chunkId: toolbar.value.chunkId,
          documentId: document.value.id,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toolbar.value.show = false
      await onEntityCreated()
    } catch (e) {
      toolbar.value.error = e instanceof Error ? e.message : 'Create failed'
    } finally {
      toolbar.value.createEntityLoading = false
    }
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

  onMounted(() => {
    window.document.addEventListener('mousedown', onDocumentMouseDown)
  })

  onUnmounted(() => {
    window.document.removeEventListener('mousedown', onDocumentMouseDown)
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
  })

  return {
    toolbar,
    toolbarRef,
    toolbarStyle,
    activeEntityId,
    activeEntityText,
    activeParentId,
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
  }
}

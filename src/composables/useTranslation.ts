import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import type { Ref } from 'vue'
import { diffWords } from 'diff'
import type { Chunk, Document } from '../types/document'

type DocumentMode = 'reading' | 'translation' | 'reader'

interface CompareEntry {
  draftIndex: number
  oldHtml: string
}

export function useTranslation(
  document: Ref<Document | null>,
  computeOverview: () => void,
  documentMode: Ref<DocumentMode>,
) {
  const translationMode = computed(() => documentMode.value === 'translation')
  const translations = ref<Record<number, string>>({})
  const currentDraftIndices = ref<Record<number, number>>({})
  const focusedChunkId = ref<number | null>(null)
  const saveTimers = ref<Record<number, ReturnType<typeof setTimeout>>>({})
  const saveStatus = ref<Record<number, 'saving' | 'saved' | 'error'>>({})
  const compareState = ref<Record<number, CompareEntry | null>>({})
  const draftMenuOpen = ref<Record<number, boolean>>({})
  const diffEditorRefs: Record<number, HTMLElement | null> = {}

  function initTranslations() {
    if (!document.value) return
    for (const chunk of document.value.chunks) {
      if (!(chunk.id in translations.value)) {
        translations.value[chunk.id] = chunk.translation ?? ''
        currentDraftIndices.value[chunk.id] = chunk.availableTranslationDrafts.length || 1
      }
    }
  }

  async function saveTranslation(chunkId: number) {
    saveStatus.value[chunkId] = 'saving'
    try {
      const res = await fetch(`/api/library/chunk/${chunkId}/translation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: translations.value[chunkId] }),
      })
      if (res.status === 401) {
        delete saveStatus.value[chunkId]
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { draftNumber: number; translator: string; dateLastModified: string; created: boolean }

      const chunk = document.value?.chunks.find(c => c.id === chunkId)
      if (chunk) {
        chunk.translationTranslator = data.translator
        chunk.translationDateLastModified = data.dateLastModified
        if (data.created) {
          chunk.availableTranslationDrafts.push(data.draftNumber)
          currentDraftIndices.value[chunkId] = chunk.availableTranslationDrafts.length
        }
      }
      computeOverview()

      saveStatus.value[chunkId] = 'saved'
      setTimeout(() => {
        if (saveStatus.value[chunkId] === 'saved') delete saveStatus.value[chunkId]
      }, 2000)
    } catch {
      saveStatus.value[chunkId] = 'error'
    }
  }

  function scheduleSave(chunkId: number) {
    if (compareState.value[chunkId]) return
    if (saveTimers.value[chunkId]) clearTimeout(saveTimers.value[chunkId])
    delete saveStatus.value[chunkId]
    saveTimers.value[chunkId] = setTimeout(() => {
      delete saveTimers.value[chunkId]
      saveTranslation(chunkId)
    }, 3000)
  }

  function flushSave(chunkId: number) {
    if (!saveTimers.value[chunkId]) return
    clearTimeout(saveTimers.value[chunkId])
    delete saveTimers.value[chunkId]
    saveTranslation(chunkId)
  }

  async function loadDraft(chunk: Chunk, draftIndex: number) {
    if (saveTimers.value[chunk.id]) {
      clearTimeout(saveTimers.value[chunk.id])
      delete saveTimers.value[chunk.id]
    }
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
    scheduleSave(chunkId)
  }

  watch(translationMode, val => {
    if (val) initTranslations()
  })

  onUnmounted(() => {
    for (const timer of Object.values(saveTimers.value)) clearTimeout(timer)
  })

  return {
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
  }
}

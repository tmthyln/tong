<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import DictHeadword from '../components/DictHeadword.vue'

// ── Types ────────────────────────────────────────────────────────────────────

interface DictEntry {
  id: number
  traditional: string
  simplified: string
  pinyin: string       // numbered pinyin: shui3, xue2
  definitions: string[]
}

type FilterKind = 'text' | 'strokes' | 'radical' | 'component' | 'tone' | 'definition'

interface ParsedToken {
  kind: FilterKind
  raw: string
  value: string
  valid: boolean
}

// ── Pinyin conversion ────────────────────────────────────────────────────────

const TONE_MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à', 'a'],
  e: ['ē', 'é', 'ě', 'è', 'e'],
  i: ['ī', 'í', 'ǐ', 'ì', 'i'],
  o: ['ō', 'ó', 'ǒ', 'ò', 'o'],
  u: ['ū', 'ú', 'ǔ', 'ù', 'u'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
}

function syllableToMarked(syllable: string): string {
  const m = syllable.match(/^(.+?)([1-5])$/)
  if (!m) return syllable
  const [, syl, toneStr] = m
  const tone = parseInt(toneStr) - 1
  const s = syl.replace(/v/g, 'ü')
  if (tone === 4) return s
  if (/[ae]/.test(s))
    return s.replace(/[ae]/, (ch) => TONE_MARKS[ch][tone])
  if (s.includes('ou'))
    return s.replace('o', TONE_MARKS['o'][tone])
  const match = s.match(/[iuüaeo](?=[^iuüaeo]*$)/)
  if (match && match.index !== undefined)
    return s.slice(0, match.index) + TONE_MARKS[s[match.index]][tone] + s.slice(match.index + 1)
  return s
}

function pinyinToMarked(pinyin: string): string {
  return pinyin.split(' ').map(syllableToMarked).join(' ')
}

// ── Query parsing ────────────────────────────────────────────────────────────

const FILTER_PREFIXES: [string, FilterKind][] = [
  ['strokes:', 'strokes'],
  ['radical:', 'radical'],
  ['component:', 'component'],
  ['tone:', 'tone'],
  ['def:', 'definition'],
]

function parseQuery(raw: string): ParsedToken[] {
  if (!raw.trim()) return []
  return raw.trim().split(/\s+/).map((token) => {
    for (const [prefix, kind] of FILTER_PREFIXES) {
      if (token.toLowerCase().startsWith(prefix)) {
        const value = token.slice(prefix.length)
        const valid = validateToken(kind, value)
        return { kind, raw: token, value, valid }
      }
    }
    return { kind: 'text' as FilterKind, raw: token, value: token, valid: true }
  })
}

function validateToken(kind: FilterKind, value: string): boolean {
  if (!value) return false
  if (kind === 'strokes') return /^\d+(-\d+)?$/.test(value)
  if (kind === 'tone') return /^[1-5]$/.test(value)
  return true
}

// Kinds that are not yet implemented on the backend (shown differently in UI).
const NOOP_KINDS = new Set<FilterKind>(['strokes', 'radical', 'component'])

// ── API ──────────────────────────────────────────────────────────────────────

function buildSearchParams(tokens: ParsedToken[]): URLSearchParams | null {
  const params = new URLSearchParams()
  let hasActiveToken = false

  const textParts: string[] = []

  for (const token of tokens) {
    if (!token.valid) continue
    hasActiveToken = true
    switch (token.kind) {
      case 'text':       textParts.push(token.value); break
      case 'strokes':    params.set('strokes', token.value); break
      case 'radical':    params.set('radical', token.value); break
      case 'component':  params.set('component', token.value); break
      case 'tone':       params.set('tone', token.value); break
      case 'definition': params.set('def', token.value); break
    }
  }

  if (textParts.length) params.set('q', textParts.join(' '))

  return hasActiveToken ? params : null
}

// ── Advanced search types ─────────────────────────────────────────────────────

interface Segment {
  text: string
  entries: DictEntry[]
}

interface Segmentation {
  segments: Segment[]
  score: number
}

// ── State ────────────────────────────────────────────────────────────────────

const searchMode = ref<'basic' | 'advanced'>('basic')
const searchQuery = ref('')
const showHelp = ref(false)

// Basic
const results = ref<DictEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const searched = ref(false)

// Advanced
const segmentations = ref<Segmentation[]>([])
const segLoading = ref(false)
const segError = ref<string | null>(null)
const segSearched = ref(false)

// Token parsing is only used in basic mode.
const tokens = computed(() =>
  searchMode.value === 'basic' ? parseQuery(searchQuery.value ?? '') : []
)

const onlyNoopFilters = computed(() =>
  tokens.value.length > 0 &&
  tokens.value.filter((t) => t.valid).every((t) => NOOP_KINDS.has(t.kind))
)

// ── Search logic ──────────────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!searchQuery.value?.trim()) {
    results.value = []
    segmentations.value = []
    searched.value = false
    segSearched.value = false
    error.value = null
    segError.value = null
    return
  }
  debounceTimer = setTimeout(runSearch, 300)
}

async function runSearch() {
  if (searchMode.value === 'basic') {
    await runBasicSearch()
  } else {
    await runAdvancedSearch()
  }
}

async function runBasicSearch() {
  const params = buildSearchParams(tokens.value)
  if (!params) { results.value = []; searched.value = false; return }
  loading.value = true
  error.value = null
  try {
    const res = await fetch(`/api/dictionary/search?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { results: DictEntry[] }
    results.value = data.results
    searched.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Search failed'
    results.value = []
  } finally {
    loading.value = false
  }
}

async function runAdvancedSearch() {
  const q = searchQuery.value?.trim()
  if (!q) return
  segLoading.value = true
  segError.value = null
  try {
    const res = await fetch(`/api/dictionary/segment?q=${encodeURIComponent(q)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { segmentations: Segmentation[] }
    segmentations.value = data.segmentations
    segSearched.value = true
  } catch (e) {
    segError.value = e instanceof Error ? e.message : 'Segmentation failed'
    segmentations.value = []
  } finally {
    segLoading.value = false
  }
}

watch(searchQuery, scheduleSearch)

watch(searchMode, (mode) => {
  // Clear stale results from the previous mode and re-search.
  if (mode === 'basic') {
    segmentations.value = []
    segSearched.value = false
    segError.value = null
  } else {
    results.value = []
    searched.value = false
    error.value = null
  }
  scheduleSearch()
})

// ── Display helpers ──────────────────────────────────────────────────────────

const TOKEN_COLORS: Record<FilterKind, string> = {
  text:       'default',
  strokes:    'orange',
  radical:    'green',
  component:  'teal',
  tone:       'purple',
  definition: 'blue',
}

const TOKEN_LABELS: Record<FilterKind, string> = {
  text:       'text',
  strokes:    'strokes',
  radical:    'radical',
  component:  'component',
  tone:       'tone',
  definition: 'definition',
}

const TOKEN_ICONS: Record<FilterKind, string> = {
  text:       'mdi-text-search',
  strokes:    'mdi-pencil-outline',
  radical:    'mdi-ideogram-cjk',
  component:  'mdi-puzzle-outline',
  tone:       'mdi-music-note',
  definition: 'mdi-book-open-outline',
}

const SYNTAX_ROWS = [
  { example: '水',           description: 'Match by Chinese character (exact or substring)' },
  { example: 'shui',        description: 'Match by pinyin (with or without tone numbers)' },
  { example: 'water',       description: 'Match by English definition (substring)' },
  { example: '氵*',         description: 'Wildcard: * = any sequence of characters' },
  { example: '人_',         description: 'Wildcard: _ = exactly one character' },
  { example: 'strokes:4',   description: 'Exact stroke count (coming soon)' },
  { example: 'strokes:4-8', description: 'Stroke count range inclusive (coming soon)' },
  { example: 'radical:水',  description: 'Entries with this Kangxi radical (coming soon)' },
  { example: 'component:口','description': 'Entries containing this component (coming soon)' },
  { example: 'tone:3',      description: 'Tone of any syllable (1–4, or 5 for neutral)' },
  { example: 'def:fire',    description: 'Definition contains this word or phrase' },
]

const EXAMPLE_SEARCHES = [
  '水', 'shui', 'fire', 'tone:4', 'def:water', '氵*', '人_',
]

function fillExample(q: string) {
  searchQuery.value = q
}
</script>

<template>
  <div class="w-100 pa-4 d-flex flex-column align-center">
  <div style="width: 100%; max-width: 720px;">
    <h1 class="text-h4 mb-6">Dictionary</h1>

    <!-- ── Mode toggle ───────────────────────────────────────────────────── -->
    <div class="d-flex ga-1 mb-3">
      <v-chip
        :variant="searchMode === 'advanced' ? 'flat' : 'outlined'"
        :color="searchMode === 'advanced' ? 'primary' : undefined"
        size="small"
        style="cursor: pointer;"
        @click="searchMode = 'advanced'"
      >
        Advanced
        <v-tooltip activator="parent" location="top">Currently broken</v-tooltip>
      </v-chip>
      <v-chip
        :variant="searchMode === 'basic' ? 'flat' : 'outlined'"
        :color="searchMode === 'basic' ? 'primary' : undefined"
        size="small"
        style="cursor: pointer;"
        @click="searchMode = 'basic'"
      >
        Basic
      </v-chip>
    </div>

    <!-- ── Search bar ─────────────────────────────────────────────────────── -->
    <v-text-field
      v-model="searchQuery"
      variant="outlined"
      density="comfortable"
      :placeholder="searchMode === 'advanced'
        ? 'Enter a Chinese phrase or sentence…'
        : 'Search by character, pinyin, definition, or use filter operators…'"
      prepend-inner-icon="mdi-magnify"
      clearable
      autofocus
      class="mb-2"
      hide-details
    >
      <template v-if="searchMode === 'basic'" #append-inner>
        <v-btn
          :icon="showHelp ? 'mdi-help-circle' : 'mdi-help-circle-outline'"
          :color="showHelp ? 'primary' : undefined"
          variant="text"
          size="small"
          density="compact"
          @click="showHelp = !showHelp"
        />
      </template>
    </v-text-field>

    <!-- ── Parsed tokens (basic only) ────────────────────────────────────── -->
    <div v-if="searchMode === 'basic' && tokens.length" class="d-flex flex-wrap align-center ga-2 mb-3 pl-1">
      <span class="text-caption text-medium-emphasis">Filters:</span>
      <v-chip
        v-for="(token, i) in tokens"
        :key="i"
        :color="!token.valid ? 'error' : NOOP_KINDS.has(token.kind) ? 'default' : TOKEN_COLORS[token.kind]"
        :prepend-icon="token.valid ? TOKEN_ICONS[token.kind] : 'mdi-alert-circle-outline'"
        size="small"
        label
        variant="tonal"
        :style="NOOP_KINDS.has(token.kind) && token.valid ? 'opacity: 0.6' : ''"
      >
        <span v-if="token.kind !== 'text'" class="text-caption text-medium-emphasis mr-1">
          {{ TOKEN_LABELS[token.kind] }}:
        </span>
        <strong>{{ token.value }}</strong>
        <v-tooltip activator="parent" location="top">
          <template v-if="!token.valid">Invalid {{ TOKEN_LABELS[token.kind] }} value</template>
          <template v-else-if="NOOP_KINDS.has(token.kind)">{{ TOKEN_LABELS[token.kind] }} filter — coming soon</template>
          <template v-else>{{ TOKEN_LABELS[token.kind] }}</template>
        </v-tooltip>
      </v-chip>
    </div>

    <!-- ── Syntax help (basic only) ──────────────────────────────────────── -->
    <v-expand-transition>
      <v-card v-if="searchMode === 'basic' && showHelp" variant="tonal" class="mb-4" color="surface-variant">
        <v-card-title class="text-body-2 font-weight-medium pt-3 pb-1 px-4">
          <v-icon icon="mdi-help-circle-outline" size="16" class="mr-1" />
          Search syntax
        </v-card-title>
        <v-card-text class="pa-0">
          <v-table density="compact" class="bg-transparent">
            <thead>
              <tr>
                <th class="text-left text-caption" style="width: 180px;">Example</th>
                <th class="text-left text-caption">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in SYNTAX_ROWS" :key="row.example">
                <td>
                  <code
                    class="text-primary font-weight-medium"
                    style="font-family: monospace; font-size: 0.85em;"
                  >{{ row.example }}</code>
                </td>
                <td class="text-body-2 text-medium-emphasis">{{ row.description }}</td>
              </tr>
            </tbody>
          </v-table>
          <div class="px-4 pb-3 pt-2">
            <span class="text-caption text-medium-emphasis">
              Combine multiple filters with spaces — all must match.
            </span>
          </div>
        </v-card-text>
      </v-card>
    </v-expand-transition>

    <!-- ══ BASIC RESULTS ══════════════════════════════════════════════════════ -->
    <template v-if="searchMode === 'basic'">

      <div v-if="loading" class="d-flex justify-center py-10">
        <v-progress-circular indeterminate color="primary" size="32" />
      </div>

      <v-alert v-else-if="error" type="error" variant="tonal" class="mb-4" :text="error" />

      <template v-else-if="!searchQuery?.trim()">
        <div class="text-center py-10 text-medium-emphasis">
          <v-icon icon="mdi-book-alphabet" size="48" class="mb-3 text-disabled" />
          <div class="text-body-1 mb-4">Enter a query above to look up entries.</div>
          <div class="text-caption mb-3">Try one of these examples:</div>
          <div class="d-flex flex-wrap justify-center ga-2">
            <v-chip
              v-for="ex in EXAMPLE_SEARCHES"
              :key="ex"
              size="small"
              variant="outlined"
              class="font-weight-medium"
              style="cursor: pointer; font-family: monospace;"
              @click="fillExample(ex)"
            >{{ ex }}</v-chip>
          </div>
        </div>
      </template>

      <template v-else-if="onlyNoopFilters">
        <div class="text-center py-10 text-medium-emphasis">
          <v-icon icon="mdi-clock-outline" size="48" class="mb-3 text-disabled" />
          <div class="text-body-1">These filters aren't available yet.</div>
          <div class="text-caption mt-2">Stroke count, radical, and component search are coming soon.</div>
        </div>
      </template>

      <template v-else-if="searched && results.length === 0">
        <div class="text-center py-10 text-medium-emphasis">
          <v-icon icon="mdi-magnify-remove-outline" size="48" class="mb-3 text-disabled" />
          <div class="text-body-1">No entries match your query.</div>
          <div class="text-caption mt-2">
            Check your spelling or
            <v-btn variant="text" size="small" density="compact" @click="showHelp = true">
              review the syntax guide.
            </v-btn>
          </div>
        </div>
      </template>

      <template v-else-if="results.length > 0">
        <div class="text-caption text-medium-emphasis mb-3 pl-1">
          {{ results.length }} {{ results.length === 1 ? 'entry' : 'entries' }}
        </div>
        <v-list lines="two" class="pa-0" bg-color="transparent">
          <v-list-item
            v-for="entry in results"
            :key="entry.id"
            :ripple="false"
            rounded="lg"
            class="mb-2 entry-item"
            border
          >
            <template #prepend>
              <DictHeadword :traditional="entry.traditional" :simplified="entry.simplified" v-slot="{ primary, secondary, swap }">
                <div class="d-flex flex-column align-center mr-4" style="min-width: 56px;">
                  <span class="text-h4 font-weight-light dict-primary" style="line-height: 1;" @click="swap">{{ primary }}</span>
                  <span v-if="secondary" class="text-caption text-medium-emphasis mt-1" style="font-size: 0.7rem;">{{ secondary }}</span>
                </div>
              </DictHeadword>
            </template>
            <v-list-item-title class="d-flex align-baseline ga-2 mb-1">
              <span class="text-body-1 font-weight-medium" style="letter-spacing: 0.02em;">
                {{ pinyinToMarked(entry.pinyin) }}
              </span>
            </v-list-item-title>
            <v-list-item-subtitle class="text-body-2" style="opacity: 1;">
              <span v-for="(def, di) in entry.definitions" :key="di">
                <span class="text-medium-emphasis mr-1" style="font-size: 0.7rem;">{{ di + 1 }}.</span>{{ def
                }}<span v-if="di < entry.definitions.length - 1" class="mx-2 text-disabled">·</span>
              </span>
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </template>

    </template>

    <!-- ══ ADVANCED RESULTS ════════════════════════════════════════════════════ -->
    <template v-else>

      <div v-if="segLoading" class="d-flex justify-center py-10">
        <v-progress-circular indeterminate color="primary" size="32" />
      </div>

      <v-alert v-else-if="segError" type="error" variant="tonal" class="mb-4" :text="segError" />

      <template v-else-if="!searchQuery?.trim()">
        <div class="text-center py-10 text-medium-emphasis">
          <v-icon icon="mdi-book-search-outline" size="48" class="mb-3 text-disabled" />
          <div class="text-body-1 mb-2">Enter a Chinese phrase to parse it into dictionary entries.</div>
          <div class="text-caption text-disabled">
            Finds the best way to segment your input as a sequence of words.
          </div>
        </div>
      </template>

      <template v-else-if="segSearched && segmentations.length === 0">
        <div class="text-center py-10 text-medium-emphasis">
          <v-icon icon="mdi-magnify-remove-outline" size="48" class="mb-3 text-disabled" />
          <div class="text-body-1">Could not segment this text.</div>
          <div class="text-caption mt-2">
            Check that the input contains valid Chinese characters,
            or try
            <v-btn variant="text" size="small" density="compact" @click="searchMode = 'basic'">
              Basic search.
            </v-btn>
          </div>
        </div>
      </template>

      <template v-else-if="segmentations.length > 0">
        <div class="text-caption text-medium-emphasis mb-3 pl-1">
          {{ segmentations.length }} {{ segmentations.length === 1 ? 'segmentation' : 'segmentations' }}
        </div>

        <v-card
          v-for="(seg, si) in segmentations"
          :key="si"
          variant="outlined"
          class="mb-3"
        >
          <v-card-text class="pb-3">
            <div class="text-caption text-medium-emphasis mb-3">
              {{ si === 0 ? 'Best match' : `Alternative ${si}` }}
            </div>

            <!-- Segment tiles -->
            <div class="d-flex align-start flex-wrap ga-3">
              <template v-for="(segment, ti) in seg.segments" :key="ti">
                <!-- Arrow between segments -->
                <v-icon
                  v-if="ti > 0"
                  icon="mdi-arrow-right"
                  size="18"
                  class="text-disabled mt-3"
                />

                <!-- Tile: one column per entry (homographs stack horizontally) -->
                <div class="d-flex ga-2">
                  <div
                    v-for="entry in segment.entries"
                    :key="entry.id"
                    class="segment-tile text-center"
                  >
                    <!-- Characters -->
                    <DictHeadword :traditional="entry.traditional" :simplified="entry.simplified" v-slot="{ primary, secondary, swap }">
                      <div class="text-h5 font-weight-light dict-primary" style="line-height: 1.1;" @click="swap">{{ primary }}</div>
                      <div v-if="secondary" class="text-disabled mb-1" style="font-size: 0.65rem;">{{ secondary }}</div>
                    </DictHeadword>
                    <!-- Pinyin -->
                    <div class="text-caption text-primary font-weight-medium mb-1">
                      {{ pinyinToMarked(entry.pinyin) }}
                    </div>
                    <!-- First definition -->
                    <div
                      class="text-caption text-medium-emphasis"
                      style="max-width: 110px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"
                    >
                      {{ entry.definitions[0] }}
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </v-card-text>
        </v-card>
      </template>

    </template>
  </div>
  </div>
</template>

<style scoped>
.dict-primary {
  cursor: pointer;
  user-select: none;
}

.segment-tile {
  min-width: 60px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.entry-item {
  transition: background-color 0.15s;
}
.entry-item:hover {
  background-color: rgba(var(--v-theme-on-surface), 0.04);
}
code {
  background: rgba(var(--v-theme-primary), 0.08);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>

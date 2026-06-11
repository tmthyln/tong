<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useUser } from '@/composables/useUser'

const { userType } = useUser()
const canRun = computed(() => userType.value !== 'public')

const PRICE_PER_M_INPUT_USD = 0.6
const PRICE_PER_M_OUTPUT_USD = 2.5

interface Entity {
  nodeType: string
  text: string
  startIndex: number
  endIndex: number
}

interface NodeTypeRun {
  nodeType: string
  entities: Entity[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason: string | null
  latencyMs: number
  rawContent: string | null
}

interface ModeResult {
  mode: 'thinking' | 'instant'
  runs: NodeTypeRun[]
  totalEntities: number
  dedupedEntities: number
  totalLatencyMs: number
  totalPromptTokens: number
  totalCompletionTokens: number
  nullContentCount: number
  lengthFinishCount: number
}

interface ChunkResult {
  chunkId: number
  content: string
  thinking: ModeResult
  instant: ModeResult
}

interface EvalMeta {
  model: string
  chunkCount: number
  nodeTypeCount: number
  maxCompletionTokens: { thinking: number; instant: number }
}

const count = ref(8)
const maxTokThinking = ref(8192)
const maxTokInstant = ref(1024)
const minChunkLength = ref(100)

const running = ref(false)
const error = ref<string | null>(null)
const meta = ref<EvalMeta | null>(null)
const results = ref<ChunkResult[]>([])
let abortController: AbortController | null = null

const progressPct = computed(() => {
  if (!meta.value) return 0
  return (results.value.length / meta.value.chunkCount) * 100
})

function aggregate(mode: 'instant' | 'thinking') {
  if (results.value.length === 0) return null
  const all = results.value.map(r => r[mode])
  const totalCalls = all.reduce((s, m) => s + m.runs.length, 0)
  const totalPrompt = all.reduce((s, m) => s + m.totalPromptTokens, 0)
  const totalCompletion = all.reduce((s, m) => s + m.totalCompletionTokens, 0)
  return {
    avgEntitiesPerChunk: all.reduce((s, m) => s + m.dedupedEntities, 0) / results.value.length,
    avgLatencyPerCallMs: all.reduce((s, m) => s + m.totalLatencyMs, 0) / Math.max(1, totalCalls),
    totalLatencyMs: all.reduce((s, m) => s + m.totalLatencyMs, 0),
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    nullContentRate: all.reduce((s, m) => s + m.nullContentCount, 0) / Math.max(1, totalCalls),
    lengthFinishRate: all.reduce((s, m) => s + m.lengthFinishCount, 0) / Math.max(1, totalCalls),
    costUsd: (totalPrompt / 1_000_000) * PRICE_PER_M_INPUT_USD
      + (totalCompletion / 1_000_000) * PRICE_PER_M_OUTPUT_USD,
  }
}

const instantAgg = computed(() => aggregate('instant'))
const thinkingAgg = computed(() => aggregate('thinking'))

function entityKey(e: Entity) {
  return `${e.nodeType}::${e.text}@${e.startIndex}`
}

function diffEntities(a: Entity[], b: Entity[]) {
  const aKeys = new Set(a.map(entityKey))
  const bKeys = new Set(b.map(entityKey))
  return {
    onlyInstant: a.filter(e => !bKeys.has(entityKey(e))),
    onlyThinking: b.filter(e => !aKeys.has(entityKey(e))),
  }
}

function perTypeRows(chunk: ChunkResult) {
  const byType = new Map<string, { instant?: NodeTypeRun; thinking?: NodeTypeRun }>()
  for (const r of chunk.instant.runs) byType.set(r.nodeType, { instant: r })
  for (const r of chunk.thinking.runs) {
    const entry = byType.get(r.nodeType) ?? {}
    entry.thinking = r
    byType.set(r.nodeType, entry)
  }
  return Array.from(byType, ([nodeType, runs]) => {
    const iEnts = runs.instant?.entities ?? []
    const tEnts = runs.thinking?.entities ?? []
    const diff = diffEntities(iEnts, tEnts)
    return {
      nodeType,
      instant: runs.instant,
      thinking: runs.thinking,
      instantEntities: iEnts,
      thinkingEntities: tEnts,
      onlyInstant: diff.onlyInstant,
      onlyThinking: diff.onlyThinking,
    }
  })
}

async function run() {
  if (running.value) return
  running.value = true
  error.value = null
  meta.value = null
  results.value = []
  abortController = new AbortController()
  try {
    // Step 1: sample chunks + load node types.
    const initRes = await fetch('/api/dev/eval/entity-extraction/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: count.value,
        minChunkLength: minChunkLength.value,
      }),
      signal: abortController.signal,
    })
    if (!initRes.ok) throw new Error(`init: HTTP ${initRes.status}: ${await initRes.text().catch(() => '')}`)
    const init = await initRes.json() as {
      model: string
      chunks: Array<{ id: number; content: string }>
      nodeTypes: Array<{ name: string; definition: string; examples: string[] }>
    }
    meta.value = {
      model: init.model,
      chunkCount: init.chunks.length,
      nodeTypeCount: init.nodeTypes.length,
      maxCompletionTokens: { thinking: maxTokThinking.value, instant: maxTokInstant.value },
    }

    // Step 2: run each chunk in a separate HTTP request, sequentially.
    for (const chunk of init.chunks) {
      if (abortController.signal.aborted) break
      const res = await fetch('/api/dev/eval/entity-extraction/chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunkId: chunk.id,
          content: chunk.content,
          nodeTypes: init.nodeTypes,
          maxCompletionTokensThinking: maxTokThinking.value,
          maxCompletionTokensInstant: maxTokInstant.value,
        }),
        signal: abortController.signal,
      })
      if (!res.ok) throw new Error(`chunk ${chunk.id}: HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      const data = await res.json() as ChunkResult
      results.value = [...results.value, data]
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      error.value = 'Cancelled'
    } else {
      error.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    running.value = false
    abortController = null
  }
}

function cancel() {
  abortController?.abort()
}

onUnmounted(() => {
  abortController?.abort()
})

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`
}
function fmtNum(n: number, dp = 0) {
  return n.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp })
}
</script>

<template>
  <div>
    <p class="text-body-2 text-medium-emphasis mb-4">Entity extraction: Kimi K2.6 thinking vs instant</p>

    <v-alert v-if="!canRun" type="info" variant="tonal" class="mb-4">
      Sign in to run evaluations.
    </v-alert>

    <v-card class="mb-4" variant="outlined">
      <v-card-text>
        <div class="d-flex flex-wrap ga-4 align-end">
          <v-text-field
            v-model.number="count"
            type="number"
            label="Chunks"
            density="compact"
            hide-details
            style="max-width: 120px"
            :disabled="running || !canRun"
          />
          <v-text-field
            v-model.number="maxTokThinking"
            type="number"
            label="Max tokens (thinking)"
            density="compact"
            hide-details
            style="max-width: 180px"
            :disabled="running || !canRun"
          />
          <v-text-field
            v-model.number="maxTokInstant"
            type="number"
            label="Max tokens (instant)"
            density="compact"
            hide-details
            style="max-width: 180px"
            :disabled="running || !canRun"
          />
          <v-text-field
            v-model.number="minChunkLength"
            type="number"
            label="Min chunk length"
            density="compact"
            hide-details
            style="max-width: 160px"
            :disabled="running || !canRun"
          />
          <v-btn
            v-if="!running"
            color="primary"
            prepend-icon="mdi-play"
            :disabled="!canRun"
            @click="run"
          >
            Run evaluation
          </v-btn>
          <v-btn v-else color="error" prepend-icon="mdi-stop" @click="cancel">
            Cancel
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-card v-if="running || meta" class="mb-4" variant="outlined">
      <v-card-text>
        <v-progress-linear
          :model-value="progressPct"
          :indeterminate="!meta"
          color="primary"
          height="8"
          rounded
        />
        <div class="text-caption text-medium-emphasis mt-2">
          <template v-if="meta">
            Chunk {{ results.length }} of {{ meta.chunkCount }} · {{ meta.nodeTypeCount }} node types ·
            {{ meta.model }} · tokens: thinking={{ meta.maxCompletionTokens.thinking }}, instant={{ meta.maxCompletionTokens.instant }}
          </template>
          <template v-else>
            Starting…
          </template>
        </div>
      </v-card-text>
    </v-card>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" closable @click:close="error = null">
      {{ error }}
    </v-alert>

    <v-card v-if="instantAgg && thinkingAgg" class="mb-4" variant="outlined">
      <v-card-title class="text-h6">Aggregate</v-card-title>
      <v-card-text>
        <v-table density="compact">
          <thead>
            <tr>
              <th>Metric</th>
              <th class="text-right">Instant</th>
              <th class="text-right">Thinking</th>
              <th class="text-right">Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Avg deduped entities / chunk</td>
              <td class="text-right">{{ fmtNum(instantAgg.avgEntitiesPerChunk, 2) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.avgEntitiesPerChunk, 2) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.avgEntitiesPerChunk - instantAgg.avgEntitiesPerChunk, 2) }}</td>
            </tr>
            <tr>
              <td>Avg latency / call (ms)</td>
              <td class="text-right">{{ fmtNum(instantAgg.avgLatencyPerCallMs) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.avgLatencyPerCallMs) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.avgLatencyPerCallMs - instantAgg.avgLatencyPerCallMs) }}</td>
            </tr>
            <tr>
              <td>Total prompt tokens</td>
              <td class="text-right">{{ fmtNum(instantAgg.totalPromptTokens) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.totalPromptTokens) }}</td>
              <td class="text-right">—</td>
            </tr>
            <tr>
              <td>Total completion tokens</td>
              <td class="text-right">{{ fmtNum(instantAgg.totalCompletionTokens) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.totalCompletionTokens) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.totalCompletionTokens / Math.max(1, instantAgg.totalCompletionTokens), 1) }}x</td>
            </tr>
            <tr>
              <td>Null-content rate</td>
              <td class="text-right">{{ fmtPct(instantAgg.nullContentRate) }}</td>
              <td class="text-right">{{ fmtPct(thinkingAgg.nullContentRate) }}</td>
              <td class="text-right">—</td>
            </tr>
            <tr>
              <td>Length-finish rate</td>
              <td class="text-right">{{ fmtPct(instantAgg.lengthFinishRate) }}</td>
              <td class="text-right">{{ fmtPct(thinkingAgg.lengthFinishRate) }}</td>
              <td class="text-right">—</td>
            </tr>
            <tr>
              <td>Est. cost (USD)</td>
              <td class="text-right">${{ instantAgg.costUsd.toFixed(4) }}</td>
              <td class="text-right">${{ thinkingAgg.costUsd.toFixed(4) }}</td>
              <td class="text-right">{{ fmtNum(thinkingAgg.costUsd / Math.max(0.0001, instantAgg.costUsd), 1) }}x</td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <v-expansion-panels v-if="results.length > 0" variant="accordion">
      <v-expansion-panel v-for="chunk in results" :key="chunk.chunkId">
        <v-expansion-panel-title>
          <div class="d-flex align-center ga-3 flex-grow-1">
            <span class="font-weight-medium">Chunk #{{ chunk.chunkId }}</span>
            <v-chip size="small" variant="tonal" color="primary">
              instant: {{ chunk.instant.dedupedEntities }}
            </v-chip>
            <v-chip size="small" variant="tonal" color="secondary">
              thinking: {{ chunk.thinking.dedupedEntities }}
            </v-chip>
            <v-chip
              v-if="chunk.thinking.dedupedEntities !== chunk.instant.dedupedEntities"
              size="small"
              variant="outlined"
              :color="chunk.thinking.dedupedEntities > chunk.instant.dedupedEntities ? 'success' : 'warning'"
            >
              Δ {{ chunk.thinking.dedupedEntities - chunk.instant.dedupedEntities }}
            </v-chip>
            <v-chip
              v-if="chunk.thinking.lengthFinishCount > 0"
              size="small"
              color="error"
              variant="tonal"
            >
              {{ chunk.thinking.lengthFinishCount }} length-finish
            </v-chip>
          </div>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <v-alert
            v-if="chunk.thinking.nullContentCount > 0 || chunk.thinking.lengthFinishCount > 0"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            Thinking mode: {{ chunk.thinking.nullContentCount }} null-content runs, {{ chunk.thinking.lengthFinishCount }} length-finish runs.
          </v-alert>

          <v-card variant="tonal" class="mb-3">
            <v-card-text class="chunk-content">{{ chunk.content }}</v-card-text>
          </v-card>

          <v-table density="compact" class="per-type-table">
            <thead>
              <tr>
                <th>Node type</th>
                <th>Instant</th>
                <th>Thinking</th>
                <th>Only-instant</th>
                <th>Only-thinking</th>
                <th class="text-right">Latency i/t (ms)</th>
                <th class="text-right">Out tokens i/t</th>
                <th>Finish i/t</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in perTypeRows(chunk)" :key="row.nodeType">
                <td class="font-weight-medium">{{ row.nodeType }}</td>
                <td>
                  <span v-if="row.instantEntities.length === 0" class="text-medium-emphasis">—</span>
                  <v-chip
                    v-for="(e, idx) in row.instantEntities"
                    :key="`i-${idx}`"
                    size="x-small"
                    variant="flat"
                    class="ma-1"
                  >
                    {{ e.text }}
                  </v-chip>
                </td>
                <td>
                  <span v-if="row.thinkingEntities.length === 0" class="text-medium-emphasis">—</span>
                  <v-chip
                    v-for="(e, idx) in row.thinkingEntities"
                    :key="`t-${idx}`"
                    size="x-small"
                    variant="flat"
                    class="ma-1"
                  >
                    {{ e.text }}
                  </v-chip>
                </td>
                <td>
                  <v-chip
                    v-for="(e, idx) in row.onlyInstant"
                    :key="`oi-${idx}`"
                    size="x-small"
                    color="warning"
                    variant="tonal"
                    class="ma-1"
                  >
                    {{ e.text }}
                  </v-chip>
                </td>
                <td>
                  <v-chip
                    v-for="(e, idx) in row.onlyThinking"
                    :key="`ot-${idx}`"
                    size="x-small"
                    color="success"
                    variant="tonal"
                    class="ma-1"
                  >
                    {{ e.text }}
                  </v-chip>
                </td>
                <td class="text-right text-mono">
                  {{ row.instant?.latencyMs ?? '—' }} / {{ row.thinking?.latencyMs ?? '—' }}
                </td>
                <td class="text-right text-mono">
                  {{ row.instant?.usage.completionTokens ?? '—' }} / {{ row.thinking?.usage.completionTokens ?? '—' }}
                </td>
                <td class="text-mono text-caption">
                  {{ row.instant?.finishReason ?? '—' }} / {{ row.thinking?.finishReason ?? '—' }}
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<style scoped>
.chunk-content {
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  max-height: 240px;
  overflow-y: auto;
}
.per-type-table :deep(th),
.per-type-table :deep(td) {
  vertical-align: top;
}
.text-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>

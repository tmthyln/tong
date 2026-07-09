<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import * as d3 from 'd3'
import { visibleLayerIndex, ZOOM_EXTENT, type TopicLabel, type TopicLayers } from '@/composables/topicLayers'

const router = useRouter()

interface ChunkPoint {
  id: string
  documentId: number
  x: number
  y: number
}

interface DocPoint {
  id: number
  title: string | null
  filename: string
  x: number
  y: number
}

const svgRef = ref<SVGSVGElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const tooltip = ref({
  visible: false,
  x: 0,
  y: 0,
  title: '',
  filename: '',
})

const CHUNK_COLOR = '#90CAF9'
const DOC_COLOR = '#EF9A9A'

const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 100
let pollTimer: number | null = null

onUnmounted(() => {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
})

function showTooltip(event: MouseEvent, title: string, subtitle: string) {
  tooltip.value = { visible: true, x: event.clientX + 12, y: event.clientY - 8, title, filename: subtitle }
}

function moveTooltip(event: MouseEvent) {
  tooltip.value.x = event.clientX + 12
  tooltip.value.y = event.clientY - 8
}

function hideTooltip() {
  tooltip.value.visible = false
}

onMounted(async () => {
  try {
    const res = await fetch('/api/library/visualization')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      chunks: ChunkPoint[]
      documents: DocPoint[]
      topicsKey: string | null
    }

    loading.value = false
    await nextTick()

    if (!data.chunks.length && !data.documents.length) return

    const svg = d3.select(svgRef.value!)
    const width = svgRef.value!.clientWidth
    const height = svgRef.value!.clientHeight

    const allX = [...data.chunks.map((p) => p.x), ...data.documents.map((p) => p.x)]
    const allY = [...data.chunks.map((p) => p.y), ...data.documents.map((p) => p.y)]

    const xScale = d3
      .scaleLinear()
      .domain([d3.min(allX)!, d3.max(allX)!])
      .range([40, width - 40])

    const yScale = d3
      .scaleLinear()
      .domain([d3.min(allY)!, d3.max(allY)!])
      .range([40, height - 40])

    const g = svg.append('g')

    // --- Hierarchical topic labels (issue #4) ---
    const labelRoot = g.append('g').attr('class', 'topic-labels').style('pointer-events', 'none')
    let topicLayerGroups: d3.Selection<SVGGElement, unknown, null, undefined>[] = []
    let labelSelection: d3.Selection<SVGTextElement, TopicLabel, SVGGElement, unknown> | null = null
    let currentZoomK = 1
    let lastVisibleLayer = -2
    let lastAppliedK = -1

    function fadeLayer(layerIndex: number, visible: boolean) {
      topicLayerGroups[layerIndex]
        ?.transition()
        .duration(250)
        .attr('opacity', visible ? 1 : 0)
        .style('pointer-events', visible ? 'auto' : 'none')
    }

    function updateTopicVisibility(k: number) {
      if (!topicLayerGroups.length) return
      const idx = visibleLayerIndex(k, topicLayerGroups.length)
      if (idx !== lastVisibleLayer) {
        // Only the outgoing and incoming layers need a transition.
        if (lastVisibleLayer >= 0) fadeLayer(lastVisibleLayer, false)
        fadeLayer(idx, true)
        lastVisibleLayer = idx
      }
      // Counter-scale so label text keeps a constant on-screen size. Pure pans
      // keep k unchanged, so skip the O(labels) attribute writes then.
      if (k !== lastAppliedK && labelSelection) {
        lastAppliedK = k
        labelSelection.attr('transform', (d) => `translate(${xScale(d.x)},${yScale(d.y)}) scale(${1 / k})`)
      }
    }

    function renderTopicLayers(layers: TopicLayers) {
      labelRoot.raise()
      labelRoot.selectAll('*').remove()
      topicLayerGroups = layers.map((layer, layerIndex) => {
        const group = labelRoot
          .append('g')
          .attr('opacity', 0)
          .style('pointer-events', 'none')
        group
          .selectAll('text.topic-label')
          .data(layer)
          .enter()
          .append('text')
          .attr('class', 'topic-label')
          .attr('text-anchor', 'middle')
          .attr('font-size', Math.max(12, 20 - layerIndex * 3))
          .attr('transform', (d) => `translate(${xScale(d.x)},${yScale(d.y)}) scale(${1 / currentZoomK})`)
          .text((d) => d.label_zh)
          .on('mouseenter', (event: MouseEvent, d: TopicLabel) => showTooltip(event, d.label_en || d.label_zh, d.label_zh))
          .on('mousemove', moveTooltip)
          .on('mouseleave', hideTooltip)
        return group
      })
      labelSelection = labelRoot.selectAll<SVGTextElement, TopicLabel>('text.topic-label')
      lastVisibleLayer = -2
      lastAppliedK = -1
      updateTopicVisibility(currentZoomK)
    }

    async function pollTopics(key: string, attempt = 0) {
      if (attempt >= MAX_POLL_ATTEMPTS) return
      try {
        const res = await fetch(`/api/library/visualization/topics?key=${key}`)
        if (res.ok) {
          const body = (await res.json()) as { status: string; layers?: TopicLayers }
          if (body.status === 'ready') {
            if (body.layers?.length) renderTopicLayers(body.layers)
            return
          }
          if (body.status === 'error') return
        }
      } catch {
        // transient network failure: keep polling
      }
      pollTimer = window.setTimeout(() => pollTopics(key, attempt + 1), POLL_INTERVAL_MS)
    }

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent(ZOOM_EXTENT)
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
        currentZoomK = event.transform.k
        updateTopicVisibility(currentZoomK)
      })

    svg.call(zoom)

    // Chunk dots
    const chunkDots = g
      .selectAll('circle.chunk')
      .data(data.chunks)
      .enter()
      .append('circle')
      .attr('class', 'chunk')
      .attr('cx', (d) => xScale(d.x))
      .attr('cy', (d) => yScale(d.y))
      .attr('r', 3)
      .attr('fill', CHUNK_COLOR)
      .attr('opacity', 0.6)
      .style('pointer-events', 'none')

    // Document dots
    g.selectAll('circle.doc')
      .data(data.documents)
      .enter()
      .append('circle')
      .attr('class', 'doc')
      .attr('cx', (d) => xScale(d.x))
      .attr('cy', (d) => yScale(d.y))
      .attr('r', 9)
      .attr('fill', DOC_COLOR)
      .attr('stroke', '#000')
      .attr('stroke-width', 1.5)
      .attr('opacity', 1)
      .style('cursor', 'pointer')
      .on('mouseenter', function (event: MouseEvent, d: DocPoint) {
        // Dim non-matching chunks, highlight matching
        chunkDots
          .attr('opacity', (c) => (c.documentId === d.id ? 0.85 : 0.1))
        showTooltip(event, d.title ?? d.filename, d.filename)
      })
      .on('mousemove', moveTooltip)
      .on('mouseleave', function () {
        chunkDots.attr('opacity', 0.6)
        hideTooltip()
      })
      .on('click', (_event: MouseEvent, d: DocPoint) => {
        router.push(`/document/${d.id}`)
      })

    if (data.topicsKey) pollTopics(data.topicsKey)
  } catch (e) {
    loading.value = false
    error.value = e instanceof Error ? e.message : 'Failed to load visualization'
  }
})
</script>

<template>
  <div class="viz-root">
    <svg ref="svgRef" v-show="!loading && !error" class="viz-svg" />

    <div v-if="loading" class="viz-center text-center">
      <v-progress-circular indeterminate />
      <p class="text-body-2 text-medium-emphasis mt-4 mb-1">
        Building the document map
      </p>
      <p class="text-caption text-medium-emphasis viz-loading-detail">
        Fetching embeddings for your documents and semantically visualizing them
        so similar documents appear near each other. This can take a moment.
      </p>
    </div>

    <v-alert v-if="error" type="error" class="viz-alert">
      {{ error }}
    </v-alert>

    <h1 class="text-h4 viz-heading">Documents</h1>

    <p v-if="!loading && !error" class="text-caption text-medium-emphasis viz-hint">
      Scroll to zoom · Drag to pan · Click a document dot to open it
    </p>

    <div
      v-if="tooltip.visible"
      class="viz-tooltip"
      :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
    >
      <div class="font-weight-medium">{{ tooltip.title }}</div>
      <div v-if="tooltip.title !== tooltip.filename" class="text-caption text-medium-emphasis">
        {{ tooltip.filename }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.viz-root {
  position: relative;
  width: 100%;
  height: calc(100vh - var(--v-layout-top, 64px));
  overflow: hidden;
}

.viz-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.viz-svg :deep(.topic-label) {
  font-weight: 600;
  fill: rgb(var(--v-theme-on-surface));
  paint-order: stroke;
  stroke: rgb(var(--v-theme-surface));
  stroke-width: 4px;
  stroke-linejoin: round;
  cursor: default;
}

.viz-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.viz-loading-detail {
  max-width: 340px;
}

.viz-alert {
  position: absolute;
  top: 60px;
  left: 16px;
  right: 16px;
  z-index: 2;
}

.viz-heading {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 2;
  pointer-events: none;
}

.viz-hint {
  position: absolute;
  bottom: 12px;
  left: 16px;
  z-index: 2;
  pointer-events: none;
}

.viz-tooltip {
  position: fixed;
  background: rgba(30, 30, 30, 0.9);
  color: #fff;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  pointer-events: none;
  z-index: 9999;
  max-width: 280px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import * as d3 from 'd3'

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

onMounted(async () => {
  try {
    const res = await fetch('/api/library/visualization')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { chunks: ChunkPoint[]; documents: DocPoint[] }

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

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 20])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
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

        tooltip.value = {
          visible: true,
          x: event.clientX + 12,
          y: event.clientY - 8,
          title: d.title ?? d.filename,
          filename: d.filename,
        }
      })
      .on('mousemove', function (event: MouseEvent) {
        tooltip.value.x = event.clientX + 12
        tooltip.value.y = event.clientY - 8
      })
      .on('mouseleave', function () {
        chunkDots.attr('opacity', 0.6)
        tooltip.value.visible = false
      })
      .on('click', (_event: MouseEvent, d: DocPoint) => {
        router.push(`/document/${d.id}`)
      })
  } catch (e) {
    loading.value = false
    error.value = e instanceof Error ? e.message : 'Failed to load visualization'
  }
})
</script>

<template>
  <div class="viz-root">
    <svg ref="svgRef" v-show="!loading && !error" class="viz-svg" />

    <v-progress-circular v-if="loading" indeterminate class="viz-center" />

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

.viz-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
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

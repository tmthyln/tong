<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import * as d3 from 'd3'

interface DocumentItem {
  id: number
  title: string | null
  original_doc_filename: string
}

interface GraphNode {
  id: number
  label: string | null
  entity_type: string
  preferred_translation: string | null
  // D3 simulation mutable fields
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

interface GraphLink {
  id: number
  source: number | GraphNode
  target: number | GraphNode
  edge_type: string
  explanation: string | null
}

const svgRef = ref<SVGSVGElement | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const documents = ref<DocumentItem[]>([])
const selectedDocId = ref<number | null>(null)
const isEmpty = ref(false)

const tooltip = ref({
  visible: false,
  x: 0,
  y: 0,
  lines: [] as string[],
})

onMounted(async () => {
  try {
    const res = await fetch('/api/library/document?limit=100')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { documents: DocumentItem[] }
    documents.value = data.documents
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load documents'
  }
})

watch(selectedDocId, async (docId) => {
  if (!docId) return
  error.value = null
  isEmpty.value = false
  loading.value = true

  try {
    const res = await fetch(`/api/knowledge/graph?documentId=${docId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { nodes: GraphNode[]; links: GraphLink[] }

    loading.value = false

    if (!data.nodes.length) {
      isEmpty.value = true
      clearGraph()
      return
    }

    await nextTick()
    renderGraph(data.nodes, data.links)
  } catch (e) {
    loading.value = false
    error.value = e instanceof Error ? e.message : 'Failed to load graph'
  }
})

function clearGraph() {
  if (!svgRef.value) return
  d3.select(svgRef.value).selectAll('g').remove()
}

function renderGraph(nodes: GraphNode[], links: GraphLink[]) {
  const svgEl = svgRef.value
  if (!svgEl) return

  const svg = d3.select(svgEl)
  svg.selectAll('g').remove()

  const width = svgEl.clientWidth
  const height = svgEl.clientHeight

  const g = svg.append('g')

  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => {
      g.attr('transform', event.transform)
    })

  svg.call(zoom)

  const colorScale = d3.scaleOrdinal(d3.schemeTableau10)

  const sim = d3
    .forceSimulation<GraphNode>(nodes)
    .force('link', d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(120))
    .force('charge', d3.forceManyBody<GraphNode>().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide<GraphNode>(30))

  // Links
  const linkSel = g
    .append('g')
    .selectAll<SVGLineElement, GraphLink>('line')
    .data(links)
    .enter()
    .append('line')
    .attr('stroke', '#aaa')
    .attr('stroke-opacity', 0.6)
    .attr('stroke-width', 1.5)
    .style('cursor', 'default')
    .on('mouseenter', function (event: MouseEvent, d: GraphLink) {
      const lines = [d.edge_type]
      if (d.explanation) lines.push(d.explanation)
      tooltip.value = { visible: true, x: event.clientX + 12, y: event.clientY - 8, lines }
    })
    .on('mousemove', function (event: MouseEvent) {
      tooltip.value.x = event.clientX + 12
      tooltip.value.y = event.clientY - 8
    })
    .on('mouseleave', function () {
      tooltip.value.visible = false
    })

  // Node group
  const nodeSel = g
    .append('g')
    .selectAll<SVGGElement, GraphNode>('g.node')
    .data(nodes)
    .enter()
    .append('g')
    .attr('class', 'node')
    .style('cursor', 'grab')

  nodeSel
    .append('circle')
    .attr('r', 12)
    .attr('fill', (d) => colorScale(d.entity_type))
    .attr('stroke', '#fff')
    .attr('stroke-width', 2)

  nodeSel
    .append('text')
    .attr('dy', '0.35em')
    .attr('text-anchor', 'middle')
    .attr('font-size', '11px')
    .attr('fill', '#333')
    .attr('y', 22)
    .attr('pointer-events', 'none')
    .text((d) => {
      const label = d.label ?? ''
      return label.length > 10 ? label.slice(0, 10) + '…' : label
    })

  nodeSel
    .on('mouseenter', function (event: MouseEvent, d: GraphNode) {
      const lines: string[] = [`[${d.entity_type}] ${d.label ?? ''}`]
      if (d.preferred_translation) lines.push(d.preferred_translation)
      tooltip.value = { visible: true, x: event.clientX + 12, y: event.clientY - 8, lines }
    })
    .on('mousemove', function (event: MouseEvent) {
      tooltip.value.x = event.clientX + 12
      tooltip.value.y = event.clientY - 8
    })
    .on('mouseleave', function () {
      tooltip.value.visible = false
    })
    .call(
      d3
        .drag<SVGGElement, GraphNode>()
        .on('start', function (event, d) {
          if (!event.active) sim.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
          d3.select(this).style('cursor', 'grabbing')
        })
        .on('drag', function (event, d) {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', function (event, d) {
          if (!event.active) sim.alphaTarget(0)
          d3.select(this).style('cursor', 'grab')
          // Keep node fixed where user dropped it
        })
    )

  sim.on('tick', () => {
    linkSel
      .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
      .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
      .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
      .attr('y2', (d) => (d.target as GraphNode).y ?? 0)

    nodeSel.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
  })
}
</script>

<template>
  <div class="kg-root">
    <svg ref="svgRef" v-show="!loading && !error && !isEmpty && selectedDocId" class="kg-svg" />

    <v-progress-circular v-if="loading" indeterminate class="kg-center" />

    <v-alert v-if="error" type="error" class="kg-alert">{{ error }}</v-alert>

    <h1 class="text-h4 kg-heading">Knowledge Graph</h1>

    <div class="kg-controls">
      <v-select
        v-model="selectedDocId"
        :items="documents.map(d => ({ ...d, _display: d.title ?? d.original_doc_filename }))"
        item-title="_display"
        item-value="id"
        label="Select document"
        density="compact"
        variant="outlined"
        hide-details
        style="width: 280px"
      />
    </div>

    <p v-if="isEmpty" class="text-body-2 text-medium-emphasis kg-center">
      No entities found for this document.
    </p>

    <p v-if="!loading && !error && !isEmpty && selectedDocId" class="text-caption text-medium-emphasis kg-hint">
      Scroll to zoom · Drag canvas to pan · Drag nodes to reposition
    </p>

    <div
      v-if="tooltip.visible"
      class="kg-tooltip"
      :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
    >
      <div v-for="(line, i) in tooltip.lines" :key="i" :class="i === 0 ? 'font-weight-medium' : 'text-caption text-medium-emphasis'">
        {{ line }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.kg-root {
  position: relative;
  width: 100%;
  height: calc(100vh - var(--v-layout-top, 64px));
  overflow: hidden;
}

.kg-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.kg-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.kg-alert {
  position: absolute;
  top: 60px;
  left: 16px;
  right: 16px;
  z-index: 2;
}

.kg-heading {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 2;
  pointer-events: none;
}

.kg-controls {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
}

.kg-hint {
  position: absolute;
  bottom: 12px;
  left: 16px;
  z-index: 2;
  pointer-events: none;
}

.kg-tooltip {
  position: fixed;
  background: rgba(30, 30, 30, 0.9);
  color: #fff;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  pointer-events: none;
  z-index: 9999;
  max-width: 320px;
}
</style>

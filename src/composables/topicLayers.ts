export interface TopicLabel {
  label_zh: string
  label_en: string
  x: number
  y: number
  size: number
}

export type TopicLayers = TopicLabel[][]

/** Shared zoom extent: d3's scaleExtent and the layer mapping must agree. */
export const ZOOM_EXTENT: [number, number] = [0.2, 20]

/**
 * Maps a d3 zoom scale k to the topic-hierarchy layer to display.
 * Layers are ordered coarse (0) -> fine (layerCount - 1); the zoom extent
 * [kMin, kMax] is split evenly in log space.
 */
export function visibleLayerIndex(
  k: number,
  layerCount: number,
  kMin = ZOOM_EXTENT[0],
  kMax = ZOOM_EXTENT[1]
): number {
  if (layerCount <= 0) return -1
  const clamped = Math.min(Math.max(k, kMin), kMax)
  const t = Math.log(clamped / kMin) / Math.log(kMax / kMin)
  return Math.min(layerCount - 1, Math.floor(t * layerCount))
}

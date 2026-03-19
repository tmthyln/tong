<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  traditional: string
  simplified: string
  /** When provided, the script that matches this text becomes primary. */
  queryText?: string
}>()

defineSlots<{
  default(props: { primary: string; secondary: string | null; swap: () => void }): unknown
}>()

function detectBaseScript(): 'traditional' | 'simplified' {
  if (props.queryText && props.queryText === props.simplified && props.queryText !== props.traditional) {
    return 'simplified'
  }
  return 'traditional'
}

const flipped = ref(false)
const baseScript = detectBaseScript()

const primaryScript = computed<'traditional' | 'simplified'>(() => {
  if (!flipped.value) return baseScript
  return baseScript === 'traditional' ? 'simplified' : 'traditional'
})

const primary = computed(() =>
  primaryScript.value === 'traditional' ? props.traditional : props.simplified
)

const secondary = computed<string | null>(() => {
  if (props.traditional === props.simplified) return null
  return primaryScript.value === 'traditional' ? props.simplified : props.traditional
})

function swap() {
  if (props.traditional !== props.simplified) flipped.value = !flipped.value
}
</script>

<template>
  <slot :primary="primary" :secondary="secondary" :swap="swap" />
</template>

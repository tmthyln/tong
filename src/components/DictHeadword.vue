<script setup lang="ts">
import { ref, computed } from 'vue'
import { usePreferences } from '../composables/usePreferences'

const props = defineProps<{
  traditional: string
  simplified: string
  /** When provided, the script that matches this text becomes primary. */
  queryText?: string
}>()

defineSlots<{
  default(props: { primary: string; secondary: string | null; swap: () => void }): unknown
}>()

const { script: preferredScript } = usePreferences()

const flipped = ref(false)

const baseScript = computed<'traditional' | 'simplified'>(() => {
  if (props.queryText && props.queryText === props.simplified && props.queryText !== props.traditional) return 'simplified'
  return preferredScript.value
})

const primaryScript = computed<'traditional' | 'simplified'>(() => {
  if (!flipped.value) return baseScript.value
  return baseScript.value === 'traditional' ? 'simplified' : 'traditional'
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

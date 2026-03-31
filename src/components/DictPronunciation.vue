<script setup lang="ts">
import { ref, computed } from 'vue'
import { usePreferences } from '../composables/usePreferences'
import { pinyinToFormat } from '../utils/pinyin'

const props = defineProps<{ pinyin: string }>()

defineSlots<{
  default(props: { text: string; all: string[]; cycle: () => void }): unknown
}>()

const { pronunciationPrimary, pronunciationSecondaries } = usePreferences()

const cycleIndex = ref(0)

const allFormats = computed(() => {
  const formats = [pronunciationPrimary.value, ...pronunciationSecondaries.value]
  return formats.map(f => pinyinToFormat(props.pinyin, f))
})

const text = computed(
  () => allFormats.value[cycleIndex.value % allFormats.value.length] ?? allFormats.value[0] ?? props.pinyin
)

function cycle() {
  cycleIndex.value = (cycleIndex.value + 1) % allFormats.value.length
}
</script>

<template>
  <slot :text="text" :all="allFormats" :cycle="cycle" />
</template>

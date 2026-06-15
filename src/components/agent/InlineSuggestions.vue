<script setup lang="ts">
import { computed } from 'vue'
import { useTranslationAgent } from '@/composables/useTranslationAgent'
import SuggestionCard from './SuggestionCard.vue'

// Renders the agent's high-priority (surface === 'inline') pending suggestions
// anchored to a specific chunk, shown inline in the reader next to that chunk.
const props = defineProps<{ chunkId: number }>()

const { state } = useTranslationAgent()

const inline = computed(() =>
  (state.value?.suggestions ?? []).filter(
    (s) => s.status === 'pending' && s.surface === 'inline' && s.chunkId === props.chunkId,
  ),
)
</script>

<template>
  <div v-if="inline.length" class="inline-suggestions">
    <SuggestionCard v-for="s in inline" :key="s.id" :suggestion="s" />
  </div>
</template>

<style scoped>
.inline-suggestions {
  margin: 8px 0;
}
</style>

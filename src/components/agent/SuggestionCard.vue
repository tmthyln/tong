<script setup lang="ts">
import { ref } from 'vue'
import { useTranslationAgent } from '@/composables/useTranslationAgent'
import type { Suggestion } from '@/types/agent'

const props = defineProps<{ suggestion: Suggestion }>()

const { resolveSuggestion } = useTranslationAgent()

const busy = ref(false)
// Editable copy for translation suggestions.
const editedTranslation = ref(
  props.suggestion.payload.kind === 'translation' ? props.suggestion.payload.translation : '',
)
const answer = ref('')

async function accept() {
  busy.value = true
  const payload =
    props.suggestion.payload.kind === 'translation' ? { translation: editedTranslation.value } : undefined
  await resolveSuggestion(props.suggestion.id, 'accept', payload)
  busy.value = false
}

async function dismiss() {
  busy.value = true
  await resolveSuggestion(props.suggestion.id, 'dismiss')
  busy.value = false
}

async function answerQuestion(text: string) {
  busy.value = true
  await resolveSuggestion(props.suggestion.id, 'answer', { answer: text })
  busy.value = false
}

const KIND_META: Record<Suggestion['kind'], { icon: string; label: string; color: string }> = {
  translation: { icon: 'mdi-translate', label: 'Translation', color: 'primary' },
  'entity-create': { icon: 'mdi-plus-circle-outline', label: 'New entity', color: 'success' },
  'entity-delete': { icon: 'mdi-delete-outline', label: 'Delete entity', color: 'error' },
  question: { icon: 'mdi-help-circle-outline', label: 'Question', color: 'info' },
}
</script>

<template>
  <v-card variant="tonal" :color="KIND_META[suggestion.kind].color" class="mb-2" density="compact">
    <v-card-text class="py-2">
      <div class="d-flex align-center ga-1 mb-1">
        <v-icon size="small">{{ KIND_META[suggestion.kind].icon }}</v-icon>
        <span class="text-caption font-weight-medium">{{ KIND_META[suggestion.kind].label }}</span>
        <v-spacer />
        <span v-if="suggestion.originBranchId" class="text-caption text-medium-emphasis">branch</span>
      </div>

      <!-- Translation -->
      <template v-if="suggestion.payload.kind === 'translation'">
        <div class="text-caption text-medium-emphasis mb-1">chunk {{ suggestion.payload.chunkId }}</div>
        <v-textarea
          v-model="editedTranslation"
          variant="outlined"
          density="compact"
          auto-grow
          rows="2"
          hide-details
        />
        <div v-if="suggestion.payload.rationale" class="text-caption text-medium-emphasis mt-1">
          {{ suggestion.payload.rationale }}
        </div>
      </template>

      <!-- Entity create -->
      <template v-else-if="suggestion.payload.kind === 'entity-create'">
        <div>
          Create <strong>{{ suggestion.payload.entityType }}</strong> entity
          “<strong>{{ suggestion.payload.text }}</strong>”
        </div>
        <div v-if="suggestion.payload.rationale" class="text-caption text-medium-emphasis mt-1">
          {{ suggestion.payload.rationale }}
        </div>
      </template>

      <!-- Entity delete -->
      <template v-else-if="suggestion.payload.kind === 'entity-delete'">
        <div>Delete entity <strong>{{ suggestion.payload.label ?? suggestion.payload.entityId }}</strong></div>
        <div v-if="suggestion.payload.rationale" class="text-caption text-medium-emphasis mt-1">
          {{ suggestion.payload.rationale }}
        </div>
      </template>

      <!-- Question -->
      <template v-else>
        <div class="mb-1">{{ suggestion.payload.question }}</div>
        <div v-if="suggestion.payload.options?.length" class="d-flex flex-wrap ga-1">
          <v-btn
            v-for="opt in suggestion.payload.options"
            :key="opt"
            size="x-small"
            variant="outlined"
            :disabled="busy"
            @click="answerQuestion(opt)"
          >{{ opt }}</v-btn>
        </div>
        <div v-else class="d-flex ga-1 mt-1">
          <v-text-field v-model="answer" density="compact" variant="outlined" hide-details placeholder="Your answer" />
          <v-btn size="small" :disabled="busy || !answer" @click="answerQuestion(answer)">Send</v-btn>
        </div>
      </template>
    </v-card-text>

    <v-card-actions v-if="suggestion.payload.kind !== 'question'" class="py-1">
      <v-spacer />
      <v-btn size="small" variant="text" :disabled="busy" @click="dismiss">Dismiss</v-btn>
      <v-btn size="small" variant="flat" :loading="busy" @click="accept">Accept</v-btn>
    </v-card-actions>
  </v-card>
</template>

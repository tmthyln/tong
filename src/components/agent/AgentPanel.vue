<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTranslationAgent } from '@/composables/useTranslationAgent'
import SuggestionCard from './SuggestionCard.vue'

const { state, connected, chat } = useTranslationAgent()

const open = ref(false)

const pending = computed(() => (state.value?.suggestions ?? []).filter((s) => s.status === 'pending'))
const activeBranches = computed(() =>
  (state.value?.branches ?? []).filter((b) => b.status === 'investigating' || b.status === 'open'),
)
const thinking = computed(() => state.value?.status === 'thinking')

const chatInput = ref('')
const chatReply = ref<string | null>(null)
const chatLoading = ref(false)

async function send() {
  const message = chatInput.value.trim()
  if (!message) return
  chatInput.value = ''
  chatLoading.value = true
  chatReply.value = await chat(message)
  chatLoading.value = false
}

const BRANCH_STATUS_COLOR: Record<string, string> = {
  open: 'grey',
  investigating: 'info',
  done: 'success',
  failed: 'error',
}
</script>

<template>
  <!-- Floating toggle: only when the agent is available -->
  <v-btn
    v-if="connected"
    class="agent-fab"
    icon
    color="primary"
    size="large"
    elevation="4"
    @click="open = !open"
  >
    <v-badge :model-value="pending.length > 0" :content="pending.length" color="error">
      <v-icon>mdi-robot-outline</v-icon>
    </v-badge>
  </v-btn>

  <v-navigation-drawer v-model="open" location="right" temporary width="380">
    <div class="d-flex align-center pa-3 ga-2">
      <v-icon>mdi-robot-outline</v-icon>
      <span class="text-subtitle-1 font-weight-medium">Translation agent</span>
      <v-spacer />
      <v-progress-circular v-if="thinking" indeterminate size="18" width="2" color="primary" />
      <v-btn icon="mdi-close" variant="text" size="small" @click="open = false" />
    </div>
    <v-divider />

    <div class="pa-3">
      <!-- Branch activity -->
      <div v-if="activeBranches.length" class="mb-3">
        <div class="text-caption text-medium-emphasis mb-1">Investigating</div>
        <div class="d-flex flex-wrap ga-1">
          <v-chip
            v-for="b in activeBranches"
            :key="b.id"
            size="x-small"
            :color="BRANCH_STATUS_COLOR[b.status]"
            variant="tonal"
          >
            {{ b.goal }}
          </v-chip>
        </div>
      </div>

      <!-- Suggestion inbox -->
      <div class="text-caption text-medium-emphasis mb-1">
        Suggestions <span v-if="pending.length">({{ pending.length }})</span>
      </div>
      <div v-if="pending.length === 0" class="text-caption text-disabled mb-3">
        Nothing pending. The agent watches as you read and translate.
      </div>
      <SuggestionCard v-for="s in pending" :key="s.id" :suggestion="s" />
    </div>

    <template #append>
      <v-divider />
      <div class="pa-3">
        <div v-if="chatReply" class="text-body-2 mb-2 agent-reply">{{ chatReply }}</div>
        <div class="d-flex ga-1">
          <v-text-field
            v-model="chatInput"
            density="compact"
            variant="outlined"
            hide-details
            placeholder="Ask the agent…"
            :disabled="chatLoading"
            @keyup.enter="send"
          />
          <v-btn icon="mdi-send" size="small" :loading="chatLoading" :disabled="!chatInput.trim()" @click="send" />
        </div>
      </div>
    </template>
  </v-navigation-drawer>
</template>

<style scoped>
.agent-fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1006;
}
.agent-reply {
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}
</style>

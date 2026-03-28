<script setup lang="ts">
import { ref } from 'vue'
import { usePreferences } from '../composables/usePreferences'
import { useUser } from '../composables/useUser'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const { userType } = useUser()
const { script, pronunciationPrimary, pronunciationSecondaries, theme, updatePreferences } = usePreferences()

const saveStatus = ref<'saving' | 'saved' | 'error' | null>(null)
let saveTimer: ReturnType<typeof setTimeout> | null = null

const PRONUNCIATION_OPTIONS = [
  { key: 'pinyin', label: 'Pinyin', example: 'shui3' },
  { key: 'marked-pinyin', label: 'Marked Pinyin', example: 'shuǐ' },
  { key: 'zhuyin', label: 'Zhuyin', example: 'ㄕㄨㄟˇ' },
  { key: 'wade-giles', label: 'Wade-Giles', example: 'shui³' },
]

async function save(patch: Parameters<typeof updatePreferences>[0]) {
  if (saveTimer) clearTimeout(saveTimer)
  saveStatus.value = 'saving'
  try {
    await updatePreferences(patch)
    saveStatus.value = 'saved'
  } catch {
    saveStatus.value = 'error'
  }
  saveTimer = setTimeout(() => { saveStatus.value = null }, 2000)
}

function onThemeChange(val: string) {
  save({ theme: val })
}

function onScriptChange(val: string) {
  save({ script: val as 'traditional' | 'simplified' })
}

function setPrimary(key: string) {
  const newSecondaries = pronunciationSecondaries.value.filter(k => k !== key)
  save({ pronunciationPrimary: key, pronunciationSecondaries: newSecondaries })
}

function toggleSecondary(key: string, checked: boolean) {
  const current = pronunciationSecondaries.value
  const newSecondaries = checked
    ? [...current.filter(k => k !== key), key]
    : current.filter(k => k !== key)
  save({ pronunciationSecondaries: newSecondaries })
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="420" @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center ga-2 pt-4 px-4">
        <span>Preferences</span>
        <v-chip
          v-if="saveStatus === 'saving'"
          size="small"
          color="primary"
          variant="tonal"
        >Saving…</v-chip>
        <v-chip
          v-else-if="saveStatus === 'saved'"
          size="small"
          color="success"
          variant="tonal"
        >Saved</v-chip>
        <v-chip
          v-else-if="saveStatus === 'error'"
          size="small"
          color="error"
          variant="tonal"
        >Error</v-chip>
      </v-card-title>

      <v-card-text class="px-4 pb-4">
        <v-alert
          v-if="userType === 'public'"
          type="info"
          density="compact"
          variant="tonal"
          class="mb-4"
        >Preferences are stored locally in your browser.</v-alert>

        <!-- Theme -->
        <div class="text-caption text-medium-emphasis mb-1">Theme</div>
        <v-btn-toggle
          :model-value="theme"
          mandatory
          density="compact"
          class="mb-4"
          @update:model-value="onThemeChange"
        >
          <v-btn value="light" prepend-icon="mdi-weather-sunny">Light</v-btn>
          <v-btn value="dark" prepend-icon="mdi-weather-night">Dark</v-btn>
        </v-btn-toggle>

        <v-divider class="mb-4" />

        <!-- Script -->
        <div class="text-caption text-medium-emphasis mb-1">Script</div>
        <v-btn-toggle
          :model-value="script"
          mandatory
          density="compact"
          class="mb-4"
          @update:model-value="onScriptChange"
        >
          <v-btn value="traditional">Traditional</v-btn>
          <v-btn value="simplified">Simplified</v-btn>
        </v-btn-toggle>

        <v-divider class="mb-2" />

        <!-- Pronunciation -->
        <div class="text-caption text-medium-emphasis mb-1">Pronunciation</div>
        <v-list density="compact" class="pa-0">
          <v-list-item
            v-for="opt in PRONUNCIATION_OPTIONS"
            :key="opt.key"
            class="px-0"
          >
            <template #prepend>
              <v-radio
                :model-value="pronunciationPrimary === opt.key"
                density="compact"
                hide-details
                @click="setPrimary(opt.key)"
              />
            </template>
            <template #default>
              <span class="text-body-2">{{ opt.label }}</span>
              <span class="text-caption text-medium-emphasis ml-2">{{ opt.example }}</span>
            </template>
            <template #append>
              <v-checkbox
                :model-value="pronunciationSecondaries.includes(opt.key)"
                :disabled="pronunciationPrimary === opt.key"
                density="compact"
                hide-details
                @update:model-value="toggleSecondary(opt.key, $event as boolean)"
              />
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

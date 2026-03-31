<script setup lang="ts">
import { ref } from 'vue'

// ── Types ─────────────────────────────────────────────────────────────────────

export type TemplateNode =
  | { type: 'op'; operator: string; children: Array<TemplateNode | null> }
  | { type: 'char'; character: string }
  | null

// ── Constants ──────────────────────────────────────────────────────────────────

const IDS_OPERATORS: Record<string, number> = {
  '⿰': 2, '⿱': 2, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2,
  '⿲': 3, '⿳': 3,
}

const CHILD_LABELS: Record<string, string[]> = {
  '⿰': ['Left', 'Right'],
  '⿱': ['Top', 'Bottom'],
  '⿲': ['Left', 'Middle', 'Right'],
  '⿳': ['Top', 'Middle', 'Bottom'],
  '⿴': ['Outer', 'Inner'],
  '⿵': ['Outer', 'Inner'],
  '⿶': ['Outer', 'Inner'],
  '⿷': ['Outer', 'Inner'],
  '⿸': ['Outer', 'Inner'],
  '⿹': ['Outer', 'Inner'],
  '⿺': ['Outer', 'Inner'],
  '⿻': ['Over', 'Under'],
}

const OPERATOR_TOOLTIPS: Record<string, string> = {
  '⿰': 'Left-right composition',
  '⿱': 'Top-bottom composition',
  '⿲': 'Left-middle-right composition',
  '⿳': 'Top-middle-bottom composition',
  '⿴': 'Surround (full)',
  '⿵': 'Surround (top open)',
  '⿶': 'Surround (bottom open)',
  '⿷': 'Surround (left open)',
  '⿸': 'Surround (top-left)',
  '⿹': 'Surround (top-right)',
  '⿺': 'Surround (bottom-left)',
  '⿻': 'Overlaid composition',
}

// ── Props / emits ──────────────────────────────────────────────────────────────

const props = defineProps<{
  modelValue: TemplateNode
  label?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: TemplateNode]
}>()

// ── Local state ───────────────────────────────────────────────────────────────

const menuOpen = ref(false)
const charInput = ref('')
const charInputError = ref('')

// ── Handlers ──────────────────────────────────────────────────────────────────

function selectOperator(op: string) {
  emit('update:modelValue', {
    type: 'op',
    operator: op,
    children: Array<TemplateNode>(IDS_OPERATORS[op]!).fill(null),
  })
  menuOpen.value = false
}

function clearNode() {
  emit('update:modelValue', null)
}

function confirmChar() {
  const cp = [...charInput.value]
  if (cp.length !== 1) {
    charInputError.value = 'Enter exactly one character'
    return
  }
  emit('update:modelValue', { type: 'char', character: cp[0]! })
  charInput.value = ''
  charInputError.value = ''
  menuOpen.value = false
}

function updateChild(index: number, child: TemplateNode) {
  if (!props.modelValue || props.modelValue.type !== 'op') return
  const newChildren = [...props.modelValue.children]
  newChildren[index] = child
  emit('update:modelValue', { ...props.modelValue, children: newChildren })
}

function onCharInputKey(e: KeyboardEvent) {
  if (e.key === 'Enter') confirmChar()
}
</script>

<template>
  <div class="ids-node">
    <!-- ── Label ────────────────────────────────────────────────────────────── -->
    <div v-if="label" class="text-caption text-medium-emphasis mb-1">{{ label }}</div>

    <!-- ── Case: null (empty/wildcard slot) ──────────────────────────────────── -->
    <template v-if="modelValue === null">
      <v-menu v-model="menuOpen" :close-on-content-click="false" location="bottom start">
        <template #activator="{ props: menuProps }">
          <v-chip
            v-bind="menuProps"
            variant="outlined"
            color="default"
            size="small"
            class="ids-slot-chip ids-slot-empty"
            style="cursor: pointer; font-style: italic;"
          >
            ?
          </v-chip>
        </template>

        <!-- Fill menu -->
        <v-card min-width="260" class="pa-3">
          <div class="text-caption text-medium-emphasis mb-2">Select operator</div>
          <div class="d-flex flex-wrap ga-1 mb-3">
            <v-chip
              v-for="op in Object.keys(IDS_OPERATORS)"
              :key="op"
              size="small"
              variant="outlined"
              style="cursor: pointer; font-size: 1rem;"
              @click="selectOperator(op)"
            >
              {{ op }}
              <v-tooltip activator="parent" location="top">{{ OPERATOR_TOOLTIPS[op] }}</v-tooltip>
            </v-chip>
          </div>

          <v-divider class="mb-3" />

          <div class="text-caption text-medium-emphasis mb-2">Or enter a character</div>
          <div class="d-flex align-center ga-2">
            <v-text-field
              v-model="charInput"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 72px; font-size: 1.2rem;"
              :error="!!charInputError"
              @keydown="onCharInputKey"
              @input="charInputError = ''"
            />
            <v-btn size="small" variant="tonal" @click="confirmChar">Set</v-btn>
          </div>
          <div v-if="charInputError" class="text-caption text-error mt-1">{{ charInputError }}</div>
        </v-card>
      </v-menu>
    </template>

    <!-- ── Case: char node ───────────────────────────────────────────────────── -->
    <template v-else-if="modelValue.type === 'char'">
      <v-chip
        variant="flat"
        color="primary"
        size="small"
        class="ids-slot-chip"
        closable
        @click:close="clearNode"
      >
        {{ modelValue.character }}
      </v-chip>
    </template>

    <!-- ── Case: op node ────────────────────────────────────────────────────── -->
    <template v-else-if="modelValue.type === 'op'">
      <v-chip
        variant="flat"
        color="secondary"
        size="small"
        class="ids-slot-chip mb-2"
        closable
        @click:close="clearNode"
      >
        {{ modelValue.operator }}
        <v-tooltip activator="parent" location="top">{{ OPERATOR_TOOLTIPS[modelValue.operator] }}</v-tooltip>
      </v-chip>

      <!-- Children -->
      <div class="ids-children">
        <IdsTemplateNode
          v-for="(child, i) in modelValue.children"
          :key="i"
          :modelValue="child"
          :label="CHILD_LABELS[modelValue.operator]?.[i] ?? String(i)"
          @update:modelValue="updateChild(i, $event)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.ids-node {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
}

.ids-slot-chip {
  font-size: 1rem;
}

.ids-children {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-left: 12px;
  border-left: 2px solid rgba(var(--v-theme-on-surface), 0.12);
  margin-left: 4px;
}
</style>

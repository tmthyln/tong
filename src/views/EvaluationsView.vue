<script setup lang="ts">
import { ref } from 'vue'
import EntityExtractionEval from '@/components/evaluations/EntityExtractionEval.vue'
import RelationshipExtractionEval from '@/components/evaluations/RelationshipExtractionEval.vue'

const tab = ref<'entity' | 'relationship'>('entity')
</script>

<template>
  <v-container fluid class="pa-6">
    <h1 class="text-h4 mb-1">Evaluations</h1>

    <v-tabs v-model="tab" class="mb-4" color="primary" density="compact">
      <v-tab value="entity">Entity extraction</v-tab>
      <v-tab value="relationship">Relationship extraction</v-tab>
    </v-tabs>

    <v-window v-model="tab">
      <v-window-item value="entity">
        <EntityExtractionEval />
      </v-window-item>
      <v-window-item value="relationship">
        <RelationshipExtractionEval />
      </v-window-item>
    </v-window>
  </v-container>
</template>

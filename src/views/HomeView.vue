<script setup lang="ts">
const features = [
  {
    title: 'Library',
    icon: 'mdi-bookshelf',
    to: '/library',
    description: 'Import and read documents. Tong converts them to clean Markdown for comfortable reading.',
  },
  {
    title: 'Dictionary',
    icon: 'mdi-book-alphabet',
    to: '/dictionary',
    description: 'Look up any Chinese word with definitions, pinyin, and example usage.',
  },
  {
    title: 'Lexicon',
    icon: 'mdi-format-list-bulleted-type',
    to: '/lexicon',
    description: "Your personal vocabulary list — words you've encountered and chosen to track.",
  },
  {
    title: 'Knowledge Graph',
    icon: 'mdi-graph-outline',
    to: '/knowledge-graph',
    description: 'Entities extracted from your reading — people, places, events — shown as a connected graph.',
  },
  {
    title: 'Translation',
    icon: 'mdi-translate',
    to: '/library',
    description: 'Translate passages and documents into English with or without smart AI assistance.',
  },
]
</script>

<template>
  <div class="w-100 pa-4">
    <!-- Hero -->
    <section class="d-flex align-center ga-4 mb-8">
      <img src="/favicon.svg" width="72" height="72" alt="Tong" style="border-radius: 14px;" />
      <div>
        <h1 class="text-h3 font-weight-light">Tong <span class="text-medium-emphasis text-h5">通</span></h1>
        <p class="text-body-1 text-medium-emphasis mt-1">An integrated Chinese language learning environment</p>
      </div>
    </section>

    <!-- About -->
    <section class="mb-8">
      <h2 class="text-h6 mb-3">About</h2>
      <v-card variant="tonal" max-width="720">
        <v-card-text class="text-body-1">
          <p class="mb-3">
            Tong (通) is a personal reading and study environment for (Mandarin) Chinese. The name (tōng)
            means <em>to pass through, to connect, to achieve fluency</em> — deep and thorough understanding of a language.
          </p>
          <p>
            Import documents, look up words as you read, build your personal vocabulary, and watch
            connections between people, places, and concepts emerge as a knowledge graph across
            everything you've studied.
          </p>
        </v-card-text>
      </v-card>
    </section>

    <!-- Features -->
    <section>
      <h2 class="text-h6 mb-3">Features</h2>
      <v-row>
        <v-col v-for="feature in features" :key="feature.title" cols="12" sm="6" md="4">
          <v-card variant="outlined" height="100%" :to="feature.to">
            <v-card-item>
              <template #prepend>
                <v-icon :icon="feature.icon" color="primary" class="mr-1" />
              </template>
              <v-card-title class="text-body-1 font-weight-medium">{{ feature.title }}</v-card-title>
            </v-card-item>
            <v-card-text class="text-body-2 text-medium-emphasis">
              {{ feature.description }}
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </section>
  </div>
</template>


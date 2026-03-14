<script setup lang="ts">
import { RouterView } from 'vue-router'
import { ref, computed } from 'vue'
import { useTheme } from 'vuetify'

const theme = useTheme()
const drawer = ref(true)

const isDark = computed(() => theme.global.current.value.dark)

function toggleTheme() {
  const newTheme = isDark.value ? 'light' : 'dark'
  theme.change(newTheme)
  localStorage.setItem('theme', newTheme)
}

const navItems = [
  { title: 'Home', icon: 'mdi-home', to: '/' },
  { title: 'Document', icon: 'mdi-file-document-outline', to: '/document' },
  { title: 'Dictionary', icon: 'mdi-book-alphabet', to: '/dictionary' },
  { title: 'Lexicon', icon: 'mdi-format-list-bulleted-type', to: '/lexicon' },
  { title: 'Knowledge Graph', icon: 'mdi-graph-outline', to: '/knowledge-graph' },
  { title: 'Library', icon: 'mdi-bookshelf', to: '/library' },
  { title: 'Settings', icon: 'mdi-cog', to: '/settings' },
]
</script>

<template>
  <v-app>
    <v-navigation-drawer
      v-model="drawer"
      expand-on-hover
      rail
    >
      <v-list>
        <v-list-item
          prepend-icon="mdi-account-circle"
          title="User Name"
          subtitle="user@example.com"
        />
      </v-list>

      <v-divider />

      <v-list density="compact" nav>
        <v-list-item
          v-for="item in navItems"
          :key="item.title"
          :prepend-icon="item.icon"
          :title="item.title"
          :to="item.to"
        />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar>
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-toolbar-title>
        <div class="d-flex align-center ga-2">
          <img src="/favicon.svg" height="30" width="30" alt="Tong" style="border-radius: 6px;" />
          <span>Tong</span>
        </div>
      </v-toolbar-title>
      <v-spacer />
      <v-btn
        :icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
        @click="toggleTheme"
      />
    </v-app-bar>

    <v-main class="main-content">
      <RouterView />
    </v-main>
  </v-app>
</template>

<style>
.main-content {
  width: 100%;
}

.main-content > * {
  width: 100%;
}
</style>
<script setup lang="ts">
import { RouterView } from 'vue-router'
import { ref, computed, onMounted } from 'vue'
import { useTheme } from 'vuetify'
import { useUser } from './composables/useUser'
import { usePreferences } from './composables/usePreferences'

const theme = useTheme()
const drawer = ref(true)

const isDark = computed(() => theme.global.current.value.dark)

function toggleTheme() {
  const newTheme = isDark.value ? 'light' : 'dark'
  theme.change(newTheme)
  localStorage.setItem('theme', newTheme)
}

const { userType, displayName, expiresIn, fetchUser, login, logout, createTestAccount } = useUser()
const { fetchPreferences } = usePreferences()

const selectedAccount = ref<string>('alice')

onMounted(() => {
  fetchUser()
  fetchPreferences()
})

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
          :title="displayName"
          :subtitle="userType === 'public' ? 'Public Read-Only User' : userType === 'authenticated' ? 'Authenticated User' : 'Test User'"
        />
        <v-list-item v-if="userType === 'public'" class="px-2 pb-2">
          <v-select
            v-model="selectedAccount"
            :items="['alice', 'bob']"
            label="Account"
            density="compact"
            hide-details
            class="mb-2"
          />
          <div class="d-flex ga-2">
            <v-btn size="small" variant="tonal" @click="login(selectedAccount)">Sign in</v-btn>
            <v-btn size="small" variant="tonal" @click="createTestAccount">Test account</v-btn>
          </div>
        </v-list-item>
        <v-list-item v-else class="px-2 pb-2">
          <div v-if="userType === 'test' && expiresIn" class="text-caption text-medium-emphasis mb-2">
            {{ expiresIn === 'Expired' ? 'Expired' : `Expires in ${expiresIn}` }}
          </div>
          <v-btn size="small" variant="tonal" @click="logout">Sign out</v-btn>
        </v-list-item>
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

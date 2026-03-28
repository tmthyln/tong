<script setup lang="ts">
import { RouterView } from 'vue-router'
import { ref, computed, onMounted } from 'vue'
import { useUser } from './composables/useUser'
import { usePreferences } from './composables/usePreferences'
import PreferencesDialog from './components/PreferencesDialog.vue'

const drawer = ref(true)
const prefsOpen = ref(false)

const { userType, displayName, expiresIn, fetchUser, login, logout, createTestAccount } = useUser()
const { fetchPreferences } = usePreferences()

const selectedAccount = ref<string>('alice')
const accountMenuOpen = ref(false)

const userSubtitle = computed(() => {
  if (userType.value === 'test' && expiresIn.value)
    return expiresIn.value === 'Expired' ? 'Expired' : `Expires in ${expiresIn.value}`
  if (userType.value === 'public') return 'Read-Only'
  return 'Authenticated'
})

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
      :expand-on-hover="!accountMenuOpen"
      :rail="!accountMenuOpen"
    >
      <v-list>
        <v-list-item
          :prepend-icon="userType === 'public' ? 'mdi-incognito' : userType === 'test' ? 'mdi-flask-outline' : 'mdi-account-circle'"
          :title="displayName"
          :subtitle="userSubtitle"
        >
          <template #append>
            <v-menu v-model="accountMenuOpen" location="bottom end">
              <template #activator="{ props }">
                <v-btn icon="mdi-dots-vertical" variant="text" size="small" v-bind="props" />
              </template>
              <v-card v-if="userType === 'public'" min-width="200">
                <v-card-text class="pb-1 pt-3">
                  <v-select
                    v-model="selectedAccount"
                    :items="['alice', 'bob']"
                    label="Account"
                    density="compact"
                    hide-details
                  />
                </v-card-text>
                <v-list density="compact">
                  <v-list-item prepend-icon="mdi-login" title="Sign in" @click="login(selectedAccount)" />
                  <v-list-item prepend-icon="mdi-account-plus-outline" title="Test account" @click="createTestAccount" />
                </v-list>
              </v-card>
              <v-list v-else density="compact" min-width="160">
                <v-list-item prepend-icon="mdi-logout" title="Sign out" @click="logout" />
              </v-list>
            </v-menu>
          </template>
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
      <v-btn icon="mdi-tune" @click="prefsOpen = true" />
    </v-app-bar>

    <PreferencesDialog v-model="prefsOpen" />

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

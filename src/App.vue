<script setup lang="ts">
import { RouterView } from 'vue-router'
import { ref, computed, onMounted, watch } from 'vue'
import { useUser } from './composables/useUser'
import { usePreferences } from './composables/usePreferences'
import { useTranslationAgent } from './composables/useTranslationAgent'
import PreferencesDialog from './components/PreferencesDialog.vue'
import AgentPanel from './components/agent/AgentPanel.vue'

const drawer = ref(true)
const prefsOpen = ref(false)

const {
  userId,
  userType,
  displayName,
  expiresIn,
  fetchUser,
  login: loginUser,
  logout: logoutUser,
  createTestAccount: createTestAccountUser,
} = useUser()
const { fetchPreferences } = usePreferences()
const { connect: connectAgent, disconnect: disconnectAgent } = useTranslationAgent()

// Connect the agent for authenticated/test users (not public, read-only).
watch(
  userId,
  (id) => {
    if (id && id !== 'public') connectAgent(id)
    else disconnectAgent()
  },
  { immediate: true },
)

const selectedAccount = ref<string>('alice')
const accountMenuOpen = ref(false)

function login(account: string) {
  accountMenuOpen.value = false
  return loginUser(account)
}

function logout() {
  accountMenuOpen.value = false
  return logoutUser()
}

function createTestAccount() {
  accountMenuOpen.value = false
  return createTestAccountUser()
}

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

const version = __APP_VERSION__
const buildDate = __BUILD_DATE__

const navItems = [
  { title: 'Home', icon: 'mdi-home', to: '/' },
  { title: 'Documents', icon: 'mdi-file-document-outline', to: '/document' },
  { title: 'Dictionary', icon: 'mdi-book-alphabet', to: '/dictionary' },
  { title: 'Lexicon', icon: 'mdi-format-list-bulleted-type', to: '/lexicon' },
  { title: 'Knowledge Graph', icon: 'mdi-graph-outline', to: '/knowledge-graph' },
  { title: 'Knowledge Scopes', icon: 'mdi-layers-triple-outline', to: '/knowledge-scopes' },
  { title: 'Library', icon: 'mdi-bookshelf', to: '/library' },
  { title: 'Evaluations', icon: 'mdi-test-tube', to: '/evaluations' },
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
            <v-menu v-model="accountMenuOpen" location="bottom end" :close-on-content-click="false">
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

      <template #append>
        <div class="px-4 pb-3 text-caption text-medium-emphasis version-label">
          <div>Tong Version {{ version }}</div>
          <div>{{ buildDate }}</div>
        </div>
      </template>
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

    <AgentPanel />
  </v-app>
</template>

<style>
.main-content {
  width: 100%;
}

.main-content > * {
  width: 100%;
}

.version-label {
  display: none;
}

.v-navigation-drawer--is-hovering .version-label,
.v-navigation-drawer:not(.v-navigation-drawer--rail) .version-label {
  display: block;
}
</style>

import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/document',
      name: 'documents',
      component: () => import('../views/DocumentsView.vue'),
    },
    {
      path: '/document/:id',
      name: 'document',
      component: () => import('../views/DocumentView.vue'),
    },
    {
      path: '/dictionary',
      name: 'dictionary',
      component: () => import('../views/DictionaryView.vue'),
    },
    {
      path: '/lexicon',
      name: 'lexicon',
      component: () => import('../views/LexiconView.vue'),
    },
    {
      path: '/knowledge-graph',
      name: 'knowledge-graph',
      component: () => import('../views/KnowledgeGraphView.vue'),
    },
    {
      path: '/library',
      name: 'library',
      component: () => import('../views/LibraryView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
    },
  ],
})

export default router
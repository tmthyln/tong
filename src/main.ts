import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const defaultTheme = localStorage.getItem('pref:theme') || (prefersDark ? 'dark' : 'light')

const vuetify = createVuetify({
  components,
  directives,
  icons: {
    defaultSet: 'mdi',
  },
  theme: {
    defaultTheme,
    themes: {
      light: {
        dark: false,
      },
      dark: {
        dark: true,
      },
    },
  },
})

createApp(App)
    .use(router)
    .use(vuetify)
    .mount('#app')
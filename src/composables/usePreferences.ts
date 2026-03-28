import { watch } from 'vue'
import { useTheme } from 'vuetify'
import { createSharedComposable, useLocalStorage } from '@vueuse/core'
import { useUser } from './useUser'

const usePreferences = createSharedComposable(() => {
  const vTheme = useTheme()

  const script = useLocalStorage<'traditional' | 'simplified'>('pref:script', 'traditional')
  const pronunciationPrimary = useLocalStorage('pref:pronunciationPrimary', 'pinyin')
  const pronunciationSecondaries = useLocalStorage<string[]>('pref:pronunciationSecondaries', [])
  const theme = useLocalStorage('pref:theme', () => {
    return localStorage.getItem('theme')
      ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  })

  watch(theme, val => vTheme.change(val), { immediate: true })

  async function fetchPreferences(): Promise<void> {
    if (useUser().userType.value === 'public') return
    const data: { script: string; pronunciationPrimary: string; pronunciationSecondaries: string[]; theme: string } =
      await fetch('/api/preferences').then(r => r.json())
    script.value = data.script as 'traditional' | 'simplified'
    pronunciationPrimary.value = data.pronunciationPrimary
    pronunciationSecondaries.value = data.pronunciationSecondaries
    theme.value = data.theme
  }

  async function updatePreferences(patch: {
    script?: 'traditional' | 'simplified'
    pronunciationPrimary?: string
    pronunciationSecondaries?: string[]
    theme?: string
  }): Promise<void> {
    if (patch.script !== undefined) script.value = patch.script
    if (patch.pronunciationPrimary !== undefined) pronunciationPrimary.value = patch.pronunciationPrimary
    if (patch.pronunciationSecondaries !== undefined) pronunciationSecondaries.value = patch.pronunciationSecondaries
    if (patch.theme !== undefined) theme.value = patch.theme
    if (useUser().userType.value === 'public') return
    const data: { script: string; pronunciationPrimary: string; pronunciationSecondaries: string[]; theme: string } =
      await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(r => r.json())
    script.value = data.script as 'traditional' | 'simplified'
    pronunciationPrimary.value = data.pronunciationPrimary
    pronunciationSecondaries.value = data.pronunciationSecondaries
    theme.value = data.theme
  }

  return { script, pronunciationPrimary, pronunciationSecondaries, theme, fetchPreferences, updatePreferences }
})

export { usePreferences }

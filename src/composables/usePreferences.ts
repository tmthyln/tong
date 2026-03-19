import { ref } from 'vue'
import { useUser } from './useUser'

const script = ref<'traditional' | 'simplified'>('traditional')
const pronunciation = ref<string>('pinyin')

async function fetchPreferences(): Promise<void> {
  const { userType } = useUser()
  if (userType.value === 'public') {
    script.value = (localStorage.getItem('pref:script') as 'traditional' | 'simplified') ?? 'traditional'
    pronunciation.value = localStorage.getItem('pref:pronunciation') ?? 'pinyin'
    return
  }
  const res = await fetch('/api/preferences')
  const data: { script: string; pronunciation: string } = await res.json()
  script.value = data.script as 'traditional' | 'simplified'
  pronunciation.value = data.pronunciation
}

async function updatePreferences(patch: { script?: 'traditional' | 'simplified'; pronunciation?: string }): Promise<void> {
  const { userType } = useUser()
  if (userType.value === 'public') {
    if (patch.script !== undefined) {
      localStorage.setItem('pref:script', patch.script)
      script.value = patch.script
    }
    if (patch.pronunciation !== undefined) {
      localStorage.setItem('pref:pronunciation', patch.pronunciation)
      pronunciation.value = patch.pronunciation
    }
    return
  }
  const res = await fetch('/api/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data: { script: string; pronunciation: string } = await res.json()
  script.value = data.script as 'traditional' | 'simplified'
  pronunciation.value = data.pronunciation
}

export function usePreferences() {
  return { script, pronunciation, fetchPreferences, updatePreferences }
}

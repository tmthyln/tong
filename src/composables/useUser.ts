import { ref, computed } from 'vue'

type UserType = 'public' | 'authenticated' | 'test'

interface MeResponse {
  userId: string
  userType: UserType
  expiresAt?: string
}

const userId = ref<string>('public')
let countdownInterval: ReturnType<typeof setInterval> | null = null

const type = computed<UserType>(() => {
  if (userId.value === 'public') return 'public'
  if (userId.value.startsWith('user:')) return 'authenticated'
  return 'test'
})

const displayName = computed(() => {
  if (userId.value.startsWith('user:')) return userId.value.slice(5)
  if (type.value === 'test') return 'Test Account'
  return 'Public'
})

const expiresIn = ref<string | null>(null)

function formatTimeRemaining(target: Date): string {
  const diff = target.getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function startCountdown(target: Date) {
  if (countdownInterval) clearInterval(countdownInterval)
  expiresIn.value = formatTimeRemaining(target)
  countdownInterval = setInterval(() => {
    expiresIn.value = formatTimeRemaining(target)
  }, 60 * 1000)
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
  expiresIn.value = null
}

function applyResponse(data: MeResponse) {
  userId.value = data.userId
  if (data.expiresAt) {
    startCountdown(new Date(data.expiresAt))
  } else {
    stopCountdown()
  }
}

async function fetchUser(): Promise<void> {
  const res = await fetch('/api/auth/me')
  const data: MeResponse = await res.json()
  applyResponse(data)
}

async function login(account: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
  })
  const data: MeResponse = await res.json()
  applyResponse(data)
}

async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST' })
  const data: MeResponse = await res.json()
  applyResponse(data)
}

async function createTestAccount(): Promise<void> {
  const res = await fetch('/api/auth/test-account', { method: 'POST' })
  const data: MeResponse = await res.json()
  applyResponse(data)
}

export function useUser() {
  return { userId, userType: type, displayName, expiresIn, fetchUser, login, logout, createTestAccount }
}

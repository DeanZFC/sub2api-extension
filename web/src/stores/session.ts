import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getSession } from '@/api/session'
import { errorMessage } from '@/api/client'
import type { Session } from '@/types/domain'

export const useSessionStore = defineStore('session', () => {
  const session = ref<Session | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  const user = computed(() => session.value?.user ?? null)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function load(force = false): Promise<Session | null> {
    if (loaded.value && !force) return session.value
    loading.value = true
    error.value = ''
    try {
      session.value = await getSession()
      loaded.value = true
      return session.value
    } catch (cause) {
      session.value = null
      loaded.value = true
      error.value = errorMessage(cause)
      return null
    } finally {
      loading.value = false
    }
  }

  return { session, user, loading, loaded, error, isAdmin, load }
})

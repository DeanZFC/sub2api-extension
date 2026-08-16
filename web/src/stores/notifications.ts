import { ref } from 'vue'
import { defineStore } from 'pinia'

export type NoticeTone = 'success' | 'error' | 'info'

export interface Notice {
  id: number
  message: string
  tone: NoticeTone
}

export const useNotificationsStore = defineStore('notifications', () => {
  const notices = ref<Notice[]>([])
  let nextId = 1

  function show(message: string, tone: NoticeTone = 'info'): void {
    const id = nextId++
    notices.value.push({ id, message, tone })
    window.setTimeout(() => dismiss(id), 4200)
  }

  function dismiss(id: number): void {
    notices.value = notices.value.filter((notice) => notice.id !== id)
  }

  return { notices, show, dismiss }
})

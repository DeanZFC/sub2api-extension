<script setup lang="ts">
import AppShell from '@/components/AppShell.vue'
import ErrorState from '@/components/ErrorState.vue'
import ToastHost from '@/components/ToastHost.vue'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
</script>

<template>
  <div v-if="session.loading && !session.loaded" class="app-bootstrap" aria-busy="true">
    <span class="loading-ring" />
    <p>正在确认登录状态…</p>
  </div>
  <div v-else-if="session.error || !session.session?.authenticated" class="app-bootstrap">
    <ErrorState
      :message="session.error || '当前会话无效，请从 Sub2API 菜单重新进入。'"
      @retry="session.load(true)"
    />
  </div>
  <AppShell v-else />
  <ToastHost />
</template>

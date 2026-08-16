<script setup lang="ts">
import { CircleCheck, Close, InfoFilled, WarningFilled } from '@element-plus/icons-vue'
import { useNotificationsStore } from '@/stores/notifications'

const store = useNotificationsStore()
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <div v-for="notice in store.notices" :key="notice.id" class="toast" :class="`toast--${notice.tone}`">
      <CircleCheck v-if="notice.tone === 'success'" />
      <WarningFilled v-else-if="notice.tone === 'error'" />
      <InfoFilled v-else />
      <span>{{ notice.message }}</span>
      <button type="button" title="关闭提示" aria-label="关闭提示" @click="store.dismiss(notice.id)">
        <Close />
      </button>
    </div>
  </div>
</template>

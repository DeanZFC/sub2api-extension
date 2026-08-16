<script setup lang="ts">
import { Refresh, Warning } from '@element-plus/icons-vue'

withDefaults(defineProps<{ message: string; retryable?: boolean }>(), { retryable: true })
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="state-panel state-panel--error" role="alert">
    <Warning class="state-panel__icon" />
    <div>
      <strong>加载失败</strong>
      <p>{{ message }}</p>
    </div>
    <button v-if="retryable" class="button button--quiet" type="button" @click="emit('retry')">
      <Refresh />
      重试
    </button>
  </div>
</template>

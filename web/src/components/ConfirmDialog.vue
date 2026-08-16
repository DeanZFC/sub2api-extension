<script setup lang="ts">
import ModalDialog from './ModalDialog.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    busy?: boolean
  }>(),
  { confirmLabel: '确认', danger: false, busy: false }
)

const emit = defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <ModalDialog :open="open" :title="title" width="440px" @close="emit('close')">
    <p class="confirm-message">{{ message }}</p>
    <template #footer>
      <button class="button button--quiet" type="button" :disabled="busy" @click="emit('close')">
        取消
      </button>
      <button
        class="button"
        :class="danger ? 'button--danger' : 'button--primary'"
        type="button"
        :disabled="busy"
        @click="emit('confirm')"
      >
        {{ busy ? '处理中…' : confirmLabel }}
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.confirm-message {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.7;
}
</style>

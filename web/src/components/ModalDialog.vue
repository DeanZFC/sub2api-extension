<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { Close } from '@element-plus/icons-vue'

withDefaults(defineProps<{ open: boolean; title: string; width?: string }>(), { width: '760px' })
const emit = defineEmits<{ close: [] }>()

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @mousedown.self="emit('close')">
      <section
        class="modal-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :style="{ '--dialog-width': width }"
      >
        <header class="modal-dialog__header">
          <h2>{{ title }}</h2>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('close')">
            <Close />
          </button>
        </header>
        <div class="modal-dialog__body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-dialog__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

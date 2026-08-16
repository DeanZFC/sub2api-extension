<script setup lang="ts">
import { Tickets } from '@element-plus/icons-vue'

defineProps<{ title: string; description: string }>()
</script>

<template>
  <div class="empty-state">
    <Tickets />
    <strong>{{ title }}</strong>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>

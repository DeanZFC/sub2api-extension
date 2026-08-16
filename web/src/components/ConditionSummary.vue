<script setup lang="ts">
import { computed } from 'vue'
import { describeCondition } from '@/domain/conditions'
import type { ConditionNode } from '@/types/domain'

const props = defineProps<{ condition: ConditionNode }>()
const text = computed(() => describeCondition(props.condition))
</script>

<template>
  <span class="condition-summary">{{ text }}</span>
</template>

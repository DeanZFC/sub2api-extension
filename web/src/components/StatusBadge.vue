<script setup lang="ts">
import { computed } from 'vue'
import type {
  FulfillmentStatus,
  GroupGrantExecutionStatus,
  LotteryStatus
} from '@/types/domain'
import type { GroupGrantLifecycleStatus } from '@/domain/groupGrantLifecycle'

const props = defineProps<{
  status: LotteryStatus | FulfillmentStatus | GroupGrantExecutionStatus | GroupGrantLifecycleStatus | 'enabled'
}>()

const labels: Record<typeof props.status, string> = {
  not_started: '未启动',
  active: '进行中',
  snapshot_ready: '开奖处理中',
  locked: '开奖处理中',
  drawn: '已开奖',
  fulfilling: '发奖中',
  fulfilled: '已完成',
  failed: '处理失败',
  running: '执行中',
  partial: '部分完成',
  pending: '待发放',
  processing: '发放中',
  succeeded: '已完成',
  manual: '人工处理',
  enabled: '已启用',
  disabled: '已停用',
  upcoming: '未开始',
  activity_ended: '活动已结束',
  pending_revoke: '待撤销',
  revoking: '撤销处理中',
  revoked: '已撤销',
  revoke_failed: '撤销失败'
}

const tone = computed(() => {
  if (['active', 'fulfilled', 'succeeded', 'enabled'].includes(props.status)) return 'success'
  if (['failed', 'revoke_failed'].includes(props.status)) return 'danger'
  if (['locked', 'drawn', 'processing', 'fulfilling', 'running', 'revoking'].includes(props.status)) return 'accent'
  if (['disabled', 'activity_ended', 'revoked'].includes(props.status)) return 'neutral'
  return 'warning'
})
</script>

<template>
  <span class="status-badge" :class="`status-badge--${tone}`">{{ labels[status] }}</span>
</template>

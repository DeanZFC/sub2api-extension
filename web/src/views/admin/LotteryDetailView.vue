<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  Back,
  CircleCheck,
  MagicStick,
  Present,
  Refresh,
  VideoPlay
} from '@element-plus/icons-vue'
import { errorMessage } from '@/api/client'
import {
  completeOutboxJob,
  drawLottery,
  fulfillLottery,
  getLottery,
  retryOutboxJob,
  startLottery
} from '@/api/lotteries'
import ConditionSummary from '@/components/ConditionSummary.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { formatActivityDate } from '@/domain/time'
import { useNotificationsStore } from '@/stores/notifications'
import type { Lottery, LotteryStatus, LotteryWinner } from '@/types/domain'

type DetailTab = 'overview' | 'candidates' | 'winners'
type ActionName = 'start' | 'draw' | 'fulfill'

const route = useRoute()
const notices = useNotificationsStore()
const lottery = ref<Lottery | null>(null)
const loading = ref(true)
const error = ref('')
const activeTab = ref<DetailTab>('overview')
const runningAction = ref<ActionName | null>(null)
const confirmAction = ref<ActionName | null>(null)
const runningFulfillmentId = ref<string | null>(null)
const completingWinner = ref<LotteryWinner | null>(null)

const id = computed(() => String(route.params.id))

const confirmCopy = computed(() => {
  if (confirmAction.value === 'start') {
    return {
      title: '启动抽奖',
      message: '启动后抽奖会显示在用户活动中心，符合条件的用户可以手动参与；开奖前仍可修改活动和奖项，已有参与记录会保留。',
      label: '确认启动',
      danger: false
    }
  }
  if (confirmAction.value === 'draw') {
    return {
      title: '发起开奖',
      message: `将从开奖时符合条件的参与用户中，无重复抽取 ${lottery.value?.winners_count || 0} 人。开奖结果写入后不能重抽。`,
      label: '确认开奖',
      danger: true
    }
  }
  return {
    title: '执行发奖',
    message: '系统将自动发放余额、并发额度和订阅奖励；实体或其他人工奖品会标记为待处理。失败任务可继续重试。',
    label: '执行发奖',
    danger: false
  }
})

const manualCompletionMessage = computed(() => {
  const winner = completingWinner.value
  if (!winner) return ''
  const user = winner.email || `用户 #${winner.user_id}`
  return `请确认已向 ${user} 发放“${winner.prize_name}”。标记完成后，该任务不能再次处理。`
})

const eligibleCandidates = computed(() =>
  (lottery.value?.candidates || []).filter((candidate) => candidate.eligible)
)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    lottery.value = await getLottery(id.value)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

async function execute(action: ActionName): Promise<void> {
  if (runningAction.value) return
  runningAction.value = action
  confirmAction.value = null
  try {
    if (action === 'start') {
      await startLottery(id.value)
      notices.show('抽奖已启动，用户现在可以参与', 'success')
    } else if (action === 'draw') {
      await drawLottery(id.value)
      notices.show('开奖完成，结果已写入', 'success')
      activeTab.value = 'winners'
    } else {
      await fulfillLottery(id.value)
      notices.show('发奖任务已执行', 'success')
      activeTab.value = 'winners'
    }
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    runningAction.value = null
  }
}

function requestConfirmation(action: ActionName): void {
  confirmAction.value = action
}

async function retryFulfillment(winner: LotteryWinner): Promise<void> {
  if (!winner.fulfillment_id || runningFulfillmentId.value) return
  runningFulfillmentId.value = winner.fulfillment_id
  try {
    await retryOutboxJob(winner.fulfillment_id)
    notices.show(`已重新提交 ${winner.email || `用户 #${winner.user_id}`} 的发奖任务`, 'success')
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    runningFulfillmentId.value = null
  }
}

async function completeManualFulfillment(): Promise<void> {
  const winner = completingWinner.value
  if (!winner?.fulfillment_id || runningFulfillmentId.value) return
  runningFulfillmentId.value = winner.fulfillment_id
  try {
    await completeOutboxJob(winner.fulfillment_id)
    notices.show(`已标记 ${winner.email || `用户 #${winner.user_id}`} 的人工奖品为完成`, 'success')
    completingWinner.value = null
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    runningFulfillmentId.value = null
  }
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return formatActivityDate(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatBalance(value: number): string {
  return `$${value.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
}

function rewardTypeLabel(type: string): string {
  if (type === 'balance') return '余额自动发放'
  if (type === 'concurrency') return '并发额度自动发放'
  if (type === 'subscription') return '订阅自动发放'
  if (type === 'physical') return '实体奖品人工发放'
  return '其他人工发放'
}

function prizeRewardText(prize: Lottery['prizes'][number]): string {
  if (prize.reward_type === 'balance') return formatBalance(prize.reward_value)
  if (prize.reward_type === 'concurrency') return `${prize.reward_value} 并发额度`
  if (prize.reward_type === 'subscription') {
    return `${prize.group_name || `分组 #${prize.group_id || ''}`} · ${prize.validity_days || 0} 天`
  }
  return '管理员人工确认'
}

function statusIs(...statuses: LotteryStatus[]): boolean {
  return Boolean(lottery.value && statuses.includes(lottery.value.status))
}

onMounted(load)
</script>

<template>
  <div class="page">
    <RouterLink class="back-link" to="/admin/lotteries"><Back />返回抽奖列表</RouterLink>

    <div v-if="loading" class="skeleton-list">
      <div class="skeleton-row skeleton-row--title" />
      <div v-for="index in 5" :key="index" class="skeleton-row" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="load" />

    <template v-else-if="lottery">
      <PageHeader :title="lottery.name" :description="lottery.description || '用户主动参与，系统自动或管理员手动开奖'">
        <template #actions>
          <StatusBadge :status="lottery.status" />
        </template>
      </PageHeader>

      <div class="action-bar">
        <button
          v-if="statusIs('not_started')"
          class="button button--primary"
          type="button"
          :disabled="Boolean(runningAction)"
          @click="requestConfirmation('start')"
        >
          <VideoPlay />
          启动抽奖
        </button>
        <button
          v-if="statusIs('active', 'snapshot_ready', 'locked')"
          class="button button--primary"
          type="button"
          :disabled="Boolean(runningAction)"
          @click="requestConfirmation('draw')"
        >
          <MagicStick />
          手动开奖
        </button>
        <button
          v-if="statusIs('drawn', 'failed')"
          class="button button--primary"
          type="button"
          :disabled="Boolean(runningAction)"
          @click="requestConfirmation('fulfill')"
        >
          <Present />
          执行发奖
        </button>
      </div>

      <section class="summary-strip" aria-label="抽奖摘要">
        <div><span>参与人数</span><strong>{{ lottery.entry_count }}</strong></div>
        <div><span>候选人数</span><strong>{{ lottery.candidate_count }}</strong></div>
        <div><span>排除人数</span><strong>{{ lottery.excluded_count }}</strong></div>
        <div><span>计划中奖</span><strong>{{ lottery.winners_count }}</strong></div>
        <div><span>名单时间</span><strong>{{ formatDate(lottery.snapshot_at) }}</strong></div>
      </section>

      <nav class="tabs" aria-label="抽奖详情视图">
        <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">概览</button>
        <button :class="{ active: activeTab === 'candidates' }" @click="activeTab = 'candidates'">
          候选名单
          <span>{{ lottery.candidate_count }}</span>
        </button>
        <button :class="{ active: activeTab === 'winners' }" @click="activeTab = 'winners'">
          开奖结果
          <span>{{ lottery.winners?.length || 0 }}</span>
        </button>
      </nav>

      <div v-if="activeTab === 'overview'" class="detail-sections">
        <section class="detail-section">
          <header><h2>开奖设置</h2></header>
          <p class="draw-schedule">
            <strong>{{ lottery.auto_draw_at ? '自动开奖' : '手动开奖' }}</strong>
            <span>{{ lottery.auto_draw_at ? formatDate(lottery.auto_draw_at) : '等待管理员点击“手动开奖”' }}</span>
          </p>
          <p v-if="lottery.auto_draw_error" class="auto-draw-error">自动开奖失败：{{ lottery.auto_draw_error }}。请调整设置或手动开奖。</p>
        </section>

        <section class="detail-section">
          <header><h2>参与条件</h2></header>
          <p class="condition-detail"><ConditionSummary :condition="lottery.condition" /></p>
        </section>

        <section class="detail-section">
          <header><h2>奖项设置</h2></header>
          <div class="data-table-wrap">
            <table class="data-table data-table--compact">
              <thead><tr><th>奖项</th><th>人数</th><th>发放方式</th><th>奖励</th></tr></thead>
              <tbody>
                <tr v-for="prize in lottery.prizes" :key="prize.id || prize.sort_order">
                  <td><strong>{{ prize.name }}</strong></td>
                  <td>{{ prize.winner_count }}</td>
                  <td>{{ rewardTypeLabel(prize.reward_type) }}</td>
                  <td>{{ prizeRewardText(prize) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="detail-section">
          <header><h2>排除原因</h2></header>
          <EmptyState
            v-if="!lottery.exclusion_summary?.length"
            title="暂无排除记录"
            description="生成候选名单后，这里会展示未通过资格校验的人数和原因。"
          />
          <div v-else class="reason-list">
            <div v-for="reason in lottery.exclusion_summary" :key="reason.code">
              <span>{{ reason.label }}</span>
              <div><i :style="{ width: `${Math.min(100, (reason.count / Math.max(1, lottery.excluded_count)) * 100)}%` }" /></div>
              <strong>{{ reason.count }} 人</strong>
            </div>
          </div>
        </section>
      </div>

      <section v-else-if="activeTab === 'candidates'" class="detail-section detail-section--tab">
        <EmptyState
          v-if="!lottery.candidates?.length"
          title="尚未生成候选名单"
            description="开奖时会从已成功参与的用户中自动生成并锁定候选名单。"
        />
        <div v-else class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>用户</th><th>当前余额快照</th><th>累计充值快照</th><th>资格</th><th>快照时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="candidate in lottery.candidates" :key="candidate.id">
                <td><strong>#{{ candidate.user_id }}</strong><small>{{ candidate.email }}</small></td>
                <td>{{ formatBalance(candidate.facts.current_balance) }}</td>
                <td>{{ formatBalance(candidate.facts.recharge_total) }}</td>
                <td>
                  <span v-if="candidate.eligible" class="text-success">符合</span>
                  <span v-else class="text-danger" :title="candidate.exclusion_reasons.join('、')">已排除</span>
                </td>
                <td>{{ formatDate(candidate.snapshot_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="eligibleCandidates.length" class="table-note">当前展示 {{ eligibleCandidates.length }} 位符合条件的快照记录。</p>
      </section>

      <section v-else class="detail-section detail-section--tab">
        <EmptyState
          v-if="!lottery.winners?.length"
          title="尚未开奖"
          description="抽奖启动后，管理员可随时手动开奖；开奖结果生成后不可重抽。"
        />
        <div v-else class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>中奖用户</th>
                <th>奖项</th>
                <th>开奖时间</th>
                <th>发奖状态</th>
                <th>备注</th>
                <th class="cell-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="winner in lottery.winners" :key="winner.id">
                <td><strong>#{{ winner.user_id }}</strong><small>{{ winner.email }}</small></td>
                <td>{{ winner.prize_name }}</td>
                <td>{{ formatDate(winner.drawn_at) }}</td>
                <td><StatusBadge :status="winner.fulfillment_status" /></td>
                <td class="error-note">{{ winner.fulfillment_error || '—' }}</td>
                <td class="cell-actions fulfillment-actions">
                  <button
                    v-if="winner.fulfillment_status === 'failed' && winner.fulfillment_id"
                    class="button button--quiet button--small"
                    type="button"
                    :disabled="Boolean(runningFulfillmentId)"
                    @click="retryFulfillment(winner)"
                  >
                    <Refresh :class="{ spinning: runningFulfillmentId === winner.fulfillment_id }" />
                    {{ runningFulfillmentId === winner.fulfillment_id ? '提交中…' : '重试' }}
                  </button>
                  <button
                    v-else-if="winner.fulfillment_status === 'manual' && winner.fulfillment_id"
                    class="button button--quiet button--small"
                    type="button"
                    :disabled="Boolean(runningFulfillmentId)"
                    @click="completingWinner = winner"
                  >
                    <CircleCheck />
                    标记完成
                  </button>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <ConfirmDialog
      :open="Boolean(confirmAction)"
      :title="confirmCopy.title"
      :message="confirmCopy.message"
      :confirm-label="confirmCopy.label"
      :danger="confirmCopy.danger"
      :busy="Boolean(runningAction)"
      @close="confirmAction = null"
      @confirm="confirmAction && execute(confirmAction)"
    />

    <ConfirmDialog
      :open="Boolean(completingWinner)"
      title="确认人工奖品已发放"
      :message="manualCompletionMessage"
      confirm-label="标记完成"
      :busy="Boolean(runningFulfillmentId)"
      @close="completingWinner = null"
      @confirm="completeManualFulfillment"
    />
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin: 4px 0 12px;
}

.summary-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 18px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.summary-strip > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
}

.summary-strip > div + div {
  border-left: 1px solid var(--border);
}

.summary-strip span {
  color: var(--text-muted);
  font-size: 12px;
}

.summary-strip strong {
  font-size: 15px;
}

.detail-sections {
  display: grid;
  gap: 0;
}

.detail-section {
  padding: 20px 0;
  border-bottom: 1px solid var(--border);
}

.detail-section--tab {
  border-bottom: 0;
}

.detail-section header {
  margin-bottom: 14px;
}

.detail-section h2 {
  margin: 0;
  font-size: 14px;
}

.condition-detail {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.65;
}

.draw-schedule {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  margin: 0;
}

.draw-schedule span {
  color: var(--text-secondary);
}

.auto-draw-error {
  margin: 12px 0 0;
  padding: 10px 12px;
  color: var(--danger);
  background: var(--danger-soft);
  line-height: 1.55;
}

.reason-list {
  display: grid;
  gap: 12px;
}

.reason-list > div {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(100px, 1fr) 70px;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.reason-list > div > div {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--surface-active);
}

.reason-list i {
  display: block;
  height: 100%;
  background: var(--warning);
}

.reason-list strong {
  text-align: right;
  font-size: 12px;
}

.table-note {
  margin: 12px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.error-note {
  max-width: 320px;
  color: var(--text-muted);
}

.fulfillment-actions {
  min-width: 116px;
}

@media (max-width: 720px) {
  .summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .summary-strip > div:nth-child(n + 3) {
    border-top: 1px solid var(--border);
  }

  .summary-strip > div:nth-child(odd) {
    border-top: 1px solid var(--border);
    border-left: 0;
  }

  .summary-strip > div:first-child {
    border-top: 0;
  }

  .reason-list > div {
    grid-template-columns: minmax(100px, 1fr) 60px;
  }

  .reason-list > div > div {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>

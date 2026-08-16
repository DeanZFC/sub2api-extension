<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft, Calendar, Check, Key, Present } from '@element-plus/icons-vue'
import { getActivity, participateInActivity } from '@/api/activities'
import { errorMessage } from '@/api/client'
import ConditionSummary from '@/components/ConditionSummary.vue'
import ErrorState from '@/components/ErrorState.vue'
import { formatActivityDate } from '@/domain/time'
import { useNotificationsStore } from '@/stores/notifications'
import type { ActivityType, UserActivity } from '@/types/domain'

const route = useRoute()
const notices = useNotificationsStore()
const activity = ref<UserActivity | null>(null)
const loading = ref(true)
const error = ref('')
const participating = ref(false)
const type = computed(() => route.params.type as ActivityType)
const id = computed(() => String(route.params.id || ''))
const icons = { lottery: Present, checkin: Calendar, group_entitlement: Key }
const labels = { lottery: '抽奖', checkin: '签到', group_entitlement: '资格' }

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    activity.value = await getActivity(type.value, id.value)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

async function participate(): Promise<void> {
  if (!activity.value || participating.value) return
  participating.value = true
  try {
    const result = await participateInActivity(type.value, id.value)
    activity.value = result
    if (type.value === 'lottery') {
      notices.show(
        result.participated ? '参与成功，请等待开奖' : '不符合条件',
        result.participated ? 'success' : 'error'
      )
    } else if (type.value === 'group_entitlement') {
      notices.show(result.granted ? `已获得${result.group_name || '活动'}资格` : '不符合条件', result.granted ? 'success' : 'error')
    } else {
      notices.show(result.participation?.checked_today ? '今日签到成功' : '不符合条件', result.participation?.checked_today ? 'success' : 'error')
    }
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    participating.value = false
  }
}

function dateRange(item: UserActivity): string {
  if (!item.starts_at && !item.ends_at) return '长期开放'
  return `${formatDate(item.starts_at) || '现在'} ~ ${formatDate(item.ends_at) || '长期'}`
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  return formatActivityDate(value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const actionDisabled = computed(() => {
  const item = activity.value
  if (!item || item.status !== 'active') return true
  if (item.type === 'lottery') return item.phase !== 'active' || Boolean(item.participated)
  if (item.type === 'checkin') return Boolean(item.participation?.checked_today)
  return Boolean(item.granted)
})

const actionText = computed(() => {
  const item = activity.value
  if (!item) return ''
  if (item.type === 'lottery') {
    if (item.participated) return '已参与抽奖'
    return item.phase === 'active' && item.status === 'active' ? '参与抽奖' : '参与已结束'
  }
  if (item.type === 'checkin') return item.participation?.checked_today ? '今日已签到' : '立即签到'
  return item.granted ? '已获得资格' : '申请资格'
})

function lotteryDrawTime(item: UserActivity): string {
  if (item.drawn_at) return `实际开奖时间：${formatFullDate(item.drawn_at)}`
  if (item.auto_draw_at) return `开奖时间：${formatFullDate(item.auto_draw_at)}`
  return '开奖时间：等待管理员手动开奖'
}

function formatFullDate(value: string): string {
  return formatActivityDate(value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function prizeRewardText(prize: NonNullable<UserActivity['prizes']>[number]): string {
  if (prize.reward_type === 'balance') return `${prize.reward_value} 余额`
  if (prize.reward_type === 'concurrency') return `${prize.reward_value} 并发额度`
  if (prize.reward_type === 'subscription') {
    return `${prize.group_name || '指定分组'}订阅 ${prize.validity_days || 0} 天`
  }
  if (prize.reward_type === 'physical') return '实体奖品'
  return '人工发放'
}

const checkinCalendar = computed(() => {
  const participation = activity.value?.type === 'checkin' ? activity.value.participation : undefined
  const today = participation?.today || ''
  const month = participation?.current_month || today.slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  if (!Number.isSafeInteger(year) || monthNumber < 1 || monthNumber > 12) return null
  const checked = new Set(participation?.checked_dates || [])
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const leadingDays = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7
  const cells: Array<{ date: string; day: number; checked: boolean; today: boolean; future: boolean } | null> = Array.from({ length: leadingDays }, () => null)
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    cells.push({ date, day, checked: checked.has(date), today: date === today, future: Boolean(today && date > today) })
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return {
    label: `${year}年${monthNumber}月`,
    checkedCount: [...checked].filter((date) => date.startsWith(`${month}-`)).length,
    cells
  }
})

function calendarDayLabel(cell: NonNullable<NonNullable<typeof checkinCalendar.value>['cells'][number]>): string {
  if (cell.checked) return `${cell.date}，已签到`
  if (cell.today) return `${cell.date}，今天，未签到`
  return cell.date
}

onMounted(load)
</script>

<template>
  <div class="activity-detail-page">
    <RouterLink class="activity-back" to="/"><ArrowLeft />返回活动列表</RouterLink>
    <div v-if="loading" class="activity-detail-loading"><span class="loading-ring" /></div>
    <ErrorState v-else-if="error" :message="error" @retry="load" />
    <template v-else-if="activity">
      <header class="activity-detail-hero" :class="`activity-detail-hero--${activity.type}`">
        <div class="activity-detail-hero__meta">
          <span><component :is="icons[activity.type]" />{{ labels[activity.type] }}</span>
          <span>{{ activity.status === 'active' ? '进行中' : activity.status === 'upcoming' ? '即将开始' : '已结束' }}</span>
          <span><Calendar />{{ dateRange(activity) }}</span>
        </div>
        <h1>{{ activity.name }}</h1>
        <p>{{ activity.description }}</p>
      </header>

      <section v-if="activity.condition" class="activity-panel activity-requirements">
        <div class="activity-panel__heading"><Key /><div><h2>参与条件</h2><p>条件以点击参与时的实时账户状态为准。</p></div></div>
        <ConditionSummary :condition="activity.condition" />
        <div v-if="activity.facts" class="activity-facts">
          <span>当前余额 <strong>{{ activity.facts.current_balance }}</strong></span>
          <span>累计充值 <strong>{{ activity.facts.recharge_total }}</strong></span>
          <span v-for="(amount, days) in activity.facts.recent_recharge_totals" :key="days">
            近 {{ days }} 天充值 <strong>{{ amount }}</strong>
          </span>
        </div>
        <ul v-if="activity.reasons?.length" class="activity-reasons"><li v-for="reason in activity.reasons" :key="reason">{{ reason }}</li></ul>
      </section>

      <section class="activity-panel activity-action-panel">
        <div class="activity-panel__heading">
          <component :is="icons[activity.type]" />
          <div><h2>{{ activity.type === 'lottery' ? '参与抽奖' : activity.type === 'checkin' ? '每日签到' : activity.group_name || '申请活动资格' }}</h2><p>{{ activity.type === 'lottery' ? '点击参与时会实时检查资格，参与成功后等待统一开奖。' : activity.type === 'checkin' ? '每天可签到一次，连续签到天数会自动累计。' : '点击申请后实时检查当前账户状态，符合条件会立即加入专属分组。' }}</p></div>
        </div>

        <template v-if="activity.type === 'lottery'">
          <div v-if="activity.winner" class="activity-result activity-result--success"><Check /><div><strong>恭喜中奖</strong><span>{{ activity.winner.prize_name }}{{ activity.winner.reward_type === 'balance' ? ` · ${activity.winner.reward_value} 余额` : '' }}</span></div></div>
          <div v-else-if="activity.drawn_at && activity.participated" class="activity-result"><Present /><div><strong>本次未中奖</strong><span>本次抽奖已经结束</span></div></div>
          <button class="activity-primary-action" type="button" :disabled="actionDisabled || participating" @click="participate">
            <Present />
            {{ participating ? '正在检查…' : actionText }}
          </button>
          <p v-if="activity.participated" class="lottery-draw-time"><Calendar />{{ lotteryDrawTime(activity) }}</p>
          <div class="prize-pool">
            <div v-for="prize in activity.prizes" :key="prize.id"><span>{{ prize.name }}</span><strong>{{ prizeRewardText(prize) }}</strong><small>{{ prize.winner_count }} 个名额</small></div>
          </div>
        </template>

        <template v-else>
          <div v-if="activity.type === 'checkin'" class="activity-stats">
            <div><span>连续签到</span><strong>{{ activity.participation?.streak_days || 0 }}<small> 天</small></strong></div>
            <div><span>累计签到</span><strong>{{ activity.participation?.total_days || 0 }}<small> 天</small></strong></div>
            <div><span>每日奖励</span><strong>{{ activity.reward?.type === 'balance' ? activity.reward.value : '无' }}</strong></div>
          </div>
          <div v-if="activity.type === 'checkin' && checkinCalendar" class="checkin-calendar">
            <div class="checkin-calendar__header">
              <div><Calendar /><strong>{{ checkinCalendar.label }}</strong></div>
              <span>本月已签到 {{ checkinCalendar.checkedCount }} 天</span>
            </div>
            <div class="checkin-calendar__weekdays" aria-hidden="true">
              <span v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']" :key="weekday">{{ weekday }}</span>
            </div>
            <div class="checkin-calendar__days">
              <template v-for="(cell, index) in checkinCalendar.cells" :key="cell?.date || `empty-${index}`">
                <div v-if="cell" class="checkin-calendar__day" :class="{ 'is-checked': cell.checked, 'is-today': cell.today, 'is-future': cell.future }" :aria-label="calendarDayLabel(cell)">
                  <span>{{ cell.day }}</span>
                  <Check v-if="cell.checked" />
                  <small v-else-if="cell.today">今</small>
                </div>
                <div v-else class="checkin-calendar__day is-empty" aria-hidden="true" />
              </template>
            </div>
          </div>
          <div v-if="activity.type === 'group_entitlement' && activity.granted" class="activity-result activity-result--success"><Check /><div><strong>已获得狂欢资格</strong><span>Sub2API 专属分组已加入你的账户</span></div></div>
          <button class="activity-primary-action" type="button" :disabled="actionDisabled || participating" @click="participate">
            <component :is="activity.type === 'checkin' ? Calendar : Key" />
            {{ participating ? '正在检查…' : actionText }}
          </button>
        </template>
      </section>

    </template>
  </div>
</template>

<style scoped>
.activity-detail-page { width: min(920px, 100%); min-height: calc(100vh - 60px); margin: 0 auto; padding: 38px clamp(16px, 4vw, 32px) 64px; }
.activity-back { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 22px; color: var(--text-muted); font-size: 14px; }
.activity-back:hover { color: var(--accent); }
.activity-back svg { width: 17px; }
.activity-detail-loading { display: grid; place-items: center; min-height: 400px; }
.activity-detail-hero { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 270px; padding: 62px clamp(26px, 6vw, 64px); border-radius: 8px; color: white; text-align: center; }
.activity-detail-hero--lottery { background: #db427e; }
.activity-detail-hero--checkin { background: #5263d7; }
.activity-detail-hero--group_entitlement { background: #087f73; }
.activity-detail-hero__meta { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.activity-detail-hero__meta span { display: inline-flex; align-items: center; gap: 5px; min-height: 27px; padding: 3px 9px; border: 1px solid rgba(255,255,255,.55); border-radius: 14px; background: rgba(20,20,30,.13); font-size: 12px; }
.activity-detail-hero__meta svg { width: 14px; }
.activity-detail-hero h1 { margin: 26px 0 10px; font-size: clamp(30px, 5vw, 48px); line-height: 1.18; letter-spacing: 0; }
.activity-detail-hero p { max-width: 660px; margin: 0; color: rgba(255,255,255,.85); font-size: 16px; line-height: 1.65; }
.activity-panel { margin-top: 22px; padding: clamp(22px, 4vw, 34px); border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.activity-panel__heading { display: flex; align-items: flex-start; gap: 14px; }
.activity-panel__heading > svg { flex: 0 0 auto; width: 28px; height: 28px; color: var(--accent); }
.activity-panel__heading h2 { margin: 0; font-size: 20px; }
.activity-panel__heading p { margin: 6px 0 0; color: var(--text-muted); line-height: 1.55; }
.activity-primary-action { display: flex; align-items: center; justify-content: center; gap: 9px; width: min(360px, 100%); min-height: 48px; margin: 26px auto 0; padding: 0 20px; border: 0; border-radius: 6px; color: white; background: var(--accent); cursor: pointer; font-size: 15px; font-weight: 700; }
.activity-primary-action:hover:not(:disabled) { background: var(--accent-hover); }
.activity-primary-action:disabled { cursor: not-allowed; opacity: .55; }
.activity-primary-action svg { width: 19px; }
.lottery-draw-time { display: flex; align-items: center; justify-content: center; gap: 7px; margin: 14px 0 0; color: var(--text-secondary); font-size: 13px; }
.lottery-draw-time svg { width: 16px; color: var(--accent); }
.activity-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 28px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.activity-stats div { padding: 18px; border-right: 1px solid var(--border); }
.activity-stats div:last-child { border: 0; }
.activity-stats span, .activity-stats strong { display: block; }
.activity-stats span { color: var(--text-muted); font-size: 12px; }
.activity-stats strong { margin-top: 7px; font-size: 24px; }
.activity-stats small { font-size: 12px; }
.checkin-calendar { width: min(590px, 100%); margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--border); }
.checkin-calendar__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.checkin-calendar__header > div { display: flex; align-items: center; gap: 9px; }
.checkin-calendar__header svg { width: 20px; color: var(--accent); }
.checkin-calendar__header strong { font-size: 17px; }
.checkin-calendar__header > span { color: var(--text-muted); font-size: 13px; }
.checkin-calendar__weekdays, .checkin-calendar__days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.checkin-calendar__weekdays { margin-bottom: 8px; color: var(--text-muted); font-size: 12px; text-align: center; }
.checkin-calendar__day { position: relative; display: grid; place-items: center; aspect-ratio: 1; min-width: 0; border: 1px solid transparent; border-radius: 5px; color: var(--text-secondary); font-size: 13px; }
.checkin-calendar__day.is-future { color: var(--text-muted); opacity: .48; }
.checkin-calendar__day.is-today { border-color: var(--accent); color: var(--accent); font-weight: 700; }
.checkin-calendar__day.is-checked { color: var(--success); background: var(--success-soft); font-weight: 700; }
.checkin-calendar__day > svg { position: absolute; right: 5px; bottom: 5px; width: 13px; height: 13px; }
.checkin-calendar__day > small { position: absolute; right: 4px; bottom: 3px; font-size: 9px; }
.activity-result { display: flex; align-items: center; gap: 12px; margin-top: 25px; padding: 16px; border-left: 3px solid var(--border-strong); background: var(--surface-muted); }
.activity-result--success { border-left-color: var(--success); background: var(--success-soft); }
.activity-result > svg { width: 28px; color: var(--success); }
.activity-result div { display: grid; gap: 4px; }
.activity-result span { color: var(--text-secondary); }
.prize-pool { display: grid; gap: 0; margin-top: 26px; border-top: 1px solid var(--border); }
.prize-pool div { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 18px; padding: 15px 0; border-bottom: 1px solid var(--border); }
.prize-pool small { color: var(--text-muted); }
.activity-requirements :deep(.condition-summary) { margin-top: 20px; }
.activity-facts { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text-muted); }
.activity-facts strong { margin-left: 5px; color: var(--text); }
.activity-reasons { margin: 16px 0 0; padding: 12px 12px 12px 32px; color: var(--danger); background: var(--danger-soft); line-height: 1.7; }
@media (max-width: 620px) {
  .activity-detail-page { padding-top: 24px; }
  .activity-detail-hero { min-height: 230px; padding: 34px 22px; }
  .activity-detail-hero__meta span:last-child { flex-basis: auto; }
  .activity-stats { grid-template-columns: 1fr; }
  .activity-stats div { border-right: 0; border-bottom: 1px solid var(--border); }
  .checkin-calendar__header { align-items: flex-start; flex-direction: column; gap: 6px; }
  .checkin-calendar__day { font-size: 12px; }
  .checkin-calendar__day > svg { right: 3px; bottom: 3px; width: 11px; height: 11px; }
  .prize-pool div { grid-template-columns: 1fr; gap: 5px; }
}
</style>

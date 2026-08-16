<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowRight, Calendar, Key, Present } from '@element-plus/icons-vue'
import { getActivities } from '@/api/activities'
import { errorMessage } from '@/api/client'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import { formatActivityDate } from '@/domain/time'
import type { ActivityStatus, ActivityType, UserActivity } from '@/types/domain'

const activities = ref<UserActivity[]>([])
const loading = ref(true)
const error = ref('')
const activeCount = computed(() => activities.value.filter((item) => item.status === 'active').length)

const icons = { lottery: Present, checkin: Calendar, group_entitlement: Key }
const typeLabels: Record<ActivityType, string> = {
  lottery: '抽奖',
  checkin: '签到',
  group_entitlement: '资格'
}
const statusLabels: Record<ActivityStatus, string> = {
  active: '进行中', upcoming: '即将开始', ended: '已结束'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    activities.value = (await getActivities()).items
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

function dateRange(item: UserActivity): string {
  if (!item.starts_at && !item.ends_at) return '长期开放'
  return `${formatDate(item.starts_at) || '现在'} ~ ${formatDate(item.ends_at) || '长期'}`
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  return formatActivityDate(value, { month: '2-digit', day: '2-digit' })
}

onMounted(load)
</script>

<template>
  <div class="activity-home">
    <section class="activity-intro">
      <div class="activity-intro__live"><span /> 活动进行中</div>
      <h1>活动中心</h1>
      <p>浏览近期推出的福利与限时活动，参与赢取奖励。</p>
      <small v-if="!loading && activities.length">{{ activeCount }} 个活动正在进行</small>
    </section>

    <div v-if="loading" class="activity-grid" aria-busy="true">
      <div v-for="index in 6" :key="index" class="activity-card activity-card--skeleton">
        <div /><span /><small />
      </div>
    </div>
    <div v-else-if="error" class="activity-state"><ErrorState :message="error" @retry="load" /></div>
    <div v-else-if="activities.length === 0" class="activity-state"><EmptyState title="暂无开放活动" description="新活动发布后会显示在这里。" /></div>
    <section v-else class="activity-grid" aria-label="活动列表">
      <RouterLink
        v-for="item in activities"
        :key="`${item.type}-${item.id}`"
        class="activity-card"
        :to="`/activities/${item.type}/${item.id}`"
      >
        <div class="activity-card__visual" :class="`activity-card__visual--${item.type}`">
          <span class="activity-card__type"><component :is="icons[item.type]" />{{ typeLabels[item.type] }}</span>
          <component :is="icons[item.type]" class="activity-card__symbol" />
          <span class="activity-card__status">{{ statusLabels[item.status] }}</span>
        </div>
        <div class="activity-card__body">
          <h2>{{ item.name }}</h2>
          <p>{{ item.description || '查看活动详情与参与条件' }}</p>
          <footer><span><Calendar />{{ dateRange(item) }}</span><ArrowRight /></footer>
        </div>
      </RouterLink>
    </section>
  </div>
</template>

<style scoped>
.activity-home {
  width: min(980px, 100%);
  min-height: calc(100vh - 60px);
  margin: 0 auto;
  padding: 54px clamp(16px, 4vw, 32px) 64px;
}
.activity-intro { position: relative; margin-bottom: 34px; }
.activity-intro__live { display: inline-flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 12px; }
.activity-intro__live span { width: 8px; height: 8px; border-radius: 50%; background: #5c54e8; box-shadow: 0 0 0 4px color-mix(in srgb, #5c54e8 12%, transparent); }
.activity-intro h1 { margin: 15px 0 8px; color: #5547dc; font-size: clamp(32px, 5vw, 48px); line-height: 1.12; letter-spacing: 0; }
.activity-intro p { margin: 0; color: var(--text-secondary); font-size: 17px; line-height: 1.6; }
.activity-intro small { position: absolute; right: 0; bottom: 4px; color: var(--text-muted); }
.activity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 310px)); gap: 16px; }
.activity-card { overflow: hidden; min-width: 0; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); box-shadow: 0 8px 26px rgba(50, 49, 80, .07); transition: transform 160ms ease, box-shadow 160ms ease; }
.activity-card:hover { transform: translateY(-3px); box-shadow: 0 14px 34px rgba(50, 49, 80, .13); }
.activity-card__visual { position: relative; display: grid; place-items: center; height: 132px; overflow: hidden; color: white; }
.activity-card__visual--lottery { background: #db427e; }
.activity-card__visual--checkin { background: #5263d7; }
.activity-card__visual--group_entitlement { background: #087f73; }
.activity-card__type, .activity-card__status { position: absolute; top: 12px; display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 2px 8px; border: 1px solid rgba(255,255,255,.5); border-radius: 12px; background: rgba(255,255,255,.9); color: #25242e; font-size: 11px; font-weight: 650; }
.activity-card__type { left: 12px; }
.activity-card__status { right: 12px; background: rgba(29,27,47,.22); color: white; }
.activity-card__type svg { width: 14px; }
.activity-card__symbol { width: 52px; height: 52px; opacity: .38; }
.activity-card__body { padding: 14px 15px 13px; }
.activity-card h2 { margin: 0; font-size: 15px; line-height: 1.35; }
.activity-card p { min-height: 38px; margin: 5px 0 10px; color: var(--text-muted); font-size: 13px; line-height: 1.45; }
.activity-card footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-muted); font-size: 12px; }
.activity-card footer span { display: flex; align-items: center; gap: 6px; min-width: 0; }
.activity-card footer svg { flex: 0 0 auto; width: 15px; height: 15px; }
.activity-card footer > svg { color: var(--accent); }
.activity-card--skeleton { height: 230px; animation: pulse 1.4s ease-in-out infinite; }
.activity-card--skeleton div { height: 132px; background: var(--surface-active); }
.activity-card--skeleton span, .activity-card--skeleton small { display: block; width: 56%; height: 13px; margin: 15px 15px 0; background: var(--surface-active); }
.activity-card--skeleton small { width: 38%; margin-top: 10px; }
.activity-state { border-top: 1px solid var(--border); }
@media (max-width: 680px) {
  .activity-home { padding-top: 34px; }
  .activity-intro { margin-bottom: 26px; }
  .activity-intro h1 { font-size: 34px; }
  .activity-intro p { font-size: 14px; }
  .activity-intro small { position: static; display: block; margin-top: 10px; }
  .activity-grid { gap: 14px; }
}
</style>

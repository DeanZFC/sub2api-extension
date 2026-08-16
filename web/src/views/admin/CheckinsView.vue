<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Calendar, Delete, EditPen, Plus, Search } from '@element-plus/icons-vue'
import { createCheckin, deleteCheckin, getCheckins, updateCheckin } from '@/api/checkins'
import { errorMessage } from '@/api/client'
import ConditionEditor from '@/components/ConditionEditor.vue'
import ConditionSummary from '@/components/ConditionSummary.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { createConditionGroup, normalizeCondition } from '@/domain/conditions'
import { formatActivityDate, fromActivityDateTimeInput, toActivityDateTimeInput } from '@/domain/time'
import { useNotificationsStore } from '@/stores/notifications'
import type { CheckinCampaign, CheckinCampaignInput, ConditionNode } from '@/types/domain'

const notices = useNotificationsStore()
const campaigns = ref<CheckinCampaign[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const deleting = ref<CheckinCampaign | null>(null)
const deletingBusy = ref(false)

const form = reactive<CheckinCampaignInput>({
  name: '',
  description: '',
  published: false,
  condition: createConditionGroup(),
  reward_type: 'none',
  reward_value: 0,
  starts_at: null,
  ends_at: null
})

const filteredCampaigns = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return campaigns.value
  return campaigns.value.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(keyword))
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    campaigns.value = (await getCheckins()).items
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

function resetForm(): void {
  Object.assign(form, {
    name: '',
    description: '',
    published: false,
    condition: createConditionGroup(),
    reward_type: 'none',
    reward_value: 0,
    starts_at: null,
    ends_at: null
  })
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  editorOpen.value = true
}

function openEdit(item: CheckinCampaign): void {
  editingId.value = item.id
  Object.assign(form, {
    name: item.name,
    description: item.description,
    published: item.published,
    condition: normalizeCondition(item.condition),
    reward_type: item.reward_type,
    reward_value: item.reward_value,
    starts_at: toLocalDateTime(item.starts_at),
    ends_at: toLocalDateTime(item.ends_at)
  })
  editorOpen.value = true
}

function updateCondition(condition: ConditionNode): void {
  form.condition = condition
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    notices.show('请填写签到活动名称', 'error')
    return
  }
  if (form.reward_type === 'balance' && Number(form.reward_value) <= 0) {
    notices.show('签到余额奖励必须大于 0', 'error')
    return
  }
  saving.value = true
  const payload: CheckinCampaignInput = {
    name: form.name.trim(),
    description: form.description.trim(),
    published: form.published,
    condition: normalizeCondition(form.condition),
    reward_type: form.reward_type,
    reward_value: form.reward_type === 'balance' ? Number(form.reward_value) : 0,
    starts_at: fromActivityDateTimeInput(form.starts_at),
    ends_at: fromActivityDateTimeInput(form.ends_at)
  }
  try {
    if (editingId.value) await updateCheckin(editingId.value, payload)
    else await createCheckin(payload)
    notices.show(editingId.value ? '签到活动已更新' : '签到活动已创建', 'success')
    editorOpen.value = false
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  if (!deleting.value) return
  deletingBusy.value = true
  try {
    await deleteCheckin(deleting.value.id)
    notices.show('签到活动已删除', 'success')
    deleting.value = null
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    deletingBusy.value = false
  }
}

function toLocalDateTime(value?: string | null): string | null {
  return toActivityDateTimeInput(value)
}

function formatDate(value?: string | null): string {
  if (!value) return '长期'
  return formatActivityDate(value, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

onMounted(load)
</script>

<template>
  <div class="page">
    <PageHeader title="签到管理" description="配置每日签到、参与条件和可选余额奖励。">
      <template #actions>
        <button class="button button--primary" type="button" @click="openCreate">
          <Plus />
          新建签到
        </button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <label class="search-control">
        <Search />
        <input v-model="search" type="search" placeholder="搜索签到活动" aria-label="搜索签到活动" />
      </label>
      <span class="toolbar__count">共 {{ campaigns.length }} 个活动</span>
    </div>

    <div v-if="loading" class="skeleton-list"><div v-for="index in 4" :key="index" class="skeleton-row" /></div>
    <ErrorState v-else-if="error" :message="error" @retry="load" />
    <EmptyState v-else-if="campaigns.length === 0" title="还没有签到活动" description="创建后可按条件向用户开放每日签到。">
      <button class="button button--primary" type="button" @click="openCreate"><Plus />新建签到</button>
    </EmptyState>
    <EmptyState v-else-if="filteredCampaigns.length === 0" title="没有匹配结果" description="尝试更换搜索关键词。" />

    <div v-else class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>活动</th><th>参与条件</th><th>奖励</th><th>参与数据</th><th>开放时间</th><th>状态</th><th class="cell-actions">操作</th></tr></thead>
        <tbody>
          <tr v-for="item in filteredCampaigns" :key="item.id">
            <td><strong>{{ item.name }}</strong><small>{{ item.description || `签到 #${item.id}` }}</small></td>
            <td class="condition-cell"><ConditionSummary :condition="item.condition" /></td>
            <td>{{ item.reward_type === 'balance' ? `${item.reward_value} 余额` : '无自动奖励' }}</td>
            <td><strong>{{ item.participant_count }} 人</strong><small>{{ item.record_count }} 次签到</small></td>
            <td><strong>{{ formatDate(item.starts_at) }}</strong><small>至 {{ formatDate(item.ends_at) }}</small></td>
            <td><StatusBadge :status="item.published ? 'enabled' : 'disabled'" /></td>
            <td class="cell-actions">
              <button class="icon-button" type="button" title="编辑签到" @click="openEdit(item)"><EditPen /></button>
              <button class="icon-button icon-button--danger" type="button" title="删除签到" :disabled="item.record_count > 0" @click="deleting = item"><Delete /></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalDialog :open="editorOpen" :title="editingId ? '编辑签到活动' : '新建签到活动'" width="820px" @close="editorOpen = false">
      <form id="checkin-form" class="form-stack" @submit.prevent="save">
        <label class="field"><span>活动名称</span><input v-model="form.name" class="control" maxlength="120" required /></label>
        <label class="field"><span>活动说明</span><textarea v-model="form.description" class="control" rows="3" maxlength="1000" /></label>
        <div class="form-grid">
          <label class="field"><span>开始时间（可选）</span><input v-model="form.starts_at" class="control" type="datetime-local" /></label>
          <label class="field"><span>结束时间（可选）</span><input v-model="form.ends_at" class="control" type="datetime-local" /></label>
        </div>
        <div class="form-grid checkin-reward-grid">
          <label class="field">
            <span>签到奖励</span>
            <select v-model="form.reward_type" class="control"><option value="none">无自动奖励</option><option value="balance">余额自动到账</option></select>
          </label>
          <label v-if="form.reward_type === 'balance'" class="field"><span>每日奖励余额</span><input v-model.number="form.reward_value" class="control" type="number" min="0.000001" step="0.01" /></label>
        </div>
        <label class="toggle-row">
          <input v-model="form.published" type="checkbox" /><span class="toggle" /><span><strong>发布到活动中心</strong><small>发布后符合条件的用户可以每日签到一次</small></span>
        </label>
        <section class="form-section">
          <div class="form-section__heading"><div><h3>参与条件</h3><p>支持充值状态、当前余额及 AND/OR 组合，留空表示全部普通用户。</p></div><Calendar /></div>
          <ConditionEditor :model-value="form.condition" @update:model-value="updateCondition" />
        </section>
      </form>
      <template #footer>
        <button class="button button--quiet" type="button" :disabled="saving" @click="editorOpen = false">取消</button>
        <button class="button button--primary" type="submit" form="checkin-form" :disabled="saving">{{ saving ? '保存中…' : '保存签到' }}</button>
      </template>
    </ModalDialog>

    <ConfirmDialog :open="Boolean(deleting)" title="删除签到活动" :message="`确定删除“${deleting?.name || ''}”吗？`" confirm-label="删除" danger :busy="deletingBusy" @close="deleting = null" @confirm="confirmDelete" />
  </div>
</template>

<style scoped>
.condition-cell { max-width: 320px; color: var(--text-secondary); line-height: 1.55; }
.checkin-reward-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.form-section__heading svg { width: 20px; color: var(--accent); }
</style>

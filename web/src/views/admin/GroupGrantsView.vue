<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  CircleClose,
  Delete,
  EditPen,
  Plus,
  Refresh,
  Search
} from '@element-plus/icons-vue'
import {
  createGroupGrantRule,
  deleteGroupGrantRule,
  getGroupGrantRules,
  getSub2ApiGroups,
  revokeGroupGrantRule,
  updateGroupGrantRule
} from '@/api/groupGrants'
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
import { groupGrantLifecycleStatus } from '@/domain/groupGrantLifecycle'
import { formatActivityDate, fromActivityDateTimeInput, toActivityDateTimeInput } from '@/domain/time'
import { useNotificationsStore } from '@/stores/notifications'
import type {
  ConditionNode,
  GroupGrantRule,
  GroupGrantRuleInput,
  Sub2ApiGroup
} from '@/types/domain'

const notices = useNotificationsStore()
const groups = ref<Sub2ApiGroup[]>([])
const rules = ref<GroupGrantRule[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const deleting = ref<GroupGrantRule | null>(null)
const deletingBusy = ref(false)
const revoking = ref<GroupGrantRule | null>(null)
const revokingBusy = ref(false)
const lifecycleNow = ref(Date.now())
let lifecycleTimer: ReturnType<typeof setInterval> | null = null

const form = reactive<GroupGrantRuleInput>({
  name: '',
  group_id: 0,
  enabled: true,
  revoke_when_ineligible: false,
  assignment_mode: 'claim',
  activity_description: '',
  activity_starts_at: null,
  activity_ends_at: null,
  revoke_at: null,
  concurrency_limit: null,
  condition: createConditionGroup()
})

const selectedGroup = computed(() => groups.value.find((group) => group.id === form.group_id))
const grantGroups = computed(() => groups.value.filter((group) => group.exclusive))
const activeGrantGroups = computed(() =>
  grantGroups.value.filter((group) => group.status === 'active')
)
const availableGrantGroups = computed(() =>
  activeGrantGroups.value.filter((group) => !group.rule_id)
)
const activeRuleCount = computed(() =>
  rules.value.filter((rule) => ruleStatus(rule) === 'active').length
)
const filteredRules = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return rules.value
  return rules.value.filter((rule) =>
    `${rule.name} ${groupName(rule)}`.toLowerCase().includes(keyword)
  )
})

async function refreshRules(): Promise<void> {
  const ruleResult = await getGroupGrantRules()
  rules.value = ruleResult.items
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [groupResult] = await Promise.all([
      getSub2ApiGroups(),
      refreshRules()
    ])
    groups.value = groupResult
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

function resetForm(): void {
  Object.assign(form, {
    name: '',
    group_id: availableGrantGroups.value[0]?.id || 0,
    enabled: true,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: '',
    activity_starts_at: null,
    activity_ends_at: null,
    revoke_at: null,
    concurrency_limit: null,
    condition: createConditionGroup()
  })
}

function openCreate(): void {
  if (availableGrantGroups.value.length === 0) {
    notices.show('没有可新建规则的专属分组', 'error')
    return
  }
  editingId.value = null
  resetForm()
  editorOpen.value = true
}

function openEdit(rule: GroupGrantRule): void {
  editingId.value = rule.id
  Object.assign(form, {
    name: rule.name,
    group_id: rule.group_id,
    enabled: rule.enabled,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: rule.activity_description,
    activity_starts_at: toLocalDateTime(rule.activity_starts_at),
    activity_ends_at: toLocalDateTime(rule.activity_ends_at),
    revoke_at: toLocalDateTime(rule.revoke_at),
    concurrency_limit: rule.concurrency_limit ?? null,
    condition: normalizeCondition(rule.condition)
  })
  editorOpen.value = true
}

function updateCondition(condition: ConditionNode): void {
  form.condition = condition
}

function groupName(rule: GroupGrantRule): string {
  return groups.value.find((group) => group.id === rule.group_id)?.name || rule.group_name || `分组 #${rule.group_id}`
}

function ruleStatus(rule: GroupGrantRule) {
  return groupGrantLifecycleStatus(rule, lifecycleNow.value)
}

function inputFromRule(rule: GroupGrantRule, enabled = rule.enabled): GroupGrantRuleInput {
  return {
    name: rule.name,
    group_id: rule.group_id,
    enabled,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: rule.activity_description,
    activity_starts_at: rule.activity_starts_at ?? null,
    activity_ends_at: rule.activity_ends_at ?? null,
    revoke_at: rule.revoke_at ?? null,
    concurrency_limit: rule.concurrency_limit ?? null,
    condition: rule.condition
  }
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    notices.show('请填写规则名称', 'error')
    return
  }
  const target = groups.value.find((group) => group.id === form.group_id)
  if (!target || !target.exclusive || target.status !== 'active') {
    notices.show('请选择一个已启用的 Sub2API 专属分组', 'error')
    return
  }
  if (form.revoke_at && !form.activity_ends_at) {
    notices.show('设置分组撤销时间前必须先设置活动结束时间', 'error')
    return
  }
  if (
    form.revoke_at &&
    form.activity_ends_at &&
    new Date(form.revoke_at).getTime() <= new Date(form.activity_ends_at).getTime()
  ) {
    notices.show('分组撤销时间必须晚于活动结束时间', 'error')
    return
  }
  if (
    form.concurrency_limit !== null &&
    form.concurrency_limit !== undefined &&
    (!Number.isInteger(form.concurrency_limit) || form.concurrency_limit < 1 || form.concurrency_limit > 100000)
  ) {
    notices.show('申请后并发数必须是 1 至 100000 之间的整数，留空表示不修改', 'error')
    return
  }
  saving.value = true
  const payload: GroupGrantRuleInput = {
    name: form.name.trim(),
    group_id: Number(form.group_id),
    enabled: form.enabled,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: form.activity_description.trim(),
    activity_starts_at: fromActivityDateTimeInput(form.activity_starts_at),
    activity_ends_at: fromActivityDateTimeInput(form.activity_ends_at),
    revoke_at: fromActivityDateTimeInput(form.revoke_at),
    concurrency_limit:
      form.concurrency_limit === null || form.concurrency_limit === undefined
        ? null
        : Number(form.concurrency_limit),
    condition: normalizeCondition(form.condition)
  }
  try {
    if (editingId.value) await updateGroupGrantRule(editingId.value, payload)
    else await createGroupGrantRule(payload)
    notices.show(editingId.value ? '授权规则已更新' : '授权规则已创建', 'success')
    editorOpen.value = false
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(rule: GroupGrantRule): Promise<void> {
  try {
    const updated = await updateGroupGrantRule(rule.id, inputFromRule(rule, !rule.enabled))
    rules.value = rules.value.map((item) => (item.id === rule.id ? updated : item))
    notices.show(updated.enabled ? '授权规则已启用' : '授权规则已停用', 'success')
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  }
}

async function confirmDelete(): Promise<void> {
  const rule = deleting.value
  if (!rule) return
  deletingBusy.value = true
  try {
    await deleteGroupGrantRule(rule.id)
    notices.show('授权规则已删除', 'success')
    deleting.value = null
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    deletingBusy.value = false
  }
}

async function confirmRevoke(): Promise<void> {
  const rule = revoking.value
  if (!rule) return
  revokingBusy.value = true
  try {
    const result = await revokeGroupGrantRule(rule.id)
    notices.show(`已提前撤销 ${result.revoked_count} 个活动授权`, 'success')
    revoking.value = null
    await load()
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    revokingBusy.value = false
  }
}

function formatMultiplier(value?: number): string {
  if (value === undefined) return '倍率未返回'
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}x`
}

function groupDisabled(group: Sub2ApiGroup): boolean {
  if (!group.exclusive || group.status !== 'active') return true
  return Boolean(group.rule_id && group.rule_id !== editingId.value)
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

function toLocalDateTime(value?: string | null): string | null {
  return toActivityDateTimeInput(value)
}

onMounted(() => {
  load()
  lifecycleTimer = setInterval(async () => {
    lifecycleNow.value = Date.now()
    try { await refreshRules() } catch { /* the visible refresh action reports persistent failures */ }
  }, 10_000)
})

onBeforeUnmount(() => {
  if (lifecycleTimer) clearInterval(lifecycleTimer)
  lifecycleTimer = null
})
</script>

<template>
  <div class="page">
    <PageHeader title="分组资格" description="用户主动申请时，实时检查余额与充值条件并加入 Sub2API 专属分组。">
      <template #actions>
        <button class="button button--quiet" type="button" :disabled="loading" @click="load">
          <Refresh :class="{ spinning: loading }" />
          刷新
        </button>
        <button
          class="button button--primary"
          type="button"
          :disabled="availableGrantGroups.length === 0"
          :title="availableGrantGroups.length === 0 ? '所有可用专属分组都已配置规则' : '新建规则'"
          @click="openCreate"
        >
          <Plus />
          新建规则
        </button>
      </template>
    </PageHeader>

    <div v-if="loading" class="skeleton-list">
      <div class="skeleton-row skeleton-row--title" />
      <div v-for="index in 5" :key="index" class="skeleton-row" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="load" />

    <template v-else>
      <section class="summary-strip" aria-label="授权摘要">
        <div><span>授权规则</span><strong>{{ rules.length }}</strong></div>
        <div><span>进行中</span><strong>{{ activeRuleCount }}</strong></div>
        <div><span>专属分组</span><strong>{{ activeGrantGroups.length }}</strong></div>
        <div><span>申请方式</span><strong>用户手动申请</strong></div>
      </section>

      <div class="toolbar grant-toolbar">
        <label class="search-control">
          <Search />
          <input v-model="search" type="search" placeholder="搜索规则或分组" aria-label="搜索规则或分组" />
        </label>
        <span class="toolbar__count">共 {{ rules.length }} 条规则</span>
      </div>

      <EmptyState
        v-if="rules.length === 0"
        :title="activeGrantGroups.length === 0 ? '没有可配置的专属分组' : '还没有资格规则'"
        :description="activeGrantGroups.length === 0
          ? '请先在 Sub2API 将目标分组设为已启用的专属分组，然后刷新本页。'
          : '创建规则并选择目标专属分组。用户申请时才会判断和授权。'"
      >
        <button
          v-if="availableGrantGroups.length > 0"
          class="button button--primary"
          type="button"
          @click="openCreate"
        >
          <Plus />
          新建规则
        </button>
      </EmptyState>
      <EmptyState
        v-else-if="filteredRules.length === 0"
        title="没有匹配结果"
        description="尝试更换搜索关键词。"
      />
      <div v-else class="data-table-wrap">
        <table class="data-table grant-rules-table">
          <thead>
            <tr>
              <th>规则</th>
              <th>目标分组</th>
              <th>申请条件</th>
              <th>活动时间</th>
              <th>状态</th>
              <th class="cell-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in filteredRules" :key="rule.id">
              <td>
                <strong>{{ rule.name }}</strong>
                <small>用户手动申请 · 规则 #{{ rule.id }}</small>
              </td>
              <td>
                <strong>{{ groupName(rule) }}</strong>
                <small>{{ groups.find((group) => group.id === rule.group_id)?.exclusive ? '专属分组' : '普通分组' }}</small>
                <small v-if="rule.concurrency_limit">申请后并发 {{ rule.concurrency_limit }}</small>
              </td>
              <td class="condition-cell"><ConditionSummary :condition="rule.condition" /></td>
              <td>
                <strong>{{ formatDate(rule.activity_starts_at || undefined) }}</strong>
                <small>申请至 {{ formatDate(rule.activity_ends_at || undefined) }}</small>
                <small>撤销于 {{ formatDate(rule.revoke_at || undefined) }}</small>
              </td>
              <td>
                <button class="status-button" type="button" @click="toggleEnabled(rule)">
                  <StatusBadge :status="ruleStatus(rule)" />
                </button>
              </td>
              <td class="cell-actions">
                <button class="icon-button icon-button--danger" type="button" title="提前撤销活动分组" @click="revoking = rule">
                  <CircleClose />
                </button>
                <button class="icon-button" type="button" title="编辑规则" @click="openEdit(rule)">
                  <EditPen />
                </button>
                <button class="icon-button icon-button--danger" type="button" title="删除规则" @click="deleting = rule">
                  <Delete />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <ModalDialog
      :open="editorOpen"
      :title="editingId ? '编辑授权规则' : '新建授权规则'"
      width="820px"
      @close="editorOpen = false"
    >
      <form id="group-grant-form" class="form-stack" @submit.prevent="save">
        <div class="form-grid grant-form-grid">
          <label class="field">
            <span>规则名称</span>
            <input v-model="form.name" class="control" maxlength="120" required />
          </label>
          <label class="field">
            <span>目标 Sub2API 分组</span>
            <select v-model.number="form.group_id" class="control" :disabled="Boolean(editingId)" required>
              <option :value="0" disabled>请选择分组</option>
              <option
                v-for="group in grantGroups"
                :key="group.id"
                :value="group.id"
                :disabled="groupDisabled(group)"
              >
                {{ group.name }} · {{ formatMultiplier(group.multiplier) }}{{ group.exclusive ? ' · 专属' : ' · 非专属' }}{{ group.status === 'inactive' ? ' · 已停用' : '' }}{{ group.rule_id && group.rule_id !== editingId ? ' · 已配置' : '' }}
              </option>
            </select>
          </label>
        </div>

        <div v-if="selectedGroup" class="selected-group-detail">
          <span>{{ selectedGroup.name }}</span>
          <strong>{{ formatMultiplier(selectedGroup.multiplier) }}</strong>
          <StatusBadge :status="selectedGroup.status === 'active' ? 'enabled' : 'disabled'" />
          <small>{{ selectedGroup.exclusive ? '专属分组' : '普通分组' }}</small>
        </div>

        <section class="form-section">
          <div class="form-section__heading">
            <div>
              <h3>用户申请</h3>
              <p>活动会显示在用户活动中心。只有用户点击申请后，系统才实时查询该用户并判断条件。</p>
            </div>
          </div>
          <div class="selected-group-detail" aria-label="授权方式">
            <span>用户手动申请</span>
            <small>不会扫描或自动加入其他用户</small>
          </div>
          <label class="field">
            <span>活动说明</span>
            <textarea v-model="form.activity_description" class="control" rows="2" maxlength="500" placeholder="例如：充值用户可申请狂欢分组资格" />
          </label>
          <label class="field">
            <span>申请后用户并发数（可选）</span>
            <input
              v-model.number="form.concurrency_limit"
              class="control"
              type="number"
              min="1"
              max="100000"
              step="1"
              placeholder="留空表示不修改"
            />
            <small class="field-hint">用户申请成功后临时设置；活动结束或提前撤销时恢复申请前的并发数。</small>
          </label>
          <div class="form-grid lifecycle-time-grid">
            <label class="field">
              <span>开始时间（可选）</span>
              <input v-model="form.activity_starts_at" class="control" type="datetime-local" />
            </label>
            <label class="field">
              <span>活动结束时间（结束后用户不可见）</span>
              <input v-model="form.activity_ends_at" class="control" type="datetime-local" />
            </label>
            <label class="field">
              <span>分组撤销时间（可选）</span>
              <input v-model="form.revoke_at" class="control" type="datetime-local" />
            </label>
          </div>
        </section>

        <div class="rule-switches">
          <label class="toggle-row">
            <input v-model="form.enabled" type="checkbox" />
            <span class="toggle" />
            <span>
              <strong>启用规则</strong>
              <small>停用后活动不会显示，用户也不能申请</small>
            </span>
          </label>
        </div>

        <section class="form-section">
          <div class="form-section__heading">
            <div>
              <h3>申请条件</h3>
              <p>留空表示所有用户符合；余额与充值状态可使用 AND/OR 嵌套组合。</p>
            </div>
          </div>
          <ConditionEditor :model-value="form.condition" @update:model-value="updateCondition" />
        </section>
      </form>
      <template #footer>
        <button class="button button--quiet" type="button" :disabled="saving" @click="editorOpen = false">
          取消
        </button>
        <button class="button button--primary" type="submit" form="group-grant-form" :disabled="saving">
          {{ saving ? '保存中…' : '保存规则' }}
        </button>
      </template>
    </ModalDialog>

    <ConfirmDialog
      :open="Boolean(revoking)"
      title="提前撤销活动分组"
      :message="`确定提前结束“${revoking?.name || ''}”并撤销本活动发放的分组吗？活动会立即停用，用户原有授权和其他分组不会变更。`"
      confirm-label="提前撤销"
      danger
      :busy="revokingBusy"
      @close="revoking = null"
      @confirm="confirmRevoke"
    />

    <ConfirmDialog
      :open="Boolean(deleting)"
      title="删除授权规则"
      :message="`删除“${deleting?.name || ''}”时，将撤销本扩展通过用户申请添加的目标分组；管理员原有授权和其他分组不会变更。`"
      confirm-label="撤销并删除"
      danger
      :busy="deletingBusy"
      @close="deleting = null"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.summary-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 4px 0 18px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.summary-strip > div {
  display: grid;
  gap: 6px;
  min-width: 0;
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
  overflow: hidden;
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grant-toolbar {
  margin-top: 14px;
}

.grant-rules-table {
  min-width: 1080px;
}

.condition-cell {
  max-width: 330px;
  color: var(--text-secondary);
  line-height: 1.55;
}

.status-button {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.grant-form-grid {
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
}

.lifecycle-time-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.selected-group-detail {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
}

.selected-group-detail span {
  font-weight: 620;
}

.selected-group-detail strong {
  color: var(--accent);
}

.selected-group-detail small {
  margin-left: auto;
  color: var(--text-muted);
}

.rule-switches {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
}

@media (max-width: 720px) {
  .summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .summary-strip > div:nth-child(3) {
    border-top: 1px solid var(--border);
    border-left: 0;
  }

  .summary-strip > div:nth-child(4) {
    border-top: 1px solid var(--border);
  }

  .grant-form-grid,
  .lifecycle-time-grid,
  .rule-switches {
    grid-template-columns: 1fr;
  }

  .selected-group-detail {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .selected-group-detail small {
    width: 100%;
    margin-left: 0;
  }
}
</style>

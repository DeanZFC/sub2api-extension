<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, EditPen, Plus, Search, View } from '@element-plus/icons-vue'
import {
  createLottery,
  deleteLottery,
  getLotteries,
  updateLottery
} from '@/api/lotteries'
import { errorMessage } from '@/api/client'
import { getSub2ApiGroups } from '@/api/groupGrants'
import ConditionEditor from '@/components/ConditionEditor.vue'
import ConditionSummary from '@/components/ConditionSummary.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import ModalDialog from '@/components/ModalDialog.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { createConditionGroup, normalizeCondition } from '@/domain/conditions'
import { fromActivityDateTimeInput, toActivityDateTimeInput } from '@/domain/time'
import { useNotificationsStore } from '@/stores/notifications'
import type {
  ConditionNode,
  Lottery,
  LotteryInput,
  LotteryPrize,
  LotteryStatus,
  Sub2ApiGroup
} from '@/types/domain'

const notices = useNotificationsStore()
const lotteries = ref<Lottery[]>([])
const groups = ref<Sub2ApiGroup[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const statusFilter = ref<'all' | LotteryStatus>('all')
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const deleting = ref<Lottery | null>(null)
const deletingBusy = ref(false)

const createPrize = (sortOrder = 0): LotteryPrize => ({
  name: sortOrder === 0 ? '余额奖励' : `奖项 ${sortOrder + 1}`,
  winner_count: 1,
  reward_type: 'balance',
  reward_value: 10,
  validity_days: 30,
  sort_order: sortOrder
})

const form = reactive<LotteryInput>({
  name: '',
  description: '',
  starts_at: null,
  ends_at: null,
  auto_draw_at: null,
  condition: createConditionGroup(),
  prizes: [createPrize()]
})

const totalWinnerCount = computed(() =>
  form.prizes.reduce((total, prize) => total + Math.max(0, Number(prize.winner_count) || 0), 0)
)

const subscriptionGroups = computed(() =>
  groups.value.filter(
    (group) => group.status === 'active' && (!group.subscription_type || group.subscription_type === 'subscription')
  )
)

const filteredLotteries = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return lotteries.value.filter((lottery) => {
    const matchesStatus = statusFilter.value === 'all' || lottery.status === statusFilter.value
    const matchesKeyword =
      !keyword || `${lottery.name} ${lottery.description}`.toLowerCase().includes(keyword)
    return matchesStatus && matchesKeyword
  })
})

const deleteMessage = computed(() => {
  const lottery = deleting.value
  if (!lottery) return ''
  const participation = lottery.entry_count
    ? `已有 ${lottery.entry_count} 人参与，参与、候选及中奖记录也会一并删除。`
    : ''
  const fulfilled = lottery.status === 'fulfilled'
    ? '已经发放到 Sub2API 的余额、并发额度或订阅不会撤回。'
    : ''
  return `确定删除“${lottery.name}”吗？${participation}${fulfilled}此操作不可撤销。`
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [lotteryPage, groupItems] = await Promise.all([getLotteries(), getSub2ApiGroups()])
    lotteries.value = lotteryPage.items
    groups.value = groupItems
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
    starts_at: null,
    ends_at: null,
    auto_draw_at: null,
    condition: createConditionGroup(),
    prizes: [createPrize()]
  })
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  editorOpen.value = true
}

function openEdit(lottery: Lottery): void {
  if (!isMutable(lottery)) return
  editingId.value = lottery.id
  Object.assign(form, {
    name: lottery.name,
    description: lottery.description,
    starts_at: toLocalDateTime(lottery.starts_at),
    ends_at: toLocalDateTime(lottery.ends_at),
    auto_draw_at: toLocalDateTime(lottery.auto_draw_at),
    condition: normalizeCondition(lottery.condition),
    prizes: lottery.prizes.map((prize) => ({ ...prize }))
  })
  editorOpen.value = true
}

function updateCondition(condition: ConditionNode): void {
  form.condition = condition
}

function addPrize(): void {
  form.prizes.push(createPrize(form.prizes.length))
}

function removePrize(index: number): void {
  if (form.prizes.length === 1) {
    notices.show('抽奖至少需要保留一个奖项', 'error')
    return
  }
  form.prizes.splice(index, 1)
}

function normalizePrizeType(prize: LotteryPrize): void {
  if (prize.reward_type === 'balance') prize.reward_value = Math.max(0.01, Number(prize.reward_value) || 10)
  if (prize.reward_type === 'concurrency') prize.reward_value = Math.max(1, Math.round(Number(prize.reward_value) || 1))
  if (prize.reward_type === 'subscription') {
    prize.reward_value = 1
    prize.validity_days = Math.max(1, Math.round(Number(prize.validity_days) || 30))
    if (!prize.group_id && subscriptionGroups.value[0]) {
      prize.group_id = subscriptionGroups.value[0].id
    }
  }
  if (prize.reward_type === 'physical' || prize.reward_type === 'manual') prize.reward_value = 0
}

function validate(): boolean {
  if (!form.name.trim()) {
    notices.show('请填写抽奖名称', 'error')
    return false
  }
  if (form.prizes.length === 0 || form.prizes.some((prize) => !prize.name.trim())) {
    notices.show('请完整填写奖项名称', 'error')
    return false
  }
  if (form.prizes.some((prize) => prize.winner_count < 1)) {
    notices.show('每个奖项的中奖人数至少为 1', 'error')
    return false
  }
  if (form.prizes.some((prize) => prize.reward_type === 'balance' && prize.reward_value <= 0)) {
    notices.show('余额奖励必须大于 0', 'error')
    return false
  }
  if (form.prizes.some((prize) => prize.reward_type === 'concurrency' && (!Number.isInteger(Number(prize.reward_value)) || prize.reward_value < 1))) {
    notices.show('并发额度必须是大于 0 的整数', 'error')
    return false
  }
  if (form.prizes.some((prize) => prize.reward_type === 'subscription' && (!prize.group_id || !Number.isInteger(Number(prize.validity_days)) || Number(prize.validity_days) < 1))) {
    notices.show('订阅奖励必须选择分组并填写有效天数', 'error')
    return false
  }
  if (form.starts_at && form.auto_draw_at && new Date(form.auto_draw_at) <= new Date(form.starts_at)) {
    notices.show('自动开奖时间必须晚于活动开始时间', 'error')
    return false
  }
  return true
}

async function save(): Promise<void> {
  if (!validate()) return
  saving.value = true
  const payload: LotteryInput = {
    name: form.name.trim(),
    description: form.description.trim(),
    starts_at: fromActivityDateTimeInput(form.starts_at),
    ends_at: fromActivityDateTimeInput(form.ends_at),
    auto_draw_at: fromActivityDateTimeInput(form.auto_draw_at),
    condition: normalizeCondition(form.condition),
    prizes: form.prizes.map((prize, index) => ({
      ...prize,
      name: prize.name.trim(),
      winner_count: Number(prize.winner_count),
      reward_value: prize.reward_type === 'manual' || prize.reward_type === 'physical'
        ? 0
        : prize.reward_type === 'subscription' ? 1 : Number(prize.reward_value),
      ...(prize.reward_type === 'subscription'
        ? { group_id: Number(prize.group_id), validity_days: Number(prize.validity_days) }
        : {}),
      sort_order: index
    }))
  }
  try {
    const wasActive = editingId.value
      ? lotteries.value.find((lottery) => lottery.id === editingId.value)?.status === 'active'
      : false
    const lottery = editingId.value
      ? await updateLottery(editingId.value, payload)
      : await createLottery(payload)
    notices.show(
      editingId.value
        ? wasActive ? '抽奖设置已更新，原有参与记录已保留' : '抽奖设置已更新'
        : '抽奖已创建',
      'success'
    )
    editorOpen.value = false
    if (editingId.value) await load()
    else window.location.assign(`/admin/lotteries/${encodeURIComponent(lottery.id)}`)
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
    await deleteLottery(deleting.value.id)
    lotteries.value = lotteries.value.filter((lottery) => lottery.id !== deleting.value?.id)
    notices.show('抽奖已删除', 'success')
    deleting.value = null
  } catch (cause) {
    notices.show(errorMessage(cause), 'error')
  } finally {
    deletingBusy.value = false
  }
}

function toLocalDateTime(value?: string | null): string | null {
  return toActivityDateTimeInput(value)
}

function isMutable(lottery: Lottery): boolean {
  return lottery.status === 'not_started' || lottery.status === 'active'
}

function isDeletable(lottery: Lottery): boolean {
  return isMutable(lottery) || lottery.status === 'fulfilled'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <PageHeader title="抽奖管理" description="用户主动参与后，可按计划自动开奖，也可由管理员手动开奖。">
      <template #actions>
        <button class="button button--primary" type="button" @click="openCreate">
          <Plus />
          新建抽奖
        </button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <label class="search-control">
        <Search />
        <input v-model="search" type="search" placeholder="搜索抽奖" aria-label="搜索抽奖" />
      </label>
      <select v-model="statusFilter" class="control toolbar__select" aria-label="按状态筛选">
        <option value="all">全部状态</option>
        <option value="not_started">未启动</option>
        <option value="active">进行中</option>
        <option value="drawn">已开奖</option>
        <option value="fulfilled">已完成</option>
        <option value="failed">处理失败</option>
      </select>
      <span class="toolbar__count">共 {{ lotteries.length }} 场</span>
    </div>

    <div v-if="loading" class="skeleton-list">
      <div v-for="index in 4" :key="index" class="skeleton-row" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="load" />
    <EmptyState
      v-else-if="lotteries.length === 0"
      title="还没有抽奖"
      description="创建抽奖并启动后，用户可主动参与。"
    >
      <button class="button button--primary" type="button" @click="openCreate">
        <Plus />
        新建抽奖
      </button>
    </EmptyState>
    <EmptyState
      v-else-if="filteredLotteries.length === 0"
      title="没有匹配结果"
      description="尝试更换搜索词或状态筛选。"
    />

    <div v-else class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>抽奖</th>
            <th>参与条件</th>
            <th>参与</th>
            <th>候选</th>
            <th>中奖人数</th>
            <th>状态</th>
            <th class="cell-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lottery in filteredLotteries" :key="lottery.id">
            <td>
              <strong>{{ lottery.name }}</strong>
              <small>{{ lottery.prizes.map((prize) => prize.name).join('、') }}</small>
            </td>
            <td class="condition-cell"><ConditionSummary :condition="lottery.condition" /></td>
            <td>{{ lottery.entry_count }}</td>
            <td>{{ lottery.snapshot_at ? lottery.candidate_count : '—' }}</td>
            <td>{{ lottery.winners_count }}</td>
            <td><StatusBadge :status="lottery.status" /></td>
            <td class="cell-actions">
              <RouterLink
                class="icon-button"
                :to="`/admin/lotteries/${lottery.id}`"
                title="查看抽奖"
                aria-label="查看抽奖"
              >
                <View />
              </RouterLink>
              <button
                class="icon-button"
                type="button"
                :disabled="!isMutable(lottery)"
                :title="isMutable(lottery) ? '编辑抽奖' : '开奖处理开始后不能编辑'"
                @click="openEdit(lottery)"
              >
                <EditPen />
              </button>
              <button
                class="icon-button icon-button--danger"
                type="button"
                :disabled="!isDeletable(lottery)"
                :title="isDeletable(lottery) ? '删除抽奖' : '开奖或发奖处理中不能删除'"
                @click="deleting = lottery"
              >
                <Delete />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalDialog
      :open="editorOpen"
      :title="editingId ? '编辑抽奖' : '新建抽奖'"
      width="820px"
      @close="editorOpen = false"
    >
      <form id="lottery-form" class="form-stack" @submit.prevent="save">
        <label class="field">
          <span>抽奖名称</span>
          <input v-model="form.name" class="control" maxlength="80" required />
        </label>
        <label class="field">
          <span>活动说明</span>
          <textarea v-model="form.description" class="control" rows="3" maxlength="300" />
        </label>

        <div class="form-grid">
          <label class="field">
            <span>开始时间（可选）</span>
            <input v-model="form.starts_at" class="control" type="datetime-local" />
          </label>
          <label class="field">
            <span>结束时间（可选）</span>
            <input v-model="form.ends_at" class="control" type="datetime-local" />
          </label>
          <label class="field">
            <span>自动开奖时间（可选）</span>
            <input v-model="form.auto_draw_at" class="control" type="datetime-local" />
            <small>不填写则仅由管理员手动开奖</small>
          </label>
        </div>
        <section class="form-section">
          <div class="form-section__heading">
            <div>
              <h3>参与条件</h3>
              <p>用户点击参与时实时检查；开奖只会从成功参与的用户中抽取。</p>
            </div>
          </div>
          <ConditionEditor :model-value="form.condition" @update:model-value="updateCondition" />
        </section>

        <section class="form-section">
          <div class="form-section__heading">
            <div>
              <h3>奖项设置</h3>
              <p>共抽取 {{ totalWinnerCount }} 人，同一用户不会重复中奖。</p>
            </div>
            <button class="button button--quiet button--small" type="button" @click="addPrize">
              <Plus />
              添加奖项
            </button>
          </div>
          <div class="prize-list">
            <div v-for="(prize, index) in form.prizes" :key="index" class="prize-row">
              <span class="prize-row__index">{{ index + 1 }}</span>
              <label class="field">
                <span>奖项名称</span>
                <input v-model="prize.name" class="control" maxlength="50" required />
              </label>
              <label class="field">
                <span>发放方式</span>
                <select v-model="prize.reward_type" class="control" @change="normalizePrizeType(prize)">
                  <option value="balance">余额自动发放</option>
                  <option value="concurrency">并发额度自动发放</option>
                  <option value="subscription">订阅自动发放</option>
                  <option value="physical">实体奖品</option>
                  <option value="manual">其他人工奖品</option>
                </select>
              </label>
              <label v-if="prize.reward_type === 'balance'" class="field field--number">
                <span>每人余额</span>
                <input v-model.number="prize.reward_value" class="control" type="number" min="0.01" step="0.01" />
              </label>
              <label v-else-if="prize.reward_type === 'concurrency'" class="field field--number">
                <span>每人并发额度</span>
                <input v-model.number="prize.reward_value" class="control" type="number" min="1" step="1" />
              </label>
              <div v-else-if="prize.reward_type === 'subscription'" class="field prize-subscription-field">
                <span>订阅内容</span>
                <div class="prize-subscription-config">
                  <select v-model.number="prize.group_id" class="control" aria-label="订阅分组">
                    <option :value="undefined" disabled>选择订阅分组</option>
                    <option v-for="group in subscriptionGroups" :key="group.id" :value="group.id">
                      {{ group.name }}
                    </option>
                  </select>
                  <input v-model.number="prize.validity_days" class="control" type="number" min="1" max="3650" step="1" aria-label="订阅天数" />
                  <span class="prize-unit">天</span>
                </div>
              </div>
              <div v-else class="field field--number">
                <span>发放处理</span>
                <div class="control control--readonly">开奖后人工确认</div>
              </div>
              <label class="field field--number">
                <span>人数</span>
                <input v-model.number="prize.winner_count" class="control" type="number" min="1" step="1" />
              </label>
              <button
                class="icon-button icon-button--danger prize-row__delete"
                type="button"
                title="删除奖项"
                @click="removePrize(index)"
              >
                <Delete />
              </button>
            </div>
          </div>
        </section>
      </form>
      <template #footer>
        <button class="button button--quiet" type="button" :disabled="saving" @click="editorOpen = false">
          取消
        </button>
        <button class="button button--primary" type="submit" form="lottery-form" :disabled="saving">
          {{ saving ? '保存中…' : '保存抽奖' }}
        </button>
      </template>
    </ModalDialog>

    <ConfirmDialog
      :open="Boolean(deleting)"
      title="删除抽奖"
      :message="deleteMessage"
      confirm-label="删除"
      danger
      :busy="deletingBusy"
      @close="deleting = null"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.condition-cell {
  max-width: 360px;
  color: var(--text-secondary);
  line-height: 1.55;
}

.prize-list {
  display: grid;
  gap: 8px;
}

.prize-row {
  display: grid;
  grid-template-columns: 28px minmax(120px, 1.1fr) minmax(140px, 1fr) minmax(150px, 1.35fr) 72px 34px;
  align-items: end;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.prize-subscription-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 70px auto;
  align-items: center;
  gap: 6px;
}

.prize-unit {
  color: var(--text-muted);
  font-size: 12px;
}

.prize-row__index {
  display: grid;
  place-items: center;
  width: 24px;
  height: 34px;
  color: var(--text-muted);
  font-size: 12px;
}

.prize-row__delete {
  margin-bottom: 0;
}

@media (max-width: 760px) {
  .prize-row {
    grid-template-columns: 28px minmax(0, 1fr) 34px;
  }

  .prize-row .field {
    grid-column: 2;
  }

  .prize-row__delete {
    grid-column: 3;
    grid-row: 1;
  }
}
</style>

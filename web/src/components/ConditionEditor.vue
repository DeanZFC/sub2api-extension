<script setup lang="ts">
import { computed } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import { createConditionGroup, createFactCondition } from '@/domain/conditions'
import type { ConditionNode, FactKey, LogicOperator, NumericOperator } from '@/types/domain'

const props = withDefaults(
  defineProps<{
    modelValue: ConditionNode
    depth?: number
    removable?: boolean
  }>(),
  { depth: 0, removable: false }
)

const emit = defineEmits<{
  'update:modelValue': [value: ConditionNode]
  remove: []
}>()

const isGroup = computed(() => props.modelValue.type === 'group')

function setLogicOperator(operator: LogicOperator): void {
  if (props.modelValue.type !== 'group') return
  emit('update:modelValue', { ...props.modelValue, operator })
}

function setFact(fact: FactKey): void {
  emit('update:modelValue', createFactCondition(fact))
}

function setNumericOperator(operator: NumericOperator): void {
  if (props.modelValue.type !== 'fact') return
  emit('update:modelValue', { ...props.modelValue, operator })
}

function setValue(value: number): void {
  if (props.modelValue.type !== 'fact') return
  emit('update:modelValue', { ...props.modelValue, value })
}

function setWindowDays(value: number): void {
  if (props.modelValue.type !== 'fact' || props.modelValue.fact !== 'recent_recharge_total') return
  emit('update:modelValue', { ...props.modelValue, window_days: value })
}

function updateChild(index: number, child: ConditionNode): void {
  if (props.modelValue.type !== 'group') return
  const children = props.modelValue.children.slice()
  children[index] = child
  emit('update:modelValue', { ...props.modelValue, children })
}

function removeChild(index: number): void {
  if (props.modelValue.type !== 'group') return
  emit('update:modelValue', {
    ...props.modelValue,
    children: props.modelValue.children.filter((_, childIndex) => childIndex !== index)
  })
}

function addFact(): void {
  if (props.modelValue.type !== 'group') return
  emit('update:modelValue', {
    ...props.modelValue,
    children: [...props.modelValue.children, createFactCondition()]
  })
}

function addGroup(): void {
  if (props.modelValue.type !== 'group') return
  emit('update:modelValue', {
    ...props.modelValue,
    children: [...props.modelValue.children, createConditionGroup()]
  })
}
</script>

<template>
  <div class="condition-node" :class="{ 'condition-node--group': isGroup }">
    <template v-if="modelValue.type === 'group'">
      <div class="condition-group__header">
        <div class="segment" aria-label="组合方式">
          <button
            type="button"
            :class="{ active: modelValue.operator === 'and' }"
            @click="setLogicOperator('and')"
          >
            同时满足
          </button>
          <button
            type="button"
            :class="{ active: modelValue.operator === 'or' }"
            @click="setLogicOperator('or')"
          >
            任一满足
          </button>
        </div>
        <button
          v-if="removable"
          class="icon-button icon-button--danger"
          type="button"
          title="删除条件组"
          aria-label="删除条件组"
          @click="emit('remove')"
        >
          <Delete />
        </button>
      </div>

      <div v-if="modelValue.children.length" class="condition-group__children">
        <ConditionEditor
          v-for="(child, index) in modelValue.children"
          :key="index"
          :model-value="child"
          :depth="(depth ?? 0) + 1"
          removable
          @update:model-value="updateChild(index, $event)"
          @remove="removeChild(index)"
        />
      </div>
      <div v-else class="condition-empty">当前没有限制，将对所有用户生效。</div>

      <div class="condition-group__actions">
        <button class="button button--quiet button--small" type="button" @click="addFact">
          <Plus />
          添加条件
        </button>
        <button
          v-if="(depth ?? 0) < 3"
          class="button button--quiet button--small"
          type="button"
          @click="addGroup"
        >
          <Plus />
          添加条件组
        </button>
      </div>
    </template>

    <template v-else>
      <div class="condition-fact">
        <select
          class="control condition-fact__name"
          aria-label="事实字段"
          :value="modelValue.fact"
          @change="setFact(($event.target as HTMLSelectElement).value as FactKey)"
        >
          <option value="current_balance">当前余额</option>
          <option value="recharge_total">累计充值金额</option>
          <option value="recent_recharge_total">近期充值金额</option>
        </select>

        <label v-if="modelValue.fact === 'recent_recharge_total'" class="condition-window">
          <span>最近</span>
          <input
            class="control"
            type="number"
            min="1"
            max="365"
            step="1"
            :value="modelValue.window_days || 7"
            aria-label="充值时间范围（天）"
            @input="setWindowDays(Number(($event.target as HTMLInputElement).value))"
          />
          <span>天</span>
        </label>

        <select
          class="control condition-fact__operator"
          aria-label="比较方式"
          :value="modelValue.operator"
          @change="setNumericOperator(($event.target as HTMLSelectElement).value as NumericOperator)"
        >
          <option value="gt">大于</option>
          <option value="gte">大于等于</option>
          <option value="eq">等于</option>
          <option value="lt">小于</option>
          <option value="lte">小于等于</option>
        </select>
        <label class="amount-input">
          <span>$</span>
          <input
            class="control"
            type="number"
            min="0"
            step="0.01"
            :value="modelValue.value"
            :aria-label="modelValue.fact === 'current_balance' ? '余额门槛' : modelValue.fact === 'recharge_total' ? '累计充值金额门槛' : '近期充值金额门槛'"
            @input="setValue(Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <button
          v-if="removable"
          class="icon-button icon-button--danger"
          type="button"
          title="删除条件"
          aria-label="删除条件"
          @click="emit('remove')"
        >
          <Delete />
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.condition-node--group {
  border-left: 3px solid var(--border-strong);
  background: var(--surface-muted);
  padding: 12px;
}

.condition-node--group .condition-node--group {
  background: var(--surface);
}

.condition-group__header,
.condition-group__actions,
.condition-fact {
  display: flex;
  align-items: center;
  gap: 8px;
}

.condition-group__header {
  justify-content: space-between;
}

.condition-group__children {
  display: grid;
  gap: 8px;
  margin: 10px 0;
}

.condition-group__actions {
  flex-wrap: wrap;
}

.condition-empty {
  margin: 12px 0;
  color: var(--text-muted);
  font-size: 13px;
}

.condition-fact {
  min-height: 42px;
  padding: 4px 0;
}

.condition-fact__name {
  width: 160px;
}

.condition-fact__operator {
  width: 112px;
}

.condition-fact__value {
  width: 116px;
}

.condition-fact__operator-label {
  color: var(--text-muted);
  font-size: 13px;
}

.amount-input {
  position: relative;
  display: flex;
  align-items: center;
  width: 150px;
}

.condition-window {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 13px;
  white-space: nowrap;
}

.condition-window input {
  width: 70px;
}

.amount-input span {
  position: absolute;
  left: 10px;
  z-index: 1;
  color: var(--text-muted);
}

.amount-input input {
  width: 100%;
  padding-left: 28px;
}

@media (max-width: 620px) {
  .condition-node--group {
    padding: 10px;
  }

  .condition-fact {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 34px;
  }

  .condition-fact__name,
  .condition-fact__operator,
  .condition-fact__value,
  .amount-input {
    width: 100%;
  }

  .condition-fact__name {
    grid-column: 1 / -1;
  }

  .condition-window {
    grid-column: 1 / -1;
  }
}
</style>

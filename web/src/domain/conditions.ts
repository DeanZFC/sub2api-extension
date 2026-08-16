import type {
  ConditionGroup,
  ConditionNode,
  FactCondition,
  FactKey,
  NumericOperator,
  UserFacts
} from '@/types/domain'

export const createFactCondition = (fact: FactKey = 'current_balance'): FactCondition => {
  if (fact === 'recent_recharge_total') {
    return { type: 'fact', fact, operator: 'gte', value: 10, window_days: 7 }
  }
  return {
    type: 'fact',
    fact,
    operator: fact === 'recharge_total' ? 'gt' : 'gte',
    value: 0
  }
}

export const createConditionGroup = (): ConditionGroup => ({
  type: 'group',
  operator: 'and',
  children: [createFactCondition()]
})

export function normalizeCondition(node: ConditionNode): ConditionNode {
  if (node.type === 'fact') {
    const numericValue = Number(node.value)
    const normalized: FactCondition = {
      type: 'fact',
      fact: node.fact,
      operator: node.operator,
      value: Number.isFinite(numericValue) ? numericValue : 0
    }
    if (node.fact === 'recent_recharge_total') {
      const days = Number(node.window_days)
      normalized.window_days = Number.isSafeInteger(days)
        ? Math.min(365, Math.max(1, days))
        : 7
    }
    return normalized
  }

  return {
    type: 'group',
    operator: node.operator,
    children: node.children.map(normalizeCondition)
  }
}

export function evaluateCondition(node: ConditionNode, facts: UserFacts): boolean {
  if (node.type === 'group') {
    if (node.children.length === 0) return true
    return node.operator === 'and'
      ? node.children.every((child) => evaluateCondition(child, facts))
      : node.children.some((child) => evaluateCondition(child, facts))
  }

  const expected = Number(node.value)
  const current = node.fact === 'current_balance'
    ? facts.current_balance
    : node.fact === 'recharge_total'
      ? facts.recharge_total
      : facts.recent_recharge_totals?.[String(node.window_days || 7)] ?? 0
  switch (node.operator as NumericOperator) {
    case 'gt':
      return current > expected
    case 'gte':
      return current >= expected
    case 'eq':
      return current === expected
    case 'lt':
      return current < expected
    case 'lte':
      return current <= expected
  }
}

export function describeCondition(node: ConditionNode): string {
  if (node.type === 'group') {
    const separator = node.operator === 'and' ? ' 且 ' : ' 或 '
    if (node.children.length === 0) return '所有用户'
    return node.children.map((child) => `(${describeCondition(child)})`).join(separator)
  }

  const operatorLabels: Record<NumericOperator, string> = {
    gt: '大于',
    gte: '大于等于',
    eq: '等于',
    lt: '小于',
    lte: '小于等于'
  }
  const subject = node.fact === 'current_balance'
    ? '当前余额'
    : node.fact === 'recharge_total'
      ? '累计充值金额'
      : `最近 ${node.window_days || 7} 天累计充值金额`
  return `${subject}${operatorLabels[node.operator as NumericOperator]} ${Number(node.value).toLocaleString('zh-CN')}`
}

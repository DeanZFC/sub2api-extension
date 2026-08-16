import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { describeCondition, evaluateCondition, normalizeCondition } from './conditions'
import type { ConditionNode } from '@/types/domain'

const rules: ConditionNode = {
  type: 'group',
  operator: 'and',
  children: [
    { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 },
    {
      type: 'group',
      operator: 'or',
      children: [
        { type: 'fact', fact: 'current_balance', operator: 'gt', value: 100 },
        { type: 'fact', fact: 'current_balance', operator: 'eq', value: 100 }
      ]
    }
  ]
}

describe('condition rules', () => {
  it('evaluates nested AND/OR groups', () => {
    expect(evaluateCondition(rules, { current_balance: 100, recharge_total: 50 })).toBe(true)
    expect(evaluateCondition(rules, { current_balance: 99, recharge_total: 50 })).toBe(false)
    expect(evaluateCondition(rules, { current_balance: 200, recharge_total: 0 })).toBe(false)
  })

  it('normalizes values before transport', () => {
    expect(
      normalizeCondition({ type: 'fact', fact: 'current_balance', operator: 'gte', value: Number.NaN })
    ).toEqual({ type: 'fact', fact: 'current_balance', operator: 'gte', value: 0 })
  })

  it('copies Vue reactive condition trees into plain editable data', () => {
    const normalized = normalizeCondition(reactive(rules))

    expect(() => structuredClone(normalized)).not.toThrow()
    expect(normalized).toEqual(rules)
  })

  it('produces an operator-aware summary', () => {
    expect(describeCondition(rules)).toContain('累计充值金额大于 0')
    expect(describeCondition(rules)).toContain('当前余额大于 100')
  })

  it('supports rolling recharge windows', () => {
    const condition: ConditionNode = {
      type: 'fact',
      fact: 'recent_recharge_total',
      operator: 'gte',
      value: 50,
      window_days: 30
    }
    expect(describeCondition(condition)).toBe('最近 30 天累计充值金额大于等于 50')
    expect(evaluateCondition(condition, {
      current_balance: 0,
      recharge_total: 100,
      recent_recharge_totals: { '30': 50 }
    })).toBe(true)
    expect(evaluateCondition(condition, {
      current_balance: 0,
      recharge_total: 100,
      recent_recharge_totals: { '30': 49.99 }
    })).toBe(false)
    expect(normalizeCondition({ ...condition, window_days: 999 })).toEqual({
      ...condition,
      window_days: 365
    })
  })
})

import { badRequest } from './errors.js';
import { assertIntegerString, centsFromUpstream, centsToDecimal } from './money.js';

export const FACT_DEFINITIONS = Object.freeze({
  balance_cents: { type: 'integer', label: '当前余额（分）' },
  has_recharged: { type: 'boolean', label: '是否充值过' },
  recharge_total_cents: { type: 'integer', label: '累计充值（分）' },
  recent_recharge_total_cents: { type: 'integer', label: '近期累计充值（分）' },
  recharge_count: { type: 'number', label: '充值次数' },
  account_age_days: { type: 'number', label: '账号注册天数' },
  user_status: { type: 'string', label: '用户状态' }
});

export const RULE_OPERATORS = Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const GROUP_OPERATORS = new Set(['all', 'any']);
const COMPARISON_OPERATORS = new Set(RULE_OPERATORS);
const MAX_DEPTH = 8;
const MAX_NODES = 100;
const MAX_RECHARGE_WINDOW_DAYS = 365;

export function validateRuleTree(input, { allowEmpty = false } = {}) {
  if (input === null || input === undefined) {
    if (allowEmpty) return null;
    throw badRequest('RULE_INVALID', '条件规则不能为空');
  }
  let count = 0;
  function visit(node, depth) {
    count += 1;
    if (count > MAX_NODES) throw badRequest('RULE_TOO_COMPLEX', `条件节点不能超过 ${MAX_NODES} 个`);
    if (depth > MAX_DEPTH) throw badRequest('RULE_TOO_DEEP', `条件嵌套不能超过 ${MAX_DEPTH} 层`);
    if (!isPlainObject(node)) throw badRequest('RULE_INVALID', '条件节点必须是对象');

    if ('op' in node) {
      if (!GROUP_OPERATORS.has(node.op)) throw badRequest('RULE_INVALID_OPERATOR', '组合条件 op 只能是 all 或 any');
      if (!Array.isArray(node.children) || node.children.length > 20) {
        throw badRequest('RULE_INVALID_CHILDREN', '每个组合条件最多包含 20 个子条件');
      }
      assertOnlyKeys(node, ['op', 'children']);
      return { op: node.op, children: node.children.map((child) => visit(child, depth + 1)) };
    }

    const definition = FACT_DEFINITIONS[node.fact];
    if (!definition) throw badRequest('RULE_INVALID_FACT', `不支持的事实字段: ${String(node.fact)}`);
    if (!COMPARISON_OPERATORS.has(node.operator)) {
      throw badRequest('RULE_INVALID_OPERATOR', `不支持的比较操作: ${String(node.operator)}`);
    }
    assertOnlyKeys(
      node,
      node.fact === 'recent_recharge_total_cents'
        ? ['fact', 'operator', 'value', 'window_days']
        : ['fact', 'operator', 'value']
    );
    if ((definition.type === 'boolean' || definition.type === 'string') && !['eq', 'neq'].includes(node.operator)) {
      throw badRequest('RULE_INVALID_OPERATOR', `${node.fact} 只支持 eq 和 neq`);
    }
    const normalized = {
      fact: node.fact,
      operator: node.operator,
      value: normalizeRuleValue(definition.type, node.value, node.fact)
    };
    if (node.fact === 'recent_recharge_total_cents') {
      normalized.window_days = normalizeRechargeWindowDays(node.window_days);
    }
    return normalized;
  }
  return visit(input, 1);
}

function normalizeRechargeWindowDays(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECHARGE_WINDOW_DAYS) {
    throw badRequest('RULE_INVALID_WINDOW', `充值时间范围必须是 1 至 ${MAX_RECHARGE_WINDOW_DAYS} 天`);
  }
  return value;
}

function normalizeRuleValue(type, value, fact) {
  if (type === 'integer') return assertIntegerString(value, `条件 ${fact}`);
  if (type === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw badRequest('RULE_INVALID_VALUE', `${fact} 必须是非负安全整数`);
    return value;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw badRequest('RULE_INVALID_VALUE', `${fact} 必须是布尔值`);
    return value;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 64) {
    throw badRequest('RULE_INVALID_VALUE', `${fact} 必须是 1 至 64 字符的字符串`);
  }
  return value.trim();
}

function assertOnlyKeys(node, allowed) {
  const extra = Object.keys(node).filter((key) => !allowed.includes(key));
  if (extra.length) throw badRequest('RULE_UNKNOWN_FIELD', `条件包含未知字段: ${extra.join(', ')}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function evaluateRule(rule, facts) {
  if (rule === null || rule === undefined) {
    return { matched: true, reasons: [], explanation: { type: 'empty', matched: true } };
  }
  const normalized = validateRuleTree(rule);
  const explanation = evaluateNode(normalized, facts || {});
  return {
    matched: explanation.matched,
    reasons: collectFailureReasons(explanation),
    explanation
  };
}

function evaluateNode(node, facts) {
  if ('op' in node) {
    const children = node.children.map((child) => evaluateNode(child, facts));
    const matched = node.op === 'all' ? children.every((child) => child.matched) : children.some((child) => child.matched);
    return { type: 'group', op: node.op, matched, children };
  }
  const actual = node.fact === 'recent_recharge_total_cents'
    ? facts.recent_recharge_totals_cents?.[String(node.window_days)]
    : facts[node.fact];
  const definition = FACT_DEFINITIONS[node.fact];
  const matched = compare(actual, node.value, node.operator, definition.type);
  return {
    type: 'rule',
    fact: node.fact,
    operator: node.operator,
    expected: node.value,
    actual: actual ?? null,
    ...(node.fact === 'recent_recharge_total_cents' ? { window_days: node.window_days } : {}),
    matched,
    reason: matched ? null : failureReason(node, actual)
  };
}

function failureReason(node, actual) {
  if (node.fact === 'has_recharged') {
    const requiresRecharge = node.operator === 'eq' ? node.value : !node.value;
    return requiresRecharge
      ? '累计充值金额需要大于 0 元'
      : '累计充值金额需要等于 0 元';
  }
  if (['balance_cents', 'recharge_total_cents', 'recent_recharge_total_cents'].includes(node.fact)) {
    const subject = node.fact === 'balance_cents'
      ? '当前余额'
      : node.fact === 'recharge_total_cents'
        ? '累计充值金额'
        : `最近 ${node.window_days} 天累计充值金额`;
    const amount = centsToDecimal(node.value).replace(/\.?0+$/, '');
    return `${subject}${operatorRequirement(node.operator, `${amount} 元`)}`;
  }
  if (node.fact === 'recharge_count') {
    return `充值次数${operatorRequirement(node.operator, `${node.value} 次`)}`;
  }
  if (node.fact === 'account_age_days') {
    return `账号注册天数${operatorRequirement(node.operator, `${node.value} 天`)}`;
  }
  if (node.fact === 'user_status') {
    return node.operator === 'neq'
      ? `账号状态不能是“${node.value}”`
      : `账号状态需要是“${node.value}”，当前为“${actual ?? '未知'}”`;
  }
  return `${FACT_DEFINITIONS[node.fact].label}条件不满足`;
}

function operatorRequirement(operator, expected) {
  switch (operator) {
    case 'gt': return `需要大于 ${expected}`;
    case 'gte': return `不足，需要至少 ${expected}`;
    case 'eq': return `需要等于 ${expected}`;
    case 'neq': return `不能等于 ${expected}`;
    case 'lt': return `需要小于 ${expected}`;
    case 'lte': return `不能超过 ${expected}`;
    default: return `未达到 ${expected}`;
  }
}

function compare(actual, expected, operator, type) {
  if (actual === undefined || actual === null) return false;
  let left = actual;
  let right = expected;
  try {
    if (type === 'integer') {
      left = BigInt(String(actual));
      right = BigInt(String(expected));
    } else if (type === 'number') {
      if (!Number.isFinite(Number(actual))) return false;
      left = Number(actual);
      right = Number(expected);
    } else if (type === 'boolean') {
      if (typeof actual !== 'boolean') return false;
    } else {
      left = String(actual);
      right = String(expected);
    }
  } catch {
    return false;
  }
  switch (operator) {
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
    case 'lt': return left < right;
    case 'lte': return left <= right;
    default: return false;
  }
}

function collectFailureReasons(explanation) {
  if (explanation.matched) return [];
  if (explanation.type === 'rule') return [explanation.reason];
  if (explanation.op === 'all') {
    return explanation.children.flatMap((child) => child.matched ? [] : collectFailureReasons(child));
  }
  const childReasons = explanation.children.flatMap((child) => child.matched ? [] : collectFailureReasons(child));
  return [...new Set([...childReasons, '以上可选条件均未满足'])];
}

export function makeUserFacts(user, rechargeSummary, now = new Date()) {
  const createdAt = new Date(user.created_at);
  const ageMs = Number.isNaN(createdAt.getTime()) ? 0 : Math.max(0, now.getTime() - createdAt.getTime());
  const eventCount = Number(rechargeSummary?.recharge_count || 0);
  const eventTotal = BigInt(String(rechargeSummary?.recharge_total_cents ?? '0'));
  const upstreamTotal = BigInt(String(user.total_recharged_cents ?? '0'));
  const excludedRewards = BigInt(String(rechargeSummary?.excluded_reward_cents ?? '0'));
  const directRechargeTotal = upstreamTotal > excludedRewards ? upstreamTotal - excludedRewards : 0n;
  const rechargeTotal = eventTotal > directRechargeTotal ? eventTotal : directRechargeTotal;
  const recentRechargeTotals = {};
  for (const [days, value] of Object.entries(rechargeSummary?.recent_recharge_totals_cents || {})) {
    if (/^\d+$/.test(days)) recentRechargeTotals[days] = String(value ?? '0');
  }
  return {
    balance_cents: String(user.balance_cents ?? '0'),
    has_recharged: rechargeTotal > 0n,
    recharge_total_cents: rechargeTotal.toString(),
    recent_recharge_totals_cents: recentRechargeTotals,
    recharge_count: eventCount > 0 ? eventCount : directRechargeTotal > 0n ? 1 : 0,
    account_age_days: Math.floor(ageMs / 86_400_000),
    user_status: String(user.status || '')
  };
}

export function rechargeWindowDays(rule) {
  if (!rule) return [];
  const days = new Set();
  function visit(node) {
    if ('op' in node) {
      node.children.forEach(visit);
      return;
    }
    if (node.fact === 'recent_recharge_total_cents') days.add(node.window_days);
  }
  visit(validateRuleTree(rule));
  return [...days].sort((left, right) => left - right);
}

// The browser API uses user-facing currency and and/or. Storage uses cents and all/any.
export function conditionFromApi(condition) {
  if (!condition || typeof condition !== 'object') throw badRequest('RULE_INVALID', '条件不能为空');
  let count = 0;
  function convert(node, depth = 1) {
    count += 1;
    if (count > MAX_NODES) throw badRequest('RULE_TOO_COMPLEX', `条件节点不能超过 ${MAX_NODES} 个`);
    if (depth > MAX_DEPTH) throw badRequest('RULE_TOO_DEEP', `条件嵌套不能超过 ${MAX_DEPTH} 层`);
    if (!isPlainObject(node)) throw badRequest('RULE_INVALID', '条件节点必须是对象');
    if (node?.type === 'group') {
      assertOnlyKeys(node, ['type', 'operator', 'children']);
      if (!['and', 'or'].includes(node.operator)) throw badRequest('RULE_INVALID_OPERATOR', '组合条件只支持 and 或 or');
      if (!Array.isArray(node.children)) throw badRequest('RULE_INVALID_CHILDREN', '组合条件缺少 children');
      if (node.children.length === 0) return { op: 'all', children: [] };
      return { op: node.operator === 'and' ? 'all' : 'any', children: node.children.map((child) => convert(child, depth + 1)) };
    }
    if (node?.type !== 'fact') throw badRequest('RULE_INVALID', '条件 type 只能是 group 或 fact');
    assertOnlyKeys(
      node,
      node.fact === 'recent_recharge_total'
        ? ['type', 'fact', 'operator', 'value', 'window_days']
        : ['type', 'fact', 'operator', 'value']
    );
    if (node.fact === 'current_balance') {
      if (!['gt', 'gte', 'eq', 'lt', 'lte'].includes(node.operator)) {
        throw badRequest('RULE_INVALID_OPERATOR', 'current_balance 不支持该比较操作');
      }
      return { fact: 'balance_cents', operator: node.operator, value: centsFromUpstream(node.value) };
    }
    if (node.fact === 'recharge_total') {
      if (!['gt', 'gte', 'eq', 'lt', 'lte'].includes(node.operator)) {
        throw badRequest('RULE_INVALID_OPERATOR', 'recharge_total 不支持该比较操作');
      }
      return { fact: 'recharge_total_cents', operator: node.operator, value: centsFromUpstream(node.value) };
    }
    if (node.fact === 'recent_recharge_total') {
      if (!['gt', 'gte', 'eq', 'lt', 'lte'].includes(node.operator)) {
        throw badRequest('RULE_INVALID_OPERATOR', 'recent_recharge_total 不支持该比较操作');
      }
      return {
        fact: 'recent_recharge_total_cents',
        operator: node.operator,
        value: centsFromUpstream(node.value),
        window_days: normalizeRechargeWindowDays(node.window_days)
      };
    }
    // Accept the former public condition so existing API clients and saved forms keep working.
    if (node.fact === 'has_recharged') {
      if (node.operator !== 'eq') throw badRequest('RULE_INVALID_OPERATOR', 'has_recharged 只支持 eq');
      return { fact: 'has_recharged', operator: node.operator, value: node.value };
    }
    // Keep the richer server DSL available for later admin UI additions.
    if (FACT_DEFINITIONS[node.fact]) return { fact: node.fact, operator: node.operator, value: node.value };
    throw badRequest('RULE_INVALID_FACT', `不支持的条件: ${String(node.fact)}`);
  }
  return validateRuleTree(convert(condition));
}

export function conditionToApi(rule) {
  if (!rule) return null;
  function convert(node) {
    if ('op' in node) {
      return { type: 'group', operator: node.op === 'all' ? 'and' : 'or', children: node.children.map(convert) };
    }
    if (node.fact === 'balance_cents') {
      return { type: 'fact', fact: 'current_balance', operator: node.operator, value: Number(centsToDecimal(node.value)) };
    }
    if (node.fact === 'recharge_total_cents') {
      return { type: 'fact', fact: 'recharge_total', operator: node.operator, value: Number(centsToDecimal(node.value)) };
    }
    if (node.fact === 'recent_recharge_total_cents') {
      return {
        type: 'fact',
        fact: 'recent_recharge_total',
        operator: node.operator,
        value: Number(centsToDecimal(node.value)),
        window_days: node.window_days
      };
    }
    // Present legacy boolean rules through the new amount-based editor.
    if (node.fact === 'has_recharged') {
      const requiresRecharge = node.operator === 'eq' ? node.value : !node.value;
      return {
        type: 'fact',
        fact: 'recharge_total',
        operator: requiresRecharge ? 'gt' : 'lte',
        value: 0
      };
    }
    return { type: 'fact', fact: node.fact, operator: node.operator, value: node.value };
  }
  return convert(validateRuleTree(rule));
}

export function factsToApi(facts) {
  const recentRechargeTotals = {};
  for (const [days, value] of Object.entries(facts.recent_recharge_totals_cents || {})) {
    recentRechargeTotals[days] = Number(centsToDecimal(value));
  }
  return {
    current_balance: Number(centsToDecimal(facts.balance_cents || '0')),
    recharge_total: Number(centsToDecimal(facts.recharge_total_cents || '0')),
    recent_recharge_totals: recentRechargeTotals,
    // Kept for compatibility with older clients; the current UI uses recharge_total.
    has_recharged: Boolean(facts.has_recharged)
  };
}

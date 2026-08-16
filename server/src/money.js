import { badRequest } from './errors.js';

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

export function decimalToScaledInteger(value, scale = 2, { round = true } = {}) {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const expanded = expandExponent(raw);
  const match = DECIMAL_RE.exec(expanded);
  if (!match) throw badRequest('INVALID_DECIMAL', `无效数值: ${raw}`);
  const negative = match[1] === '-';
  const fraction = match[3] || '';
  let digits = fraction.padEnd(scale, '0').slice(0, scale);
  let result = BigInt(match[2]) * 10n ** BigInt(scale) + BigInt(digits || '0');
  if (round && fraction.length > scale && Number(fraction[scale]) >= 5) result += 1n;
  return (negative ? -result : result).toString();
}

function expandExponent(value) {
  if (!/[eE]/.test(value)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 21 });
}

export function centsFromUpstream(value) {
  return decimalToScaledInteger(value, 2, { round: true });
}

export function centsToDecimal(cents) {
  let integer;
  try {
    integer = BigInt(String(cents));
  } catch {
    throw badRequest('INVALID_MONEY', '金额必须为整数分字符串');
  }
  const negative = integer < 0n;
  const absolute = negative ? -integer : integer;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function addIntegerStrings(values) {
  return values.reduce((total, value) => total + BigInt(String(value)), 0n).toString();
}

export function assertIntegerString(value, field, { min, max } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw badRequest('VALIDATION_ERROR', `${field}必须是整数字符串`);
  }
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) throw badRequest('VALIDATION_ERROR', `${field}必须是整数字符串`);
  const integer = BigInt(raw);
  if (min !== undefined && integer < BigInt(min)) throw badRequest('VALIDATION_ERROR', `${field}不能小于 ${min}`);
  if (max !== undefined && integer > BigInt(max)) throw badRequest('VALIDATION_ERROR', `${field}不能大于 ${max}`);
  return integer.toString();
}

export function assertDecimalString(value, field, { min = '0', max = '1000000000' } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) {
    throw badRequest('VALIDATION_ERROR', `${field}必须是最多6位小数的非负定点数`);
  }
  const scaled = BigInt(decimalToScaledInteger(raw, 6, { round: false }));
  if (scaled < BigInt(decimalToScaledInteger(min, 6)) || scaled > BigInt(decimalToScaledInteger(max, 6))) {
    throw badRequest('VALIDATION_ERROR', `${field}超出允许范围`);
  }
  return raw;
}

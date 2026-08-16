import { badRequest } from './errors.js';

export function objectBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('VALIDATION_ERROR', '请求体必须是 JSON 对象');
  }
  return value;
}

export function requiredString(value, field, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('VALIDATION_ERROR', `${field}不能为空`);
  const trimmed = value.trim();
  if ([...trimmed].length > maxLength) throw badRequest('VALIDATION_ERROR', `${field}不能超过 ${maxLength} 个字符`);
  return trimmed;
}

export function optionalString(value, field, maxLength = 2000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest('VALIDATION_ERROR', `${field}必须是字符串`);
  const trimmed = value.trim();
  if ([...trimmed].length > maxLength) throw badRequest('VALIDATION_ERROR', `${field}不能超过 ${maxLength} 个字符`);
  return trimmed;
}

export function integer(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest('VALIDATION_ERROR', `${field}必须是 ${min} 至 ${max} 之间的整数`);
  }
  return value;
}

export function positiveId(value, field = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('VALIDATION_ERROR', `${field}无效`);
  return id;
}

export function boolean(value, field) {
  if (typeof value !== 'boolean') throw badRequest('VALIDATION_ERROR', `${field}必须是布尔值`);
  return value;
}

export function actionUrl(value) {
  const url = requiredString(value, 'action_url', 1000);
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return parsed.toString();
  } catch { /* invalid URL */ }
  throw badRequest('VALIDATION_ERROR', 'action_url 必须是站内路径或 HTTPS 地址');
}

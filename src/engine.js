'use strict';

// 路由匹配、参数校验、条件场景判断

const { resolvePath, renderString } = require('./template');

function decode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const split = (p) => p.split('/').filter(Boolean);

// 返回 { params, score } 或 null。静态段得分高于 :参数，参数高于 *，用于多条接口都能匹配时选最具体的
function matchPath(pattern, pathname) {
  const ps = split(pattern);
  const xs = split(pathname).map(decode);
  const params = {};
  let score = 0;
  for (let i = 0; i < ps.length; i++) {
    const seg = ps[i];
    if (seg === '*') {
      params['*'] = xs.slice(i).join('/');
      return { params, score: score + 1 };
    }
    if (i >= xs.length) return null;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = xs[i];
      score += 2;
    } else if (decode(seg) === xs[i]) {
      score += 3;
    } else {
      return null;
    }
  }
  return xs.length === ps.length ? { params, score } : null;
}

function findMock(mocks, method, pathname) {
  let best = null;
  for (const mock of mocks) {
    if (!mock.enabled) continue;
    if (mock.method !== 'ANY' && mock.method !== method) continue;
    const m = matchPath(mock.path, pathname);
    if (!m) continue;
    const score = m.score * 10 + (mock.method === 'ANY' ? 0 : 5);
    if (!best || score > best.score) best = { mock, params: m.params, score };
  }
  return best;
}

const isBlank = (v) => v === undefined || v === null || v === '';
const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const TYPE_LABELS = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔值',
  array: '数组',
  object: '对象',
};

// strict=false 时允许字符串形式的数字/布尔（query、header、表单提交的值都是字符串）
function checkType(v, type, strict) {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' ? Number.isFinite(v) : !strict && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
    case 'integer':
      return typeof v === 'number' ? Number.isInteger(v) : !strict && typeof v === 'string' && /^-?\d+$/.test(v);
    case 'boolean':
      return typeof v === 'boolean' || (!strict && (v === 'true' || v === 'false'));
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    default:
      return true;
  }
}

function validateRules(rules, ctx, { bodyIsJson = true } = {}) {
  const errors = [];
  for (const rule of rules) {
    const key = rule.in === 'headers' ? rule.name.toLowerCase() : rule.name;
    const value = resolvePath(ctx[rule.in], key);
    if (isBlank(value)) {
      if (rule.required) errors.push(`${rule.name} 不能为空`);
      continue;
    }
    const strict = rule.in === 'body' && bodyIsJson;
    if (rule.type !== 'any' && !checkType(value, rule.type, strict)) {
      errors.push(`${rule.name} 应为${TYPE_LABELS[rule.type]}`);
      continue;
    }
    const primitive = typeof value !== 'object';
    if (primitive && rule.maxLength && String(value).length > rule.maxLength) {
      errors.push(`${rule.name} 长度不能超过 ${rule.maxLength}`);
    }
    if (primitive && rule.enum.length && !rule.enum.includes(String(value))) {
      errors.push(`${rule.name} 只能是 ${rule.enum.join(' / ')}`);
    }
  }
  return errors;
}

function testCondition(cond, ctx) {
  // header 名在请求里统一是小写
  const field = cond.field.replace(/^headers\.(.+)$/i, (_, name) => `headers.${name.toLowerCase()}`);
  const actual = resolvePath(ctx, field);
  if (cond.op === 'exists') return !isBlank(actual);
  if (cond.op === 'notExists') return isBlank(actual);

  const expected = renderString(cond.value ?? '', ctx);
  const a = Number(actual);
  const b = Number(expected);
  const numeric = !isBlank(actual) && !isBlank(expected) && !Number.isNaN(a) && !Number.isNaN(b);
  switch (cond.op) {
    case 'eq':
      return asText(actual) === asText(expected);
    case 'ne':
      return asText(actual) !== asText(expected);
    case 'gt':
      return numeric && a > b;
    case 'gte':
      return numeric && a >= b;
    case 'lt':
      return numeric && a < b;
    case 'lte':
      return numeric && a <= b;
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((x) => asText(x) === asText(expected))
        : asText(actual).includes(asText(expected));
    default:
      return false;
  }
}

// 没有条件的场景视为「强制返回」：启用后所有请求都命中
function matchScenario(scenario, ctx) {
  if (!scenario.enabled) return false;
  if (scenario.conditions.length === 0) return true;
  const test = (c) => testCondition(c, ctx);
  return scenario.match === 'any' ? scenario.conditions.some(test) : scenario.conditions.every(test);
}

module.exports = { matchPath, findMock, validateRules, matchScenario };

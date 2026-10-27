'use strict';

// 接口配置的持久化：保存在一个 JSON 文件里，写入时先写临时文件再改名，避免写一半损坏

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'];
const RULE_SOURCES = ['body', 'query', 'params', 'headers'];
const RULE_TYPES = ['any', 'string', 'number', 'integer', 'boolean', 'array', 'object'];
const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'notExists'];
const RESERVED_PATHS = ['/__admin', '/__health'];

const DEFAULT_VALIDATION_BODY = '{\n  "code": "400",\n  "msg": "{{error}}",\n  "data": null\n}';

class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const text = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v));
const oneOf = (list, v, fallback) => (list.includes(v) ? v : fallback);
const newId = () => crypto.randomBytes(6).toString('hex');

function intIn(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function normalizePath(p) {
  let s = text(p).trim().split('?')[0];
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

// 兼容 {key: value} 和 [{key, value}] 两种写法
function normalizeHeaders(h) {
  const entries = Array.isArray(h)
    ? h.map((x) => [x && x.key, x && x.value])
    : h && typeof h === 'object'
      ? Object.entries(h)
      : [];
  const out = {};
  for (const [k, v] of entries) {
    const key = text(k).trim();
    if (key) out[key] = text(v);
  }
  return out;
}

function normalizeResponse(r, defaultStatus, defaultBody) {
  const src = r || {};
  return {
    status: intIn(src.status, defaultStatus, 100, 599),
    headers: normalizeHeaders(src.headers),
    body: text(src.body, defaultBody),
  };
}

function normalizeRule(r) {
  const src = r || {};
  const enumValues = Array.isArray(src.enum) ? src.enum : text(src.enum).split(/[,，]/);
  return {
    in: oneOf(RULE_SOURCES, src.in, 'body'),
    name: text(src.name).trim(),
    type: oneOf(RULE_TYPES, src.type, 'any'),
    required: Boolean(src.required),
    maxLength: intIn(src.maxLength, 0, 0, 1000000),
    enum: enumValues.map((s) => text(s).trim()).filter(Boolean),
  };
}

function normalizeScenario(s, index) {
  const src = s || {};
  const conditions = (Array.isArray(src.conditions) ? src.conditions : [])
    .map((c) => ({ field: text(c && c.field).trim(), op: oneOf(OPERATORS, c && c.op, 'eq'), value: text(c && c.value) }))
    .filter((c) => c.field);
  return {
    name: text(src.name).trim() || `场景${index + 1}`,
    enabled: src.enabled !== false,
    match: src.match === 'any' ? 'any' : 'all',
    conditions,
    response: normalizeResponse(src.response, 200, '{}'),
  };
}

function normalizeMock(input) {
  const m = input || {};
  const method = text(m.method, 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new StoreError(`不支持的请求方法: ${method}`);
  if (!text(m.path).trim()) throw new StoreError('接口路径不能为空');

  const p = normalizePath(m.path);
  if (RESERVED_PATHS.some((r) => p === r || p.startsWith(`${r}/`))) {
    throw new StoreError(`${p} 是系统保留路径，请换一个`);
  }
  const segments = p.split('/');
  const star = segments.indexOf('*');
  if (star !== -1 && star !== segments.length - 1) throw new StoreError('通配符 * 只能放在路径最后');

  const now = new Date().toISOString();
  const id = text(m.id).trim();
  return {
    id: /^[\w-]{1,64}$/.test(id) ? id : newId(),
    name: text(m.name).trim() || p,
    description: text(m.description),
    method,
    path: p,
    enabled: m.enabled !== false,
    delay: intIn(m.delay, 0, 0, 60000),
    rules: (Array.isArray(m.rules) ? m.rules : []).map(normalizeRule).filter((r) => r.name),
    validationResponse: normalizeResponse(m.validationResponse, 400, DEFAULT_VALIDATION_BODY),
    scenarios: (Array.isArray(m.scenarios) ? m.scenarios : []).map(normalizeScenario),
    response: normalizeResponse(m.response, 200, '{}'),
    createdAt: text(m.createdAt) || now,
    updatedAt: text(m.updatedAt) || now,
  };
}

function findDuplicate(mocks) {
  const seen = new Map();
  for (const m of mocks) {
    const key = `${m.method} ${m.path}`;
    if (seen.has(key)) return key;
    seen.set(key, m);
  }
  return null;
}

// 先写临时文件再改名，避免写一半损坏
function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // 不自动覆盖损坏的文件，避免丢配置
    throw new Error(`读取配置文件失败 ${file}: ${err.message}`);
  }
}

class Store {
  constructor(file, seeds = []) {
    this.file = file;
    if (fs.existsSync(file)) {
      const raw = readJsonFile(file);
      this.mocks = (Array.isArray(raw) ? raw : raw.mocks || []).map(normalizeMock);
    } else {
      this.mocks = seeds.map(normalizeMock);
      this.save();
    }
  }

  list() {
    return this.mocks;
  }

  get(id) {
    return this.mocks.find((m) => m.id === id);
  }

  create(input) {
    const mock = normalizeMock({ ...input, id: undefined, createdAt: undefined, updatedAt: undefined });
    this.assertUnique(mock);
    this.mocks.push(mock);
    this.save();
    return mock;
  }

  update(id, input) {
    const index = this.mocks.findIndex((m) => m.id === id);
    if (index === -1) throw new StoreError('接口不存在', 404);
    const mock = normalizeMock({
      ...input,
      id,
      createdAt: this.mocks[index].createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.assertUnique(mock, id);
    this.mocks[index] = mock;
    this.save();
    return mock;
  }

  remove(id) {
    const index = this.mocks.findIndex((m) => m.id === id);
    if (index === -1) throw new StoreError('接口不存在', 404);
    this.mocks.splice(index, 1);
    this.save();
  }

  // mode: merge 按 id 或「方法+路径」覆盖同名接口并新增其余接口；replace 清空后导入
  import(list, mode = 'merge') {
    if (!Array.isArray(list)) throw new StoreError('导入内容格式不正确，应包含接口数组');
    const incoming = list.map(normalizeMock);
    const next = mode === 'replace' ? [] : [...this.mocks];
    for (const m of incoming) {
      const i = next.findIndex((x) => x.id === m.id || (x.method === m.method && x.path === m.path));
      if (i === -1) next.push(m);
      else next[i] = { ...m, id: next[i].id };
    }
    const dup = findDuplicate(next);
    if (dup) throw new StoreError(`导入后会出现重复的接口: ${dup}`, 409);
    this.mocks = next;
    this.save();
    return incoming.length;
  }

  assertUnique(mock, ignoreId) {
    const dup = this.mocks.find((m) => m.id !== ignoreId && m.method === mock.method && m.path === mock.path);
    if (dup) throw new StoreError(`已存在相同的接口 ${mock.method} ${mock.path}（${dup.name}）`, 409);
  }

  save() {
    writeJsonFile(this.file, { version: 1, mocks: this.mocks });
  }
}

module.exports = { Store, StoreError, normalizeMock, writeJsonFile, readJsonFile };

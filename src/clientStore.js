'use strict';

// 接口调用功能的持久化：
//   client.json   集合、请求、环境变量
//   records.json  用户手动「保存到服务器」的调用记录
// 本机历史保存在浏览器里，不经过这里。

const fs = require('node:fs');
const crypto = require('node:crypto');
const { StoreError, writeJsonFile, readJsonFile } = require('./store');
const { HELPERS } = require('./template');

const CLIENT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_MODES = ['none', 'json', 'form', 'raw'];
const VAR_NAME = /^[A-Za-z_][\w-]*$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RECORDS = 500;
const RECORD_BODY_LIMIT = 20000;
const NOTE_LIMIT = 200;

const DEFAULT_OPTIONS = { timeout: 30000, followRedirects: true, insecure: false };

const text = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v));
const oneOf = (list, v, fallback) => (list.includes(v) ? v : fallback);
const newId = () => crypto.randomBytes(6).toString('hex');
const validId = (v) => (/^[\w-]{1,64}$/.test(text(v)) ? text(v) : '');
// 留出截断提示的长度，读回已截断的内容时不会再截断一次
const needsTruncate = (s) => text(s).length > RECORD_BODY_LIMIT + 100;
const truncate = (s) => {
  const str = text(s);
  return needsTruncate(str) ? `${str.slice(0, RECORD_BODY_LIMIT)}\n...（已截断，共 ${str.length} 字符）` : str;
};

function intIn(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function isHelperName(name) {
  return Object.prototype.hasOwnProperty.call(HELPERS, name);
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ key: text(r && r.key), value: text(r && r.value), enabled: !(r && r.enabled === false) }))
    .filter((r) => r.key.trim() || r.value.trim());
}

function normalizeStringMap(obj) {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) out[k] = Array.isArray(v) ? v.map(text).join(', ') : text(v);
  }
  return out;
}

function normalizeOptions(o) {
  const src = o || {};
  return {
    timeout: intIn(src.timeout, DEFAULT_OPTIONS.timeout, 1000, 300000),
    followRedirects: src.followRedirects !== false,
    insecure: src.insecure === true,
  };
}

// 请求内容（不含 id / 集合等归属信息），发送和保存共用
function normalizeRequestContent(input) {
  const r = input || {};
  const body = r.body || {};
  return {
    name: text(r.name).trim(),
    method: oneOf(CLIENT_METHODS, text(r.method).toUpperCase(), 'GET'),
    url: text(r.url).trim(),
    params: normalizeRows(r.params),
    headers: normalizeRows(r.headers),
    body: {
      mode: oneOf(BODY_MODES, body.mode, 'none'),
      json: text(body.json),
      form: normalizeRows(body.form),
      raw: text(body.raw),
      rawType: text(body.rawType).trim() || 'text/plain',
    },
    options: normalizeOptions(r.options),
  };
}

function normalizeVars(vars, { strict = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const v of normalizeRows(vars)) {
    const key = v.key.trim();
    if (!key) continue;
    if (!VAR_NAME.test(key) || FORBIDDEN_NAMES.has(key)) {
      if (strict) throw new StoreError(`变量名「${key}」不合法：只能包含字母、数字、_、-，并且以字母或下划线开头`);
      continue;
    }
    if (isHelperName(key)) {
      if (strict) throw new StoreError(`变量名「${key}」和内置函数重名，请换一个`);
      continue;
    }
    if (seen.has(key)) {
      if (strict) throw new StoreError(`变量「${key}」重复了`);
      continue;
    }
    seen.add(key);
    out.push({ key, value: v.value, enabled: v.enabled });
  }
  return out;
}

function normalizeEnvironment(e, index) {
  const src = e || {};
  const name = text(src.name).trim() || `环境${index + 1}`;
  let vars;
  try {
    vars = normalizeVars(src.vars);
  } catch (err) {
    throw new StoreError(`环境「${name}」中的${err.message}`);
  }
  return { id: validId(src.id) || newId(), name, vars };
}

function normalizeRecord(input) {
  const r = input || {};
  const sent = r.sent || {};
  const resp = r.response;
  const err = r.error;
  const timing = r.timing || {};
  return {
    id: newId(),
    time: Number.isNaN(Date.parse(r.time)) ? new Date().toISOString() : new Date(r.time).toISOString(),
    note: text(r.note).trim().slice(0, NOTE_LIMIT),
    envName: text(r.envName).slice(0, 100),
    request: normalizeRequestContent(r.request),
    sent: {
      method: text(sent.method),
      url: text(sent.url),
      headers: normalizeStringMap(sent.headers),
      body: sent.body === undefined || sent.body === null ? null : truncate(sent.body),
    },
    response: resp
      ? {
          status: intIn(resp.status, 0, 0, 999),
          statusText: text(resp.statusText),
          headers: normalizeStringMap(resp.headers),
          body: truncate(resp.body),
          binary: resp.binary === true,
          contentType: text(resp.contentType),
          size: intIn(resp.size, 0, 0, Number.MAX_SAFE_INTEGER),
          truncated: resp.truncated === true || needsTruncate(resp.body),
        }
      : null,
    error: err ? { code: text(err.code), message: text(err.message) } : null,
    timing: { totalMs: intIn(timing.totalMs, 0, 0, Number.MAX_SAFE_INTEGER), ttfbMs: timing.ttfbMs === null ? null : intIn(timing.ttfbMs, 0, 0, Number.MAX_SAFE_INTEGER) },
    redirects: (Array.isArray(r.redirects) ? r.redirects : []).map(text).slice(0, 10),
  };
}

const recordSummary = (r) => ({
  id: r.id,
  time: r.time,
  note: r.note,
  envName: r.envName,
  name: r.request.name,
  method: r.sent.method || r.request.method,
  url: r.sent.url || r.request.url,
  status: r.response ? r.response.status : null,
  error: r.error ? r.error.code : null,
  totalMs: r.timing.totalMs,
});

const byOrder = (a, b) => a.order - b.order || text(a.createdAt).localeCompare(text(b.createdAt));
const nextOrder = (list) => list.reduce((max, x) => Math.max(max, x.order), -1) + 1;

class ClientStore {
  constructor(clientFile, recordsFile) {
    this.clientFile = clientFile;
    this.recordsFile = recordsFile;
    this.collections = [];
    this.requests = [];
    this.environments = [];
    this.records = [];

    if (fs.existsSync(clientFile)) {
      const raw = readJsonFile(clientFile);
      this.collections = (raw.collections || []).map((c) => this.normalizeCollection(c));
      const ids = new Set(this.collections.map((c) => c.id));
      this.requests = (raw.requests || []).map((r) => this.normalizeRequest(r)).filter((r) => ids.has(r.collectionId));
      // 读文件时不因为个别变量名不合法而启动失败
      this.environments = (raw.environments || []).map((e, i) => ({
        id: validId(e && e.id) || newId(),
        name: text(e && e.name).trim() || `环境${i + 1}`,
        vars: normalizeVars(e && e.vars, { strict: false }),
      }));
    }
    if (fs.existsSync(recordsFile)) {
      const raw = readJsonFile(recordsFile);
      this.records = (raw.records || []).map((r) => ({ ...normalizeRecord(r), id: validId(r && r.id) || newId() }));
    }
  }

  // ---------- 读取 ----------

  snapshot() {
    return {
      collections: [...this.collections].sort(byOrder),
      requests: [...this.requests].sort(byOrder),
      environments: this.environments,
    };
  }

  // ---------- 集合 ----------

  normalizeCollection(input) {
    const c = input || {};
    const now = new Date().toISOString();
    return {
      id: validId(c.id) || newId(),
      name: text(c.name).trim() || '未命名集合',
      order: intIn(c.order, 0, 0, 1000000),
      createdAt: text(c.createdAt) || now,
      updatedAt: text(c.updatedAt) || now,
    };
  }

  createCollection(input) {
    const c = this.normalizeCollection({ name: input && input.name, order: nextOrder(this.collections) });
    this.collections.push(c);
    this.saveClient();
    return c;
  }

  updateCollection(id, input) {
    const c = this.collections.find((x) => x.id === id);
    if (!c) throw new StoreError('集合不存在', 404);
    if (input && input.name !== undefined) c.name = text(input.name).trim() || c.name;
    c.updatedAt = new Date().toISOString();
    this.saveClient();
    return c;
  }

  removeCollection(id) {
    if (!this.collections.some((x) => x.id === id)) throw new StoreError('集合不存在', 404);
    this.collections = this.collections.filter((x) => x.id !== id);
    this.requests = this.requests.filter((r) => r.collectionId !== id);
    this.saveClient();
  }

  // ---------- 请求 ----------

  normalizeRequest(input) {
    const r = input || {};
    const now = new Date().toISOString();
    const content = normalizeRequestContent(r);
    return {
      id: validId(r.id) || newId(),
      collectionId: text(r.collectionId),
      order: intIn(r.order, 0, 0, 1000000),
      ...content,
      name: content.name || content.url || '未命名请求',
      createdAt: text(r.createdAt) || now,
      updatedAt: text(r.updatedAt) || now,
    };
  }

  assertCollection(id) {
    if (!this.collections.some((c) => c.id === id)) throw new StoreError('请选择一个已有的集合');
  }

  createRequest(input) {
    const src = input || {};
    this.assertCollection(src.collectionId);
    const siblings = this.requests.filter((r) => r.collectionId === src.collectionId);
    const req = this.normalizeRequest({ ...src, id: undefined, createdAt: undefined, updatedAt: undefined, order: nextOrder(siblings) });
    this.requests.push(req);
    this.saveClient();
    return req;
  }

  updateRequest(id, input) {
    const index = this.requests.findIndex((r) => r.id === id);
    if (index === -1) throw new StoreError('请求不存在，可能已被删除', 404);
    const old = this.requests[index];
    const src = input || {};
    const collectionId = src.collectionId || old.collectionId;
    this.assertCollection(collectionId);
    const order = collectionId === old.collectionId ? old.order : nextOrder(this.requests.filter((r) => r.collectionId === collectionId));
    this.requests[index] = this.normalizeRequest({ ...src, id, collectionId, order, createdAt: old.createdAt, updatedAt: new Date().toISOString() });
    this.saveClient();
    return this.requests[index];
  }

  removeRequest(id) {
    if (!this.requests.some((r) => r.id === id)) throw new StoreError('请求不存在', 404);
    this.requests = this.requests.filter((r) => r.id !== id);
    this.saveClient();
  }

  // ---------- 环境 ----------

  setEnvironments(list) {
    if (!Array.isArray(list)) throw new StoreError('环境列表格式不正确');
    const envs = list.map(normalizeEnvironment);
    if (new Set(envs.map((e) => e.id)).size !== envs.length) throw new StoreError('环境 id 重复');
    this.environments = envs;
    this.saveClient();
    return envs;
  }

  // ---------- 服务器记录 ----------

  listRecords() {
    return [...this.records].sort((a, b) => b.time.localeCompare(a.time)).map(recordSummary);
  }

  getRecord(id) {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw new StoreError('记录不存在', 404);
    return r;
  }

  createRecord(input) {
    if (this.records.length >= MAX_RECORDS) throw new StoreError(`服务器记录已达 ${MAX_RECORDS} 条上限，请先删除一些旧记录`, 409);
    const r = normalizeRecord(input);
    this.records.push(r);
    this.saveRecords();
    return recordSummary(r);
  }

  updateRecord(id, input) {
    const r = this.getRecord(id);
    if (input && input.note !== undefined) r.note = text(input.note).trim().slice(0, NOTE_LIMIT);
    this.saveRecords();
    return recordSummary(r);
  }

  removeRecord(id) {
    this.getRecord(id);
    this.records = this.records.filter((x) => x.id !== id);
    this.saveRecords();
  }

  // ---------- 导出导入（不包含环境变量和记录） ----------

  exportData() {
    const { collections, requests } = this.snapshot();
    return { collections, requests };
  }

  // 先校验、算出导入后的结果，返回一个提交函数；这样可以和接口配置的导入一起「要么都成功，要么都不改」
  prepareImport(data, mode = 'merge') {
    const src = data || {};
    if (!Array.isArray(src.collections) || !Array.isArray(src.requests)) throw new StoreError('导入内容格式不正确，client 中应包含 collections 和 requests');
    const incomingCols = src.collections.map((c) => this.normalizeCollection(c));
    const incomingReqs = src.requests.map((r) => this.normalizeRequest(r));
    const cols = mode === 'replace' ? [] : [...this.collections];
    const reqs = mode === 'replace' ? [] : [...this.requests];
    for (const c of incomingCols) {
      const i = cols.findIndex((x) => x.id === c.id);
      if (i === -1) cols.push(c);
      else cols[i] = c;
    }
    const colIds = new Set(cols.map((c) => c.id));
    for (const r of incomingReqs) {
      if (!colIds.has(r.collectionId)) throw new StoreError(`请求「${r.name}」所属的集合不存在`);
      const i = reqs.findIndex((x) => x.id === r.id);
      if (i === -1) reqs.push(r);
      else reqs[i] = r;
    }
    return {
      collections: incomingCols.length,
      requests: incomingReqs.length,
      commit: () => {
        this.collections = cols;
        this.requests = reqs;
        this.saveClient();
      },
    };
  }

  // ---------- 保存 ----------

  saveClient() {
    writeJsonFile(this.clientFile, { version: 1, collections: this.collections, requests: this.requests, environments: this.environments });
  }

  saveRecords() {
    writeJsonFile(this.recordsFile, { version: 1, records: this.records });
  }
}

module.exports = { ClientStore, normalizeRequestContent, normalizeVars, isHelperName, CLIENT_METHODS, MAX_RECORDS, RECORD_BODY_LIMIT };

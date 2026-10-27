'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { findMock, validateRules, matchScenario } = require('./engine');
const { renderBody, renderString } = require('./template');
const { StoreError } = require('./store');
const { createClientRouter } = require('./clientRouter');

const LOG_LIMIT = 300;
const LOG_BODY_LIMIT = 20000;

const truncate = (s) => (s.length > LOG_BODY_LIMIT ? `${s.slice(0, LOG_BODY_LIMIT)}\n...（已截断，共 ${s.length} 字符）` : s);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RequestLog {
  constructor(limit = LOG_LIMIT) {
    this.limit = limit;
    this.items = [];
  }

  add(entry) {
    this.items.unshift(entry);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }

  list({ mockId, limit = 100 } = {}) {
    const items = mockId ? this.items.filter((e) => e.mock && e.mock.id === mockId) : this.items;
    return items.slice(0, limit);
  }

  clear() {
    this.items = [];
  }
}

function parseBody(raw, contentType) {
  if (typeof raw !== 'string' || raw === '') return { body: {}, isJson: true, raw: '' };
  if ((contentType || '').toLowerCase().includes('application/x-www-form-urlencoded')) {
    return { body: Object.fromEntries(new URLSearchParams(raw)), isJson: false, raw };
  }
  try {
    return { body: JSON.parse(raw), isJson: true, raw };
  } catch {
    return { body: raw, isJson: false, raw };
  }
}

function sameToken(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// 接口调用功能会让服务器替人访问内网地址，必须设置管理口令才能使用
function clientStatus({ clientStore, adminToken, clientEnabled }) {
  if (!clientStore) return { enabled: false, reason: '接口调用功能没有初始化' };
  if (!clientEnabled) return { enabled: false, reason: '接口调用功能已被关闭（CLIENT_ENABLED=false）' };
  if (!adminToken) return { enabled: false, reason: '接口调用功能需要先设置管理口令 ADMIN_TOKEN，设置方法见 README' };
  return { enabled: true, reason: '' };
}

function createAdminRouter({ store, clientStore, log, adminToken, clientEnabled, proxyAllowHosts }) {
  const router = express.Router();
  router.use(express.json({ limit: '10mb' }));
  const client = clientStatus({ clientStore, adminToken, clientEnabled });

  router.get('/info', (req, res) => {
    res.json({ authRequired: Boolean(adminToken), mockCount: store.list().length, client });
  });

  router.use((req, res, next) => {
    if (!adminToken || sameToken(req.get('x-admin-token'), adminToken)) return next();
    res.status(401).json({ message: '管理口令错误' });
  });

  router.use('/client', createClientRouter({ clientStore, enabled: client.enabled, disabledReason: client.reason, allowHosts: proxyAllowHosts }));

  router.get('/mocks', (req, res) => res.json(store.list()));

  router.get('/mocks/:id', (req, res) => {
    const mock = store.get(req.params.id);
    if (!mock) throw new StoreError('接口不存在', 404);
    res.json(mock);
  });

  router.post('/mocks', (req, res) => res.status(201).json(store.create(req.body)));
  router.put('/mocks/:id', (req, res) => res.json(store.update(req.params.id, req.body)));

  router.delete('/mocks/:id', (req, res) => {
    store.remove(req.params.id);
    res.status(204).end();
  });

  router.get('/logs', (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, LOG_LIMIT);
    res.json(log.list({ mockId: req.query.mockId || '', limit }));
  });

  router.delete('/logs', (req, res) => {
    log.clear();
    res.status(204).end();
  });

  // 导出接口配置和接口调用的集合、请求；环境变量可能包含 token，不导出
  router.get('/export', (req, res) => {
    const data = { version: 2, exportedAt: new Date().toISOString(), mocks: store.list() };
    if (clientStore) data.client = clientStore.exportData();
    res.json(data);
  });

  // 文件里没有 client 时不动现有的集合和请求，覆盖导入也一样
  router.post('/import', (req, res) => {
    const body = req.body || {};
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const clientImport = body.client && clientStore ? clientStore.prepareImport(body.client, mode) : null;
    const count = store.import(body.mocks, mode);
    if (clientImport) clientImport.commit();
    res.json({ count, collections: clientImport ? clientImport.collections : 0, requests: clientImport ? clientImport.requests : 0 });
  });

  router.use((err, req, res, next) => {
    if (err instanceof StoreError) return res.status(err.status).json({ message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: '请求内容不是合法的 JSON' });
    console.error(err);
    res.status(500).json({ message: err.message || '服务器内部错误' });
  });

  return router;
}

function createMockHandler({ store, log }) {
  return async function handleMock(req, res) {
    const started = Date.now();
    const pathname = req.path;
    const { body, isJson, raw } = parseBody(req.body, req.get('content-type'));
    const match = findMock(store.list(), req.method, pathname);

    if (!match && req.method === 'GET' && pathname === '/') return res.redirect('/__admin/');

    let status;
    let output;
    let isJsonOutput = true;
    let hit;
    const headers = {};

    if (!match) {
      status = 404;
      hit = '未匹配';
      output = JSON.stringify({ code: '404', msg: `未找到匹配的接口: ${req.method} ${pathname}`, data: null });
    } else {
      const { mock, params } = match;
      const ctx = { body, query: req.query, params, headers: req.headers, method: req.method, path: pathname };
      try {
        // 顺序：条件场景 → 参数校验 → 默认返回
        let resp;
        const scenario = mock.scenarios.find((s) => matchScenario(s, ctx));
        if (scenario) {
          resp = scenario.response;
          hit = `场景：${scenario.name}`;
        } else {
          const errors = validateRules(mock.rules, ctx, { bodyIsJson: isJson });
          if (errors.length) {
            resp = mock.validationResponse;
            ctx.error = errors.join('；');
            ctx.errors = errors;
            hit = '参数校验失败';
          } else {
            resp = mock.response;
            hit = '默认返回';
          }
        }
        if (mock.delay) await sleep(mock.delay);
        const rendered = renderBody(resp.body, ctx);
        status = resp.status;
        output = rendered.body;
        isJsonOutput = rendered.json;
        for (const [k, v] of Object.entries(resp.headers)) {
          const value = renderString(v, ctx);
          headers[k] = value === undefined || value === null ? '' : String(value);
        }
      } catch (err) {
        status = 500;
        hit = '模板错误';
        output = JSON.stringify({ code: '500', msg: `返回值模板出错：${err.message}`, data: null });
        isJsonOutput = true;
      }
    }

    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = isJsonOutput ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    }
    res.status(status).set(headers).send(output);

    log.add({
      id: crypto.randomBytes(6).toString('hex'),
      time: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      mock: match ? { id: match.mock.id, name: match.mock.name, path: match.mock.path } : null,
      hit,
      status,
      durationMs: Date.now() - started,
      request: { headers: req.headers, query: req.query, body: truncate(raw) },
      response: { headers, body: truncate(output) },
    });
  };
}

function createApp({ store, clientStore = null, adminToken = '', clientEnabled = true, proxyAllowHosts = '' }) {
  const app = express();
  const log = new RequestLog();

  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', true);

  app.get('/__health', (req, res) => res.json({ status: 'ok' }));
  app.use('/__admin/api', createAdminRouter({ store, clientStore, log, adminToken, clientEnabled, proxyAllowHosts }));
  app.use('/__admin', express.static(path.join(__dirname, '..', 'public')));

  // 允许浏览器跨域调用模拟接口
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
    res.set('Access-Control-Allow-Credentials', 'true');
    if (req.method !== 'OPTIONS') return next();
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || '*');
    res.status(204).end();
  });

  app.use(express.text({ type: () => true, limit: '10mb' }), createMockHandler({ store, log }));

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ code: String(status), msg: err.message || '服务器内部错误', data: null });
  });

  return app;
}

module.exports = { createApp, RequestLog };

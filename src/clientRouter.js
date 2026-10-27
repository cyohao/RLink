'use strict';

// 接口调用功能的管理接口：/__admin/api/client/*

const express = require('express');
const { StoreError } = require('./store');
const { renderText, TemplateError, HELPERS } = require('./template');
const { normalizeRequestContent, normalizeVars, isHelperName } = require('./clientStore');
const { sendRequest, RequestFailed } = require('./httpClient');

const NO_BODY_METHODS = ['GET', 'HEAD'];
const SIMPLE_VAR = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
const DEFAULT_HEADERS = {
  'User-Agent': 'RuiLink/1.0',
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
};

// ---------- 访问白名单 ----------

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function hostPattern(host) {
  // *.example.com 匹配任意层级的子域名；其他位置的 * 只匹配一段，比如 192.168.1.*
  const lead = host.startsWith('*.') ? '(?:[^.]+\\.)+' : '';
  const rest = lead ? host.slice(2) : host;
  return new RegExp(`^${lead}${escapeRe(rest).replace(/\*/g, '[^.]+')}$`, 'i');
}

function parseAllowHosts(spec) {
  return String(spec || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => {
      // host、host:port，IPv6 地址写在方括号里：[::1]:8080
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+|\*))?$/.exec(item);
      if (!m) throw new Error(`PROXY_ALLOW_HOSTS 中的「${item}」格式不正确`);
      return { host: hostPattern(m[1]), port: m[2] && m[2] !== '*' ? m[2] : null };
    });
}

const defaultPort = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');

function createHostChecker(spec, selfOrigin) {
  const rules = parseAllowHosts(spec);
  return (url) => {
    if (selfOrigin && url.origin === selfOrigin) return;
    if (!rules.length) return;
    const port = defaultPort(url);
    if (rules.some((r) => r.host.test(url.hostname) && (!r.port || r.port === port))) return;
    throw new RequestFailed('NOT_ALLOWED', `地址 ${url.hostname}:${port} 不在允许访问的范围内（由 PROXY_ALLOW_HOSTS 设置）`);
  };
}

// ---------- 变量替换与组装请求 ----------

function variablesToContext(vars) {
  const ctx = {};
  for (const v of normalizeVars(vars, { strict: false })) {
    if (v.enabled) ctx[v.key] = v.value;
  }
  return ctx;
}

function usedStrings(req) {
  const rows = (list) => list.filter((r) => r.enabled).flatMap((r) => [r.key, r.value]);
  const out = [req.url, ...rows(req.params), ...rows(req.headers)];
  if (req.body.mode === 'json') out.push(req.body.json);
  if (req.body.mode === 'raw') out.push(req.body.raw, req.body.rawType);
  if (req.body.mode === 'form') out.push(...rows(req.body.form));
  return out;
}

function findMissingVars(req, ctx) {
  const missing = new Set();
  for (const s of usedStrings(req)) {
    for (const m of s.matchAll(SIMPLE_VAR)) {
      const name = m[1];
      if (!isHelperName(name) && !Object.prototype.hasOwnProperty.call(ctx, name)) missing.add(name);
    }
  }
  return [...missing];
}

function resolveUrl(raw, selfOrigin) {
  const s = raw.trim();
  if (!s) throw new StoreError('请填写请求地址');
  let full = s;
  if (s.startsWith('/')) full = selfOrigin + s;
  else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) full = `http://${s}`;
  let url;
  try {
    url = new URL(full);
  } catch {
    throw new StoreError(`请求地址格式不正确：${s}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new StoreError(`只支持 http 和 https 地址：${s}`);
  url.hash = '';
  return url;
}

/**
 * 把编辑器里的请求（含 {{变量}}）变成真正要发出去的请求。
 * 有问题时抛出 StoreError（400）。
 */
function prepareRequest(input, variables, { selfOrigin, envName = '' } = {}) {
  const req = normalizeRequestContent(input);
  const ctx = variablesToContext(variables);
  const missing = findMissingVars(req, ctx);
  if (missing.length) {
    throw new StoreError(`变量未定义：${missing.join('、')}（${envName ? `当前环境：${envName}` : '当前没有选择环境'}）`);
  }

  const render = (s) => renderText(s, ctx);
  try {
    const url = resolveUrl(render(req.url), selfOrigin);
    const params = req.params.filter((p) => p.enabled && p.key.trim());
    if (params.length) {
      const qs = params.map((p) => `${encodeURIComponent(render(p.key))}=${encodeURIComponent(render(p.value))}`).join('&');
      url.search = url.search ? `${url.search}&${qs}` : `?${qs}`;
    }

    const headers = {};
    const setHeader = (name, value) => {
      const existing = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
      if (existing) delete headers[existing];
      headers[name] = value;
    };
    for (const h of req.headers) {
      if (h.enabled && h.key.trim()) setHeader(render(h.key).trim(), render(h.value));
    }
    const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

    let body;
    if (!NO_BODY_METHODS.includes(req.method)) {
      const { mode } = req.body;
      let contentType;
      if (mode === 'json') {
        body = render(req.body.json);
        contentType = 'application/json';
      } else if (mode === 'form') {
        const form = new URLSearchParams();
        for (const f of req.body.form) if (f.enabled && f.key.trim()) form.append(render(f.key), render(f.value));
        body = form.toString();
        contentType = 'application/x-www-form-urlencoded';
      } else if (mode === 'raw') {
        body = render(req.body.raw);
        contentType = render(req.body.rawType);
      }
      if (body !== undefined && contentType && !hasHeader('content-type')) headers['Content-Type'] = contentType;
    }
    for (const [k, v] of Object.entries(DEFAULT_HEADERS)) {
      if (!hasHeader(k)) headers[k] = v;
    }

    return { method: req.method, url, headers, body, options: req.options };
  } catch (err) {
    if (err instanceof TemplateError) throw new StoreError(`变量替换出错：${err.message}`);
    throw err;
  }
}

const sentView = (p) => ({ method: p.method, url: p.url.href, headers: p.headers, body: p.body === undefined ? null : p.body });

// ---------- 路由 ----------

function createClientRouter({ clientStore, enabled, disabledReason, allowHosts = '' }) {
  const router = express.Router();
  const selfOriginOf = (req) => `http://127.0.0.1:${req.socket.localPort}`;

  router.use((req, res, next) => {
    if (enabled) return next();
    res.status(403).json({ message: disabledReason });
  });

  router.get('/', (req, res) => {
    res.json({ ...clientStore.snapshot(), allowHosts, helpers: Object.keys(HELPERS) });
  });

  router.post('/collections', (req, res) => res.status(201).json(clientStore.createCollection(req.body)));
  router.put('/collections/:id', (req, res) => res.json(clientStore.updateCollection(req.params.id, req.body)));
  router.delete('/collections/:id', (req, res) => {
    clientStore.removeCollection(req.params.id);
    res.status(204).end();
  });

  router.post('/requests', (req, res) => res.status(201).json(clientStore.createRequest(req.body)));
  router.put('/requests/:id', (req, res) => res.json(clientStore.updateRequest(req.params.id, req.body)));
  router.delete('/requests/:id', (req, res) => {
    clientStore.removeRequest(req.params.id);
    res.status(204).end();
  });

  router.put('/environments', (req, res) => res.json(clientStore.setEnvironments(req.body && req.body.environments)));

  // 只做变量替换，不发送，用于「复制 curl」
  router.post('/preview', (req, res) => {
    const body = req.body || {};
    const prepared = prepareRequest(body.request, body.variables, { selfOrigin: selfOriginOf(req), envName: body.envName });
    res.json({ sent: sentView(prepared) });
  });

  // Express 4 不会捕获 async 函数里的异常，需要手动交给错误处理
  router.post('/send', (req, res, next) => send(req, res).catch(next));

  async function send(req, res) {
    const body = req.body || {};
    const selfOrigin = selfOriginOf(req);
    const prepared = prepareRequest(body.request, body.variables, { selfOrigin, envName: body.envName });
    const checkUrl = createHostChecker(allowHosts, selfOrigin);
    try {
      checkUrl(prepared.url);
    } catch (err) {
      throw new StoreError(err.message, 403);
    }

    // 浏览器点「取消」或断开时，同时中止发往目标的请求
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const result = await sendRequest({
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      body: prepared.body,
      timeout: prepared.options.timeout,
      followRedirects: prepared.options.followRedirects,
      insecure: prepared.options.insecure,
      signal: controller.signal,
      checkUrl,
    });
    if (res.destroyed) return;
    res.json({ sent: sentView(prepared), ...result });
  }

  router.get('/records', (req, res) => res.json(clientStore.listRecords()));
  router.get('/records/:id', (req, res) => res.json(clientStore.getRecord(req.params.id)));
  router.post('/records', (req, res) => res.status(201).json(clientStore.createRecord(req.body)));
  router.put('/records/:id', (req, res) => res.json(clientStore.updateRecord(req.params.id, req.body)));
  router.delete('/records/:id', (req, res) => {
    clientStore.removeRecord(req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { createClientRouter, prepareRequest, createHostChecker, parseAllowHosts };

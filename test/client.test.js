'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');
const { ClientStore, MAX_RECORDS } = require('../src/clientStore');
const { prepareRequest } = require('../src/clientRouter');
const seeds = require('../src/seeds');

const TOKEN = 's3cret';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

// 被调用的目标服务
async function startTarget() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const json = (status, data, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      const port = server.address().port;
      switch (req.url.split('?')[0]) {
        case '/echo':
          return json(200, { method: req.method, url: req.url, headers: req.headers, body });
        case '/r303':
          res.writeHead(303, { Location: '/echo' });
          return res.end();
        case '/r307':
          res.writeHead(307, { Location: '/echo' });
          return res.end();
        case '/r-other-host':
          res.writeHead(302, { Location: `http://localhost:${port}/echo` });
          return res.end();
        case '/r-loop':
          res.writeHead(302, { Location: '/r-loop' });
          return res.end();
        case '/gzip':
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
          return res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
        case '/gbk':
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=GBK' });
          return res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // 「中文」
        case '/png':
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
        case '/big':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(Buffer.alloc(11 * 1024 * 1024, 'a'));
        case '/slow':
          return; // 一直不返回
        default:
          return json(404, { error: 'not found' });
      }
    });
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, port, close: () => server.closeAllConnections() || server.close() };
}

async function startServer({ adminToken = TOKEN, clientEnabled = true, proxyAllowHosts = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-client-test-'));
  const store = new Store(path.join(dir, 'mocks.json'), seeds);
  const clientStore = new ClientStore(path.join(dir, 'client.json'), path.join(dir, 'records.json'));
  const app = createApp({ store, clientStore, adminToken, clientEnabled, proxyAllowHosts });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token = adminToken) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Admin-Token'] = token;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  };
  const send = (request, variables = [], envName = '') => call('POST', '/__admin/api/client/send', { request, variables, envName });
  const close = () => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { call, send, close, dir, clientStore };
}

async function setup(t, opts) {
  const target = await startTarget();
  const app = await startServer(opts);
  t.after(() => {
    target.close();
    app.close();
  });
  return { target, ...app };
}

const vars = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value, enabled: true }));

// ---------- 组装请求 ----------

test('组装请求：变量、内置函数、Params、默认请求头', () => {
  const p = prepareRequest(
    {
      method: 'POST',
      url: '{{baseUrl}}/api/x?a=1',
      params: [
        { key: 'q', value: '中 文', enabled: true },
        { key: 'off', value: '1', enabled: false },
      ],
      headers: [{ key: 'X-Token', value: 'Bearer {{token}}', enabled: true }],
      body: { mode: 'json', json: '{"qty": {{qty}}, "day": "{{now \'YYYY\'}}"}' },
    },
    vars({ baseUrl: 'http://h:8080', token: 'abc', qty: '10' }),
    { selfOrigin: 'http://127.0.0.1:1' },
  );
  assert.equal(p.url.href, 'http://h:8080/api/x?a=1&q=%E4%B8%AD%20%E6%96%87');
  assert.equal(p.headers['X-Token'], 'Bearer abc');
  assert.equal(p.headers['Content-Type'], 'application/json');
  assert.equal(p.headers['User-Agent'], 'RuiLink/1.0');
  const body = JSON.parse(p.body);
  assert.equal(body.qty, 10, '纯文本替换：没有引号的变量替换后是数字');
  assert.equal(body.day, String(new Date().getFullYear()), '有引号的仍然是字符串');
});

test('组装请求：未定义变量报错，禁用的变量也算未定义', () => {
  assert.throws(
    () => prepareRequest({ url: '{{baseUrl}}/x', headers: [{ key: 'T', value: '{{token}}' }] }, [{ key: 'baseUrl', value: 'h', enabled: true }, { key: 'token', value: 't', enabled: false }], { envName: '测试环境' }),
    /变量未定义：token（当前环境：测试环境）/,
  );
  assert.throws(() => prepareRequest({ url: '{{x}}' }, []), /当前没有选择环境/);
});

test('组装请求：相对地址指向自己，缺少协议时补 http，手动 Content-Type 优先，GET 忽略请求体', () => {
  const self = prepareRequest({ url: '/wms/a' }, [], { selfOrigin: 'http://127.0.0.1:3000' });
  assert.equal(self.url.href, 'http://127.0.0.1:3000/wms/a');
  assert.equal(prepareRequest({ url: '10.0.0.1:81/a' }, []).url.href, 'http://10.0.0.1:81/a');
  const p = prepareRequest({ method: 'PUT', url: 'h/x', headers: [{ key: 'content-type', value: 'text/xml' }], body: { mode: 'raw', raw: '<a/>', rawType: 'text/plain' } }, []);
  assert.deepEqual(Object.keys(p.headers).filter((k) => k.toLowerCase() === 'content-type'), ['content-type']);
  assert.equal(p.headers['content-type'], 'text/xml');
  const form = prepareRequest({ method: 'POST', url: 'h', body: { mode: 'form', form: [{ key: 'a', value: '1 2' }, { key: 'b', value: '&' }] } }, []);
  assert.equal(form.body, 'a=1+2&b=%26');
  assert.equal(form.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(prepareRequest({ method: 'GET', url: 'h', body: { mode: 'json', json: '{}' } }, []).body, undefined);
  assert.throws(() => prepareRequest({ url: 'ftp://h/x' }, []), /只支持 http 和 https/);
});

// ---------- 发送 ----------

test('发送：回显请求、实际请求、计时', async (t) => {
  const { target, send } = await setup(t);
  const res = await send({ method: 'POST', url: '{{base}}/echo', headers: [{ key: 'Authorization', value: 'x' }], body: { mode: 'json', json: '{"a":1}' } }, vars({ base: target.base }));
  assert.equal(res.status, 200);
  assert.equal(res.json.response.status, 200);
  const echo = JSON.parse(res.json.response.body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.body, '{"a":1}');
  assert.equal(echo.headers['content-type'], 'application/json');
  assert.equal(echo.headers['content-length'], '7');
  assert.equal(res.json.sent.url, `${target.base}/echo`);
  assert.equal(typeof res.json.timing.totalMs, 'number');
});

test('发送：相对地址调用本服务的模拟接口', async (t) => {
  const { send, call } = await setup(t);
  const res = await send({ method: 'POST', url: '/wms/api/feature-codes', body: { mode: 'json', json: '{}' } });
  assert.equal(JSON.parse(res.json.response.body).code, '0');
  const logs = await call('GET', '/__admin/api/logs');
  assert.equal(logs.json[0].url, '/wms/api/feature-codes', '也会记到请求日志里');
});

test('发送：重定向 303 改为 GET，307 保留请求体，跨主机去掉 Authorization，循环重定向报错', async (t) => {
  const { target, send } = await setup(t);
  const post = (p, extra = {}) => send({ method: 'POST', url: target.base + p, body: { mode: 'raw', raw: 'hello' }, ...extra });

  const r303 = await post('/r303');
  assert.equal(JSON.parse(r303.json.response.body).method, 'GET');
  assert.deepEqual(r303.json.redirects, [`${target.base}/echo`]);

  const r307 = JSON.parse((await post('/r307')).json.response.body);
  assert.equal(r307.method, 'POST');
  assert.equal(r307.body, 'hello');

  const other = JSON.parse((await post('/r-other-host', { method: 'GET', headers: [{ key: 'Authorization', value: 'secret' }] })).json.response.body);
  assert.equal(other.headers.authorization, undefined);

  const loop = await post('/r-loop', { method: 'GET' });
  assert.equal(loop.json.error.code, 'TOO_MANY_REDIRECTS');

  const noFollow = await post('/r303', { options: { followRedirects: false } });
  assert.equal(noFollow.json.response.status, 303);
});

test('发送：gzip 解压、GBK 解码、二进制、超过大小上限截断', async (t) => {
  const { target, send } = await setup(t);
  const get = (p) => send({ url: target.base + p }).then((r) => r.json.response);
  assert.deepEqual(JSON.parse((await get('/gzip')).body), { zipped: true });
  assert.equal((await get('/gbk')).body, '中文');
  const png = await get('/png');
  assert.equal(png.binary, true);
  assert.equal(png.size, 8);
  const big = await get('/big');
  assert.equal(big.truncated, true);
  assert.equal(big.size, 10 * 1024 * 1024);
});

test('发送：超时、连接被拒绝都返回中文说明', async (t) => {
  const { target, send } = await setup(t);
  const slow = await send({ url: `${target.base}/slow`, options: { timeout: 1000 } });
  assert.equal(slow.status, 200);
  assert.equal(slow.json.error.code, 'TIMEOUT');
  assert.match(slow.json.error.message, /超时/);

  const closed = http.createServer();
  const port = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const refused = await send({ url: `http://127.0.0.1:${port}/` });
  assert.equal(refused.json.error.code, 'ECONNREFUSED');
  assert.match(refused.json.error.message, /连接被拒绝/);
});

test('发送：参数有问题时返回 400', async (t) => {
  const { send } = await setup(t);
  const res = await send({ url: '{{nope}}/x' });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /变量未定义：nope/);
});

// ---------- 安全 ----------

test('安全：没设置口令时接口调用不可用，设置后必须带口令', async (t) => {
  const noToken = await startServer({ adminToken: '' });
  t.after(noToken.close);
  const info = await noToken.call('GET', '/__admin/api/info');
  assert.equal(info.json.client.enabled, false);
  assert.match(info.json.client.reason, /ADMIN_TOKEN/);
  assert.equal((await noToken.call('GET', '/__admin/api/client')).status, 403);
  assert.equal((await noToken.call('GET', '/__admin/api/mocks')).status, 200, '其他管理功能不受影响');

  const withToken = await startServer();
  t.after(withToken.close);
  assert.equal((await withToken.call('GET', '/__admin/api/client', undefined, '')).status, 401);
  assert.equal((await withToken.call('GET', '/__admin/api/client')).status, 200);

  const off = await startServer({ clientEnabled: false });
  t.after(off.close);
  assert.equal((await off.call('POST', '/__admin/api/client/send', { request: { url: '/x' } })).status, 403);
});

test('安全：PROXY_ALLOW_HOSTS 白名单，重定向之后的地址也检查', async (t) => {
  const { target, send } = await setup(t, { proxyAllowHosts: `127.0.0.1:${0}, 10.*` });
  const blocked = await send({ url: `${target.base}/echo` });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.message, /不在允许访问的范围内/);
  assert.equal((await send({ url: '/wms/api/feature-codes', method: 'POST' })).json.response.status, 200, '调用本服务不受限制');

  const app2 = await startServer({ proxyAllowHosts: `127.0.0.1:${target.port}` });
  t.after(app2.close);
  assert.equal((await app2.send({ url: `${target.base}/echo` })).json.response.status, 200);
  const redirected = await app2.send({ url: `${target.base}/r-other-host` });
  assert.equal(redirected.json.error.code, 'NOT_ALLOWED', '跳到 localhost 不在名单里');
});

// ---------- 集合、请求、环境、记录 ----------

test('集合与请求：增删改、移动、删除集合时一并删除请求、重启后仍在', async (t) => {
  const { call, dir } = await setup(t);
  const api = (m, u, b) => call(m, `/__admin/api/client${u}`, b);
  const c1 = (await api('POST', '/collections', { name: 'WMS' })).json;
  const c2 = (await api('POST', '/collections', { name: '其他' })).json;
  assert.equal((await api('POST', '/requests', { name: 'x', url: '/a' })).status, 400, '必须指定集合');
  const r = (await api('POST', '/requests', { collectionId: c1.id, name: '出库', method: 'post', url: '/a', headers: [{ key: '', value: '' }] })).json;
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, [], '空行会被去掉');

  const moved = (await api('PUT', `/requests/${r.id}`, { ...r, collectionId: c2.id, name: '出库2' })).json;
  assert.equal(moved.collectionId, c2.id);
  assert.equal(moved.createdAt, r.createdAt);

  await api('PUT', `/collections/${c2.id}`, { name: '改名' });
  const reloaded = new ClientStore(path.join(dir, 'client.json'), path.join(dir, 'records.json')).snapshot();
  assert.equal(reloaded.collections.find((c) => c.id === c2.id).name, '改名');
  assert.equal(reloaded.requests[0].name, '出库2');

  assert.equal((await api('DELETE', `/collections/${c2.id}`)).status, 204);
  assert.equal((await api('GET', '')).json.requests.length, 0);
});

test('环境：变量名校验', async (t) => {
  const { call } = await setup(t);
  const put = (environments) => call('PUT', '/__admin/api/client/environments', { environments });
  assert.equal((await put([{ name: '测试', vars: vars({ baseUrl: 'http://h', 'my-token': 't' }) }])).status, 200);
  assert.match((await put([{ name: '测试', vars: vars({ now: '1' }) }])).json.message, /和内置函数重名/);
  assert.match((await put([{ name: '测试', vars: vars({ '1a': '1' }) }])).json.message, /不合法/);
  assert.match((await put([{ name: '测试', vars: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] }])).json.message, /重复/);
  const { json } = await call('GET', '/__admin/api/client');
  assert.equal(json.environments[0].vars.length, 2, '校验失败时不会改动');
});

test('服务器记录：保存、列表、备注、删除、上限', async (t) => {
  const { call, clientStore } = await setup(t);
  const api = (m, u, b) => call(m, `/__admin/api/client${u}`, b);
  const long = 'x'.repeat(30000);
  const created = await api('POST', '/records', {
    time: '2026-10-27T08:00:00.000Z',
    envName: '测试',
    request: { method: 'POST', url: '{{b}}/a' },
    sent: { method: 'POST', url: 'http://h/a', headers: { a: '1' }, body: long },
    response: { status: 200, statusText: 'OK', headers: {}, body: long, size: 30000 },
    timing: { totalMs: 12, ttfbMs: 10 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.url, 'http://h/a');
  const detail = (await api('GET', `/records/${created.json.id}`)).json;
  assert.ok(detail.response.body.length < 20200, '响应体截断');
  assert.equal(detail.response.truncated, true);

  assert.equal((await api('PUT', `/records/${created.json.id}`, { note: '联调通过' })).json.note, '联调通过');
  assert.equal((await api('GET', '/records')).json[0].note, '联调通过');

  for (let i = 1; i < MAX_RECORDS; i++) clientStore.records.push({ ...detail, id: `r${i}` });
  assert.equal((await api('POST', '/records', { request: {} })).status, 409);

  assert.equal((await api('DELETE', `/records/${created.json.id}`)).status, 204);
  assert.equal((await api('GET', `/records/${created.json.id}`)).status, 404);
});

// ---------- 导出导入 ----------

test('导出导入：v2 带集合和请求、不含环境变量；v1 文件不影响现有集合', async (t) => {
  const { call } = await setup(t);
  const api = (m, u, b) => call(m, `/__admin/api${u}`, b);
  const c = (await api('POST', '/client/collections', { name: 'WMS' })).json;
  await api('POST', '/client/requests', { collectionId: c.id, name: 'r', url: '/a' });
  await api('PUT', '/client/environments', { environments: [{ name: 'e', vars: vars({ token: 'secret' }) }] });

  const exported = (await api('GET', '/export')).json;
  assert.equal(exported.version, 2);
  assert.equal(exported.client.collections.length, 1);
  assert.equal(exported.client.requests.length, 1);
  assert.equal(exported.client.environments, undefined);
  assert.ok(!JSON.stringify(exported).includes('secret'));

  // v1 文件覆盖导入：只替换接口
  await api('POST', '/import', { mode: 'replace', mocks: [{ method: 'GET', path: '/only' }] });
  assert.equal((await api('GET', '/client')).json.requests.length, 1);

  // v2 覆盖导入：集合和请求也替换，环境保留
  const res = await api('POST', '/import', { mode: 'replace', mocks: exported.mocks, client: { collections: [], requests: [] } });
  assert.equal(res.json.count, exported.mocks.length);
  const after = (await api('GET', '/client')).json;
  assert.equal(after.collections.length, 0);
  assert.equal(after.environments.length, 1);

  // 请求所属集合不存在时整体失败，接口配置也不会被改动
  const bad = await api('POST', '/import', { mode: 'replace', mocks: [], client: { collections: [], requests: [{ collectionId: 'nope', url: '/x' }] } });
  assert.equal(bad.status, 400);
  assert.equal((await api('GET', '/mocks')).json.length, exported.mocks.length);
});

'use strict';

// 对照测试：只通过 HTTP 调用，不依赖服务的内部代码，Node 版和 Rust 版（桌面端）用同一套用例。
//   node --test test/compat.test.js                    测 Node 版
//   MOCK_IMPL=rust node --test test/compat.test.js     测 Rust 版（需要先在 desktop/src-tauri 下 cargo build）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const IMPL = process.env.MOCK_IMPL || 'node';
const ROOT = path.join(__dirname, '..');
const RUST_BIN = path.join(ROOT, 'desktop', 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'ruilink.exe' : 'ruilink');
const TOKEN = 's3cret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// 启动被测服务，返回调用工具
async function startServer({ token = TOKEN, allowHosts = '', clientEnabled = true, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), `compat-${IMPL}-`));
  const port = await freePort();
  const child =
    IMPL === 'rust'
      ? spawn(RUST_BIN, ['--serve', '--port', String(port), '--data-dir', dir, '--token', token, '--allow-hosts', allowHosts, '--client-enabled', String(clientEnabled)], { stdio: 'ignore' })
      : spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
          stdio: 'ignore',
          env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_TOKEN: token, PROXY_ALLOW_HOSTS: allowHosts, CLIENT_ENABLED: String(clientEnabled) },
        });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/__health`)).ok) break;
    } catch {
      if (i > 100) throw new Error(`${IMPL} 服务没有启动`);
    }
    await sleep(100);
  }
  const call = async (method, url, body, tk = token, headers = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (tk) h['X-Admin-Token'] = tk;
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const send = (request, variables = [], envName = '') => call('POST', '/__admin/api/client/send', { request, variables, envName });
  const preview = (request, variables = [], envName = '') => call('POST', '/__admin/api/client/preview', { request, variables, envName });
  const stop = async () => {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  };
  const close = async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, port, call, send, preview, stop, close, dir };
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
        case '/br':
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' });
          return res.end(zlib.brotliCompressSync(JSON.stringify({ br: true })));
        case '/gbk':
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=GBK' });
          return res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
        case '/png':
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
        case '/big':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(Buffer.alloc(11 * 1024 * 1024, 'a'));
        case '/slow':
          return;
        default:
          return json(404, { error: 'not found' });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function setup(t, opts) {
  const target = await startTarget();
  const app = await startServer(opts);
  t.after(async () => {
    target.close();
    await app.close();
  });
  return { target, ...app };
}

const vars = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value, enabled: true }));
const SEED_COUNT = 5;

// ---------- 模拟接口 ----------

test(`[${IMPL}] I-03 出库：正常返回按数量生成垛明细`, async (t) => {
  const { call } = await setup(t);
  const res = await call('POST', '/wms/api/task/out', { taskNo: 'KILL001', batchNo: 'SC202610-01', featureCode: '102000', quantity: 5, stationCode: '01' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json; charset=utf-8/);
  assert.equal(res.json.code, '0');
  assert.equal(res.json.data.acceptedQty, 5);
  const stacks = res.json.data.stacks;
  assert.equal(stacks.length, 3);
  assert.equal(stacks[2].upBoxCode, '');
  const nums = [stacks[0].upBoxCode, stacks[0].downBoxCode, stacks[1].upBoxCode, stacks[1].downBoxCode, stacks[2].downBoxCode].map((c) => Number(c.slice(1)));
  assert.deepEqual(nums, nums.map((_, i) => nums[0] + i));
  assert.equal(stacks[0].featureCode, '102000');
  assert.match(res.json.data.wmsTaskNo, /^WMS\d{8}\d{6}$/);
  assert.deepEqual(Object.keys(res.json), ['code', 'msg', 'data'], 'JSON 字段顺序和配置一致');
});

test(`[${IMPL}] I-03 出库：参数校验失败、场景命中`, async (t) => {
  const { call } = await setup(t);
  const bad = await call('POST', '/wms/api/task/out', { quantity: '10', stationCode: '01' });
  assert.equal(bad.json.code, '1002');
  assert.match(bad.json.msg, /taskNo 不能为空/);
  assert.match(bad.json.msg, /quantity 应为整数/);
  const big = await call('POST', '/wms/api/task/out', { taskNo: 'K2', batchNo: 'SC1', featureCode: '102000', quantity: 300, stationCode: '01' });
  assert.equal(big.json.code, '3001');
});

test(`[${IMPL}] I-04 回库：必填和枚举校验`, async (t) => {
  const { call } = await setup(t);
  const base = { taskNo: 'BACK1', batchNo: 'SC1', quantity: 2, stationCode: '01', downBoxCode: '2' };
  assert.match((await call('POST', '/wms/api/task/back', { ...base, taskType: 'KILL' })).json.msg, /featureCode 必填/);
  assert.match((await call('POST', '/wms/api/task/back', { ...base, taskType: 'XX' })).json.msg, /KILL \/ CLEAN/);
  assert.equal((await call('POST', '/wms/api/task/back', { ...base, taskType: 'CLEAN' })).json.code, '0');
});

test(`[${IMPL}] 管理接口：新增、修改、重复校验、删除、请求日志`, async (t) => {
  const { call } = await setup(t);
  const created = await call('POST', '/__admin/api/mocks', { name: '查询箱子', method: 'GET', path: 'box/:code/', response: { status: 200, body: '{"code":"{{params.code}}","page":"{{query.page}}","n":"{{add query.page 1}}"}' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.path, '/box/:code');
  const hit = await call('GET', '/box/B001?page=3');
  assert.deepEqual(hit.json, { code: 'B001', page: '3', n: 4 });
  assert.equal((await call('POST', '/__admin/api/mocks', { method: 'GET', path: '/box/:code' })).status, 409);

  const updated = await call('PUT', `/__admin/api/mocks/${created.json.id}`, { ...created.json, response: { status: 201, headers: { 'X-Mock': 'yes' }, body: 'plain {{params.code}}' } });
  assert.equal(updated.status, 200);
  const hit2 = await call('GET', '/box/B002');
  assert.equal(hit2.status, 201);
  assert.equal(hit2.text, 'plain B002');
  assert.equal(hit2.headers.get('x-mock'), 'yes');
  assert.match(hit2.headers.get('content-type'), /text\/plain/);
  assert.equal(hit2.headers.get('access-control-allow-origin'), '*');

  const logs = await call('GET', `/__admin/api/logs?mockId=${created.json.id}`);
  assert.equal(logs.json.length, 2);
  assert.equal(logs.json[0].url, '/box/B002');
  assert.equal(logs.json[0].hit, '默认返回');
  assert.equal(logs.json[1].request.query.page, '3');

  assert.equal((await call('DELETE', `/__admin/api/mocks/${created.json.id}`)).status, 204);
  const miss = await call('GET', '/box/B002');
  assert.equal(miss.status, 404);
  assert.equal(miss.json.msg, '未找到匹配的接口: GET /box/B002');
});

test(`[${IMPL}] 模拟接口：表单请求体、查询数组、跨域预检、根路径跳转`, async (t) => {
  const { call } = await setup(t);
  await call('POST', '/__admin/api/mocks', { method: 'ANY', path: '/echo/*', response: { body: '{"b":"{{body}}","q":"{{query.a}}","w":"{{params.*}}","m":"{{method}}"}' } });
  const form = await call('POST', '/echo/x/y?a=1&a=2', 'k=v&n=1', null, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.deepEqual(form.json, { b: { k: 'v', n: '1' }, q: ['1', '2'], w: 'x/y', m: 'POST' });
  const opt = await call('OPTIONS', '/echo/x', undefined, null, { Origin: 'http://a.com', 'Access-Control-Request-Headers': 'x-token' });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), 'http://a.com');
  assert.equal(opt.headers.get('access-control-allow-headers'), 'x-token');
  const root = await call('GET', '/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/__admin/');
});

test(`[${IMPL}] 保留路径、管理页面、健康检查`, async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('POST', '/__admin/api/mocks', { method: 'GET', path: '/__admin/x' })).status, 400);
  const page = await call('GET', '/__admin/');
  assert.equal(page.status, 200);
  assert.match(page.text, /瑞联/);
  assert.equal((await call('GET', '/__admin/client.js')).status, 200);
  assert.deepEqual((await call('GET', '/__health')).json, { status: 'ok' });
});

test(`[${IMPL}] 口令：需要携带，模拟接口不受影响`, async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/__admin/api/info', undefined, '')).json.authRequired, true);
  assert.equal((await call('GET', '/__admin/api/mocks', undefined, '')).status, 401);
  assert.equal((await call('GET', '/__admin/api/mocks')).status, 200);
  assert.equal((await call('POST', '/wms/api/feature-codes', {}, '')).json.code, '0');
});

test(`[${IMPL}] 配置持久化：重启后仍然存在`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `compat-persist-${IMPL}-`));
  const a = await startServer({ dataDir: dir });
  await a.call('POST', '/__admin/api/mocks', { method: 'POST', path: '/persist' });
  const c = await a.call('POST', '/__admin/api/client/collections', { name: 'C' });
  await a.call('POST', '/__admin/api/client/requests', { collectionId: c.json.id, name: 'R', url: '/x' });
  await a.stop();
  const b = await startServer({ dataDir: dir });
  try {
    assert.equal((await b.call('GET', '/__admin/api/mocks')).json.length, SEED_COUNT + 1);
    assert.equal((await b.call('GET', '/__admin/api/client')).json.requests[0].name, 'R');
  } finally {
    await b.close();
  }
});

// ---------- 接口调用：组装请求 ----------

test(`[${IMPL}] 组装请求：变量、内置函数、Params、默认请求头`, async (t) => {
  const { preview } = await setup(t);
  const { json } = await preview(
    {
      method: 'POST',
      url: '{{baseUrl}}/api/x?a=1',
      params: [{ key: 'q', value: '中 文', enabled: true }, { key: 'off', value: '1', enabled: false }],
      headers: [{ key: 'X-Token', value: 'Bearer {{token}}', enabled: true }],
      body: { mode: 'json', json: '{"qty": {{qty}}, "day": "{{now \'YYYY\'}}"}' },
    },
    vars({ baseUrl: 'http://h:8080', token: 'abc', qty: '10' }),
  );
  assert.equal(json.sent.url, 'http://h:8080/api/x?a=1&q=%E4%B8%AD%20%E6%96%87');
  assert.equal(json.sent.headers['X-Token'], 'Bearer abc');
  assert.equal(json.sent.headers['Content-Type'], 'application/json');
  assert.equal(json.sent.headers['User-Agent'], 'RuiLink/1.0');
  const body = JSON.parse(json.sent.body);
  assert.equal(body.qty, 10);
  assert.equal(body.day, String(new Date().getFullYear()));
});

test(`[${IMPL}] 组装请求：未定义变量、相对地址、表单、GET 不带请求体`, async (t) => {
  const { preview, port } = await setup(t);
  const missing = await preview({ url: '{{baseUrl}}/x', headers: [{ key: 'T', value: '{{token}}' }] }, [{ key: 'baseUrl', value: 'h', enabled: true }, { key: 'token', value: 't', enabled: false }], '测试环境');
  assert.equal(missing.status, 400);
  assert.match(missing.json.message, /变量未定义：token（当前环境：测试环境）/);
  assert.equal((await preview({ url: '/wms/a' })).json.sent.url, `http://127.0.0.1:${port}/wms/a`);
  assert.equal((await preview({ url: '10.0.0.1:81/a' })).json.sent.url, 'http://10.0.0.1:81/a');
  const form = await preview({ method: 'POST', url: 'h', body: { mode: 'form', form: [{ key: 'a', value: '1 2' }, { key: 'b', value: '&' }] } });
  assert.equal(form.json.sent.body, 'a=1+2&b=%26');
  assert.equal((await preview({ method: 'GET', url: 'h', body: { mode: 'json', json: '{}' } })).json.sent.body, null);
  assert.equal((await preview({ url: 'ftp://h/x' })).status, 400);
});

// ---------- 接口调用：发送 ----------

test(`[${IMPL}] 发送：回显请求、相对地址调用模拟接口`, async (t) => {
  const { target, send } = await setup(t);
  const res = await send({ method: 'POST', url: '{{base}}/echo', body: { mode: 'json', json: '{"a":1}' } }, vars({ base: target.base }));
  assert.equal(res.json.response.status, 200);
  const echo = JSON.parse(res.json.response.body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.body, '{"a":1}');
  assert.equal(echo.headers['content-type'], 'application/json');
  assert.equal(echo.headers['content-length'], '7');
  assert.equal(typeof res.json.timing.totalMs, 'number');
  const self = await send({ method: 'POST', url: '/wms/api/feature-codes', body: { mode: 'json', json: '{}' } });
  assert.equal(JSON.parse(self.json.response.body).code, '0');
});

test(`[${IMPL}] 发送：重定向`, async (t) => {
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
  assert.equal((await post('/r-loop', { method: 'GET' })).json.error.code, 'TOO_MANY_REDIRECTS');
  assert.equal((await post('/r303', { options: { followRedirects: false } })).json.response.status, 303);
});

test(`[${IMPL}] 发送：gzip、br、GBK、二进制、大小上限`, async (t) => {
  const { target, send } = await setup(t);
  const get = (p) => send({ url: target.base + p }).then((r) => r.json.response);
  assert.deepEqual(JSON.parse((await get('/gzip')).body), { zipped: true });
  assert.deepEqual(JSON.parse((await get('/br')).body), { br: true });
  assert.equal((await get('/gbk')).body, '中文');
  const png = await get('/png');
  assert.equal(png.binary, true);
  assert.equal(png.size, 8);
  const big = await get('/big');
  assert.equal(big.truncated, true);
  assert.equal(big.size, 10 * 1024 * 1024);
});

test(`[${IMPL}] 发送：超时、连接被拒绝`, async (t) => {
  const { target, send } = await setup(t);
  const slow = await send({ url: `${target.base}/slow`, options: { timeout: 1000 } });
  assert.equal(slow.status, 200);
  assert.equal(slow.json.error.code, 'TIMEOUT');
  assert.match(slow.json.error.message, /超时/);
  const port = await freePort();
  const refused = await send({ url: `http://127.0.0.1:${port}/` });
  assert.equal(refused.json.error.code, 'ECONNREFUSED');
  assert.match(refused.json.error.message, /连接被拒绝/);
});

// ---------- 安全 ----------

test(`[${IMPL}] 安全：没设置口令时接口调用不可用；可以关闭`, async (t) => {
  const noToken = await startServer({ token: '' });
  t.after(noToken.close);
  const info = await noToken.call('GET', '/__admin/api/info');
  assert.equal(info.json.client.enabled, false);
  assert.match(info.json.client.reason, /ADMIN_TOKEN/);
  assert.equal((await noToken.call('GET', '/__admin/api/client')).status, 403);
  assert.equal((await noToken.call('GET', '/__admin/api/mocks')).status, 200);

  const off = await startServer({ clientEnabled: false });
  t.after(off.close);
  assert.equal((await off.call('POST', '/__admin/api/client/send', { request: { url: '/x' } })).status, 403);
});

test(`[${IMPL}] 安全：访问白名单，重定向之后也检查`, async (t) => {
  const target = await startTarget();
  t.after(() => target.close());
  const a = await startServer({ allowHosts: '127.0.0.1:1, 10.*' });
  t.after(a.close);
  const blocked = await a.send({ url: `${target.base}/echo` });
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.message, /不在允许访问的范围内/);
  assert.equal((await a.send({ url: '/wms/api/feature-codes', method: 'POST' })).json.response.status, 200);

  const b = await startServer({ allowHosts: `127.0.0.1:${target.port}` });
  t.after(b.close);
  assert.equal((await b.send({ url: `${target.base}/echo` })).json.response.status, 200);
  assert.equal((await b.send({ url: `${target.base}/r-other-host` })).json.error.code, 'NOT_ALLOWED');
});

// ---------- 集合、环境、记录、导入导出 ----------

test(`[${IMPL}] 集合与请求：增删改、移动、删除集合时一并删除请求`, async (t) => {
  const { call } = await setup(t);
  const api = (m, u, b) => call(m, `/__admin/api/client${u}`, b);
  const c1 = (await api('POST', '/collections', { name: 'WMS' })).json;
  const c2 = (await api('POST', '/collections', { name: '其他' })).json;
  assert.equal((await api('POST', '/requests', { name: 'x', url: '/a' })).status, 400);
  const r = (await api('POST', '/requests', { collectionId: c1.id, name: '出库', method: 'post', url: '/a', headers: [{ key: '', value: '' }] })).json;
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, []);
  const moved = (await api('PUT', `/requests/${r.id}`, { ...r, collectionId: c2.id, name: '出库2' })).json;
  assert.equal(moved.collectionId, c2.id);
  assert.equal(moved.createdAt, r.createdAt);
  assert.equal((await api('PUT', `/collections/${c2.id}`, { name: '改名' })).json.name, '改名');
  assert.equal((await api('DELETE', `/collections/${c2.id}`)).status, 204);
  const snap = (await api('GET', '')).json;
  assert.equal(snap.requests.length, 0);
  assert.ok(snap.helpers.includes('uuid'));
});

test(`[${IMPL}] 环境：变量名校验`, async (t) => {
  const { call } = await setup(t);
  const put = (environments) => call('PUT', '/__admin/api/client/environments', { environments });
  assert.equal((await put([{ name: '测试', vars: vars({ baseUrl: 'http://h', 'my-token': 't' }) }])).status, 200);
  assert.match((await put([{ name: '测试', vars: vars({ now: '1' }) }])).json.message, /和内置函数重名/);
  assert.match((await put([{ name: '测试', vars: vars({ '1a': '1' }) }])).json.message, /不合法/);
  assert.match((await put([{ name: '测试', vars: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] }])).json.message, /重复/);
  assert.equal((await call('GET', '/__admin/api/client')).json.environments[0].vars.length, 2);
});

test(`[${IMPL}] 服务器记录：保存、备注、截断、删除、上限`, async (t) => {
  const { call } = await setup(t);
  const api = (m, u, b) => call(m, `/__admin/api/client${u}`, b);
  const long = 'x'.repeat(30000);
  const record = {
    time: '2026-10-27T08:00:00.000Z',
    envName: '测试',
    request: { method: 'POST', url: '{{b}}/a' },
    sent: { method: 'POST', url: 'http://h/a', headers: { a: '1' }, body: long },
    response: { status: 200, statusText: 'OK', headers: {}, body: long, size: 30000 },
    timing: { totalMs: 12, ttfbMs: 10 },
  };
  const created = await api('POST', '/records', record);
  assert.equal(created.status, 201);
  assert.equal(created.json.url, 'http://h/a');
  const detail = (await api('GET', `/records/${created.json.id}`)).json;
  assert.ok(detail.response.body.length < 20200);
  assert.equal(detail.response.truncated, true);
  assert.equal(detail.time, '2026-10-27T08:00:00.000Z');
  assert.equal((await api('PUT', `/records/${created.json.id}`, { note: '联调通过' })).json.note, '联调通过');
  assert.equal((await api('GET', '/records')).json[0].note, '联调通过');
  for (let i = 1; i < 500; i++) await api('POST', '/records', { request: {} });
  assert.equal((await api('POST', '/records', { request: {} })).status, 409);
  assert.equal((await api('DELETE', `/records/${created.json.id}`)).status, 204);
  assert.equal((await api('GET', `/records/${created.json.id}`)).status, 404);
});

test(`[${IMPL}] 导出导入：v2 不含环境变量；v1 文件不影响集合；失败时不改动`, async (t) => {
  const { call } = await setup(t);
  const api = (m, u, b) => call(m, `/__admin/api${u}`, b);
  const c = (await api('POST', '/client/collections', { name: 'WMS' })).json;
  await api('POST', '/client/requests', { collectionId: c.id, name: 'r', url: '/a' });
  await api('PUT', '/client/environments', { environments: [{ name: 'e', vars: vars({ token: 'secret' }) }] });

  const exported = (await api('GET', '/export')).json;
  assert.equal(exported.version, 2);
  assert.equal(exported.mocks.length, SEED_COUNT);
  assert.equal(exported.client.collections.length, 1);
  assert.equal(exported.client.requests.length, 1);
  assert.ok(!JSON.stringify(exported).includes('secret'));

  await api('POST', '/import', { mode: 'replace', mocks: [{ method: 'GET', path: '/only' }] });
  assert.equal((await api('GET', '/mocks')).json.length, 1);
  assert.equal((await api('GET', '/client')).json.requests.length, 1);

  const res = await api('POST', '/import', { mode: 'replace', mocks: exported.mocks, client: { collections: [], requests: [] } });
  assert.equal(res.json.count, SEED_COUNT);
  const after = (await api('GET', '/client')).json;
  assert.equal(after.collections.length, 0);
  assert.equal(after.environments.length, 1);

  const bad = await api('POST', '/import', { mode: 'replace', mocks: [], client: { collections: [], requests: [{ collectionId: 'nope', url: '/x' }] } });
  assert.equal(bad.status, 400);
  assert.equal((await api('GET', '/mocks')).json.length, SEED_COUNT);

  await api('POST', '/import', { mode: 'merge', mocks: [{ method: 'GET', path: '/new' }] });
  assert.equal((await api('GET', '/mocks')).json.length, SEED_COUNT + 1);
});

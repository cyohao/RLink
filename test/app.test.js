'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');
const { matchPath } = require('../src/engine');
const seeds = require('../src/seeds');

async function startServer({ adminToken = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-test-'));
  const store = new Store(path.join(dir, 'mocks.json'), seeds);
  const app = createApp({ store, adminToken });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const close = () => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { call, close, dir };
}

test('路径匹配：参数、通配符、优先级', () => {
  assert.deepEqual(matchPath('/box/:id', '/box/B01').params, { id: 'B01' });
  assert.equal(matchPath('/box/:id', '/box/B01/x'), null);
  assert.deepEqual(matchPath('/files/*', '/files/a/b').params, { '*': 'a/b' });
  assert.ok(matchPath('/box/list', '/box/list').score > matchPath('/box/:id', '/box/list').score);
});

test('I-03 出库：正常返回按数量生成垛明细', async (t) => {
  const { call, close } = await startServer();
  t.after(close);
  const res = await call('POST', '/wms/api/task/out', {
    taskNo: 'KILL001',
    batchNo: 'SC202610-01',
    featureCode: '102000',
    quantity: 5,
    stationCode: '01',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.code, '0');
  assert.equal(res.json.data.acceptedQty, 5);
  const stacks = res.json.data.stacks;
  assert.equal(stacks.length, 3);
  assert.equal(stacks[2].upBoxCode, '', '奇数数量时最后一垛为单箱');
  assert.notEqual(stacks[0].upBoxCode, '');
  const nums = [stacks[0].upBoxCode, stacks[0].downBoxCode, stacks[1].upBoxCode, stacks[1].downBoxCode, stacks[2].downBoxCode]
    .map((code) => Number(code.slice(1)));
  assert.deepEqual(nums, nums.map((_, i) => nums[0] + i), '箱号连续不跳号');
  assert.equal(stacks[0].featureCode, '102000');
  assert.match(res.json.data.wmsTaskNo, /^WMS\d{8}\d{6}$/);
});

test('I-03 出库：参数校验失败返回 1002', async (t) => {
  const { call, close } = await startServer();
  t.after(close);
  const res = await call('POST', '/wms/api/task/out', { quantity: '10', stationCode: '01' });
  assert.equal(res.json.code, '1002');
  assert.match(res.json.msg, /taskNo 不能为空/);
  assert.match(res.json.msg, /quantity 应为整数/);
});

test('I-03 出库：数量超过 200 命中库存不足场景', async (t) => {
  const { call, close } = await startServer();
  t.after(close);
  const res = await call('POST', '/wms/api/task/out', {
    taskNo: 'KILL002',
    batchNo: 'SC202610-01',
    featureCode: '102000',
    quantity: 300,
    stationCode: '01',
  });
  assert.equal(res.json.code, '3001');
});

test('I-04 回库：KILL 缺少特征码、枚举校验', async (t) => {
  const { call, close } = await startServer();
  t.after(close);
  const base = { taskNo: 'BACK1', batchNo: 'SC1', quantity: 2, stationCode: '01', downBoxCode: '2' };
  assert.match((await call('POST', '/wms/api/task/back', { ...base, taskType: 'KILL' })).json.msg, /featureCode 必填/);
  assert.match((await call('POST', '/wms/api/task/back', { ...base, taskType: 'XX' })).json.msg, /KILL \/ CLEAN/);
  assert.equal((await call('POST', '/wms/api/task/back', { ...base, taskType: 'CLEAN' })).json.code, '0');
});

test('管理接口：新增、修改、重复校验、删除、请求日志', async (t) => {
  const { call, close } = await startServer();
  t.after(close);

  const created = await call('POST', '/__admin/api/mocks', {
    name: '查询箱子',
    method: 'GET',
    path: 'box/:code/',
    response: { status: 200, body: '{"code":"{{params.code}}","page":"{{query.page}}"}' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.path, '/box/:code', '路径自动补斜杠并去掉末尾斜杠');

  const hit = await call('GET', '/box/B001?page=3');
  assert.deepEqual(hit.json, { code: 'B001', page: '3' });

  const dup = await call('POST', '/__admin/api/mocks', { method: 'GET', path: '/box/:code' });
  assert.equal(dup.status, 409);

  const updated = await call('PUT', `/__admin/api/mocks/${created.json.id}`, {
    ...created.json,
    response: { status: 201, headers: { 'X-Mock': 'yes' }, body: 'plain {{params.code}}' },
  });
  assert.equal(updated.status, 200);
  const hit2 = await call('GET', '/box/B002');
  assert.equal(hit2.status, 201);
  assert.equal(hit2.text, 'plain B002');
  assert.equal(hit2.headers.get('x-mock'), 'yes');
  assert.match(hit2.headers.get('content-type'), /text\/plain/);

  const logs = await call('GET', `/__admin/api/logs?mockId=${created.json.id}`);
  assert.equal(logs.json.length, 2);
  assert.equal(logs.json[0].url, '/box/B002');

  assert.equal((await call('DELETE', `/__admin/api/mocks/${created.json.id}`)).status, 204);
  assert.equal((await call('GET', '/box/B002')).status, 404);
});

test('保留路径不能被占用', async (t) => {
  const { call, close } = await startServer();
  t.after(close);
  const res = await call('POST', '/__admin/api/mocks', { method: 'GET', path: '/__admin/x' });
  assert.equal(res.status, 400);
});

test('设置管理口令后需要携带口令，模拟接口不受影响', async (t) => {
  const { call, close } = await startServer({ adminToken: 's3cret' });
  t.after(close);
  assert.equal((await call('GET', '/__admin/api/info')).json.authRequired, true);
  assert.equal((await call('GET', '/__admin/api/mocks')).status, 401);
  assert.equal((await call('GET', '/__admin/api/mocks', undefined, { 'X-Admin-Token': 's3cret' })).status, 200);
  assert.equal((await call('POST', '/wms/api/feature-codes', {})).json.code, '0');
});

test('导入导出：合并与覆盖', async (t) => {
  const { call, close } = await startServer();
  t.after(close);
  const exported = (await call('GET', '/__admin/api/export')).json;
  assert.equal(exported.mocks.length, seeds.length);

  const extra = { name: '新接口', method: 'GET', path: '/new' };
  await call('POST', '/__admin/api/import', { mode: 'merge', mocks: [extra] });
  assert.equal((await call('GET', '/__admin/api/mocks')).json.length, seeds.length + 1);

  await call('POST', '/__admin/api/import', { mode: 'replace', mocks: [extra] });
  assert.equal((await call('GET', '/__admin/api/mocks')).json.length, 1);
});

test('配置持久化：重启后仍然存在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-persist-'));
  const file = path.join(dir, 'mocks.json');
  const store = new Store(file, []);
  store.create({ method: 'POST', path: '/persist' });
  const reloaded = new Store(file, seeds);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].path, '/persist');
  fs.rmSync(dir, { recursive: true, force: true });
});

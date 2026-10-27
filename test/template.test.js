'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBody, renderString, TemplateError } = require('../src/template');

const ctx = {
  body: { taskNo: 'T001', quantity: 5, items: [{ code: 'A' }] },
  query: { page: '2' },
  headers: { 'x-auth-token': 'abc' },
};

test('整个字符串是单个表达式时保留原始类型', () => {
  assert.equal(renderString('{{body.quantity}}', ctx), 5);
  assert.deepEqual(renderString('{{body.items}}', ctx), [{ code: 'A' }]);
});

test('字符串中嵌入多个表达式时拼接', () => {
  assert.equal(renderString('任务{{body.taskNo}}-{{query.page}}', ctx), '任务T001-2');
  assert.equal(renderString('{{body.taskNo}}{{query.page}}', ctx), 'T0012');
});

test('取值路径支持数组下标和带横线的 header', () => {
  assert.equal(renderString('{{body.items[0].code}}', ctx), 'A');
  assert.equal(renderString('{{headers.x-auth-token}}', ctx), 'abc');
  assert.equal(renderString('{{body.missing.deep}}', ctx), undefined);
});

test('函数与嵌套调用', () => {
  assert.equal(renderString("{{concat 'B' (pad 7 4)}}", ctx), 'B0007');
  assert.equal(renderString('{{ceil (div body.quantity 2)}}', ctx), 3);
  assert.equal(renderString("{{default body.none 'x'}}", ctx), 'x');
  assert.match(renderString("{{now 'YYYYMMDD'}}", ctx), /^\d{8}$/);
  assert.match(renderString("{{randomStr 6 'digit'}}", ctx), /^\d{6}$/);
});

test('seq 按名称递增', () => {
  const first = renderString("{{seq 'test-seq' 10}}", ctx);
  assert.equal(first, 10);
  assert.equal(renderString("{{seq 'test-seq'}}", ctx), 11);
});

test('if 只执行选中的分支', () => {
  assert.equal(renderString("{{seq 'lazy'}}", ctx), 1);
  assert.equal(renderString("{{if (gt 1 2) (seq 'lazy') 'no'}}", ctx), 'no');
  assert.equal(renderString("{{seq 'lazy'}}", ctx), 2, '未选中的分支不应消耗序号');
  assert.equal(renderString("{{if (eq body.taskNo 'T001') 'yes'}}", ctx), 'yes');
});

test('$repeat 按次数生成数组，并提供 $index / $no', () => {
  const tpl = JSON.stringify({
    list: { $repeat: '{{body.quantity}}', $item: { no: '{{$no}}', idx: '{{$index}}' } },
  });
  const out = JSON.parse(renderBody(tpl, ctx).body);
  assert.equal(out.list.length, 5);
  assert.deepEqual(out.list[4], { no: 5, idx: 4 });
});

test('非 JSON 返回值按文本渲染', () => {
  const out = renderBody('hello {{body.taskNo}}', ctx);
  assert.deepEqual(out, { body: 'hello T001', json: false });
});

test('错误的表达式给出明确提示', () => {
  assert.throws(() => renderString('{{unknownFn 1}}', ctx), TemplateError);
  assert.throws(() => renderString("{{concat 'a}}", ctx), /引号/);
  assert.throws(() => renderString('{{div 1 0}}', ctx), /除数/);
  assert.throws(() => renderBody(JSON.stringify({ x: { $repeat: 999999 } }), ctx), /不能超过/);
});

test('无法通过取值路径访问原型', () => {
  assert.equal(renderString('{{body.__proto__}}', ctx), undefined);
  assert.equal(renderString('{{body.constructor}}', ctx), undefined);
});

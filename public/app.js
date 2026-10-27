'use strict';

const API = '/__admin/api';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'];
const SOURCES = [['body', 'Body'], ['query', 'Query'], ['params', '路径参数'], ['headers', 'Header']];
const TYPES = [['any', '任意'], ['string', '字符串'], ['number', '数字'], ['integer', '整数'], ['boolean', '布尔'], ['array', '数组'], ['object', '对象']];
const OPS = [['eq', '等于'], ['ne', '不等于'], ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'], ['contains', '包含'], ['exists', '有值'], ['notExists', '为空']];
const NO_VALUE_OPS = ['exists', 'notExists'];

const DEFAULT_OK_BODY = '{\n  "code": "0",\n  "msg": "success",\n  "data": {}\n}';
const DEFAULT_ERROR_BODY = '{\n  "code": "400",\n  "msg": "{{error}}",\n  "data": null\n}';

const state = {
  mocks: [],
  selectedId: null,
  draft: null,
  dirty: false,
  filter: '',
  view: 'mocks',
  logs: [],
  selectedLogId: null,
  logMockId: '',
  logTimer: null,
  debug: new Map(),
};

const $ = (sel) => document.querySelector(sel);
// 模拟接口的地址。桌面端连接服务器时，模拟接口由服务器提供，desktop.js 会改写这个值
let mockOrigin = location.origin;
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.path.localeCompare(b.path) || a.method.localeCompare(b.method);

// ---------- 通用工具 ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = true;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  // select 要在选项加进来之后才能设置 value
  if (value !== undefined) el.value = value;
  return el;
}

const options = (pairs, current) =>
  pairs.map(([v, label]) => h('option', { value: v, selected: v === current }, label));

function toast(message, type = 'ok') {
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 2500);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function storageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // 浏览器禁用存储时忽略
  }
}

function prettyText(text) {
  if (typeof text !== 'string' || text === '') return text || '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const pretty = (v) => (typeof v === 'string' ? prettyText(v) : JSON.stringify(v, null, 2));

function formatTime(iso) {
  const d = new Date(iso);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// http 访问服务器 IP 时 navigator.clipboard 不可用，退回到 execCommand
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

function download(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- 接口请求 ----------

let adminToken = storageGet('mockAdminToken');

async function api(method, url, body, { signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const res = await fetch(API + url, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    const input = window.prompt('请输入管理口令（服务启动时设置的 ADMIN_TOKEN）');
    if (input === null) throw new Error('需要管理口令');
    adminToken = input.trim();
    storageSet('mockAdminToken', adminToken);
    return api(method, url, body, { signal });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
  return data;
}

// ---------- 草稿：响应头在编辑时用数组，方便增删行 ----------

const headersToRows = (obj) => Object.entries(obj || {}).map(([key, value]) => ({ key, value }));

function toDraft(mock) {
  const d = structuredClone(mock);
  for (const r of [d.response, d.validationResponse, ...d.scenarios.map((s) => s.response)]) {
    r.headers = headersToRows(r.headers);
  }
  return d;
}

function blankDraft() {
  return {
    id: null,
    name: '',
    description: '',
    method: 'POST',
    path: '/api/',
    enabled: true,
    delay: 0,
    rules: [],
    validationResponse: { status: 200, headers: [], body: DEFAULT_ERROR_BODY },
    scenarios: [],
    response: { status: 200, headers: [], body: DEFAULT_OK_BODY },
  };
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  const mark = $('#dirty-mark');
  if (mark) mark.hidden = false;
}

const confirmDiscard = () => !state.dirty || window.confirm('当前修改还没保存，确定放弃吗？');

// ---------- 接口列表 ----------

async function loadMocks() {
  state.mocks = await api('GET', '/mocks');
  renderList();
  renderLogFilter();
}

function renderList() {
  const box = $('#mock-list');
  const q = state.filter.trim().toLowerCase();
  const items = state.mocks
    .filter((m) => !q || `${m.name} ${m.path} ${m.method}`.toLowerCase().includes(q))
    .sort(byName);

  box.replaceChildren(
    ...(items.length
      ? items.map((m) =>
          h(
            'button',
            {
              class: `mock-item${m.id === state.selectedId ? ' active' : ''}${m.enabled ? '' : ' disabled'}`,
              onclick: () => selectMock(m.id),
            },
            h('span', { class: `method m-${m.method}` }, m.method),
            h('span', { class: 'mock-text' }, h('span', { class: 'mock-name' }, m.name), h('span', { class: 'mock-path' }, m.path)),
            m.enabled ? null : h('span', { class: 'tag' }, '停用'),
          ),
        )
      : [h('div', { class: 'empty' }, q ? '没有匹配的接口' : '还没有接口，点击「新建」添加')]),
  );
}

function selectMock(id) {
  if (id === state.selectedId && state.draft) return;
  if (!confirmDiscard()) return;
  const mock = state.mocks.find((m) => m.id === id);
  state.selectedId = id;
  state.draft = mock ? toDraft(mock) : null;
  state.dirty = false;
  renderList();
  renderEditor();
}

function newMock() {
  if (!confirmDiscard()) return;
  state.selectedId = null;
  state.draft = blankDraft();
  state.dirty = true;
  renderList();
  renderEditor();
  $('#f-path')?.focus();
}

// ---------- 编辑区 ----------

function renderEditor() {
  const root = $('#editor');
  const d = state.draft;
  if (!d) {
    root.replaceChildren(h('div', { class: 'placeholder' }, '从左侧选择一个接口，或点击「新建」'));
    return;
  }
  const scrollTop = root.scrollTop;
  root.replaceChildren(
    h(
      'div',
      { class: 'editor-bar' },
      h('div', { class: 'editor-title' }, d.id ? d.name || d.path : '新建接口', h('span', { class: 'dirty-mark', id: 'dirty-mark', hidden: !state.dirty }, '● 未保存')),
      d.id ? h('button', { class: 'btn ghost', onclick: duplicateMock }, '复制为新接口') : null,
      d.id ? h('button', { class: 'btn ghost danger', onclick: deleteMock }, '删除') : null,
      h('button', { class: 'btn primary', onclick: saveMock, title: 'Ctrl + S' }, '保存'),
    ),
    h(
      'div',
      { class: 'editor-body' },
      basicCard(d),
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, '默认返回', h('span', { class: 'muted' }, '条件场景没命中、参数校验也通过时返回')), responseEditor(d.response)),
      rulesCard(d),
      scenariosCard(d),
      d.id ? debugCard(d) : null,
    ),
  );
  root.scrollTop = scrollTop;
}

function bindInput(obj, key, attrs = {}, transform = (v) => v) {
  const { oninput, ...rest } = attrs;
  return h('input', {
    type: 'text',
    value: obj[key] ?? '',
    ...rest,
    oninput: (e) => {
      obj[key] = transform(e.target.value);
      markDirty();
      if (oninput) oninput(e);
    },
  });
}

function bindCheckbox(obj, key, onchange) {
  return h('input', {
    type: 'checkbox',
    checked: Boolean(obj[key]),
    onchange: (e) => {
      obj[key] = e.target.checked;
      markDirty();
      if (onchange) onchange(e);
    },
  });
}

function bindSelect(obj, key, pairs, onchange) {
  return h(
    'select',
    {
      onchange: (e) => {
        obj[key] = e.target.value;
        markDirty();
        if (onchange) onchange(e);
      },
    },
    options(pairs, obj[key]),
  );
}

const field = (label, input, hint) =>
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);

const toInt = (v) => (v === '' ? 0 : Number.parseInt(v, 10) || 0);

function basicCard(d) {
  const urlText = h('span', {}, mockOrigin + (d.path || ''));
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, '基本信息'),
    h(
      'div',
      { class: 'grid grid-basic' },
      field('方法', bindSelect(d, 'method', METHODS.map((m) => [m, m === 'ANY' ? 'ANY（任意）' : m]))),
      field('路径', bindInput(d, 'path', { id: 'f-path', placeholder: '/api/box/:code', class: 'code', oninput: (e) => (urlText.textContent = mockOrigin + e.target.value) })),
      field('延迟（毫秒）', bindInput(d, 'delay', { type: 'number', min: 0, max: 60000 }, toInt)),
      h('label', { class: 'check', style: 'padding-bottom:8px' }, bindCheckbox(d, 'enabled'), '启用'),
    ),
    h('div', { class: 'grid grid-2', style: 'margin-top:12px' }, field('名称', bindInput(d, 'name', { placeholder: '例如：出库任务申请' })), field('说明', bindInput(d, 'description'))),
    h('div', { class: 'url-preview' }, '调用地址：', urlText, h('button', { class: 'btn small ghost', onclick: () => copyText(mockOrigin + d.path) }, '复制')),
  );
}

function responseEditor(resp, hint) {
  return h(
    'div',
    {},
    h('div', { class: 'grid', style: 'grid-template-columns:140px 1fr' }, field('HTTP 状态码', bindInput(resp, 'status', { type: 'number', min: 100, max: 599 }, toInt)), h('div')),
    h('div', { class: 'code-head' }, h('span', { class: 'field-label' }, '响应头'), null),
    headersEditor(resp.headers),
    codeArea(resp, 'body', { rows: 12, label: '响应体', hint }),
  );
}

function headersEditor(rows) {
  const box = h('div');
  const render = () => {
    box.replaceChildren(
      ...rows.map((row, i) =>
        h(
          'div',
          { class: 'row' },
          bindInput(row, 'key', { placeholder: 'Header 名称，例如 X-Request-Id', class: 'code' }),
          bindInput(row, 'value', { placeholder: '值，可以使用 {{...}}', class: 'code' }),
          h('button', { class: 'icon-btn', title: '删除', onclick: () => { rows.splice(i, 1); markDirty(); render(); } }, '✕'),
        ),
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: () => { rows.push({ key: '', value: '' }); markDirty(); render(); } }, '+ 添加响应头'), rows.length ? null : h('span', { class: 'muted' }, '默认会根据响应体自动设置 Content-Type')),
    );
  };
  render();
  return box;
}

function jsonStatus(text) {
  const src = (text || '').trim();
  if (!src) return ['warn', '空响应体'];
  try {
    JSON.parse(src);
    return ['ok', '✓ JSON 格式正确'];
  } catch (err) {
    if (/^[[{]/.test(src)) return ['err', `JSON 格式错误：${err.message}`];
    return ['warn', '不是 JSON，将按纯文本返回'];
  }
}

function codeArea(obj, key, { rows = 10, label, hint, onInput = markDirty } = {}) {
  const status = h('span', { class: 'json-status' });
  const update = () => {
    const [cls, msg] = jsonStatus(obj[key]);
    status.className = `json-status ${cls}`;
    status.textContent = msg;
  };
  const ta = h('textarea', {
    class: 'code',
    rows,
    spellcheck: 'false',
    value: obj[key] ?? '',
    oninput: (e) => {
      obj[key] = e.target.value;
      onInput();
      update();
    },
    onkeydown: (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = e.target;
      e.target.value = `${value.slice(0, s)}  ${value.slice(end)}`;
      e.target.selectionStart = e.target.selectionEnd = s + 2;
      e.target.dispatchEvent(new Event('input'));
    },
  });
  const format = () => {
    try {
      ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
      ta.dispatchEvent(new Event('input'));
    } catch (err) {
      toast(`无法格式化：${err.message}`, 'error');
    }
  };
  update();
  return h(
    'div',
    {},
    h('div', { class: 'code-head' }, h('span', { class: 'field-label' }, label || '内容', hint ? h('span', { class: 'hint' }, `　${hint}`) : null), h('span', { class: 'row' }, status, h('button', { class: 'btn small ghost', onclick: format }, '格式化 JSON'))),
    ta,
  );
}

function rulesCard(d) {
  const box = h('div');
  const render = () => {
    const body = d.rules.map((r, i) =>
      h(
        'tr',
        {},
        h('td', { style: 'width:110px' }, bindSelect(r, 'in', SOURCES)),
        h('td', {}, bindInput(r, 'name', { placeholder: '字段名，如 taskNo', class: 'code' })),
        h('td', { style: 'width:100px' }, bindSelect(r, 'type', TYPES)),
        h('td', { class: 'center', style: 'width:50px' }, bindCheckbox(r, 'required')),
        h('td', { style: 'width:100px' }, bindInput(r, 'maxLength', { type: 'number', min: 0, placeholder: '不限', value: r.maxLength || '' }, toInt)),
        h('td', {}, bindInput({ v: (r.enum || []).join(',') }, 'v', { placeholder: '逗号分隔，如 KILL,CLEAN', oninput: (e) => { r.enum = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); } })),
        h('td', { style: 'width:36px' }, h('button', { class: 'icon-btn', title: '删除', onclick: () => { d.rules.splice(i, 1); markDirty(); render(); } }, '✕')),
      ),
    );
    box.replaceChildren(
      d.rules.length
        ? h('table', { class: 'sub-table' }, h('thead', {}, h('tr', {}, ['位置', '字段', '类型', '必填', '最大长度', '可选值', ''].map((t) => h('th', {}, t)))), h('tbody', {}, body))
        : h('div', { class: 'muted' }, '没有校验规则，所有请求都直接进入默认返回'),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small ghost', onclick: () => { d.rules.push({ in: 'body', name: '', type: 'string', required: true, maxLength: 0, enum: [] }); markDirty(); render(); } }, '+ 添加规则')),
    );
  };
  render();
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, '参数校验', h('span', { class: 'muted' }, '不通过时返回下方「校验失败时返回」的内容')),
    box,
    h('details', { class: 'sub' }, h('summary', {}, '校验失败时返回'), responseEditor(d.validationResponse, '{{error}} 是错误说明')),
  );
}

function scenariosCard(d) {
  const box = h('div');
  const render = () => {
    box.replaceChildren(
      ...d.scenarios.map((s, i) => scenarioEditor(d, s, i, render)),
      h('button', {
        class: 'btn small ghost',
        onclick: () => {
          d.scenarios.push({ name: `场景${d.scenarios.length + 1}`, enabled: true, match: 'all', conditions: [{ field: 'body.', op: 'eq', value: '' }], response: { status: 200, headers: [], body: DEFAULT_OK_BODY } });
          markDirty();
          render();
        },
      }, '+ 添加场景'),
    );
  };
  render();
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, '条件场景', h('span', { class: 'muted' }, '按顺序判断，命中第一个就返回；没有条件的场景启用后会拦截所有请求')),
    box,
  );
}

function scenarioEditor(d, s, index, rerenderAll) {
  const wrap = h('div', { class: `scenario${s.enabled ? '' : ' off'}` });
  const conds = h('div');
  const renderConds = () => {
    conds.replaceChildren(
      ...s.conditions.map((c, i) =>
        h(
          'div',
          { class: 'row' },
          bindInput(c, 'field', { placeholder: 'body.quantity / query.page / headers.x-auth-token', class: 'code' }),
          h('div', { style: 'width:130px;flex-shrink:0' }, bindSelect(c, 'op', OPS, renderConds)),
          NO_VALUE_OPS.includes(c.op) ? h('div', { style: 'flex:1' }) : bindInput(c, 'value', { placeholder: '比较的值', class: 'code' }),
          h('button', { class: 'icon-btn', title: '删除条件', onclick: () => { s.conditions.splice(i, 1); markDirty(); renderConds(); } }, '✕'),
        ),
      ),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn small ghost', onclick: () => { s.conditions.push({ field: 'body.', op: 'eq', value: '' }); markDirty(); renderConds(); } }, '+ 添加条件'), s.conditions.length ? null : h('span', { class: 'muted' }, '没有条件：启用后所有请求都返回这个场景')),
    );
  };
  renderConds();

  const move = (delta) => {
    const j = index + delta;
    if (j < 0 || j >= d.scenarios.length) return;
    [d.scenarios[index], d.scenarios[j]] = [d.scenarios[j], d.scenarios[index]];
    markDirty();
    rerenderAll();
  };

  wrap.append(
    h(
      'div',
      { class: 'scenario-head' },
      h('label', { class: 'check', title: '启用' }, bindCheckbox(s, 'enabled', (e) => wrap.classList.toggle('off', !e.target.checked)), ''),
      bindInput(s, 'name', { placeholder: '场景名称' }),
      bindSelect(s, 'match', [['all', '满足全部条件'], ['any', '满足任一条件']]),
      h('button', { class: 'icon-btn', title: '上移', onclick: () => move(-1) }, '↑'),
      h('button', { class: 'icon-btn', title: '下移', onclick: () => move(1) }, '↓'),
      h('button', { class: 'btn small ghost danger', onclick: () => { d.scenarios.splice(index, 1); markDirty(); rerenderAll(); } }, '删除场景'),
    ),
    h('div', { class: 'cond-label' }, '条件'),
    conds,
    h('details', { class: 'sub', open: true }, h('summary', {}, '命中时返回'), responseEditor(s.response)),
  );
  return wrap;
}

// ---------- 调试 ----------

function sampleValue(type) {
  return { string: 'test', number: 1, integer: 1, boolean: true, array: [], object: {} }[type] ?? 'test';
}

function sampleBody(rules) {
  const body = {};
  for (const r of rules.filter((x) => x.in === 'body')) {
    const keys = r.name.split('.');
    let cur = body;
    keys.slice(0, -1).forEach((k) => (cur = cur[k] = cur[k] || {}));
    cur[keys[keys.length - 1]] = r.enum && r.enum.length ? r.enum[0] : sampleValue(r.type);
  }
  return JSON.stringify(body, null, 2);
}

function debugCard(d) {
  const mem = state.debug.get(d.id) || {
    method: d.method === 'ANY' ? 'GET' : d.method,
    url: d.path,
    headers: '',
    body: d.method === 'GET' ? '' : sampleBody(d.rules),
  };
  state.debug.set(d.id, mem);

  const methods = d.method === 'ANY' ? METHODS.filter((m) => m !== 'ANY') : [d.method];
  const result = h('div', { class: 'debug-result' });

  const buildRequest = () => {
    let headers = {};
    if (mem.headers.trim()) {
      headers = JSON.parse(mem.headers);
      if (typeof headers !== 'object' || Array.isArray(headers)) throw new Error('请求头需要是 JSON 对象');
    }
    const hasBody = !['GET', 'DELETE'].includes(mem.method) && mem.body.trim() !== '';
    if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    return { headers, body: hasBody ? mem.body : undefined };
  };

  const send = async () => {
    let req;
    try {
      req = buildRequest();
    } catch (err) {
      toast(`请求头格式错误：${err.message}`, 'error');
      return;
    }
    result.replaceChildren(h('div', { class: 'muted' }, '请求中…'));
    const started = performance.now();
    try {
      const target = mem.url.startsWith('/') ? mockOrigin + mem.url : mem.url;
      const res = await fetch(target, { method: mem.method, headers: req.headers, body: req.body });
      const text = await res.text();
      const ms = Math.round(performance.now() - started);
      result.replaceChildren(
        h('div', { class: 'debug-meta' }, h('span', { class: res.ok ? 'status-ok' : 'status-bad' }, `${res.status} ${res.statusText}`), h('span', { class: 'muted' }, `${ms} ms`), h('span', { class: 'muted' }, res.headers.get('content-type') || '')),
        h('pre', {}, prettyText(text)),
      );
    } catch (err) {
      result.replaceChildren(h('div', { class: 'status-bad' }, `请求失败：${err.message}`));
    }
  };

  const copyCurl = () => {
    let req;
    try {
      req = buildRequest();
    } catch (err) {
      toast(`请求头格式错误：${err.message}`, 'error');
      return;
    }
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const parts = [`curl -X ${mem.method} ${q(mockOrigin + mem.url)}`];
    for (const [k, v] of Object.entries(req.headers)) parts.push(`-H ${q(`${k}: ${v}`)}`);
    if (req.body !== undefined) parts.push(`-d ${q(req.body)}`);
    copyText(parts.join(' \\\n  '));
  };

  const plain = (key) => (e) => {
    mem[key] = e.target.value;
  };

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, '调试', h('span', { class: 'muted' }, '调用的是已保存的版本，修改后请先保存')),
    h(
      'div',
      { class: 'debug-grid' },
      h('select', { onchange: plain('method'), value: mem.method }, methods.map((m) => h('option', { value: m }, m))),
      h('input', { type: 'text', class: 'code', value: mem.url, oninput: plain('url'), placeholder: '/api/xxx?page=1' }),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => openInClient({ name: d.name, method: mem.method, url: mem.url, headers: mem.headers, body: mem.body }), title: '带上当前填写的内容，到「接口调用」里继续调试' }, '在接口调用中打开'),
        h('button', { class: 'btn ghost', onclick: copyCurl }, '复制 curl'),
        h('button', { class: 'btn primary', onclick: send }, '发送'),
      ),
    ),
    h('div', { class: 'grid grid-2', style: 'margin-top:10px' },
      field('请求头（JSON）', h('textarea', { class: 'code', rows: 6, spellcheck: 'false', value: mem.headers, oninput: plain('headers'), placeholder: '{\n  "X-Auth-Token": "mock-token"\n}' })),
      field('请求体', h('textarea', { class: 'code', rows: 6, spellcheck: 'false', value: mem.body, oninput: plain('body') })),
    ),
    result,
  );
}

// ---------- 保存 / 删除 / 复制 ----------

function fromDraft(d) {
  const { id, createdAt, updatedAt, ...rest } = d;
  return rest;
}

async function saveMock() {
  const d = state.draft;
  if (!d) return;
  try {
    const saved = d.id ? await api('PUT', `/mocks/${encodeURIComponent(d.id)}`, fromDraft(d)) : await api('POST', '/mocks', fromDraft(d));
    const i = state.mocks.findIndex((m) => m.id === saved.id);
    if (i === -1) state.mocks.push(saved);
    else state.mocks[i] = saved;
    state.selectedId = saved.id;
    state.draft = toDraft(saved);
    state.dirty = false;
    renderList();
    renderEditor();
    renderLogFilter();
    toast('已保存，立即生效');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteMock() {
  const d = state.draft;
  if (!d || !d.id || !window.confirm(`确定删除「${d.name}」（${d.method} ${d.path}）吗？删除后无法恢复。`)) return;
  try {
    await api('DELETE', `/mocks/${encodeURIComponent(d.id)}`);
    state.mocks = state.mocks.filter((m) => m.id !== d.id);
    state.selectedId = null;
    state.draft = null;
    state.dirty = false;
    renderList();
    renderEditor();
    renderLogFilter();
    toast('已删除');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function duplicateMock() {
  if (!confirmDiscard()) return;
  const copy = structuredClone(state.draft);
  copy.id = null;
  copy.name = `${copy.name} 副本`;
  copy.path = `${copy.path}-copy`;
  state.selectedId = null;
  state.draft = copy;
  state.dirty = true;
  renderList();
  renderEditor();
  $('#f-path')?.focus();
}

// ---------- 请求日志 ----------

function renderLogFilter() {
  const sel = $('#log-filter');
  sel.replaceChildren(
    h('option', { value: '' }, '全部接口'),
    ...[...state.mocks].sort(byName).map((m) => h('option', { value: m.id }, `${m.method} ${m.path}　${m.name}`)),
  );
  sel.value = state.logMockId;
}

async function loadLogs() {
  try {
    const qs = new URLSearchParams({ limit: '300' });
    if (state.logMockId) qs.set('mockId', state.logMockId);
    state.logs = await api('GET', `/logs?${qs}`);
    renderLogs();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderLogs() {
  const rows = state.logs.map((e) =>
    h(
      'tr',
      { class: e.id === state.selectedLogId ? 'active' : '', onclick: () => { state.selectedLogId = e.id; renderLogs(); } },
      h('td', {}, formatTime(e.time)),
      h('td', {}, h('span', { class: `method m-${e.method}` }, e.method)),
      h('td', { class: 'url', title: e.url }, e.url),
      h('td', {}, e.mock ? e.mock.name : h('span', { class: 'muted' }, '—')),
      h('td', {}, e.hit),
      h('td', {}, h('span', { class: e.status < 400 ? 'status-ok' : 'status-bad' }, e.status)),
      h('td', {}, `${e.durationMs} ms`),
    ),
  );
  $('#log-rows').replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 7, class: 'empty' }, '还没有请求记录'))]));

  const entry = state.logs.find((e) => e.id === state.selectedLogId);
  const detail = $('#log-detail');
  if (!entry) {
    detail.replaceChildren();
    return;
  }
  detail.replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, `${entry.method} ${entry.url}`), h('span', { class: 'muted' }, `来源 ${entry.ip || '-'}`)),
    h('h4', {}, '请求体'),
    h('pre', {}, prettyText(entry.request.body) || '（空）'),
    h('h4', {}, 'Query 参数'),
    h('pre', {}, pretty(entry.request.query)),
    h('h4', {}, '请求头'),
    h('pre', {}, pretty(entry.request.headers)),
    h('h4', {}, `响应（${entry.status}，${entry.hit}）`),
    h('pre', {}, prettyText(entry.response.body) || '（空）'),
    h('h4', {}, '响应头'),
    h('pre', {}, pretty(entry.response.headers)),
  );
}

function syncLogTimer() {
  clearInterval(state.logTimer);
  state.logTimer = null;
  if (state.view === 'logs' && $('#log-auto').checked) state.logTimer = setInterval(loadLogs, 3000);
}

// ---------- 导入导出 ----------

async function exportConfig() {
  try {
    const data = await api('GET', '/export');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    download(`mock-config-${stamp}.json`, JSON.stringify(data, null, 2));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function importConfig(file) {
  let mocks;
  let client;
  try {
    const parsed = JSON.parse(await file.text());
    mocks = Array.isArray(parsed) ? parsed : parsed.mocks;
    if (!Array.isArray(mocks)) throw new Error('文件里没有找到接口列表');
    client = !Array.isArray(parsed) && parsed.client ? parsed.client : undefined;
  } catch (err) {
    toast(`读取文件失败：${err.message}`, 'error');
    return;
  }
  const dialog = $('#import-dialog');
  const clientText = client ? `、${(client.collections || []).length} 个集合、${(client.requests || []).length} 个请求` : '';
  $('#import-summary').textContent = `文件「${file.name}」中有 ${mocks.length} 个接口${clientText}，当前有 ${state.mocks.length} 个接口。`;
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener(
    'close',
    async () => {
      const mode = dialog.returnValue;
      if (mode !== 'merge' && mode !== 'replace') return;
      try {
        const result = await api('POST', '/import', { mode, mocks, client });
        state.selectedId = null;
        state.draft = null;
        state.dirty = false;
        await loadMocks();
        renderEditor();
        if (client) clientAfterImport();
        toast(`已导入 ${result.count} 个接口${client ? `、${result.collections} 个集合、${result.requests} 个请求` : ''}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    { once: true },
  );
}

// ---------- 页面切换与初始化 ----------

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === 'logs') loadLogs();
  if (view === 'client') clientShow();
  if (view === 'desktop') desktopShow();
  syncLogTimer();
}

function bindGlobalEvents() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#btn-new').addEventListener('click', newMock);
  $('#mock-search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderList();
  });
  $('#btn-export').addEventListener('click', exportConfig);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importConfig(file);
  });
  $('#log-filter').addEventListener('change', (e) => {
    state.logMockId = e.target.value;
    loadLogs();
  });
  $('#log-auto').addEventListener('change', syncLogTimer);
  $('#btn-log-refresh').addEventListener('click', loadLogs);
  $('#btn-log-clear').addEventListener('click', async () => {
    if (!window.confirm('确定清空全部请求日志吗？')) return;
    try {
      await api('DELETE', '/logs');
      state.selectedLogId = null;
      await loadLogs();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.view === 'mocks' && state.draft) {
      e.preventDefault();
      saveMock();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });
}

async function init() {
  bindGlobalEvents();
  renderEditor();
  try {
    await loadMocks();
    if (state.mocks.length) selectMock([...state.mocks].sort(byName)[0].id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

init();

'use strict';

// ---------- 接口调用 ----------
// 请求由服务器转发（/__admin/api/client/send），这里只负责编辑和展示。
// 复用 app.js 里的 h、options、field、api、toast、copyText、prettyText、codeArea、formatTime、storageGet、storageSet。

const CLIENT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_MODES = [['none', '无'], ['json', 'JSON'], ['form', '表单（x-www-form-urlencoded）'], ['raw', '纯文本']];
const RAW_TYPES = ['text/plain', 'application/xml', 'text/xml', 'text/html', 'application/javascript'];
const NO_BODY_METHODS = ['GET', 'HEAD'];
const DEFAULT_REQ_HEADERS = [['User-Agent', 'RuiLink/1.0'], ['Accept', '*/*'], ['Accept-Encoding', 'gzip, deflate, br']];
const SIMPLE_VAR = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
const HISTORY_KEY = 'mockClientHistory';
const ENV_KEY = 'mockClientEnv';
const COLLAPSED_KEY = 'mockClientCollapsed';
const HISTORY_LIMIT = 100;
const HISTORY_BODY_LIMIT = 20000;

function readJson(key, fallback) {
  try {
    const v = JSON.parse(storageGet(key) || 'null');
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

const cs = {
  ready: null, // 首次打开时加载数据的 Promise
  status: null,
  collections: [],
  requests: [],
  environments: [],
  helpers: new Set(),
  allowHosts: '',
  envId: storageGet(ENV_KEY),
  side: 'collections',
  filter: '',
  collapsed: new Set(readJson(COLLAPSED_KEY, [])),
  draft: null,
  dirty: false,
  selected: null, // { type: 'request' | 'history' | 'record', id }
  reqTab: 'params',
  resTab: 'body',
  resRaw: false,
  result: null,
  sending: null,
  history: readJson(HISTORY_KEY, []),
  historyPersist: true,
  records: [],
  els: {}, // 编辑区里需要局部更新的元素
  sideList: null,
};

const enc = encodeURIComponent;
// 和 h() 一样跳过 null / false，replaceChildren 会把它们变成文字
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
const tmpId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
const currentEnv = () => cs.environments.find((e) => e.id === cs.envId) || null;
const confirmClientDiscard = () => !cs.dirty || window.confirm('当前请求的修改还没保存，确定放弃吗？');
const methodTag = (m) => h('span', { class: `method m-${m}` }, m);

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function cut(s) {
  if (typeof s !== 'string' || s.length <= HISTORY_BODY_LIMIT) return s;
  return `${s.slice(0, HISTORY_BODY_LIMIT)}\n...（已截断，共 ${s.length} 字符）`;
}

function tryDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------- 弹窗 ----------

function formDialog({ title, message, fields, okText = '确定', wide = false }) {
  return new Promise((resolve) => {
    const values = Object.fromEntries(fields.map((f) => [f.name, f.value ?? '']));
    const rows = fields.map((f) => {
      const input =
        f.type === 'select'
          ? h('select', { onchange: (e) => { values[f.name] = e.target.value; sync(); } }, options(f.options, values[f.name]))
          : h('input', { type: 'text', value: values[f.name], placeholder: f.placeholder, oninput: (e) => (values[f.name] = e.target.value) });
      return { f, input, wrap: field(f.label, input) };
    });
    const sync = () => rows.forEach((r) => (r.wrap.hidden = r.f.showIf ? !r.f.showIf(values) : false));
    const dialog = h(
      'dialog',
      { class: wide ? 'wide' : '' },
      h(
        'form',
        { method: 'dialog' },
        h('h3', {}, title),
        message ? h('p', { class: 'muted' }, message) : null,
        h('div', { class: 'form-fields' }, rows.map((r) => r.wrap)),
        h(
          'div',
          { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close('cancel') }, '取消'),
          h('button', { value: 'ok', class: 'btn primary' }, okText),
        ),
      ),
    );
    sync();
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok' ? values : null);
    });
    document.body.append(dialog);
    dialog.showModal();
    const first = rows.find((r) => !r.wrap.hidden && r.input.tagName === 'INPUT');
    if (first) first.input.select();
  });
}

// ---------- 加载 ----------

function clientShow() {
  if (!cs.ready) {
    cs.ready = clientInit().catch((err) => {
      toast(err.message, 'error');
      cs.ready = null;
      return false;
    });
  }
  return cs.ready;
}

async function clientInit() {
  cs.status = (await api('GET', '/info')).client;
  if (!cs.status || !cs.status.enabled) {
    renderClientDisabled();
    return false;
  }
  await clientReload();
  renderClient();
  return true;
}

async function clientReload() {
  const data = await api('GET', '/client');
  cs.collections = data.collections;
  cs.requests = data.requests;
  cs.environments = data.environments;
  cs.helpers = new Set(data.helpers);
  cs.allowHosts = data.allowHosts;
  if (cs.envId && !currentEnv()) setEnv('');
}

// 导入配置后重新加载集合和请求
function clientAfterImport() {
  cs.ready = null;
  cs.draft = null;
  cs.dirty = false;
  cs.selected = null;
  cs.result = null;
  if (state.view === 'client') clientShow();
}

function setEnv(id) {
  cs.envId = id;
  storageSet(ENV_KEY, id);
}

function renderClientDisabled() {
  $('#client-side').hidden = true;
  put($('#client-main'),
    h(
      'div',
      { class: 'placeholder' },
      h('p', {}, cs.status ? cs.status.reason : '接口调用功能不可用'),
      h('p', { class: 'muted' }, '例如在 .env 文件中写上 ADMIN_TOKEN=你的口令，然后重启服务。'),
    ),
  );
}

function renderClient() {
  $('#client-side').hidden = false;
  renderClientSide();
  renderClientMain();
}

// ---------- 草稿 ----------

function blankRequest(collectionId = null) {
  return {
    id: null,
    collectionId,
    name: '',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', json: '', form: [], raw: '', rawType: 'text/plain' },
    options: { timeout: 30000, followRedirects: true, insecure: false },
  };
}

function toDraftRequest(r) {
  const base = blankRequest();
  const d = {
    ...base,
    ...structuredClone(r),
    body: { ...base.body, ...structuredClone(r.body || {}) },
    options: { ...base.options, ...structuredClone(r.options || {}) },
  };
  d.params = d.params || [];
  d.headers = d.headers || [];
  d.body.form = d.body.form || [];
  // 地址里带着 ?a=1 时拆到 Params 表格里
  const i = d.url.indexOf('?');
  if (i !== -1) {
    const parsed = parseQuery(d.url.slice(i + 1));
    d.url = d.url.slice(0, i);
    d.params = [...parsed, ...d.params];
  }
  return d;
}

function draftToRequest(d) {
  const { name, method, url, params, headers, body, options: opts } = d;
  return structuredClone({ name, method, url, params, headers, body, options: opts });
}

function parseQuery(qs) {
  return qs
    .split('#')[0]
    .split('&')
    .filter((s) => s !== '')
    .map((pair) => {
      const j = pair.indexOf('=');
      return { key: tryDecode(j === -1 ? pair : pair.slice(0, j)), value: tryDecode(j === -1 ? '' : pair.slice(j + 1)), enabled: true };
    });
}

// 地址栏显示的内容：地址 + 启用的 Params（不编码，方便阅读；发送时由服务器编码）
function composeUrl(d) {
  const ps = d.params.filter((p) => p.enabled && p.key);
  return ps.length ? `${d.url}?${ps.map((p) => `${p.key}=${p.value}`).join('&')}` : d.url;
}

function applyUrlInput(d, value) {
  const i = value.indexOf('?');
  d.url = i === -1 ? value : value.slice(0, i);
  const disabled = d.params.filter((p) => !p.enabled);
  d.params = [...(i === -1 ? [] : parseQuery(value.slice(i + 1))), ...disabled];
}

function markClientDirty() {
  if (!cs.dirty) {
    cs.dirty = true;
    if (cs.els.dirty) cs.els.dirty.hidden = false;
  }
  updateVarWarning();
  updateTabCounts();
}

function openDraft(d, { selected = null, result = null, dirty = false } = {}) {
  cs.draft = d;
  cs.dirty = dirty;
  cs.selected = selected;
  cs.result = result;
  cs.resTab = result && !result.response ? 'sent' : 'body';
  renderClientSide();
  renderClientMain();
}

function clientNew(collectionId = null) {
  if (!confirmClientDiscard()) return;
  openDraft(blankRequest(collectionId));
  if (cs.els.url) cs.els.url.focus();
}

function openSavedRequest(id) {
  if (cs.selected && cs.selected.type === 'request' && cs.selected.id === id) return;
  if (!confirmClientDiscard()) return;
  const r = cs.requests.find((x) => x.id === id);
  if (r) openDraft(toDraftRequest(r), { selected: { type: 'request', id } });
}

// 从调试卡片跳过来
async function openInClient({ name, method, url, headers, body }) {
  switchView('client');
  if (!(await clientShow())) return;
  if (!confirmClientDiscard()) return;
  let headerRows = [];
  try {
    const obj = headers && headers.trim() ? JSON.parse(headers) : {};
    headerRows = Object.entries(obj).map(([key, value]) => ({ key, value: String(value), enabled: true }));
  } catch {
    toast('调试卡片里的请求头不是合法的 JSON，已忽略', 'error');
  }
  const d = blankRequest();
  d.name = name || '';
  d.method = CLIENT_METHODS.includes(method) ? method : 'GET';
  d.headers = headerRows;
  applyUrlInput(d, url || '');
  if (body && body.trim()) {
    try {
      JSON.parse(body);
      d.body.mode = 'json';
      d.body.json = body;
    } catch {
      d.body.mode = 'raw';
      d.body.raw = body;
    }
  }
  openDraft(d, { dirty: true });
}

// ---------- 左侧栏 ----------

function renderClientSide() {
  const side = $('#client-side');
  const envSel = h(
    'select',
    {
      onchange: (e) => {
        setEnv(e.target.value);
        updateVarWarning();
      },
    },
    h('option', { value: '' }, '无环境'),
    cs.environments.map((e) => h('option', { value: e.id, selected: e.id === cs.envId }, e.name)),
  );
  envSel.value = cs.envId || '';

  const tab = (key, label) =>
    h(
      'button',
      {
        class: `side-tab${cs.side === key ? ' active' : ''}`,
        onclick: () => {
          cs.side = key;
          if (key === 'records') loadRecords();
          renderClientSide();
        },
      },
      label,
    );

  const actions = {
    collections: [
      h('button', { class: 'btn primary', onclick: () => clientNew() }, '新建请求'),
      h('button', { class: 'btn ghost', onclick: newCollection, title: '新建集合' }, '+ 集合'),
    ],
    history: [h('button', { class: 'btn ghost danger', onclick: clearHistory }, '清空')],
    records: [h('button', { class: 'btn ghost', onclick: loadRecords }, '刷新')],
  }[cs.side];

  const list = h('div', { class: 'mock-list' });
  cs.sideList = list;
  put(side,
    h('div', { class: 'sidebar-head env-row' }, h('span', { class: 'muted' }, '环境'), envSel, h('button', { class: 'btn ghost', onclick: openEnvDialog }, '管理')),
    h('div', { class: 'side-tabs' }, tab('collections', '集合'), tab('history', `历史${cs.history.length ? `（${cs.history.length}）` : ''}`), tab('records', '服务器记录')),
    h(
      'div',
      { class: 'sidebar-head' },
      h('input', {
        type: 'search',
        placeholder: '搜索',
        value: cs.filter,
        oninput: (e) => {
          cs.filter = e.target.value;
          renderSideList();
        },
      }),
      actions,
    ),
    cs.side === 'history' && !cs.historyPersist ? h('div', { class: 'side-note' }, '浏览器存储不可用或已满，历史只在当前页面有效') : null,
    cs.side === 'records' ? h('div', { class: 'side-note muted' }, '这里的记录保存在服务器上，所有人都能看到') : null,
    list,
  );
  renderSideList();
}

function renderSideList() {
  const q = cs.filter.trim().toLowerCase();
  const match = (...texts) => !q || texts.join(' ').toLowerCase().includes(q);
  const list = cs.sideList;
  let items = [];
  if (cs.side === 'collections') items = collectionItems(match, Boolean(q));
  else if (cs.side === 'history') items = cs.history.filter((e) => match(e.request.name, entryUrl(e))).map(historyItem);
  else items = cs.records.filter((r) => match(r.name, r.url, r.note)).map(recordItem);
  const empty = {
    collections: q ? '没有匹配的请求' : '还没有保存的请求。点击「新建请求」，发送后点「保存」放进集合',
    history: q ? '没有匹配的记录' : '发送过的请求会出现在这里（只保存在当前浏览器）',
    records: q ? '没有匹配的记录' : '在「历史」里点击 ☁ 可以把一次调用保存到服务器',
  }[cs.side];
  put(list, ...(items.length ? items : [h('div', { class: 'empty' }, empty)]));
}

const isSelected = (type, id) => cs.selected && cs.selected.type === type && cs.selected.id === id;
const entryUrl = (e) => (e.sent && e.sent.url) || e.request.url;

function iconBtn(title, text, onclick) {
  return h(
    'button',
    {
      class: 'icon-btn',
      title,
      onclick: (e) => {
        e.stopPropagation();
        onclick();
      },
    },
    text,
  );
}

function resultTag(status, error) {
  if (error) return h('span', { class: 'status-bad small-status' }, error === 'CANCELLED' ? '已取消' : '失败');
  if (status === null || status === undefined) return null;
  return h('span', { class: `${status < 400 ? 'status-ok' : 'status-bad'} small-status` }, status);
}

function collectionItems(match, searching) {
  const out = [];
  for (const c of cs.collections) {
    const reqs = cs.requests.filter((r) => r.collectionId === c.id);
    const shown = searching ? reqs.filter((r) => match(r.name, r.url, c.name)) : reqs;
    if (searching && !shown.length && !match(c.name)) continue;
    const open = searching || !cs.collapsed.has(c.id);
    out.push(
      h(
        'div',
        { class: 'coll-head', onclick: () => toggleCollection(c.id) },
        h('span', { class: `caret${open ? ' open' : ''}` }, '▶'),
        h('span', { class: 'coll-name' }, c.name),
        h('span', { class: 'coll-count' }, reqs.length),
        h(
          'span',
          { class: 'item-actions' },
          iconBtn('在这个集合里新建请求', '+', () => clientNew(c.id)),
          iconBtn('重命名', '✎', () => renameCollection(c)),
          iconBtn('删除集合', '✕', () => deleteCollection(c)),
        ),
      ),
    );
    if (!open) continue;
    for (const r of shown) {
      out.push(
        h(
          'div',
          { class: `mock-item nested${isSelected('request', r.id) ? ' active' : ''}`, onclick: () => openSavedRequest(r.id) },
          methodTag(r.method),
          h('span', { class: 'mock-text' }, h('span', { class: 'mock-name' }, r.name), h('span', { class: 'mock-path' }, r.url)),
          h(
            'span',
            { class: 'item-actions' },
            iconBtn('复制', '⧉', () => duplicateRequest(r)),
            iconBtn('移动到其他集合', '⇄', () => moveRequest(r)),
            iconBtn('删除', '✕', () => deleteRequest(r)),
          ),
        ),
      );
    }
  }
  return out;
}

function historyItem(e) {
  return h(
    'div',
    { class: `mock-item${isSelected('history', e.id) ? ' active' : ''}`, onclick: () => openEntry(e, 'history') },
    methodTag(e.request.method),
    h(
      'span',
      { class: 'mock-text' },
      h('span', { class: 'mock-name' }, e.request.name || e.request.url),
      h('span', { class: 'mock-path', title: entryUrl(e) }, `${formatTime(e.time)}${e.envName ? `　${e.envName}` : ''}　${entryUrl(e)}`),
    ),
    resultTag(e.response && e.response.status, e.error && e.error.code),
    h(
      'span',
      { class: 'item-actions' },
      iconBtn('保存到服务器，所有人都能看到', '☁', () => saveEntryToServer(e)),
      iconBtn('删除', '✕', () => deleteHistory(e.id)),
    ),
  );
}

function recordItem(r) {
  return h(
    'div',
    { class: `mock-item${isSelected('record', r.id) ? ' active' : ''}`, onclick: () => openRecord(r.id) },
    methodTag(r.method),
    h(
      'span',
      { class: 'mock-text' },
      h('span', { class: 'mock-name' }, r.note || r.name || r.url),
      h('span', { class: 'mock-path' }, `${formatTime(r.time)}　${r.url}`),
    ),
    resultTag(r.status, r.error),
    h('span', { class: 'item-actions' }, iconBtn('修改备注', '✎', () => editRecordNote(r)), iconBtn('删除', '✕', () => deleteRecord(r))),
  );
}

// ---------- 集合与请求 ----------

function toggleCollection(id) {
  if (cs.collapsed.has(id)) cs.collapsed.delete(id);
  else cs.collapsed.add(id);
  storageSet(COLLAPSED_KEY, JSON.stringify([...cs.collapsed]));
  renderSideList();
}

async function newCollection() {
  const v = await formDialog({ title: '新建集合', fields: [{ name: 'name', label: '集合名称', placeholder: '例如：昆船 WMS' }], okText: '新建' });
  if (!v || !v.name.trim()) return;
  try {
    cs.collections.push(await api('POST', '/client/collections', { name: v.name }));
    renderClientSide();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameCollection(c) {
  const v = await formDialog({ title: '重命名集合', fields: [{ name: 'name', label: '集合名称', value: c.name }] });
  if (!v || !v.name.trim()) return;
  try {
    Object.assign(c, await api('PUT', `/client/collections/${enc(c.id)}`, { name: v.name }));
    renderSideList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCollection(c) {
  const count = cs.requests.filter((r) => r.collectionId === c.id).length;
  if (!window.confirm(`确定删除集合「${c.name}」吗？${count ? `其中的 ${count} 个请求也会一起删除，` : ''}删除后无法恢复。`)) return;
  try {
    await api('DELETE', `/client/collections/${enc(c.id)}`);
    cs.collections = cs.collections.filter((x) => x.id !== c.id);
    cs.requests = cs.requests.filter((r) => r.collectionId !== c.id);
    if (cs.draft && cs.draft.collectionId === c.id && cs.draft.id) {
      cs.draft.id = null;
      cs.draft.collectionId = null;
      cs.selected = null;
      markClientDirty();
      renderClientMain();
    }
    renderClientSide();
    toast('已删除');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function collectionChoices(includeNew) {
  const list = cs.collections.map((c) => [c.id, c.name]);
  return includeNew ? [...list, ['__new', '+ 新建集合…']] : list;
}

async function clientSave() {
  const d = cs.draft;
  if (!d) return;
  if (!d.id) {
    clientSaveAs();
    return;
  }
  try {
    const saved = await api('PUT', `/client/requests/${enc(d.id)}`, { ...draftToRequest(d), collectionId: d.collectionId });
    cs.requests = cs.requests.map((r) => (r.id === saved.id ? saved : r));
    cs.dirty = false;
    if (cs.els.dirty) cs.els.dirty.hidden = true;
    renderSideList();
    toast('已保存');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function clientSaveAs() {
  const d = cs.draft;
  if (!d) return;
  const v = await formDialog({
    title: d.id ? '另存为新请求' : '保存请求',
    fields: [
      { name: 'name', label: '名称', value: d.name || d.url, placeholder: '例如：出库任务下发' },
      { name: 'collectionId', label: '保存到集合', type: 'select', options: collectionChoices(true), value: d.collectionId || (cs.collections[0] ? cs.collections[0].id : '__new') },
      { name: 'newCollection', label: '新集合名称', placeholder: '例如：昆船 WMS', showIf: (x) => x.collectionId === '__new' },
    ],
    okText: '保存',
  });
  if (!v) return;
  try {
    let collectionId = v.collectionId;
    if (collectionId === '__new') {
      if (!v.newCollection.trim()) throw new Error('请填写新集合的名称');
      const c = await api('POST', '/client/collections', { name: v.newCollection });
      cs.collections.push(c);
      collectionId = c.id;
    }
    const saved = await api('POST', '/client/requests', { ...draftToRequest(d), name: v.name, collectionId });
    cs.requests.push(saved);
    cs.collapsed.delete(collectionId);
    cs.side = 'collections';
    openDraft(toDraftRequest(saved), { selected: { type: 'request', id: saved.id }, result: cs.result });
    toast('已保存');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function duplicateRequest(r) {
  try {
    const saved = await api('POST', '/client/requests', { ...r, name: `${r.name} 副本` });
    cs.requests.push(saved);
    renderSideList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function moveRequest(r) {
  const others = collectionChoices(false).filter(([id]) => id !== r.collectionId);
  if (!others.length) {
    toast('没有其他集合，请先新建一个集合', 'error');
    return;
  }
  const v = await formDialog({ title: `移动「${r.name}」`, fields: [{ name: 'collectionId', label: '移动到', type: 'select', options: others, value: others[0][0] }], okText: '移动' });
  if (!v) return;
  try {
    const saved = await api('PUT', `/client/requests/${enc(r.id)}`, { ...r, collectionId: v.collectionId });
    cs.requests = cs.requests.map((x) => (x.id === saved.id ? saved : x));
    if (cs.draft && cs.draft.id === r.id) cs.draft.collectionId = saved.collectionId;
    cs.collapsed.delete(saved.collectionId);
    renderSideList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteRequest(r) {
  if (!window.confirm(`确定删除请求「${r.name}」吗？删除后无法恢复。`)) return;
  try {
    await api('DELETE', `/client/requests/${enc(r.id)}`);
    cs.requests = cs.requests.filter((x) => x.id !== r.id);
    if (cs.draft && cs.draft.id === r.id) {
      cs.draft = null;
      cs.dirty = false;
      cs.selected = null;
      cs.result = null;
      renderClientMain();
    }
    renderSideList();
    toast('已删除');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- 本机历史 ----------

// 浏览器存储空间不够时，删掉较旧的一半再试
function saveHistory() {
  let list = cs.history;
  for (;;) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      cs.history = list;
      cs.historyPersist = true;
      return;
    } catch {
      if (list.length <= 1) {
        cs.historyPersist = false;
        return;
      }
      list = list.slice(0, Math.floor(list.length / 2));
    }
  }
}

function addHistory(request, env, result) {
  const entry = {
    id: tmpId(),
    time: new Date().toISOString(),
    envName: env ? env.name : '',
    request,
    sent: { ...result.sent, body: cut(result.sent.body) },
    response: result.response ? { ...result.response, body: cut(result.response.body) } : null,
    error: result.error || null,
    timing: result.timing,
    redirects: result.redirects || [],
  };
  cs.history = [entry, ...cs.history].slice(0, HISTORY_LIMIT);
  saveHistory();
  renderClientSide(); // 更新「历史」标签上的数量
}

function deleteHistory(id) {
  cs.history = cs.history.filter((e) => e.id !== id);
  saveHistory();
  if (isSelected('history', id)) cs.selected = null;
  renderClientSide();
}

function clearHistory() {
  if (!cs.history.length || !window.confirm('确定清空当前浏览器里的全部历史吗？已保存到服务器的记录不受影响。')) return;
  cs.history = [];
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // 忽略
  }
  renderClientSide();
}

function openEntry(e, type) {
  if (isSelected(type, e.id)) return;
  if (!confirmClientDiscard()) return;
  openDraft(toDraftRequest({ ...e.request, id: null, collectionId: null }), { selected: { type, id: e.id }, result: e });
}

async function saveEntryToServer(e) {
  const v = await formDialog({
    title: '保存到服务器',
    message: '保存后所有人都能在「服务器记录」里看到这次调用（请求、响应都会保存，内容较长的部分会截断）。',
    fields: [{ name: 'note', label: '备注（可选）', placeholder: '例如：出库联调通过' }],
    okText: '保存',
  });
  if (!v) return;
  try {
    await api('POST', '/client/records', { ...e, note: v.note });
    toast('已保存到服务器');
    if (cs.side === 'records') loadRecords();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- 服务器记录 ----------

async function loadRecords() {
  try {
    cs.records = await api('GET', '/client/records');
    if (cs.side === 'records') renderSideList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openRecord(id) {
  if (isSelected('record', id)) return;
  if (!confirmClientDiscard()) return;
  try {
    const r = await api('GET', `/client/records/${enc(id)}`);
    openDraft(toDraftRequest({ ...r.request, id: null, collectionId: null }), { selected: { type: 'record', id }, result: r });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function editRecordNote(r) {
  const v = await formDialog({ title: '修改备注', fields: [{ name: 'note', label: '备注', value: r.note }] });
  if (!v) return;
  try {
    Object.assign(r, await api('PUT', `/client/records/${enc(r.id)}`, { note: v.note }));
    renderSideList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteRecord(r) {
  if (!window.confirm('确定删除这条服务器记录吗？所有人都将看不到它，删除后无法恢复。')) return;
  try {
    await api('DELETE', `/client/records/${enc(r.id)}`);
    cs.records = cs.records.filter((x) => x.id !== r.id);
    if (isSelected('record', r.id)) cs.selected = null;
    renderSideList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- 环境管理 ----------

function openEnvDialog() {
  const envs = structuredClone(cs.environments);
  let sel = (currentEnv() || envs[0] || {}).id || null;
  const listBox = h('div', { class: 'env-list' });
  const editBox = h('div', { class: 'env-edit' });

  const renderList = () =>
    put(listBox,
      ...envs.map((e) => h('div', { class: `env-item${e.id === sel ? ' active' : ''}`, onclick: () => { sel = e.id; renderAll(); } }, e.name || '（未命名）')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => {
            const e = { id: tmpId(), name: `环境${envs.length + 1}`, vars: [{ key: 'baseUrl', value: '', enabled: true }] };
            envs.push(e);
            sel = e.id;
            renderAll();
          },
        },
        '+ 新建环境',
      ),
    );

  const renderEdit = () => {
    const e = envs.find((x) => x.id === sel);
    if (!e) {
      put(editBox, h('div', { class: 'empty' }, '还没有环境，点击左侧「新建环境」'));
      return;
    }
    put(editBox,
      h(
        'div',
        { class: 'row' },
        h('input', { type: 'text', value: e.name, placeholder: '环境名称', oninput: (ev) => { e.name = ev.target.value; renderList(); } }),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { const c = structuredClone(e); c.id = tmpId(); c.name = `${e.name} 副本`; envs.push(c); sel = c.id; renderAll(); } }, '复制'),
        h('button', { type: 'button', class: 'btn small ghost danger', onclick: () => { if (!window.confirm(`确定删除环境「${e.name}」吗？`)) return; envs.splice(envs.indexOf(e), 1); sel = envs[0] ? envs[0].id : null; renderAll(); } }, '删除'),
      ),
      h('p', { class: 'hint' }, '在请求里用 {{变量名}} 引用。变量名只能包含字母、数字、_、-，以字母或下划线开头，不能和内置函数（如 now、seq）重名。'),
      kvTable(e.vars, { keyPh: '变量名，例如 baseUrl', valuePh: '值', addText: '+ 添加变量', onChange: () => {} }),
    );
  };
  const renderAll = () => {
    renderList();
    renderEdit();
  };

  const dialog = h(
    'dialog',
    { class: 'wide' },
    h('h3', {}, '管理环境'),
    h('p', { class: 'muted' }, '环境保存在服务器上，所有人共用；每个人选择哪个环境只保存在自己的浏览器里。导出配置时不包含环境变量。'),
    h('div', { class: 'env-layout' }, listBox, editBox),
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, '取消'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onclick: async () => {
            try {
              cs.environments = await api('PUT', '/client/environments', { environments: envs });
              if (sel && !cs.envId) setEnv(sel);
              if (cs.envId && !currentEnv()) setEnv('');
              dialog.close();
              renderClientSide();
              updateVarWarning();
              toast('环境已保存');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        '保存',
      ),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  renderAll();
  document.body.append(dialog);
  dialog.showModal();
}

// ---------- 编辑区 ----------

function kvTable(rows, { keyPh = '名称', valuePh = '值，可以使用 {{变量}}', addText = '+ 添加', onChange }) {
  const box = h('div', { class: 'kv' });
  const render = () =>
    put(box,
      ...rows.map((row, i) =>
        h(
          'div',
          { class: `kv-row${row.enabled ? '' : ' off'}` },
          h('input', {
            type: 'checkbox',
            title: '启用',
            checked: row.enabled,
            onchange: (e) => {
              row.enabled = e.target.checked;
              e.target.parentElement.classList.toggle('off', !row.enabled);
              onChange();
            },
          }),
          h('input', { type: 'text', class: 'code', value: row.key, placeholder: keyPh, oninput: (e) => { row.key = e.target.value; onChange(); } }),
          h('input', { type: 'text', class: 'code', value: row.value, placeholder: valuePh, oninput: (e) => { row.value = e.target.value; onChange(); } }),
          h('button', { type: 'button', class: 'icon-btn', title: '删除', onclick: () => { rows.splice(i, 1); render(); onChange(); } }, '✕'),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => {
            rows.push({ key: '', value: '', enabled: true });
            render();
            onChange();
            const inputs = box.querySelectorAll('.kv-row input[type="text"]');
            inputs[inputs.length - 2].focus();
          },
        },
        addText,
      ),
    );
  render();
  return box;
}

function draftStrings(d) {
  const rows = (list) => list.filter((r) => r.enabled).flatMap((r) => [r.key, r.value]);
  const out = [d.url, ...rows(d.params), ...rows(d.headers)];
  if (!NO_BODY_METHODS.includes(d.method)) {
    if (d.body.mode === 'json') out.push(d.body.json);
    if (d.body.mode === 'raw') out.push(d.body.raw, d.body.rawType);
    if (d.body.mode === 'form') out.push(...rows(d.body.form));
  }
  return out;
}

function updateVarWarning() {
  const el = cs.els.warn;
  if (!el || !cs.draft) return;
  const env = currentEnv();
  const defined = new Set((env ? env.vars : []).filter((v) => v.enabled).map((v) => v.key));
  const missing = new Set();
  for (const s of draftStrings(cs.draft)) {
    for (const m of s.matchAll(SIMPLE_VAR)) if (!cs.helpers.has(m[1]) && !defined.has(m[1])) missing.add(m[1]);
  }
  el.hidden = !missing.size;
  el.textContent = missing.size ? `⚠ 未定义变量：${[...missing].join('、')}（${env ? `当前环境：${env.name}` : '当前没有选择环境'}），发送时会报错` : '';
}

function tabCount(key) {
  const d = cs.draft;
  const n = (list) => list.filter((r) => r.enabled && r.key.trim()).length;
  if (key === 'params') return n(d.params);
  if (key === 'headers') return n(d.headers);
  if (key === 'body') return d.body.mode === 'none' ? 0 : null;
  return null;
}

function updateTabCounts() {
  for (const [key, el] of Object.entries(cs.els.tabCounts || {})) {
    const c = tabCount(key);
    el.textContent = c ? `（${c}）` : key === 'body' && cs.draft.body.mode !== 'none' ? ' ●' : '';
  }
  if (cs.els.autoHeaders) renderAutoHeaders();
}

function autoHeaders(d) {
  const has = (name) => d.headers.some((r) => r.enabled && r.key.trim().toLowerCase() === name.toLowerCase());
  const out = [];
  if (!NO_BODY_METHODS.includes(d.method) && d.body.mode !== 'none' && !has('content-type')) {
    out.push(['Content-Type', { json: 'application/json', form: 'application/x-www-form-urlencoded', raw: d.body.rawType }[d.body.mode]]);
  }
  for (const [k, v] of DEFAULT_REQ_HEADERS) if (!has(k)) out.push([k, v]);
  return out;
}

function renderAutoHeaders() {
  const list = autoHeaders(cs.draft);
  put(cs.els.autoHeaders,
    list.length ? h('div', { class: 'muted' }, '自动添加（手动填写同名请求头时以手动填写的为准）：') : null,
    ...list.map(([k, v]) => h('div', { class: 'auto-header code' }, `${k}: ${v}`)),
  );
}

function renderClientMain() {
  const root = $('#client-main');
  const d = cs.draft;
  cs.els = {};
  if (!d) {
    put(root,
      h('div', { class: 'placeholder' }, h('p', {}, '从左侧选择一个请求，或者新建一个'), h('button', { class: 'btn primary', onclick: () => clientNew() }, '新建请求')),
    );
    return;
  }

  const dirtyMark = h('span', { class: 'dirty-mark', hidden: !cs.dirty }, '● 未保存');
  cs.els.dirty = dirtyMark;
  const nameInput = h('input', {
    type: 'text',
    class: 'title-input',
    value: d.name,
    placeholder: d.id ? '请求名称' : '未保存的请求',
    oninput: (e) => {
      d.name = e.target.value;
      markClientDirty();
    },
  });
  const collection = d.id ? cs.collections.find((c) => c.id === d.collectionId) : null;

  const urlInput = h('input', {
    type: 'text',
    class: 'code',
    value: composeUrl(d),
    placeholder: '{{baseUrl}}/api/xxx 或 /wms/api/xxx（调用本服务的模拟接口）',
    oninput: (e) => {
      applyUrlInput(d, e.target.value);
      if (cs.reqTab === 'params') renderReqTab();
      markClientDirty();
    },
    onkeydown: (e) => {
      // Ctrl + Enter 由全局快捷键处理
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) clientSend();
    },
  });
  cs.els.url = urlInput;

  const methodSel = h(
    'select',
    {
      class: 'method-select',
      onchange: (e) => {
        d.method = e.target.value;
        methodSel.className = `method-select m-${d.method}`;
        if (cs.reqTab === 'body') renderReqTab();
        markClientDirty();
      },
    },
    CLIENT_METHODS.map((m) => h('option', { value: m, selected: m === d.method }, m)),
  );
  methodSel.value = d.method;
  methodSel.className = `method-select m-${d.method}`;

  const sendBtn = h('button', { class: 'btn primary send-btn', onclick: clientSend, title: 'Ctrl + Enter' }, '发送');
  cs.els.send = sendBtn;

  const warn = h('div', { class: 'var-warn', hidden: true });
  cs.els.warn = warn;

  const tabBar = h('div', { class: 'inner-tabs' });
  const tabBody = h('div', {});
  cs.els.tabBar = tabBar;
  cs.els.tabBody = tabBody;

  const response = h('div', { class: 'card' });
  cs.els.response = response;

  put(root,
    h(
      'div',
      { class: 'editor-bar' },
      collection ? h('span', { class: 'muted crumb' }, `${collection.name} /`) : null,
      nameInput,
      dirtyMark,
      h('button', { class: 'btn ghost', onclick: copyClientCurl }, '复制 curl'),
      d.id ? h('button', { class: 'btn ghost', onclick: clientSaveAs }, '另存为') : null,
      d.id ? h('button', { class: 'btn ghost danger', onclick: () => deleteRequest(cs.requests.find((r) => r.id === d.id)) }, '删除') : null,
      h('button', { class: 'btn primary', onclick: clientSave, title: 'Ctrl + S' }, '保存'),
    ),
    h(
      'div',
      { class: 'editor-body' },
      h('div', { class: 'req-line' }, methodSel, urlInput, sendBtn),
      warn,
      h('div', { class: 'card' }, tabBar, tabBody),
      response,
    ),
  );
  renderReqTabs();
  renderSendButton();
  renderResponse();
  updateVarWarning();
}

function renderReqTabs() {
  const tabs = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['settings', '设置']];
  cs.els.tabCounts = {};
  put(cs.els.tabBar,
    ...tabs.map(([key, label]) => {
      const count = h('span', { class: 'count' });
      cs.els.tabCounts[key] = count;
      return h(
        'button',
        {
          class: `inner-tab${cs.reqTab === key ? ' active' : ''}`,
          onclick: () => {
            cs.reqTab = key;
            renderReqTabs();
          },
        },
        label,
        count,
      );
    }),
  );
  renderReqTab();
}

function renderReqTab() {
  const d = cs.draft;
  const box = cs.els.tabBody;
  cs.els.autoHeaders = null;
  const changed = () => markClientDirty();

  if (cs.reqTab === 'params') {
    put(box,
      kvTable(d.params, {
        keyPh: '参数名',
        addText: '+ 添加参数',
        onChange: () => {
          cs.els.url.value = composeUrl(d);
          changed();
        },
      }),
      h('p', { class: 'hint' }, '和地址栏里 ? 后面的内容同步；发送时会自动做 URL 编码。'),
    );
  } else if (cs.reqTab === 'headers') {
    cs.els.autoHeaders = h('div', { class: 'auto-headers' });
    put(box, kvTable(d.headers, { keyPh: 'Header 名称，例如 X-Auth-Token', addText: '+ 添加请求头', onChange: changed }), cs.els.autoHeaders);
    renderAutoHeaders();
  } else if (cs.reqTab === 'body') {
    const modes = h(
      'div',
      { class: 'mode-group' },
      BODY_MODES.map(([value, label]) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'radio',
            name: 'client-body-mode',
            checked: d.body.mode === value,
            onchange: () => {
              d.body.mode = value;
              renderReqTab();
              changed();
            },
          }),
          label,
        ),
      ),
    );
    let content = null;
    if (d.body.mode === 'json') {
      content = codeArea(d.body, 'json', { rows: 14, label: 'JSON', hint: '可以使用 {{变量}} 和内置函数，按文本替换', onInput: changed });
    } else if (d.body.mode === 'form') {
      content = kvTable(d.body.form, { keyPh: '字段名', addText: '+ 添加字段', onChange: changed });
    } else if (d.body.mode === 'raw') {
      const types = RAW_TYPES.includes(d.body.rawType) ? RAW_TYPES : [d.body.rawType, ...RAW_TYPES];
      content = h(
        'div',
        {},
        h(
          'div',
          { class: 'row', style: 'margin-bottom:8px' },
          h('span', { class: 'muted' }, 'Content-Type'),
          h('select', { style: 'width:auto', onchange: (e) => { d.body.rawType = e.target.value; changed(); } }, types.map((t) => h('option', { value: t, selected: t === d.body.rawType }, t))),
        ),
        h('textarea', { class: 'code', rows: 14, spellcheck: 'false', value: d.body.raw, oninput: (e) => { d.body.raw = e.target.value; changed(); } }),
      );
    } else {
      content = h('div', { class: 'muted' }, '这个请求没有请求体');
    }
    put(box,
      modes,
      NO_BODY_METHODS.includes(d.method) && d.body.mode !== 'none' ? h('div', { class: 'notice', style: 'margin-bottom:10px' }, `${d.method} 请求不会发送请求体`) : null,
      content,
    );
  } else {
    const o = d.options;
    put(box,
      h(
        'div',
        { class: 'settings' },
        field(
          '超时时间（秒）',
          h('input', {
            type: 'number',
            min: 1,
            max: 300,
            value: Math.round(o.timeout / 1000),
            style: 'width:120px',
            oninput: (e) => {
              const n = Number.parseInt(e.target.value, 10);
              o.timeout = Math.min(300, Math.max(1, Number.isNaN(n) ? 30 : n)) * 1000;
              changed();
            },
          }),
          '整个请求（连接、等待、接收）的最长时间，1–300 秒',
        ),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.followRedirects, onchange: (e) => { o.followRedirects = e.target.checked; changed(); } }), '自动跟随重定向（最多 5 次）'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o.insecure, onchange: (e) => { o.insecure = e.target.checked; changed(); } }), '忽略 HTTPS 证书错误（内网自签证书时使用）'),
        cs.allowHosts ? h('p', { class: 'hint' }, `服务器只允许访问：${cs.allowHosts}`) : null,
      ),
    );
  }
  updateTabCounts();
}

// ---------- 发送与响应 ----------

function renderSendButton() {
  const btn = cs.els.send;
  if (!btn) return;
  btn.textContent = cs.sending ? '取消' : '发送';
  btn.className = `btn send-btn ${cs.sending ? 'danger' : 'primary'}`;
}

async function clientSend() {
  if (cs.sending) {
    cs.sending.abort();
    return;
  }
  const d = cs.draft;
  if (!d) return;
  const env = currentEnv();
  const request = draftToRequest(d);
  const controller = new AbortController();
  cs.sending = controller;
  renderSendButton();
  renderResponse();
  try {
    const result = await api('POST', '/client/send', { request, variables: env ? env.vars : [], envName: env ? env.name : '' }, { signal: controller.signal });
    cs.result = result;
    cs.resTab = result.response ? (cs.resTab === 'sent' ? 'body' : cs.resTab) : 'sent';
    addHistory(request, env, result);
  } catch (err) {
    cs.result = { error: controller.signal.aborted ? { code: 'CANCELLED', message: '请求已取消' } : { code: 'INVALID', message: err.message } };
  } finally {
    cs.sending = null;
    if (cs.draft === d) {
      renderSendButton();
      renderResponse();
    }
  }
}

function renderResponse() {
  const box = cs.els.response;
  if (!box) return;
  const r = cs.result;
  const title = h('div', { class: 'card-title' }, '响应');
  if (cs.sending) {
    put(box, title, h('div', { class: 'muted' }, '请求中…'));
    return;
  }
  if (!r) {
    put(box, title, h('div', { class: 'muted' }, '点击「发送」后在这里查看响应'));
    return;
  }
  if (!r.sent) {
    put(box, title, h('div', { class: 'error-box' }, r.error.message));
    return;
  }

  const res = r.response;
  const t = r.timing || {};
  const meta = h(
    'div',
    { class: 'res-meta' },
    res ? h('span', { class: res.status < 400 ? 'status-ok' : 'status-bad' }, `${res.status} ${res.statusText || ''}`) : null,
    h('span', { class: 'muted', title: t.ttfbMs !== null && t.ttfbMs !== undefined ? `首字节 ${t.ttfbMs} ms` : '' }, `${t.totalMs} ms`),
    res ? h('span', { class: 'muted' }, formatSize(res.size)) : null,
    r.redirects && r.redirects.length ? h('span', { class: 'muted', title: r.redirects.join('\n') }, `经过 ${r.redirects.length} 次重定向`) : null,
    r.envName ? h('span', { class: 'muted' }, `环境：${r.envName}`) : null,
    r.time ? h('span', { class: 'muted' }, formatTime(r.time)) : null,
  );
  title.append(meta);

  const tabs = res ? [['body', 'Body'], ['headers', `Headers（${Object.keys(res.headers).length}）`], ['sent', '实际请求']] : [['sent', '实际请求']];
  if (!tabs.some(([k]) => k === cs.resTab)) cs.resTab = tabs[0][0];
  const tabBar = h(
    'div',
    { class: 'inner-tabs' },
    tabs.map(([key, label]) =>
      h(
        'button',
        {
          class: `inner-tab${cs.resTab === key ? ' active' : ''}`,
          onclick: () => {
            cs.resTab = key;
            renderResponse();
          },
        },
        label,
      ),
    ),
  );

  let content;
  if (cs.resTab === 'body') {
    content = responseBody(res);
  } else if (cs.resTab === 'headers') {
    content = headerTable(res.headers);
  } else {
    const s = r.sent;
    content = h(
      'div',
      { class: 'sent-view' },
      h('div', { class: 'code sent-line' }, `${s.method} ${s.url}`),
      h('h4', {}, '请求头'),
      headerTable(s.headers),
      h('h4', {}, '请求体'),
      h('pre', {}, s.body === null || s.body === undefined || s.body === '' ? '（无）' : prettyText(s.body)),
      r.redirects && r.redirects.length ? [h('h4', {}, '重定向'), h('pre', {}, r.redirects.join('\n'))] : null,
    );
  }

  put(box, title, r.error ? h('div', { class: 'error-box' }, h('b', {}, `${r.error.code}　`), r.error.message) : null, tabBar, content);
}

function responseBody(res) {
  if (res.binary) return h('div', { class: 'muted' }, `二进制内容（${res.contentType || '未知类型'}，${formatSize(res.size)}），不显示`);
  const isJson = (() => {
    try {
      JSON.parse(res.body);
      return true;
    } catch {
      return false;
    }
  })();
  const shown = cs.resRaw || !isJson ? res.body : prettyText(res.body);
  return h(
    'div',
    { class: 'res-body' },
    h(
      'div',
      { class: 'row', style: 'margin-bottom:6px' },
      isJson
        ? h(
            'span',
            { class: 'seg' },
            h('button', { class: `btn small ${cs.resRaw ? 'ghost' : ''}`, onclick: () => { cs.resRaw = false; renderResponse(); } }, '美化'),
            h('button', { class: `btn small ${cs.resRaw ? '' : 'ghost'}`, onclick: () => { cs.resRaw = true; renderResponse(); } }, '原始'),
          )
        : null,
      h('button', { class: 'btn small ghost', onclick: () => copyText(res.body) }, '复制'),
      res.truncated ? h('span', { class: 'json-status warn' }, '响应内容过长，只显示了一部分') : null,
    ),
    h('pre', {}, shown === '' ? '（空）' : shown),
  );
}

function headerTable(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return h('div', { class: 'muted' }, '（无）');
  return h(
    'table',
    { class: 'sub-table header-table' },
    h('tbody', {}, entries.map(([k, v]) => h('tr', {}, h('td', { class: 'code' }, k), h('td', { class: 'code' }, Array.isArray(v) ? v.join(', ') : v)))),
  );
}

async function copyClientCurl() {
  const d = cs.draft;
  if (!d) return;
  const env = currentEnv();
  try {
    const { sent } = await api('POST', '/client/preview', { request: draftToRequest(d), variables: env ? env.vars : [], envName: env ? env.name : '' });
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    // 相对地址在服务器上指向 127.0.0.1，复制出去时换成浏览器访问的地址
    let url = sent.url;
    if (d.url.trim().startsWith('/')) {
      const u = new URL(sent.url);
      url = mockOrigin + u.pathname + u.search;
    }
    const parts = [`curl -X ${sent.method} ${q(url)}`];
    for (const [k, v] of Object.entries(sent.headers)) {
      if (k.toLowerCase() !== 'accept-encoding') parts.push(`-H ${q(`${k}: ${v}`)}`);
    }
    parts.push('--compressed');
    if (sent.body !== null) parts.push(`--data-raw ${q(sent.body)}`);
    if (d.options.insecure) parts.push('-k');
    copyText(parts.join(' \\\n  '));
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- 全局事件 ----------

document.addEventListener('keydown', (e) => {
  if (state.view !== 'client' || !cs.draft || !(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    clientSave();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    clientSend();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (cs.dirty) e.preventDefault();
});

'use strict';

// 返回值模板引擎：渲染 {{表达式}}。
// 表达式只支持「取值路径」和「内置函数调用」，不执行任意代码。
//   {{body.taskNo}}                      取请求参数
//   {{now 'YYYYMMDD'}}                   调用函数
//   {{concat 'WMS' (pad (seq 'out') 6)}} 括号嵌套调用
// JSON 中的 {"$repeat": 次数, "$item": {...}} 会生成数组，$item 内可用 $index / $no。

const crypto = require('node:crypto');

class TemplateError extends Error {}

const MAX_REPEAT = 10000;
const counters = new Map();

const CHARSETS = {
  digit: '0123456789',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  hex: '0123456789abcdef',
};
CHARSETS.alnum = CHARSETS.digit + CHARSETS.upper + CHARSETS.lower;

const pad2 = (n, len = 2) => String(n).padStart(len, '0');

function formatDate(d, fmt) {
  const parts = {
    YYYY: d.getFullYear(),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
    SSS: pad2(d.getMilliseconds(), 3),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|SSS|ss/g, (t) => parts[t]);
}

function toNum(v, fn) {
  const n = typeof v === 'number' ? v : Number(v);
  if (v === '' || v === null || v === undefined || Number.isNaN(n)) {
    throw new TemplateError(`${fn} 的参数不是数字: ${JSON.stringify(v)}`);
  }
  return n;
}

const isBlank = (v) => v === undefined || v === null || v === '';
const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const HELPERS = {
  now: (fmt = 'YYYY-MM-DD HH:mm:ss') => formatDate(new Date(), String(fmt)),
  timestamp: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  randomInt: (min = 0, max = 100) => {
    const lo = Math.ceil(toNum(min, 'randomInt'));
    const hi = Math.floor(toNum(max, 'randomInt'));
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  },
  randomStr: (len = 8, charset = 'alnum') => {
    const chars = CHARSETS[charset] || String(charset);
    const n = Math.min(toNum(len, 'randomStr'), 1000);
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  },
  pick: (...args) => args[Math.floor(Math.random() * args.length)],
  seq: (name = 'default', start = 1) => {
    const key = String(name);
    const next = counters.has(key) ? counters.get(key) + 1 : toNum(start, 'seq');
    counters.set(key, next);
    return next;
  },
  pad: (v, len = 2, ch = '0') => asText(v).padStart(toNum(len, 'pad'), String(ch)),
  concat: (...args) => args.map(asText).join(''),
  add: (...args) => args.reduce((s, x) => s + toNum(x, 'add'), 0),
  sub: (a, b) => toNum(a, 'sub') - toNum(b, 'sub'),
  mul: (...args) => args.reduce((s, x) => s * toNum(x, 'mul'), 1),
  div: (a, b) => {
    const d = toNum(b, 'div');
    if (d === 0) throw new TemplateError('div 的除数不能为 0');
    return toNum(a, 'div') / d;
  },
  ceil: (v) => Math.ceil(toNum(v, 'ceil')),
  floor: (v) => Math.floor(toNum(v, 'floor')),
  round: (v) => Math.round(toNum(v, 'round')),
  min: (...args) => Math.min(...args.map((x) => toNum(x, 'min'))),
  max: (...args) => Math.max(...args.map((x) => toNum(x, 'max'))),
  len: (v) => {
    if (isBlank(v)) return 0;
    if (Array.isArray(v) || typeof v === 'string') return v.length;
    if (typeof v === 'object') return Object.keys(v).length;
    return String(v).length;
  },
  upper: (v) => asText(v).toUpperCase(),
  lower: (v) => asText(v).toLowerCase(),
  default: (v, fallback) => (isBlank(v) ? fallback : v),
  number: (v) => toNum(v, 'number'),
  string: (v) => asText(v),
  eq: (a, b) => asText(a) === asText(b),
  gt: (a, b) => toNum(a, 'gt') > toNum(b, 'gt'),
  lt: (a, b) => toNum(a, 'lt') < toNum(b, 'lt'),
  if: (cond, a, b = '') => (cond && cond !== 'false' && cond !== '0' ? a : b),
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function resolvePath(obj, path) {
  const parts = String(path).replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const key of parts) {
    if (cur === null || cur === undefined || FORBIDDEN_KEYS.has(key)) return undefined;
    if (Array.isArray(cur) && key === 'length') {
      cur = cur.length;
    } else {
      cur = Object.prototype.hasOwnProperty.call(Object(cur), key) ? cur[key] : undefined;
    }
  }
  return cur;
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push({ t: c });
      i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (j >= src.length) throw new TemplateError(`字符串缺少结束引号: ${src}`);
      tokens.push({ t: 'lit', v: s });
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()'"]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      if (/^-?\d+(\.\d+)?$/.test(word)) tokens.push({ t: 'lit', v: Number(word) });
      else if (word === 'true' || word === 'false') tokens.push({ t: 'lit', v: word === 'true' });
      else if (word === 'null') tokens.push({ t: 'lit', v: null });
      else tokens.push({ t: 'id', v: word });
    }
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const parseAtom = () => {
    const tk = tokens[pos++];
    if (tk.t === ')') throw new TemplateError('多余的右括号');
    if (tk.t !== '(') return tk;
    const items = [];
    while (pos < tokens.length && tokens[pos].t !== ')') items.push(parseAtom());
    if (pos >= tokens.length) throw new TemplateError('缺少右括号');
    pos++;
    return { t: 'call', items };
  };
  const items = [];
  while (pos < tokens.length) items.push(parseAtom());
  return { t: 'call', items };
}

const isHelper = (name) => Object.prototype.hasOwnProperty.call(HELPERS, name);

function evalNode(node, ctx) {
  if (node.t === 'lit') return node.v;
  // 单独出现的函数名（如 concat 'A' uuid）按无参调用处理，其余按取值路径处理
  if (node.t === 'id') return isHelper(node.v) ? HELPERS[node.v]() : resolvePath(ctx, node.v);
  const [head, ...rest] = node.items;
  if (!head) throw new TemplateError('表达式为空');
  // if 只计算选中的分支，避免没选中的分支里的 seq 等函数也被执行
  if (head.t === 'id' && head.v === 'if') {
    const [cond, a, b] = rest;
    if (!cond) throw new TemplateError('if 缺少条件');
    const branch = HELPERS.if(evalNode(cond, ctx), a, b);
    return branch ? evalNode(branch, ctx) : '';
  }
  if (head.t === 'id' && isHelper(head.v)) return HELPERS[head.v](...rest.map((n) => evalNode(n, ctx)));
  if (rest.length === 0) return evalNode(head, ctx);
  throw new TemplateError(`未知的函数: ${head.v ?? '(...)'}`);
}

function evaluate(expr, ctx) {
  try {
    return evalNode(parse(tokenize(expr)), ctx);
  } catch (err) {
    if (err instanceof TemplateError) throw new TemplateError(`{{${expr.trim()}}} ${err.message}`);
    throw err;
  }
}

const WHOLE = /^\{\{((?:(?!\}\}).)*)\}\}$/s;
const INLINE = /\{\{((?:(?!\}\}).)*?)\}\}/gs;

// 整个字符串只有一个 {{...}} 时保留原始类型（数字、数组等），否则拼接成字符串
function renderString(s, ctx) {
  const whole = s.match(WHOLE);
  if (whole) return evaluate(whole[1], ctx);
  return s.replace(INLINE, (_, expr) => asText(evaluate(expr, ctx)));
}

// 只做文本替换，不保留原始类型。用于发出去的请求，行为和 Postman 一致
function renderText(s, ctx) {
  return asText(s).replace(INLINE, (_, expr) => asText(evaluate(expr, ctx)));
}

function renderNode(node, ctx) {
  if (typeof node === 'string') {
    const v = renderString(node, ctx);
    return v === undefined ? null : v;
  }
  if (Array.isArray(node)) return node.map((n) => renderNode(n, ctx));
  if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, '$repeat')) {
      const count = Number(renderNode(node.$repeat, ctx));
      if (!Number.isFinite(count) || count < 0) throw new TemplateError(`$repeat 的次数无效: ${count}`);
      if (count > MAX_REPEAT) throw new TemplateError(`$repeat 次数不能超过 ${MAX_REPEAT}，当前为 ${count}`);
      const item = Object.prototype.hasOwnProperty.call(node, '$item') ? node.$item : null;
      const out = [];
      for (let i = 0; i < Math.floor(count); i++) {
        out.push(renderNode(item, { ...ctx, $index: i, $no: i + 1, $parentIndex: ctx.$index, $parentNo: ctx.$no }));
      }
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = renderNode(v, ctx);
    return out;
  }
  return node;
}

// 返回值是合法 JSON 时按 JSON 渲染，否则按纯文本渲染
function renderBody(text, ctx) {
  const src = text ?? '';
  if (src.trim() === '') return { body: '', json: false };
  let tree;
  try {
    tree = JSON.parse(src);
  } catch {
    return { body: asText(renderString(src, ctx)), json: false };
  }
  return { body: JSON.stringify(renderNode(tree, ctx)), json: true };
}

module.exports = { TemplateError, HELPERS, resolvePath, renderString, renderText, renderNode, renderBody };

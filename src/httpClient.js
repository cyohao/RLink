'use strict';

// 接口调用功能的 HTTP 客户端：由服务器代替浏览器发出请求。
// 负责超时、重定向、解压、字符集解码、响应大小上限和取消，出错时返回中文说明而不是抛异常。

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME_INVALID/;

class RequestFailed extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const findHeader = (headers, name) => Object.keys(headers).find((k) => k.toLowerCase() === name);

function withoutHeaders(headers, names) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k.toLowerCase())));
}

function describeError(err, { url, timeout }) {
  if (err instanceof RequestFailed) return { code: err.code, message: err.message };
  const code = err.code || 'ERROR';
  const host = url ? url.host : '';
  if (code === 'ECONNREFUSED') return { code, message: `连接被拒绝：${host} 没有服务在监听，请检查地址和端口` };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code, message: `找不到主机 ${url ? url.hostname : ''}，请检查地址或 DNS 设置` };
  if (code === 'ETIMEDOUT') return { code, message: `连接 ${host} 超时` };
  if (code === 'ECONNRESET') return { code, message: '连接被对方关闭（ECONNRESET）' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { code, message: `网络不可达：${host}` };
  if (code === 'EPIPE') return { code, message: '对方在请求发送完之前关闭了连接' };
  if (CERT_ERRORS.test(code)) {
    return { code, message: `HTTPS 证书校验失败：${err.message}。如果是内网自签证书，可以在「设置」里勾选「忽略证书错误」` };
  }
  if (code === 'EPROTO' || code.startsWith('ERR_SSL')) return { code, message: `TLS 握手失败：${err.message}。请确认对方是否支持 HTTPS` };
  if (code.startsWith('HPE_')) return { code, message: `对方返回的不是合法的 HTTP 响应（${err.message}）` };
  if (code === 'ERR_INVALID_CHAR') return { code, message: `请求头里有非法字符（请求头的值不能包含中文等非 ASCII 字符）：${err.message}` };
  if (code === 'ERR_INVALID_HTTP_TOKEN') return { code, message: `请求头名称不合法：${err.message}` };
  if (timeout && code === 'TIMEOUT') return { code, message: `请求超时（${timeout / 1000} 秒内没有完成）` };
  return { code, message: err.message || String(err) };
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType || '');
  return m ? m[1].toLowerCase() : 'utf-8';
}

function isTextType(contentType) {
  const ct = (contentType || '').toLowerCase();
  return /^text\//.test(ct) || /json|xml|javascript|x-www-form-urlencoded|ecmascript|graphql|yaml|csv/.test(ct);
}

function decodeBody(buf, contentType) {
  if (buf.length === 0) return { text: '', binary: false };
  if (contentType && !isTextType(contentType)) return { text: '', binary: true };
  if (!contentType) {
    // 没有 Content-Type 时，能按 UTF-8 正常解码的就当作文本
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), binary: false };
    } catch {
      return { text: '', binary: true };
    }
  }
  let decoder;
  try {
    decoder = new TextDecoder(charsetOf(contentType));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(buf), binary: false };
}

function decompressor(encoding) {
  const e = (encoding || '').trim().toLowerCase();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

// 发出一次请求（不处理重定向），读完响应体后返回
function requestOnce({ method, url, headers, body, insecure, signal, maxBytes, onResponse }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let req;
    try {
      req = lib.request(url, { method, headers, signal, rejectUnauthorized: !insecure });
    } catch (err) {
      reject(err);
      return;
    }
    req.on('error', reject);
    req.on('response', (res) => {
      onResponse();
      const decoder = decompressor(res.headers['content-encoding']);
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks = [];
      let size = 0;
      let truncated = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ res, buf: Buffer.concat(chunks), truncated });
      };
      const fail = (err) => {
        if (done) return;
        done = true;
        if (decoder && err.code && err.code.startsWith('Z_')) reject(new RequestFailed('DECOMPRESS', `响应解压失败（${res.headers['content-encoding']}）：${err.message}`));
        else reject(err);
      };
      stream.on('data', (chunk) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', finish);
      // pipe 不会传递错误，原始响应和解压流都要监听
      stream.on('error', fail);
      if (decoder) res.on('error', fail);
      res.on('close', () => {
        if (!res.complete) fail(Object.assign(new Error('响应没有接收完整，连接就被关闭了'), { code: 'ECONNRESET' }));
      });
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 发送请求。
 * @param {object} opts
 *   method, url（字符串或 URL）, headers（对象）, body（字符串或 Buffer，可省略）
 *   timeout（毫秒，覆盖整个过程）, followRedirects, insecure
 *   signal（外部取消）, checkUrl(url)（重定向时检查地址，不允许时抛出 RequestFailed）
 * @returns {Promise<{response?, error?, timing, redirects, finalUrl}>}
 */
async function sendRequest(opts) {
  const { timeout = 30000, followRedirects = true, insecure = false, signal, checkUrl, maxBytes = MAX_RESPONSE_BYTES } = opts;
  const started = performance.now();
  let ttfb = null;
  const redirects = [];

  const controller = new AbortController();
  let abortReason = null;
  const timer = setTimeout(() => {
    abortReason = 'TIMEOUT';
    controller.abort();
  }, timeout);
  const onCancel = () => {
    abortReason = 'CANCELLED';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onCancel();
    else signal.addEventListener('abort', onCancel, { once: true });
  }

  let method = opts.method;
  let url = new URL(opts.url);
  let headers = { ...opts.headers };
  let body = opts.body;
  if (body !== undefined && !findHeader(headers, 'content-length')) headers['Content-Length'] = String(Buffer.byteLength(body));

  const timing = () => ({ totalMs: Math.round(performance.now() - started), ttfbMs: ttfb });

  try {
    for (;;) {
      let result;
      try {
        result = await requestOnce({
          method,
          url,
          headers,
          body,
          insecure,
          signal: controller.signal,
          maxBytes,
          onResponse: () => {
            ttfb = Math.round(performance.now() - started);
          },
        });
      } catch (err) {
        if (abortReason === 'TIMEOUT') throw new RequestFailed('TIMEOUT', `请求超时（${timeout / 1000} 秒内没有完成）`);
        if (abortReason === 'CANCELLED') throw new RequestFailed('CANCELLED', '请求已取消');
        throw err;
      }
      const { res, buf, truncated } = result;
      const location = res.headers.location;

      if (followRedirects && REDIRECT_CODES.has(res.statusCode) && location) {
        if (redirects.length >= MAX_REDIRECTS) throw new RequestFailed('TOO_MANY_REDIRECTS', `重定向次数超过 ${MAX_REDIRECTS} 次，已停止`);
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new RequestFailed('BAD_REDIRECT', `不支持重定向到 ${next.href}`);
        if (checkUrl) checkUrl(next);
        // 303 一律改为 GET；301/302 按浏览器的习惯，非 GET/HEAD 也改为 GET
        if (res.statusCode === 303 ? method !== 'HEAD' : (res.statusCode === 301 || res.statusCode === 302) && method !== 'GET' && method !== 'HEAD') {
          method = 'GET';
          body = undefined;
          headers = withoutHeaders(headers, ['content-type', 'content-length']);
        }
        // 跳到别的主机时不带上认证信息
        if (next.host !== url.host) headers = withoutHeaders(headers, ['authorization', 'cookie']);
        const hostKey = findHeader(headers, 'host');
        if (hostKey) delete headers[hostKey];
        redirects.push(next.href);
        url = next;
        continue;
      }

      const contentType = res.headers['content-type'] || '';
      const decoded = decodeBody(buf, contentType);
      return {
        finalUrl: url.href,
        redirects,
        timing: timing(),
        response: {
          status: res.statusCode,
          statusText: res.statusMessage || http.STATUS_CODES[res.statusCode] || '',
          headers: res.headers,
          body: decoded.text,
          binary: decoded.binary,
          contentType,
          size: buf.length,
          truncated,
        },
      };
    }
  } catch (err) {
    return { finalUrl: url.href, redirects, timing: timing(), error: describeError(err, { url, timeout }) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCancel);
  }
}

module.exports = { sendRequest, RequestFailed, MAX_RESPONSE_BYTES, MAX_REDIRECTS };

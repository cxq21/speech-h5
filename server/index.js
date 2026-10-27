'use strict';
// 最小服务：静态托管 public/ + WebSocket 中转 /asr → 讯飞方言识别大模型（自动续接 60s 会话）
// 密钥只从环境变量读取，不下发前端、不写日志。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const xf = require('./xfyun');
const llm = require('./llm');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_SESSION_SEC = Number(process.env.MAX_SESSION_SEC || 600);   // 单次最长录音
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 2);           // 同时在用的路数（≤讯飞套餐并发）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const FRAME_BYTES = xf.FRAME_BYTES; // 每 40ms 1280 字节（16k/16bit/单声道）
const ROTATE_MS = Number(process.env.ROTATE_MS || 55000); // 讯飞单会话上限 60s，最晚此时续接
const SOFT_ROTATE_MS = ROTATE_MS - 10000;                  // 此后遇到静音帧就提前续接，避免把一个字切成两半
const VAD_RMS = Number(process.env.VAD_RMS || 200);       // 空闲时的能量门限：有声才开新会话，省服务量
const PRE_FRAMES = 10;                                    // 开会话前保留 400ms 预缓冲，避免吞首字

function credentials() {
  const appId = process.env.XFYUN_APPID, apiKey = process.env.XFYUN_API_KEY, apiSecret = process.env.XFYUN_API_SECRET;
  return appId && apiKey && apiSecret ? { appId, apiKey, apiSecret } : null;
}

// 安全解析请求路径：扫描器会发 "//"、"//evil" 之类的路径，new URL(path, base) 会抛错或把它当成主机名
function parseUrl(u) { try { return new URL('http://x' + (String(u || '/').startsWith('/') ? u : '/' + u)); } catch { return new URL('http://x/'); } }

// ---------- 静态文件 ----------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = parseUrl(req.url);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, configured: !!credentials(), active, upstreamSessions, llm: llm.status() }));
  }
  if (url.pathname === '/api/polish') return handlePolish(req, res);
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- 润色 API（LLM）----------
// 只接受已确认的句子 + 前端从本地知识库检索出的少量片段/术语；提示词在服务端拼，前端无法自定义
const rate = new Map(); // ip → {n, t}
function allowRate(ip) {
  const now = Date.now(), r = rate.get(ip) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++; rate.set(ip, r); if (rate.size > 5000) rate.clear();
  return r.n <= Number(process.env.POLISH_RATE_PER_MIN || 40);
}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
function handlePolish(req, res) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) return json(403, { error: 'origin' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowRate(ip)) return json(429, { fallback: true, reason: '请求过于频繁' });
  let body = '', size = 0;
  req.on('data', (d) => { size += d.length; if (size > 32768) { json(413, { error: 'too large' }); req.destroy(); } else body += d; });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let b; try { b = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 8).map((x) => ({ id: clip(x.id, 20), text: clip(x.text, 300) })).filter((x) => x.text);
    if (!items.length) return json(400, { error: 'no items' });
    const ctx = {
      terms: (Array.isArray(b.terms) ? b.terms : []).slice(0, 60).map((t) => clip(t, 20)).filter(Boolean),
      refs: (Array.isArray(b.refs) ? b.refs : []).slice(0, 3).map((t) => clip(t, 400)).filter(Boolean),
      before: clip(b.before, 200), emoji: !!b.emoji, para: !!b.para,
    };
    try { json(200, await llm.polish(items, ctx)); } catch (e) { json(200, { fallback: true, reason: 'error' }); }
  });
}

// 兜底：单个请求/连接的异常只记日志，不让进程退出（Render 上进程崩溃会整站 502）
process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.message));

// ---------- WebSocket 中转 ----------
let active = 0, upstreamSessions = 0; // upstreamSessions：自启动以来开过的讯飞会话数（= 消耗的调用次数）
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = parseUrl(req.url);
  if (pathname !== '/asr') return socket.destroy();
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws));
});

function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function rms(frame) {
  let sum = 0; const n = frame.length >> 1;
  for (let i = 0; i + 1 < frame.length; i += 2) { const v = frame.readInt16LE(i); sum += v * v; }
  return n ? Math.sqrt(sum / n) : 0;
}

// 一个浏览器连接 = 若干个顺序的讯飞会话（每段 ≤ ROTATE_MS，或被讯飞尾静音 eos 截断）。
// 同一时刻每个浏览器连接最多只占 1 路讯飞并发；会话切换期间的音频先缓存，新会话建立后补发。
function handleClient(client) {
  const cred = credentials();
  if (!cred) { send(client, { type: 'error', code: 'NO_CREDENTIALS', message: '服务端未配置讯飞密钥（XFYUN_APPID / XFYUN_API_KEY / XFYUN_API_SECRET）' }); return client.close(); }
  if (active >= MAX_SESSIONS) { send(client, { type: 'error', code: 'BUSY', message: `并发已满（${MAX_SESSIONS} 路），请稍后再试` }); return client.close(); }
  active++;
  send(client, { type: 'status', status: 'ready' });

  let pending = Buffer.alloc(0); // 不足一帧的尾巴
  let cur = null;                // 当前讯飞会话
  let carry = [];                // 当前会话收尾期间到达的音频
  let pre = [];                  // 空闲时的预缓冲
  let stopping = false, closed = false, segIndex = 0;
  let dhw = xf.hotwords(); // 会话热词：环境变量 + 前端知识库术语（{type:'hot'}）
  const timer = setTimeout(() => { send(client, { type: 'info', message: `已达单次最长时长 ${MAX_SESSION_SEC}s，自动结束` }); stop(); }, MAX_SESSION_SEC * 1000);

  function onFrame(frame) {
    if (closed) return;
    if (cur && cur.state === 'connecting') return void cur.queue.push(frame);
    if (cur && cur.state === 'open') {
      sendAudio(cur, frame);
      const ms = cur.frames * 40;
      cur.quiet = rms(frame) < VAD_RMS / 2 ? cur.quiet + 1 : 0;
      if (ms >= ROTATE_MS || (ms >= SOFT_ROTATE_MS && cur.quiet >= 5)) endSession(cur); // 软续接：连续 200ms 静音
      return;
    }
    if (cur) return void carry.push(frame); // closing
    if (stopping) return;
    pre.push(frame); if (pre.length > PRE_FRAMES) pre.shift();
    if (rms(frame) >= VAD_RMS) { const q = pre; pre = []; openSession(q); }
  }

  function sendAudio(s, buf) {
    s.ws.send(xf.audioFrame(cred.appId, s.frames === 0 ? 0 : 1, buf, s.seq++, { dhw }));
    s.frames += buf.length / FRAME_BYTES;
  }

  function openSession(queue) {
    upstreamSessions++;
    const s = { ws: new WebSocket(xf.buildAuthUrl(cred), { handshakeTimeout: 10000 }), state: 'connecting', frames: 0, seq: 0,
      asm: new xf.PgsAssembler(), text: '', queue, quiet: 0, index: segIndex++, killTimer: null };
    cur = s;
    s.ws.on('open', () => {
      if (cur !== s) return;
      s.state = 'open';
      if (s.queue.length) { sendAudio(s, Buffer.concat(s.queue)); s.queue = []; } // 一次补发（帧大小整数倍）
      if (stopping || s.frames * 40 >= ROTATE_MS) endSession(s);
    });
    s.ws.on('message', (raw) => {
      const m = xf.parseMessage(raw);
      if (m.code !== 0) return fail(String(m.code), `${xf.ERROR_HINTS[m.code] || '识别服务错误'}（${m.message}）`);
      if (m.result) { s.text = s.asm.apply(m.result); send(client, { type: 'partial', text: s.text, seg: s.index }); }
      if (m.status === 2 || (m.result && m.result.ls)) { if (s.state === 'open') s.state = 'closing'; try { s.ws.close(); } catch {} }
    });
    s.ws.on('unexpected-response', (_req, res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => {
        let msg = body; try { msg = JSON.parse(body).message || body; } catch {}
        fail(`HTTP_${res.statusCode}`, `讯飞握手失败：${String(msg).slice(0, 200)}（检查密钥/服务开通/服务器时间）`);
      });
    });
    s.ws.on('error', (e) => fail('UPSTREAM', `连接讯飞失败：${e.code || e.message}`));
    s.ws.on('close', () => onSessionClosed(s));
  }

  function endSession(s) {
    if (s.state !== 'open') return;
    s.ws.send(xf.audioFrame(cred.appId, 2, null, s.seq++));
    s.state = 'closing';
    s.killTimer = setTimeout(() => { try { s.ws.terminate(); } catch {} }, 10000);
  }

  function onSessionClosed(s) {
    clearTimeout(s.killTimer);
    if (cur !== s || closed) return;
    cur = null;
    if (s.text) send(client, { type: 'final', text: s.text, seg: s.index });
    const c = carry; carry = [];
    if (stopping) {
      if (c.some((f) => rms(f) >= VAD_RMS)) openSession(c); // 收尾期间还有人声：再开一段并立即结束
      else finishClient();
      return;
    }
    for (const f of c) onFrame(f); // 交给门限逻辑：有声立即续接新会话
  }

  function stop() {
    if (stopping || closed) return;
    if (pending.length) { const tail = Buffer.alloc(FRAME_BYTES); pending.copy(tail); pending = Buffer.alloc(0); onFrame(tail); }
    stopping = true;
    if (!cur) return finishClient();
    if (cur.state === 'open') endSession(cur); // connecting：open 后自动结束；closing：等 close
  }
  function finishClient() { send(client, { type: 'status', status: 'done' }); cleanup(); }
  function fail(code, message) {
    if (closed) return;
    console.warn(`[asr] error code=${code} ${message}`); // 不含密钥/URL
    send(client, { type: 'error', code, message });
    cleanup();
  }
  function cleanup() {
    if (closed) return; closed = true; active--; clearTimeout(timer);
    if (cur) { clearTimeout(cur.killTimer); try { cur.ws.terminate(); } catch {} cur = null; }
    try { client.close(); } catch {}
  }

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= FRAME_BYTES) { onFrame(Buffer.from(pending.subarray(0, FRAME_BYTES))); pending = pending.subarray(FRAME_BYTES); }
    } else {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'stop') stop();
      if (msg.type === 'hot' && Array.isArray(msg.words)) dhw = xf.hotwords(msg.words.slice(0, 200).map((w) => String(w).slice(0, 20))); // 下一个讯飞会话起生效
    }
  });
  client.on('close', () => cleanup());
  client.on('error', () => cleanup());
}

server.listen(PORT, HOST, () => {
  console.log(`speech-h5 listening on http://${HOST}:${PORT}  (xfyun slm credentials: ${credentials() ? 'configured' : 'MISSING'}, MAX_SESSIONS=${MAX_SESSIONS})`);
});

module.exports = { server };

'use strict';
// LLM 润色层：按批处理已确认的句子（纠同音错字/专有名词/标点 + 可选表情 + 可选分段建议）
// 后端（按优先级）：
//   1) OpenAI 兼容：LLM_BASE_URL + LLM_API_KEY + LLM_MODEL（也可指向讯飞星火 HTTP：https://spark-api-open.xf-yun.com/v1，Key 为 APIPassword）
//   2) 讯飞星火 WebSocket：复用 XFYUN_APPID/API_KEY/API_SECRET，SPARK_DOMAIN 默认 lite（需在控制台为该应用开通星火）
// 失败/超时 → 返回 fallback，前端保留原文。密钥不出服务端、不写日志。
const { WebSocket } = require('ws');
const xf = require('./xfyun');

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 10000);
const MAX_CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 2);
const SPARK = {
  lite: 'wss://spark-api.xf-yun.com/v1.1/chat', generalv3: 'wss://spark-api.xf-yun.com/v3.1/chat', 'pro-128k': 'wss://spark-api.xf-yun.com/chat/pro-128k',
  'generalv3.5': 'wss://spark-api.xf-yun.com/v3.5/chat', 'max-32k': 'wss://spark-api.xf-yun.com/chat/max-32k', '4.0Ultra': 'wss://spark-api.xf-yun.com/v4.0/chat',
};

function provider() {
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) return { kind: 'openai', name: `openai-compatible:${process.env.LLM_MODEL || 'default'}` };
  if (process.env.LLM_DISABLE === '1') return null;
  const domain = process.env.SPARK_DOMAIN || 'lite';
  if (process.env.XFYUN_APPID && process.env.XFYUN_API_KEY && process.env.XFYUN_API_SECRET && SPARK[domain]) return { kind: 'spark', name: `spark:${domain}`, domain };
  return null;
}

// 熔断：未授权/鉴权类错误 10 分钟内不再请求；其他错误 30s
const state = { downUntil: 0, lastError: '', ok: 0, fail: 0, inflight: 0, queue: [] };
function status() { const p = provider(); return { provider: p ? p.name : null, available: !!p && Date.now() >= state.downUntil, lastError: state.lastError, ok: state.ok, fail: state.fail }; }

function buildMessages(items, ctx) {
  const sys = [
    '你是语音转写文本的校对助手。输入是语音识别（可能含方言）得到的句子。',
    '只允许：纠正同音/近音错别字、专有名词（以「术语表」「参考资料」为准）、标点符号；数字格式保持不变。',
    '不允许：增删实质内容、改写句式、翻译或替换方言词、合并或拆分句子。拿不准就保持原样。',
    ctx.emoji ? '表情：只给情绪或内容非常明显的句子在句末加 1 个贴切的 emoji，整体克制（多数句子不加，前后句不要连续加）。' : '不要添加任何 emoji。',
    ctx.para ? '分段：判断每句是否应另起一段（明显换话题时为 true，否则 false）。' : '',
    '只输出 JSON 数组，不要任何解释：[{"id":编号,"text":"校对后的句子","newPara":true或false}]',
  ].filter(Boolean).join('\n');
  const parts = [];
  if (ctx.terms && ctx.terms.length) parts.push('术语表：' + ctx.terms.join('、'));
  if (ctx.refs && ctx.refs.length) parts.push('参考资料：\n' + ctx.refs.map((r, i) => `[${i + 1}] ${r}`).join('\n'));
  if (ctx.before) parts.push('上文（仅供理解，不要输出）：' + ctx.before);
  parts.push('待校对句子：' + JSON.stringify(items.map((x) => ({ id: x.id, text: x.text })), null, 0));
  return [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n\n') }];
}

function parseJSONArray(s) {
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('LLM 输出不是 JSON 数组');
  const arr = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error('LLM 输出不是数组');
  return arr;
}

async function callOpenAI(messages, signal) {
  const base = process.env.LLM_BASE_URL.replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4o-mini', messages, temperature: 0.1, max_tokens: 1500 }),
  });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`HTTP ${r.status} ${t.slice(0, 120)}`); e.auth = r.status === 401 || r.status === 403; throw e; }
  const j = JSON.parse(t);
  return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
}

function callSpark(domain, messages, signal) {
  return new Promise((resolve, reject) => {
    const cred = { appId: process.env.XFYUN_APPID, apiKey: process.env.XFYUN_API_KEY, apiSecret: process.env.XFYUN_API_SECRET };
    const ws = new WebSocket(xf.buildAuthUrl(cred, new Date(), SPARK[domain]), { handshakeTimeout: 8000 });
    let out = '', done = false;
    const finish = (err, v) => { if (done) return; done = true; try { ws.close(); } catch {} err ? reject(err) : resolve(v); };
    signal.addEventListener('abort', () => finish(new Error('timeout')));
    ws.on('open', () => ws.send(JSON.stringify({
      header: { app_id: cred.appId, uid: 'speech-h5' },
      parameter: { chat: { domain, temperature: 0.1, max_tokens: 1500 } },
      payload: { message: { text: messages.map((m) => ({ role: m.role, content: m.content })) } },
    })));
    ws.on('message', (raw) => {
      let j; try { j = JSON.parse(raw); } catch { return; }
      if (j.header.code !== 0) { const e = new Error(`星火 ${j.header.code} ${String(j.header.message).slice(0, 60)}`); e.auth = [11200, 10313, 11201, 10010].includes(j.header.code); return finish(e); }
      for (const c of (j.payload && j.payload.choices && j.payload.choices.text) || []) out += c.content || '';
      if (j.header.status === 2) finish(null, out);
    });
    ws.on('unexpected-response', (_q, res) => { const e = new Error(`星火握手 HTTP ${res.statusCode}`); e.auth = res.statusCode === 401 || res.statusCode === 403; finish(e); });
    ws.on('error', (e) => finish(e));
  });
}

// items: [{id, text}]，ctx: {terms, refs, before, emoji, para}
async function polish(items, ctx) {
  const p = provider();
  if (!p) return { fallback: true, reason: 'LLM 未配置' };
  if (Date.now() < state.downUntil) return { fallback: true, reason: 'LLM 暂不可用：' + state.lastError };
  if (state.inflight >= MAX_CONCURRENCY) {
    if (state.queue.length >= 10) return { fallback: true, reason: 'LLM 繁忙' };
    await new Promise((r) => state.queue.push(r));
  }
  state.inflight++;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), TIMEOUT_MS); const t0 = Date.now();
  try {
    const messages = buildMessages(items, ctx);
    const content = p.kind === 'openai' ? await callOpenAI(messages, ac.signal) : await callSpark(p.domain, messages, ac.signal);
    const arr = parseJSONArray(content);
    state.ok++; state.lastError = '';
    const byId = new Map(arr.filter((x) => x && x.id !== undefined).map((x) => [String(x.id), x]));
    return { provider: p.name, ms: Date.now() - t0, results: items.map((it) => { const r = byId.get(String(it.id)); return r ? { id: it.id, text: String(r.text || ''), newPara: !!r.newPara } : { id: it.id }; }) };
  } catch (e) {
    state.fail++; state.lastError = ac.signal.aborted ? `超时(${TIMEOUT_MS}ms)` : String(e.message || e).slice(0, 120);
    if (e.auth) state.downUntil = Date.now() + 10 * 60 * 1000; else if (!ac.signal.aborted) state.downUntil = Date.now() + 30 * 1000;
    console.warn('[llm] fallback:', state.lastError);
    return { fallback: true, reason: state.lastError, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer); state.inflight--; const next = state.queue.shift(); if (next) next();
  }
}

module.exports = { polish, status, provider, buildMessages, parseJSONArray, _state: state };

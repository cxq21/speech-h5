'use strict';
// 讯飞「方言识别大模型」WebSocket API（slm，202 种方言免切）
// 文档：https://www.xfyun.cn/doc/spark/spark_slm_iat.html
const crypto = require('crypto');

const ENDPOINT = process.env.XFYUN_ENDPOINT || 'wss://iat.cn-huabei-1.xf-yun.com/v1'; // XFYUN_ENDPOINT 仅供本地 mock
const FRAME_BYTES = 1280;          // 文档建议：PCM 每 40ms 发 1280 字节
const MAX_SESSION_MS = 60000;      // 文档：单次会话音频最长 60s（超时报 10114）

// 文档鉴权：signature_origin = "host: $host\ndate: $date\nGET $path HTTP/1.1"
//          signature = base64(hmac-sha256(signature_origin, APISecret))
//          authorization = base64('api_key="..", algorithm="hmac-sha256", headers="host date request-line", signature=".."')
function signature(host, date, path, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(`host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`).digest('base64');
}
function authorization(apiKey, sig) {
  return Buffer.from(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`).toString('base64');
}
function buildAuthUrl(cred, now = new Date(), endpoint = ENDPOINT) {
  const u = new URL(endpoint);
  const date = now.toUTCString(); // RFC1123，GMT；服务端允许 ±300s
  const sig = signature(u.host, date, u.pathname, cred.apiSecret);
  const q = new URLSearchParams({ authorization: authorization(cred.apiKey, sig), date, host: u.host });
  return `${u.origin}${u.pathname}?${q}`;
}

// 识别参数：方言免切（accent=mulacc）、流式动态修正（dwa=wpgs）、标点、数字规整
function iatParams(extra = {}) {
  return {
    language: 'zh_cn', accent: 'mulacc', domain: 'slm',
    eos: Number(process.env.XFYUN_EOS || 1800), // 尾静音截断(ms)，600~10000；到点引擎结束本次会话
    dwa: 'wpgs', ptt: 1, nunum: 1,
    ...(extra.dhw || hotwords() ? { dhw: extra.dhw || hotwords() } : {}),
    result: { encoding: 'utf8', compress: 'raw', format: 'json' },
  };
}

// 会话热词（文档 dhw，≤1024 字节）：XFYUN_HOTWORDS="屯溪|歙县|毛豆腐" → "utf-8;屯溪|歙县|毛豆腐"
function hotwords(extraWords = []) {
  const w = [...new Set([...(process.env.XFYUN_HOTWORDS || '').split(/[|,，\n]/), ...extraWords].map((x) => String(x).replace(/[|;]/g, '').trim()).filter(Boolean))];
  if (!w.length) return '';
  let out = 'utf-8;';
  for (const x of w) { const next = out + (out.endsWith(';') ? '' : '|') + x; if (Buffer.byteLength(next) > 1024) break; out = next; }
  return out;
}

// status: 0 首帧（带 parameter）/ 1 中间帧 / 2 尾帧
function audioFrame(appId, status, pcm, seq, extra) {
  const msg = {
    header: { app_id: appId, status, ...(status === 0 && process.env.XFYUN_RES_ID ? { res_id: process.env.XFYUN_RES_ID } : {}) }, // res_id：控制台应用级热词
    payload: { audio: { encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, status, seq, audio: pcm ? pcm.toString('base64') : '' } },
  };
  if (status === 0) msg.parameter = { iat: iatParams(extra) };
  return JSON.stringify(msg);
}

// wpgs 动态修正拼装：pgs=apd 追加，pgs=rpl 替换 rg=[起始sn, 结束sn] 范围内的旧结果
class PgsAssembler {
  constructor() { this.parts = new Map(); }
  apply(r) {
    if (r.pgs === 'rpl' && Array.isArray(r.rg)) for (let sn = r.rg[0]; sn <= r.rg[1]; sn++) this.parts.delete(sn);
    this.parts.set(r.sn, r.text);
    return this.text();
  }
  text() { return [...this.parts.keys()].sort((a, b) => a - b).map((k) => this.parts.get(k)).join(''); }
}

// 解析服务端消息 → { code, message, sid, status, result? }
function parseMessage(raw) {
  let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return { code: -1, message: 'bad json' }; }
  const h = msg.header || {};
  const out = { code: Number(h.code ?? 0), message: h.message || '', sid: h.sid, status: h.status };
  const t = msg.payload && msg.payload.result && msg.payload.result.text;
  if (t) {
    try {
      const r = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
      let text = '';
      for (const ws of r.ws || []) for (const cw of ws.cw || []) text += cw.w || '';
      out.result = { sn: r.sn, pgs: r.pgs, rg: r.rg, ls: !!r.ls, bg: r.bg, ed: r.ed, text };
    } catch { /* ignore */ }
  }
  return out;
}

// 文档 6.1 错误码 → 提示
const ERROR_HINTS = {
  10009: '输入数据非法', 10010: '没有授权许可或授权数已满（并发已满）', 10019: 'session 超时',
  10043: '音频解码失败', 10114: '会话超过 60s', 10139: '参数错误', 10160: '请求 JSON 非法', 10161: 'base64 解码失败',
  10163: '参数校验失败', 10200: '读取数据超时（10s 未发送数据）', 10313: 'appid 和 apikey 不匹配', 10317: '版本非法',
  11200: '功能未授权：确认该 APPID 已添加「方言识别大模型」且服务量/有效期未用尽', 11201: '每日交互次数超限',
};

module.exports = { hotwords, ENDPOINT, FRAME_BYTES, MAX_SESSION_MS, signature, authorization, buildAuthUrl, iatParams, audioFrame, PgsAssembler, parseMessage, ERROR_HINTS };

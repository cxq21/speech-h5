'use strict';
// 端到端自测：把 16k/16bit/单声道 PCM 文件按实时速率（40ms/1280B）推给本服务 /asr，打印结果与延迟
// 用法：node scripts/e2e-client.js sample.pcm [ws://localhost:8080/asr]
const fs = require('fs');
const { WebSocket } = require('ws');
const file = process.argv[2]; const url = process.argv[3] || 'ws://localhost:8080/asr';
const pcm = fs.readFileSync(file);
// 语音起点：第一个 RMS ≥ 200 的 40ms 帧（用于扣除样例开头的静音）
let onsetMs = 0;
for (let off = 0; off + 1280 <= pcm.length; off += 1280) {
  let sum = 0; for (let i = 0; i < 1280; i += 2) { const v = pcm.readInt16LE(off + i); sum += v * v; }
  if (Math.sqrt(sum / 640) >= 200) { onsetMs = off / 32; break; }
}
const ws = new WebSocket(url, process.env.E2E_ORIGIN ? { origin: process.env.E2E_ORIGIN } : {}); // 服务端设置了 ALLOWED_ORIGINS 时传入
const t0 = Date.now(); let tReady = 0, tFirst = 0, tFirstFinal = 0, tLastFinal = 0, tStop = 0, finals = [], lastPartial = '';
const ms = () => Date.now() - t0;
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'status' && m.status === 'ready') { tReady = ms(); console.log(`[${ms()}ms] ready`); pump(); }
  else if (m.type === 'partial') { if (!tFirst && m.text) tFirst = ms(); lastPartial = m.text; console.log(`[${ms()}ms] partial: ${m.text}`); }
  else if (m.type === 'final') { if (!tFirst && m.text) tFirst = ms(); if (!tFirstFinal) tFirstFinal = ms(); tLastFinal = ms(); finals.push(m.text); console.log(`[${ms()}ms] FINAL:   ${m.text}`); }
  else console.log(`[${ms()}ms]`, JSON.stringify(m));
});
ws.on('close', () => {
  console.log('\n==== 结果 ====\n' + (finals.join('') || lastPartial));
  const audioSec = pcm.length / 32000;
  console.log(`音频 ${audioSec.toFixed(1)}s；连接就绪 ${tReady}ms；首个中间结果 ${tFirst ? tFirst - tReady : '-'}ms（相对开始发音频）/ ${tFirst ? tFirst - tReady - onsetMs : '-'}ms（相对语音起点 ${onsetMs}ms）；` +
    `首个最终句 ${tFirstFinal ? tFirstFinal - tReady : '-'}ms；音频发完→最后最终结果 ${tLastFinal && tStop ? tLastFinal - tStop : '-'}ms；停止→连接关闭 ${tStop ? ms() - tStop : '-'}ms`);
});
function pump() {
  let off = 0;
  const iv = setInterval(() => {
    if (off >= pcm.length) { clearInterval(iv); tStop = ms(); ws.send(JSON.stringify({ type: 'stop' })); return; }
    ws.send(pcm.subarray(off, off + 1280)); off += 1280;
  }, 40);
}

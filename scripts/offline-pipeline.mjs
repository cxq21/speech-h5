// 离线跑前端处理链路（与浏览器 AudioWorklet 同一份 dsp.mjs），输出 16k PCM 供 e2e-client 推流
// 用法：node scripts/offline-pipeline.mjs in.f32(48k float32 单声道) out.pcm [legacy|new] [denoise=1] [nearOnly=1] [sens=50]
import fs from 'fs';
import { Pipeline, legacyDownsample } from '../public/dsp.mjs';
const [inp, outp, mode = 'new', dn = '1', near = '1', sens = '50'] = process.argv.slice(2);
const b = fs.readFileSync(inp); const x = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
let pcm, timeline = '';
if (mode === 'legacy') pcm = legacyDownsample(x, 48000);
else {
  const p = new Pipeline({ sampleRate: 48000, rnnoiseWasm: fs.readFileSync(new URL('../public/vendor/rnnoise.wasm', import.meta.url)), denoise: dn === '1', nearOnly: near === '1', sensitivity: Number(sens) });
  let opens = 0, n = 0;
  for (let i = 0; i < x.length; i += 128) {
    p.push(x.subarray(i, i + 128));
    for (; n < p.frames.length; n++) { opens += p.frames[n].some((v) => v !== 0) ? 1 : 0; if ((n + 1) % 5 === 0) { timeline += opens >= 3 ? '█' : opens ? '▄' : '·'; opens = 0; } }
  }
  p.flush();
  const all = new Int16Array(p.frames.length * 640); p.frames.forEach((f, i) => all.set(f, i * 640)); pcm = all;
  console.error(`floor=${p.floorDb.toFixed(1)}dB ref=${p.refDb.toFixed(1)}dB rnnoise=${!!p.rnn}`);
}
fs.writeFileSync(outp, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
if (timeline) console.error('门限(每格200ms) ' + timeline);

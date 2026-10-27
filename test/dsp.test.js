'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const load = () => import('../public/dsp.mjs');
const SR = 48000;
// 40ms 粒度的合成信号：幅度 a 的 220Hz 调制音（无 RNNoise 时只看电平）
function tone(sec, db) {
  const a = Math.sqrt(2) * 10 ** (db / 20), n = Math.round(sec * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * 220 * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * i / SR));
  return x;
}
function run(p, x) { for (let i = 0; i < x.length; i += 128) p.push(x.subarray(i, i + 128)); p.flush(); return p.frames; }
const energy = (fr) => fr.reduce((s, v) => s + v * v, 0);

test('时间轴不变：输出帧数 = 输入时长 / 40ms（门限开或关都送帧）', async () => {
  const { Pipeline } = await load();
  const p = new Pipeline({ sampleRate: SR, denoise: false, nearOnly: true, sensitivity: 50 });
  const frames = run(p, tone(3, -60));
  assert.ok(Math.abs(frames.length - 75) <= 1, `frames=${frames.length}`);
  assert.ok(frames.every((f) => f.length === 640));
});

test('近讲门限：远处小声被静音，主讲人大声放行，且预卷保住句首', async () => {
  const { Pipeline } = await load();
  const p = new Pipeline({ sampleRate: SR, denoise: false, nearOnly: true, sensitivity: 50 });
  const x = new Float32Array(SR * 6);
  x.set(tone(2, -42), 0);            // 0-2s 远处人声（-42dBFS）
  x.set(tone(2, -18), SR * 3);       // 3-5s 主讲人（-18dBFS）
  const fr = run(p, x);
  const far = fr.slice(22, 50).reduce((s, f) => s + energy(f), 0);
  const main = fr.slice(78, 124).filter((f) => energy(f) > 0).length;
  assert.strictEqual(far, 0, '远处人声应被静音');
  assert.ok(main >= 44, `主讲人帧应几乎全部放行（${main}/46）`);
  assert.ok(energy(fr[75]) > 0 || energy(fr[76]) > 0, '起始帧应通过预卷补发');
});

test('关闭近讲过滤时全部放行', async () => {
  const { Pipeline } = await load();
  const p = new Pipeline({ sampleRate: SR, denoise: false, nearOnly: false, sensitivity: 50 });
  const fr = run(p, tone(1, -42));
  assert.ok(fr.slice(2).every((f) => energy(f) > 0));
});

test('RNNoise wasm 可加载并返回语音概率', async () => {
  const { RNNoise } = await load();
  const r = new RNNoise(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'rnnoise.wasm')));
  const v = r.process(new Float32Array(480));
  assert.ok(v >= 0 && v <= 1);
});

test('会话热词 dhw 格式与 1024 字节上限', () => {
  const xf = require('../server/xfyun');
  process.env.XFYUN_HOTWORDS = '屯溪|歙县, 毛豆腐';
  assert.strictEqual(xf.hotwords(), 'utf-8;屯溪|歙县|毛豆腐');
  assert.strictEqual(JSON.parse(xf.audioFrame('a', 0, Buffer.alloc(2), 0)).parameter.iat.dhw, 'utf-8;屯溪|歙县|毛豆腐');
  process.env.XFYUN_HOTWORDS = Array.from({ length: 400 }, (_, i) => '热词' + i).join('|');
  assert.ok(Buffer.byteLength(xf.hotwords()) <= 1024);
  delete process.env.XFYUN_HOTWORDS;
  assert.strictEqual(JSON.parse(xf.audioFrame('a', 0, Buffer.alloc(2), 0)).parameter.iat.dhw, undefined);
});

test('wpgs 典型序列：apd/rpl 交替不丢字不重字', () => {
  const xf = require('../server/xfyun');
  const a = new xf.PgsAssembler();
  a.apply({ sn: 1, pgs: 'apd', text: '今天' });
  a.apply({ sn: 2, pgs: 'rpl', rg: [1, 1], text: '今天天气' });
  a.apply({ sn: 3, pgs: 'apd', text: '很好，' });
  a.apply({ sn: 4, pgs: 'rpl', rg: [3, 3], text: '很好。' });
  assert.strictEqual(a.apply({ sn: 5, pgs: 'apd', text: '我们' }), '今天天气很好。我们');
  assert.strictEqual(a.apply({ sn: 6, pgs: 'rpl', rg: [2, 5], text: '今天天气不错，我们走吧' }), '今天天气不错，我们走吧');
});

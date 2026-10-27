'use strict';
const test = require('node:test');
const assert = require('node:assert');
const xf = require('../server/xfyun');

test('签名与官方文档示例一致（APISecret=secretxxxxxxxx2df7900c09xxxxxxxx, date=Tue, 14 May 2024 08:46:48 GMT）', () => {
  // 文档示例 signature=S66FeqTJlvkd+KfJg+a73BAabocwRg2scKflONI8o80=（示例使用 host iat.xf-yun.com、GET /v1）
  assert.strictEqual(xf.signature('iat.xf-yun.com', 'Tue, 14 May 2024 08:46:48 GMT', '/v1', 'secretxxxxxxxx2df7900c09xxxxxxxx'),
    'S66FeqTJlvkd+KfJg+a73BAabocwRg2scKflONI8o80=');
});

test('authorization 原文格式与文档示例一致', () => {
  const a = Buffer.from(xf.authorization('a1d6746dd1bb19f19d59205ad0007464', 'D6EC1BDy9Z9vcTjtNyim0zsEf/KALHBh5NSqaW01CIo='), 'base64').toString();
  // 文档示例 URL 中 authorization 解码后的原文
  const doc = Buffer.from('YXBpX2tleT0iYTFkNjc0NmRkMWJiMTlmMTlkNTkyMDVhZDAwMDc0NjQiLCBhbGdvcml0aG09ImhtYWMtc2hhMjU2IiwgaGVhZGVycz0iaG9zdCBkYXRlIHJlcXVlc3QtbGluZSIsIHNpZ25hdHVyZT0iRDZFQzFCRHk5Wjl2Y1RqdE55aW0wenNFZi9LQUxIQmg1TlNxYVcwMUNJbz0i', 'base64').toString();
  assert.strictEqual(a, doc);
});

test('buildAuthUrl：host/date/authorization 齐全，签名可复算，不含 secret', () => {
  const now = new Date('2024-05-14T08:46:48Z');
  const url = new URL(xf.buildAuthUrl({ apiKey: 'k', apiSecret: 'secret-value' }, now, 'wss://iat.cn-huabei-1.xf-yun.com/v1'));
  assert.strictEqual(url.searchParams.get('host'), 'iat.cn-huabei-1.xf-yun.com');
  assert.strictEqual(url.searchParams.get('date'), 'Tue, 14 May 2024 08:46:48 GMT');
  const auth = Buffer.from(url.searchParams.get('authorization'), 'base64').toString();
  const sig = xf.signature('iat.cn-huabei-1.xf-yun.com', 'Tue, 14 May 2024 08:46:48 GMT', '/v1', 'secret-value');
  assert.ok(auth.includes(`signature="${sig}"`) && auth.startsWith('api_key="k"'));
  assert.ok(!url.toString().includes('secret-value'));
});

test('首帧带方言免切/流式修正参数，后续帧不带 parameter', () => {
  const f0 = JSON.parse(xf.audioFrame('app', 0, Buffer.alloc(1280), 0));
  assert.deepStrictEqual([f0.header.status, f0.parameter.iat.accent, f0.parameter.iat.domain, f0.parameter.iat.dwa], [0, 'mulacc', 'slm', 'wpgs']);
  assert.strictEqual(Buffer.from(f0.payload.audio.audio, 'base64').length, 1280);
  const f1 = JSON.parse(xf.audioFrame('app', 1, Buffer.alloc(1280), 1));
  assert.strictEqual(f1.parameter, undefined);
  const f2 = JSON.parse(xf.audioFrame('app', 2, null, 2));
  assert.deepStrictEqual([f2.header.status, f2.payload.audio.audio], [2, '']);
});

test('wpgs 动态修正：apd 追加、rpl 按 rg 替换', () => {
  const a = new xf.PgsAssembler();
  assert.strictEqual(a.apply({ sn: 1, pgs: 'apd', text: '今天' }), '今天');
  assert.strictEqual(a.apply({ sn: 2, pgs: 'rpl', rg: [1, 1], text: '今天天气' }), '今天天气');
  assert.strictEqual(a.apply({ sn: 3, pgs: 'apd', text: '很好。' }), '今天天气很好。');
  assert.strictEqual(a.apply({ sn: 4, pgs: 'rpl', rg: [2, 3], text: '今天天气真好。' }), '今天天气真好。');
});

test('parseMessage：解析 base64 结果与错误码', () => {
  const inner = { sn: 1, ls: true, pgs: 'apd', ws: [{ cw: [{ w: '科大讯飞' }] }, { cw: [{ w: '。' }] }] };
  const m = xf.parseMessage(JSON.stringify({ header: { code: 0, sid: 's', status: 2 }, payload: { result: { text: Buffer.from(JSON.stringify(inner)).toString('base64') } } }));
  assert.deepStrictEqual([m.code, m.status, m.result.text, m.result.ls], [0, 2, '科大讯飞。', true]);
  const e = xf.parseMessage(JSON.stringify({ header: { code: 11200, message: 'auth no license' } }));
  assert.strictEqual(e.code, 11200);
  assert.ok(xf.ERROR_HINTS[11200]);
});

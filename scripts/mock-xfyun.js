// 本地 mock：模拟讯飞方言识别大模型（slm）协议，用于无额度/离线联调。
// 用法：node scripts/mock-xfyun.js  然后  XFYUN_ENDPOINT=ws://localhost:9000/v1 XFYUN_APPID=x XFYUN_API_KEY=x XFYUN_API_SECRET=x npm start
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: Number(process.env.MOCK_PORT || 9000) });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
wss.on('connection', (ws) => {
  let sn = 0, frames = 0;
  const send = (status, words, pgs) => ws.send(JSON.stringify({
    header: { code: 0, message: 'success', sid: 'mock', status },
    payload: { result: { status, text: b64({ sn: ++sn, ls: status === 2, pgs, rg: pgs === 'rpl' ? [sn - 1, sn - 1] : undefined, ws: [{ cw: [{ w: words }] }] }) } },
  }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    frames++;
    if (frames % 10 === 0) send(1, `模拟识别${frames / 10}`, 'apd');
    if (m.header.status === 2) { send(2, '。', 'apd'); ws.close(); }
  });
});
console.log('mock xfyun slm on ws://localhost:' + (process.env.MOCK_PORT || 9000) + '/v1');

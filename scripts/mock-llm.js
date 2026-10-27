// 本地 mock：OpenAI 兼容 /v1/chat/completions，按术语表做简单同音纠错 + 少量表情 + 话题分段，用于联调（不代表真实模型效果）
const http = require('http');
const FIX = [['吞溪', '屯溪'], ['臭桂鱼', '臭鳜鱼'], ['黑县', '黟县'], ['设县', '歙县'], ['会意', '会议']];
http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const msgs = JSON.parse(b).messages; const u = msgs[1].content;
    const items = JSON.parse(u.slice(u.indexOf('待校对句子：') + 6));
    const out = items.map((it) => { let t = it.text; for (const [a, c] of FIX) t = t.split(a).join(c);
      if (/高兴|太好了|恭喜/.test(t)) t += '😄'; return { id: it.id, text: t, newPara: /^(另外|对了|说到)/.test(t) }; });
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] })); }, 600);
  });
}).listen(Number(process.env.MOCK_LLM_PORT || 9100), () => console.log('mock llm on :' + (process.env.MOCK_LLM_PORT || 9100)));

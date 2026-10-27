import * as T from './textrules.mjs';
{
  const $ = (id) => document.getElementById(id);
  const startBtn = $('start'), stopBtn = $('stop'), clearBtn = $('clear');
  const finalsEl = $('finals'), errorEl = $('error'), metaEl = $('meta'), ph = $('ph');
  const optDenoise = $('optDenoise'), optNear = $('optNear'), sens = $('sens');
  const optPara = $('optPara'), optEmoji = $('optEmoji'), optPolish = $('optPolish'), polishNote = $('polishNote');
  const meterBar = $('meterBar'), meterThr = $('meterThr'), gateText = $('gateText');

  let ws = null, ctx = null, stream = null, node = null, source = null, mute = null;
  let tStart = 0, firstResultAt = 0, wasmBytes = null;

  // 设置：本地保存
  const saved = JSON.parse(localStorage.getItem('asr-settings') || '{}');
  if ('denoise' in saved) optDenoise.checked = saved.denoise;
  if ('nearOnly' in saved) optNear.checked = saved.nearOnly;
  if ('sensitivity' in saved) sens.value = saved.sensitivity;
  for (const [k, el] of [['para', optPara], ['emoji', optEmoji], ['polish', optPolish]]) if (k in saved) el.checked = saved[k];
  $('sensVal').textContent = sens.value;
  const settings = () => ({ denoise: optDenoise.checked, nearOnly: optNear.checked, sensitivity: Number(sens.value), para: optPara.checked, emoji: optEmoji.checked, polish: optPolish.checked });
  function onSettings() {
    $('sensVal').textContent = sens.value;
    localStorage.setItem('asr-settings', JSON.stringify(settings()));
    if (node) node.port.postMessage({ type: 'set', ...settings() }); // 录音中实时生效
    if (stream) { // 浏览器自带处理：开了 RNNoise 就关掉系统降噪（避免叠加失真）；近讲模式关掉自动增益（保留远近音量差）
      const t = stream.getAudioTracks()[0];
      t && t.applyConstraints && t.applyConstraints(constraints()).catch(() => {});
    }
  }
  [optDenoise, optNear].forEach((el) => (el.onchange = onSettings)); sens.oninput = onSettings;
  [optPara, optEmoji, optPolish].forEach((el) => (el.onchange = () => { onSettings(); render(); if (optPolish.checked) schedulePolish(sentences.filter((x) => !x.polishedAt).map((x) => x.id)); }));
  const constraints = () => ({ channelCount: 1, echoCancellation: true, noiseSuppression: !optDenoise.checked, autoGainControl: !optNear.checked });

  // ---------- 文本模型：句子 → 段落（规则层即时，LLM 层异步覆盖） ----------
  const sentences = []; // {id, raw, ruleEmoji, breakRule, polished?, llmEmoji?, breakLLM?, polishedAt?, pending?, fresh?}
  let partial = '', curSeg = null, segGap = 0, lastActivity = 0, nextId = 1, view = 'pol';
  let kb = T.parseKB(localStorage.getItem('asr-kb') || '');
  function addFinal(text, gapMs) {
    const parts = T.splitSentences(text);
    parts.forEach((raw, i) => {
      // 当前段落统计（按规则分段结果）
      let count = 0, chars = 0;
      for (let k = sentences.length - 1; k >= 0; k--) { count++; chars += sentences[k].raw.length; if (sentences[k].breakRule) break; }
      const recent = sentences.slice(-2).some((x) => x.ruleEmoji);
      sentences.push({ id: nextId++, raw, ruleEmoji: T.ruleEmoji(raw, recent), breakRule: T.ruleBreak(raw, { count, chars }, { gapMs: i === 0 ? gapMs : 0 }) });
    });
    render();
    schedulePolish(sentences.slice(-parts.length).map((x) => x.id));
  }
  const textOf = (x) => {
    const base = view === 'pol' ? (x.polished != null ? x.polished : T.applyFixes(x.raw, kb.fixes)) : x.raw;
    const emo = !optEmoji.checked ? '' : view === 'pol' && x.llmEmoji !== undefined ? x.llmEmoji : x.ruleEmoji;
    return T.withEmoji(base, emo);
  };
  const isBreak = (x, i) => i > 0 && optPara.checked && (x.breakLLM != null ? x.breakLLM : x.breakRule);
  function render() {
    finalsEl.textContent = '';
    let p = document.createElement('p'); finalsEl.appendChild(p);
    sentences.forEach((x, i) => {
      if (isBreak(x, i)) { p = document.createElement('p'); finalsEl.appendChild(p); }
      const sp = document.createElement('span'); sp.className = 's' + (x.fresh && view === 'pol' ? ' fresh' : '') + (x.pending && view === 'pol' ? ' pending' : '');
      sp.textContent = textOf(x); p.appendChild(sp);
    });
    const ps = document.createElement('span'); ps.id = 'partial'; ps.textContent = partial; p.appendChild(ps);
    // 平滑替换：高亮 1 帧后淡出
    if (sentences.some((x) => x.fresh)) requestAnimationFrame(() => setTimeout(() => { sentences.forEach((x) => (x.fresh = false)); finalsEl.querySelectorAll('.s.fresh').forEach((el) => el.classList.remove('fresh')); }, 50));
  }
  const fullText = () => [...finalsEl.querySelectorAll('p')].map((p) => [...p.querySelectorAll('.s')].map((s) => s.textContent).join('')).filter(Boolean).join('\n\n');
  $('viewRaw').onclick = () => { view = 'raw'; $('viewRaw').className = 'on'; $('viewPol').className = ''; render(); };
  $('viewPol').onclick = () => { view = 'pol'; $('viewPol').className = 'on'; $('viewRaw').className = ''; render(); };
  $('copy').onclick = async () => {
    const t = fullText(); if (!t) return;
    try { await navigator.clipboard.writeText(t); } catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    $('copy').textContent = '已复制 ✓'; setTimeout(() => ($('copy').textContent = '复制全文'), 1500);
  };

  // ---------- LLM 润色队列：按句合并（≤4 句 或 1.2s），单连接串行，超时/失败保留原文 ----------
  const queue = []; let polishTimer = null, inflight = false, llmDownUntil = 0;
  function schedulePolish(ids) {
    if (!optPolish.checked) return;
    for (const id of ids) if (!queue.includes(id)) queue.push(id);
    clearTimeout(polishTimer);
    if (queue.length >= 4) flushPolish(); else polishTimer = setTimeout(flushPolish, 1200);
  }
  async function flushPolish(force) {
    if (inflight || !queue.length || !optPolish.checked) return;
    if (Date.now() < llmDownUntil) { queue.length = 0; return; }
    const batch = queue.splice(0, 4).map((id) => sentences.find((x) => x.id === id)).filter(Boolean);
    if (!batch.length) return;
    inflight = true; batch.forEach((x) => (x.pending = true)); render();
    const joined = batch.map((x) => x.raw).join('');
    const firstIdx = sentences.indexOf(batch[0]);
    const before = sentences.slice(Math.max(0, firstIdx - 2), firstIdx).map((x) => x.polished || x.raw).join('');
    const body = { items: batch.map((x) => ({ id: x.id, text: T.applyFixes(x.raw, kb.fixes) })), terms: T.relevantTerms(kb.terms, joined), refs: T.searchBM25(kb.index, joined, 2).map((r) => r.text),
      before, emoji: optEmoji.checked, para: optPara.checked };
    const t0 = performance.now(); let r = null;
    try {
      const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 15000);
      const resp = await fetch('api/polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      clearTimeout(tm); r = await resp.json();
    } catch { r = { fallback: true, reason: '网络/超时' }; }
    const ms = Math.round(performance.now() - t0);
    batch.forEach((x) => { x.pending = false; x.polishedAt = Date.now(); });
    if (r && r.results) {
      for (const res of r.results) {
        const x = batch.find((b) => String(b.id) === String(res.id)); if (!x || !res.text) continue;
        if (!T.acceptablePolish(x.raw, res.text)) continue; // 改动过大 → 视为改写，保留原文
        const emos = res.text.match(T.EMOJI_RE) || [];
        x.polished = T.stripEmoji(res.text).trim(); x.llmEmoji = body.emoji ? (emos[0] || '') : undefined;
        if (body.para && sentences.indexOf(x) > 0) x.breakLLM = !!res.newPara;
        x.fresh = x.polished !== T.applyFixes(x.raw, kb.fixes);
      }
      polishNote.textContent = `AI 润色：${r.provider || ''} ${r.ms || ms}ms`;
    } else {
      polishNote.textContent = `AI 润色不可用（${(r && r.reason) || '未知'}），已用规则层`;
      if (r && /未配置|不可用|11200|未授权/.test(r.reason || '')) llmDownUntil = Date.now() + 60000;
    }
    inflight = false; render();
    if (queue.length) setTimeout(flushPolish, force ? 0 : 200);
  }

  // ---------- 知识库（本机保存） ----------
  const kbEl = $('kb'), kbInfo = $('kbInfo');
  kbEl.value = localStorage.getItem('asr-kb') || '';
  const kbSummary = () => (kbInfo.textContent = kbEl.value.trim() ? `已解析：术语 ${kb.terms.length} 个，纠错 ${kb.fixes.length} 条，资料片段 ${kb.chunks.length} 段` : '未填写');
  kbSummary();
  $('kbSave').onclick = () => {
    if (kbEl.value.length > 200000) return (kbInfo.textContent = '内容过长（上限 20 万字）');
    localStorage.setItem('asr-kb', kbEl.value); kb = T.parseKB(kbEl.value); kbSummary(); render();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hot', words: T.hotwordList(kb.terms) }));
  };
  window.__asr = { sentences, addFinal, fullText, setView: (v) => (v === 'raw' ? $('viewRaw') : $('viewPol')).click() }; // 自测用

  function setStatus(text, cls) { $('statusText').textContent = text; $('dot').className = cls || ''; }
  function showError(msg) { errorEl.textContent = msg || ''; if (msg) setStatus('出错', 'err'); }
  // dBFS(-70..0) → 百分比
  const pct = (db) => Math.max(0, Math.min(100, (db + 70) / 70 * 100));
  function meter(m) {
    window.__meter = m; // 调试/自测用
    meterBar.style.width = pct(m.level) + '%';
    meterBar.className = m.open ? 'on' : '';
    if (m.thr !== null && !m.calibrating) { meterThr.style.display = 'block'; meterThr.style.left = pct(m.thr) + '%'; } else meterThr.style.display = 'none';
    gateText.textContent = m.calibrating ? '校准环境中…（约 1 秒，可以直接开始说话）' : m.thr === null ? '收音中（未开启近讲过滤）' : m.open ? '● 正在收音（主讲人）' : '○ 已忽略（声音太远/太小或非人声）';
  }

  async function loadWasm() {
    if (wasmBytes) return wasmBytes.slice(0);
    try { const r = await fetch('vendor/rnnoise.wasm'); if (r.ok) wasmBytes = await r.arrayBuffer(); } catch {}
    return wasmBytes ? wasmBytes.slice(0) : null;
  }

  async function start() {
    showError('');
    if (!window.isSecureContext) return showError('麦克风需要 HTTPS（或 localhost）访问本页面。');
    if (!navigator.mediaDevices || !window.AudioWorkletNode) return showError('当前浏览器不支持录音（需要 getUserMedia + AudioWorklet）。');
    startBtn.disabled = true; setStatus('请求麦克风…', 'busy');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints() });
    } catch (e) { startBtn.disabled = false; return showError('无法使用麦克风：' + (e.name === 'NotAllowedError' ? '权限被拒绝' : e.message)); }

    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ sampleRate: 48000 }); } catch { ctx = new AC(); } // RNNoise 需要 48kHz
    await ctx.resume(); // iOS 需要在用户手势里 resume
    try {
      const wasm = await loadWasm();
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'pcm-capture', { processorOptions: { wasm, ...settings() } });
    } catch (e) { stopCapture(); startBtn.disabled = false; return showError('音频处理初始化失败（浏览器版本过旧？建议 iOS 15+/Chrome 90+）：' + e.message); }
    mute = ctx.createGain(); mute.gain.value = 0; // 让图保持运行但不外放
    source.connect(node).connect(mute).connect(ctx.destination);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/asr`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { const words = T.hotwordList(kb.terms); if (words.length) ws.send(JSON.stringify({ type: 'hot', words })); };
    curSeg = null; lastActivity = 0;
    setStatus('连接识别服务…', 'busy');
    tStart = performance.now(); firstResultAt = 0;

    node.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); return; }
      if (d.type === 'meter') meter(d);
      else if (d.type === 'init' && optDenoise.checked && !d.rnnoise) metaEl.textContent = `RNNoise 不可用（采样率 ${d.sampleRate}Hz${d.rnnError ? '，' + d.rnnError : ''}），已改用系统降噪`;
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'status') {
        if (m.status === 'ready') setStatus('识别中（自动识别方言）', 'ready');
        if (m.status === 'done') { setStatus('已结束'); teardown(); }
      } else if (m.type === 'partial' || m.type === 'final') {
        if (!firstResultAt && m.text) { firstResultAt = performance.now(); metaEl.textContent = `首个结果：${Math.round(firstResultAt - tStart)} ms（从开始录音算起）`; }
        ph.style.display = 'none';
        if (m.seg !== curSeg) { curSeg = m.seg; segGap = lastActivity ? performance.now() - lastActivity : 0; }
        lastActivity = performance.now();
        if (m.type === 'final') { partial = ''; addFinal(m.text, segGap); segGap = 0; }
        else { partial = m.text; render(); }
        window.scrollTo(0, document.body.scrollHeight);
      } else if (m.type === 'error') {
        showError(`[${m.code}] ${m.message}`); teardown();
      } else if (m.type === 'info') metaEl.textContent = m.message;
    };
    ws.onerror = () => showError('与服务端的连接出错');
    ws.onclose = () => { if (stopBtn.disabled === false) setStatus('连接已关闭'); teardown(); };
    stopBtn.disabled = false;
  }

  function stopCapture() {
    try { source && source.disconnect(); node && node.disconnect(); mute && mute.disconnect(); } catch {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = node = source = mute = null;
    meterBar.style.width = '0'; meterThr.style.display = 'none';
  }
  function stop() {
    stopCapture();
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'stop' })); setStatus('等待最终结果…', 'busy'); }
    stopBtn.disabled = true;
  }
  function teardown() {
    stopCapture();
    if (ws) { ws.onclose = null; if (ws.readyState <= 1) ws.close(); ws = null; }
    // 未确认的中间结果保留为正式文本，避免丢字
    if (partial) { const t = partial; partial = ''; addFinal(t, 0); }
    flushPolish(true);
    startBtn.disabled = false; stopBtn.disabled = true;
  }

  startBtn.onclick = start; stopBtn.onclick = stop;
  clearBtn.onclick = () => { sentences.length = 0; queue.length = 0; partial = ''; render(); metaEl.textContent = ''; showError(''); polishNote.textContent = ''; ph.style.display = ''; };
}

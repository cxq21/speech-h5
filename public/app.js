(() => {
  const $ = (id) => document.getElementById(id);
  const startBtn = $('start'), stopBtn = $('stop'), clearBtn = $('clear');
  const finalsEl = $('finals'), partialEl = $('partial'), errorEl = $('error'), metaEl = $('meta'), ph = $('ph');
  const optDenoise = $('optDenoise'), optNear = $('optNear'), sens = $('sens');
  const meterBar = $('meterBar'), meterThr = $('meterThr'), gateText = $('gateText');

  let ws = null, ctx = null, stream = null, node = null, source = null, mute = null;
  let tStart = 0, firstResultAt = 0, wasmBytes = null;

  // 设置：本地保存
  const saved = JSON.parse(localStorage.getItem('asr-settings') || '{}');
  if ('denoise' in saved) optDenoise.checked = saved.denoise;
  if ('nearOnly' in saved) optNear.checked = saved.nearOnly;
  if ('sensitivity' in saved) sens.value = saved.sensitivity;
  $('sensVal').textContent = sens.value;
  const settings = () => ({ denoise: optDenoise.checked, nearOnly: optNear.checked, sensitivity: Number(sens.value) });
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
  const constraints = () => ({ channelCount: 1, echoCancellation: true, noiseSuppression: !optDenoise.checked, autoGainControl: !optNear.checked });

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
        if (m.type === 'final') { finalsEl.textContent += m.text; partialEl.textContent = ''; }
        else partialEl.textContent = m.text;
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
    if (partialEl.textContent) { finalsEl.textContent += partialEl.textContent; partialEl.textContent = ''; }
    startBtn.disabled = false; stopBtn.disabled = true;
  }

  startBtn.onclick = start; stopBtn.onclick = stop;
  clearBtn.onclick = () => { finalsEl.textContent = ''; partialEl.textContent = ''; metaEl.textContent = ''; showError(''); };
})();

(() => {
  const $ = (id) => document.getElementById(id);
  const startBtn = $('start'), stopBtn = $('stop'), clearBtn = $('clear');
  const finalsEl = $('finals'), partialEl = $('partial'), errorEl = $('error'), metaEl = $('meta'), ph = $('ph');

  let ws = null, ctx = null, stream = null, node = null, source = null;
  let tStart = 0, firstResultAt = 0;

  function setStatus(text, cls) { $('statusText').textContent = text; $('dot').className = cls || ''; }
  function showError(msg) { errorEl.textContent = msg || ''; if (msg) setStatus('出错', 'err'); }

  async function start() {
    showError('');
    if (!window.isSecureContext) return showError('麦克风需要 HTTPS（或 localhost）访问本页面。');
    if (!navigator.mediaDevices || !window.AudioWorkletNode) return showError('当前浏览器不支持录音（需要 getUserMedia + AudioWorklet）。');
    startBtn.disabled = true; setStatus('请求麦克风…', 'busy');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { startBtn.disabled = false; return showError('无法使用麦克风：' + (e.name === 'NotAllowedError' ? '权限被拒绝' : e.message)); }

    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume(); // iOS 需要在用户手势里 resume
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-capture');
    const mute = ctx.createGain(); mute.gain.value = 0; // 让图保持运行但不外放
    source.connect(node).connect(mute).connect(ctx.destination);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/asr`);
    ws.binaryType = 'arraybuffer';
    setStatus('连接识别服务…', 'busy');
    tStart = performance.now(); firstResultAt = 0;

    node.port.onmessage = (e) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data); };
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
    try { source && source.disconnect(); node && node.disconnect(); } catch {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = node = source = null;
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

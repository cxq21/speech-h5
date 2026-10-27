// 前端音频处理核心（AudioWorklet 与 Node 测试共用，无 DOM 依赖）
// 链路：高通 100Hz → [RNNoise 降噪, 仅 48kHz] → 抗混叠低通 + 重采样 16kHz → 近讲人门限（自适应底噪 + 主讲人电平参考 + RNNoise VAD）→ 40ms Int16 帧
export const OUT_RATE = 16000, FRAME = 640; // 640 样本 = 40ms = 1280 字节

// ---------- RNNoise（@jitsi/rnnoise-wasm 的 wasm，导入仅 2 个：resize_heap / memcpy_big） ----------
export class RNNoise {
  constructor(wasmBytes) {
    let mem;
    const env = {
      a: (req) => { // emscripten_resize_heap
        const old = mem.buffer.byteLength; if (req <= old) return true;
        try { mem.grow(Math.ceil((req - old) / 65536)); return true; } catch { return false; }
      },
      b: (d, s, n) => { new Uint8Array(mem.buffer).copyWithin(d, s, s + n); }, // emscripten_memcpy_big
    };
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), { a: env });
    const x = inst.exports; mem = x.c;
    x.d(); // __wasm_call_ctors
    this.x = x; this.st = x.f(0); // rnnoise_create(NULL)
    this.ptr = x.g(480 * 4);      // malloc：输入输出共用（rnnoise 支持就地处理）
  }
  // 480 个样本（48kHz/10ms），float，幅度按 int16 量级；返回该帧语音概率 0..1
  process(frame) {
    const heap = new Float32Array(this.x.c.buffer, this.ptr, 480);
    for (let i = 0; i < 480; i++) heap[i] = frame[i] * 32768;
    const vad = this.x.j(this.st, this.ptr, this.ptr);
    const out = new Float32Array(this.x.c.buffer, this.ptr, 480);
    for (let i = 0; i < 480; i++) frame[i] = out[i] / 32768;
    return vad;
  }
}

// RBJ 二阶高通
function highpass(sr, f0 = 100, q = 0.707) {
  const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - a) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

// 加窗 sinc 低通 + 线性插值重采样（任意输入采样率 → 16k）
class Resampler {
  constructor(sr) {
    this.ratio = sr / OUT_RATE;
    const N = sr > OUT_RATE ? 63 : 1, fc = Math.min(7000, sr * 0.45) / sr;
    this.h = new Float32Array(N); let sum = 0;
    for (let i = 0; i < N; i++) {
      const m = i - (N - 1) / 2, sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1 || 1)) + 0.08 * Math.cos(4 * Math.PI * i / (N - 1 || 1));
      this.h[i] = N === 1 ? 1 : sinc * win; sum += this.h[i];
    }
    for (let i = 0; i < N; i++) this.h[i] /= sum;
    this.buf = new Float32Array(1 << 14); this.len = 0; this.pos = N - 1; // pos：下一个输出对应的输入位置（相对 buf 起点）
  }
  fir(i) { const h = this.h, N = h.length, b = this.buf; let s = 0; for (let k = 0; k < N; k++) s += h[k] * b[i - k]; return s; }
  push(x, out) {
    if (this.len + x.length > this.buf.length) { const nb = new Float32Array((this.len + x.length) * 2); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; }
    this.buf.set(x, this.len); this.len += x.length;
    while (this.pos + 1 < this.len) {
      const i = Math.floor(this.pos), t = this.pos - i;
      out.push(t === 0 ? this.fir(i) : this.fir(i) * (1 - t) + this.fir(i + 1) * t);
      this.pos += this.ratio;
    }
    const keep = this.h.length, drop = Math.floor(this.pos) - keep + 1;
    if (drop > 0) { this.buf.copyWithin(0, drop, this.len); this.len -= drop; this.pos -= drop; }
  }
}

// 灵敏度 0..100（默认 50）→ 门限参数（默认值由合成多人场景离线扫参得到，见 README）
export function gateParams(sens = 50) {
  const s = Math.max(0, Math.min(100, sens));
  return {
    absMinDb: -23 - 0.2 * s,   // 绝对电平下限 dBFS（50 → -33）：主讲人电平未学到之前的主要依据
    openDb: 3 + 0.04 * s,      // 打开：平滑电平 ≥ 主讲人参考 - openDb（50 → 5dB）
    keepDb: 12,                // 维持：平滑电平 ≥ 主讲人参考 - keepDb（迟滞，保住主讲人的弱音节）
    bgMarginDb: 10 - 0.04 * s, // 打开还要高于「背景人声电平」+ 该值（50 → 8dB）
    vadMin: 0.4,               // RNNoise 语音概率下限
  };
}
const CAL_FRAMES = 20, HANG = 12, PREROLL = 7, WIN = 5; // 校准 0.8s；拖尾 480ms；预卷 280ms；平滑窗 200ms

export class Pipeline {
  // opts: { sampleRate, rnnoiseWasm?: ArrayBuffer, denoise, nearOnly, sensitivity }
  constructor(opts) {
    this.sr = opts.sampleRate;
    this.hp = highpass(this.sr);
    this.rs = new Resampler(this.sr);
    this.rnn = null;
    if (opts.rnnoiseWasm && this.sr === 48000) { try { this.rnn = new RNNoise(opts.rnnoiseWasm); } catch (e) { this.rnnError = String(e); } }
    this.rnnBuf = new Float32Array(480); this.rnnN = 0;
    this.out16 = []; this.vadAcc = 0; this.vadCnt = 0; this.vadQ = [];
    this.frames = [];                   // 输出：Int16Array(640) 列表
    this.set(opts);
    // 门限状态
    this.floorDb = null; this.refDb = -100; this.hits = 0; this.bgDb = -100; this.win = []; this.thr = 0; this.nFrames = 0;
    this.open = false; this.hang = 0; this.preroll = []; this.lastLevel = -100; this.lastVad = null;
  }
  set(o) {
    if ('denoise' in o) this.denoise = !!o.denoise;
    if ('nearOnly' in o) this.nearOnly = !!o.nearOnly;
    if ('sensitivity' in o) { this.sens = Number(o.sensitivity); this.p = gateParams(this.sens); }
  }
  get calibrating() { return this.nearOnly && this.nFrames <= CAL_FRAMES; }

  // 输入任意长度 Float32 单声道样本；产出的 16k 帧放入 this.frames
  push(input) {
    const tmp = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) tmp[i] = this.hp(input[i]);
    if (this.rnn) {
      // RNNoise 始终运行（保持状态连续 + 提供 VAD），关闭降噪时只用 VAD、输出原声
      const outChunk = [];
      for (let i = 0; i < tmp.length; i++) {
        this.rnnBuf[this.rnnN++] = tmp[i];
        if (this.rnnN === 480) {
          const orig = this.denoise ? null : this.rnnBuf.slice();
          const vad = this.rnn.process(this.rnnBuf);
          const res = orig || this.rnnBuf;
          for (let k = 0; k < 480; k++) outChunk.push(res[k]);
          this.vadQ.push(vad); this.rnnN = 0;
        }
      }
      this.resample(Float32Array.from(outChunk));
    } else this.resample(tmp);
  }
  resample(x) {
    const out = [];
    this.rs.push(x, out);
    for (const v of out) {
      this.out16.push(v);
      if (this.out16.length === FRAME) { this.onFrame(Float32Array.from(this.out16)); this.out16 = []; }
    }
  }
  onFrame(f) {
    let e = 0; for (let i = 0; i < FRAME; i++) e += f[i] * f[i];
    const level = 10 * Math.log10(e / FRAME + 1e-12);           // dBFS（满幅正弦 ≈ -3dB）
    let vad = null;
    if (this.rnn) { const q = this.vadQ.splice(0, 4); vad = q.length ? Math.max(...q) : 0; } // 40ms ≈ 4 个 10ms RNNoise 帧
    this.nFrames++;
    // 平滑电平（200ms 能量均值）：主讲人音节密集、电平高；远处/旁人声音平均更低
    this.win.push(e / FRAME + 1e-12); if (this.win.length > WIN) this.win.shift();
    const ls = 10 * Math.log10(this.win.reduce((x, y) => x + y) / this.win.length);
    this.lastLevel = ls; this.lastVad = vad;
    if (this.floorDb === null) this.floorDb = level;
    else this.floorDb += level < this.floorDb ? (level - this.floorDb) * 0.3 : Math.min(level - this.floorDb, 0.04);

    const i16 = toInt16(f);
    if (!this.nearOnly) { this.open = true; this.frames.push(i16); return; }

    const p = this.p, voiced = vad === null || vad >= p.vadMin;
    const calibrating = this.nFrames <= CAL_FRAMES;
    if (calibrating) {
      // 校准期：门限保持关闭，学习背景人声电平；音频全部暂存为预卷（用户立刻开口也不丢句首）
      if (voiced) this.bgDb = Math.max(this.bgDb, Math.min(ls - 3, p.absMinDb + 3));
    } else {
      const thrOpen = Math.max(p.absMinDb, this.refDb - p.openDb, this.bgDb + p.bgMarginDb);
      const thrKeep = Math.max(p.absMinDb - 3, this.refDb - p.keepDb);
      const openHit = voiced && ls >= thrOpen;
      this.thr = thrOpen;
      this.hits = ((this.hits << 1) | (openHit ? 1 : 0)) & 7;
      if (!this.open) {
        if (openHit && ((this.hits & 1) + ((this.hits >> 1) & 1) + ((this.hits >> 2) & 1)) >= 2) {
          this.open = true; this.hang = HANG;
          if (this.preroll.length) fade(this.preroll[0], true);
          for (const pf of this.preroll) this.frames.push(pf);   // 补发预卷原声
          this.preroll = [];
        }
      } else if (voiced && ls >= thrKeep) this.hang = HANG;
      else if (--this.hang <= 0) { this.open = false; fade(i16, false); this.frames.push(i16); this.updateBg(ls, voiced); return; }
      // 主讲人参考电平：只从门限打开且达到打开门限的帧学习（快升慢降）
      if (this.open && openHit) this.refDb += ls > this.refDb ? 0.2 * (ls - this.refDb) : 0.01 * (ls - this.refDb);
      this.refDb = Math.max(this.refDb, p.absMinDb + p.openDb);
      this.updateBg(ls, voiced);
    }
    if (this.open) return void this.frames.push(i16);
    this.preroll.push(i16);
    const limit = calibrating ? CAL_FRAMES : PREROLL;
    while (this.preroll.length > limit) { this.preroll.shift(); this.frames.push(new Int16Array(FRAME)); } // 门限关闭：送静音保持时间轴
  }
  // 背景人声电平：门限关闭时的人声帧（旁人说话）慢慢抬高（上限 absMin+3），安静时缓慢回落
  updateBg(ls, voiced) {
    if (this.open || !voiced) return;
    const cap = this.p.absMinDb + 3;
    this.bgDb = ls > this.bgDb ? Math.min(this.bgDb + 0.05 * (ls - this.bgDb), cap) : this.bgDb + 0.005 * (ls - this.bgDb);
  }
  // 结束时把未决预卷以静音补齐（保持时间轴）
  flush() { while (this.preroll.length) { this.preroll.shift(); this.frames.push(new Int16Array(FRAME)); } }
}

function toInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  return o;
}
function fade(fr, inward) { const n = fr.length; for (let i = 0; i < n; i++) fr[i] = Math.round(fr[i] * (inward ? i / n : 1 - i / n)); }

// 旧版链路（对照用）：区间平均降采样、无滤波、无门限
export function legacyDownsample(input, sr) {
  const ratio = sr / OUT_RATE, out = []; let pos = 0;
  while (pos + ratio <= input.length) {
    const s = Math.floor(pos), e = Math.max(s + 1, Math.floor(pos + ratio)); let sum = 0;
    for (let k = s; k < e; k++) sum += input[k];
    out.push(sum / (e - s)); pos += ratio;
  }
  return toInt16(Float32Array.from(out));
}

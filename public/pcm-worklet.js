// AudioWorklet（模块脚本）：调用 dsp.mjs 的处理链路，输出 16kHz Int16 PCM，每帧 640 样本（1280 字节 = 40ms）
import { Pipeline } from './dsp.mjs';

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.p = new Pipeline({ sampleRate, rnnoiseWasm: o.wasm, denoise: o.denoise, nearOnly: o.nearOnly, sensitivity: o.sensitivity });
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'set') this.p.set(e.data); };
    this.port.postMessage({ type: 'init', sampleRate, rnnoise: !!this.p.rnn, rnnError: this.p.rnnError || '' });
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.p.push(ch);
    const fr = this.p.frames;
    for (let i = 0; i < fr.length; i++) {
      this.port.postMessage(fr[i].buffer, [fr[i].buffer]);
      if (++this.n % 3 === 0) { // ~120ms 一次电平表
        const p = this.p;
        this.port.postMessage({ type: 'meter', level: p.lastLevel, thr: p.nearOnly ? p.thr : null, open: p.open, calibrating: p.calibrating, vad: p.lastVad });
      }
    }
    fr.length = 0;
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);

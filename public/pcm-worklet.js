// AudioWorklet：把任意采样率的单声道输入重采样到 16kHz Int16 PCM，按 640 样本（1280 字节 = 40ms）一帧输出
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // sampleRate 为 AudioWorkletGlobalScope 全局量
    this.acc = [];   // 待重采样的浮点样本
    this.pos = 0;    // 在 acc 中的小数读取位置
    this.out = new Int16Array(640);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this.acc.push(ch[i]);
    // 简单的区间平均降采样（抗混叠够用），16k 输入时等价于直通
    while (this.pos + this.ratio <= this.acc.length) {
      const start = Math.floor(this.pos), end = Math.max(start + 1, Math.floor(this.pos + this.ratio));
      let sum = 0; for (let k = start; k < end; k++) sum += this.acc[k];
      let v = sum / (end - start);
      v = Math.max(-1, Math.min(1, v));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.pos += this.ratio;
      if (this.n === 640) { this.port.postMessage(this.out.buffer.slice(0)); this.n = 0; }
    }
    const drop = Math.floor(this.pos);
    if (drop > 0) { this.acc.splice(0, drop); this.pos -= drop; }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);

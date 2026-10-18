/**
 * 麦克风采集：把声卡的浮点流重采样成 16kHz 单声道 PCM16，
 * 按 20ms（320 样本）一帧发给页面。
 *
 * 取自 Coopanion 的 `web/mic-worklet.js`：**代码逐行相同**，只把文件头的
 * 英文注释换成了中文（因此不是「逐字节相同」）。重采样用「落在每个输出样本
 * 区间内的输入样本取平均」，对语音识别足够。
 */
class PetMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.acc = 0;
    this.sum = 0;
    this.n = 0;
    this.frame = new Int16Array(320);
    this.at = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.acc += 1;
      if (this.acc >= this.step) {
        this.acc -= this.step;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0; this.n = 0;
        this.frame[this.at++] = v < 0 ? v * 32768 : v * 32767;
        if (this.at === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.at = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pet-mic', PetMic);

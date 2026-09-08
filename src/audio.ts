/**
 * Drives mouth movement from whatever she is currently saying.
 *
 * Reads a short-window RMS off the audio graph each frame rather than
 * pre-analysing the clip, so the same path works for a downloaded voice line
 * and for TTS audio streamed in later.
 */
import { fetchBytes } from './pet';
export class LipSync {
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private buf?: Float32Array;
  private current = 0;
  private source?: AudioBufferSourceNode;

  /** Smoothed 0..1 mouth openness. */
  get level(): number {
    return this.current;
  }

  get speaking(): boolean {
    return !!this.source;
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.25;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private queue: string[] = [];
  private draining = false;

  /** Interrupts anything playing and speaks this clip. */
  async play(url: string): Promise<number> {
    this.queue.length = 0;
    this.stop();
    return this.start(url);
  }

  /**
   * Appends a clip to be spoken after the current one.
   *
   * The server streams long replies as sentence-sized chunks (`audio_continue`),
   * so they have to play back-to-back or she talks over herself.
   */
  enqueue(url: string): void {
    this.queue.push(url);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.source) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        await this.start(this.queue.shift()!);
        await new Promise<void>((resolve) => {
          const wait = () => (this.source ? setTimeout(wait, 40) : resolve());
          wait();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async start(url: string): Promise<number> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume();

    const data = await fetchBytes(url);
    const audio = await ctx.decodeAudioData(data);

    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(this.analyser!);
    src.onended = () => {
      if (this.source === src) this.source = undefined;
    };
    src.start();
    this.source = src;
    return audio.duration;
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already ended */
      }
      this.source = undefined;
    }
  }

  /**
   * Call once per frame. Silence decays rather than snapping shut, which reads
   * as a mouth closing instead of a jump cut.
   */
  update(dt: number): number {
    let target = 0;
    if (this.source && this.analyser && this.buf) {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      // speech RMS sits well below 1.0; lift it into a usable range and clamp
      target = Math.min(1, rms * 5.5);
    }
    const rate = target > this.current ? 26 : 12; // open fast, close softer
    this.current += (target - this.current) * Math.min(1, rate * dt);
    return this.current;
  }
}

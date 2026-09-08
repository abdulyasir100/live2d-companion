/**
 * Links the model to avatar-server.
 *
 * Speaks the protocol the existing Unity client already uses, so the server
 * needs no changes: `chat` carries a reply plus an emotion tag and the first
 * audio chunk, and `audio_continue` streams the remaining sentence chunks.
 */
import type { CompanionModel } from './model';
import type { LipSync } from './audio';

export interface CompanionOptions {
  host: string;
  onState?: (state: string) => void;
  onReply?: (text: string, emotion: string) => void;
}

/**
 * Emotion tags the server can send (config.VALID_EMOTIONS) mapped onto what
 * this model actually has. Expressions hold the face; a motion plays once for
 * the body.
 *
 * Motions are named by family only - the converted set has inconsistent
 * intensity suffixes (joy-03 exists at lv04 but not lv03), so the actual clip
 * is resolved from the model's index at play time. Listing several families per
 * emotion also keeps repeated reactions from looking canned.
 */
const EMOTION_MAP: Record<string, { expression: string; motions: string[] }> = {
  HAPPY: { expression: 'joy-01', motions: ['joy-', 'happy-', 'smile-'] },
  SAD: { expression: 'sad-01', motions: ['sad-', 'disappoint-', 'tear-'] },
  SURPRISED: { expression: 'surprise-01', motions: ['surprise-', 'notice-'] },
  ANGRY: { expression: 'anger-01', motions: ['anger-', 'provoke-'] },
  THINKING: { expression: 'serious-01', motions: ['think-', 'question-'] },
  NEUTRAL: { expression: 'idle-01', motions: [] }
};

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;
const PING_INTERVAL = 25000;

export class Companion {
  private ws?: WebSocket;
  private backoff = RECONNECT_MIN;
  private pingTimer?: number;
  private closed = false;

  constructor(
    private model: () => CompanionModel,
    private lipSync: LipSync,
    private opts: CompanionOptions
  ) {}

  private get httpBase(): string {
    return `http://${this.opts.host}`;
  }

  /** Audio arrives as a server-relative path like /audio/xxx.wav. */
  private absolute(url: string): string {
    return /^https?:/i.test(url) ? url : `${this.httpBase}${url}`;
  }

  connect(): void {
    this.closed = false;
    const ws = new WebSocket(`ws://${this.opts.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = RECONNECT_MIN;
      this.opts.onState?.('connected');
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL);
    };

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      this.opts.onState?.('disconnected');
      if (this.closed) return;
      // the server restarts on deploy, so keep retrying with a widening gap
      window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX);
    };

    ws.onerror = () => ws.close();
  }

  disconnect(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    this.ws?.close();
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  private handle(msg: any): void {
    switch (msg.type) {
      case 'chat':
      case 'reminder': {
        const emotion = String(msg.emotion ?? 'NEUTRAL').toUpperCase();
        this.express(emotion);
        if (msg.audio_url) this.lipSync.play(this.absolute(msg.audio_url));
        this.opts.onReply?.(msg.reply ?? '', emotion);
        break;
      }

      case 'audio_continue':
        // later sentences of the same reply - queue, never interrupt
        if (msg.audio_url) this.lipSync.enqueue(this.absolute(msg.audio_url));
        break;

      case 'sleep':
        this.opts.onState?.(msg.sleeping ? 'sleeping' : 'awake');
        if (msg.sleeping) {
          this.lipSync.stop();
          this.model().setExpression('idle-01');
        }
        break;

      case 'connected':
        // the socket already reported 'connected' on open; this carries the count
        this.opts.onState?.(`ready (${msg.clients ?? '?'} client(s))`);
        break;
    }
  }

  private express(emotion: string): void {
    const mapped = EMOTION_MAP[emotion] ?? EMOTION_MAP.NEUTRAL;
    this.model().setExpression(mapped.expression);

    // one-shot body motions only; looping clips would never hand back control
    const candidates = this.model().motionIndex.filter(
      (e) => !e.loop && mapped.motions.some((prefix) => e.name.startsWith(prefix))
    );
    if (candidates.length) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      void this.model().playMotion(pick.name);
    }
  }
}

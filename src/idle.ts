/**
 * Keeps her alive between conversations.
 *
 * A looping idle clip runs as the baseline, and every so often a one-shot
 * ambient motion interrupts it - a glance around, a breath - before the loop
 * resumes. Without this she only ever moves when the server speaks, which reads
 * as a statue that occasionally twitches.
 */
import type { CompanionModel } from './model';

/**
 * Motion families neutral enough to fire unprompted. Emotional families
 * (anger, cry, shout, dance) are deliberately excluded - unprompted they read
 * as mood swings rather than idling.
 */
const AMBIENT = [
  'look-around-',
  'deep-breath-',
  'default-',
  'turn-l-',
  'turn-r-',
  'turn-u-',
  'notice-',
  'wink-',
  'smile-'
];

const SLEEPY = ['sleepy-'];

export interface IdleOptions {
  /** Seconds between ambient motions, picked uniformly in this range. */
  minGap?: number;
  maxGap?: number;
  onPlay?: (name: string) => void;
}

export class IdleDirector {
  private timer = 0;
  private next: number;
  private starting = false;
  private sleeping = false;

  constructor(
    private model: () => CompanionModel,
    private opts: IdleOptions = {}
  ) {
    this.opts.minGap ??= 9;
    this.opts.maxGap ??= 24;
    this.next = this.gap();
  }

  setSleeping(v: boolean): void {
    this.sleeping = v;
  }

  private gap(): number {
    const { minGap, maxGap } = this.opts as Required<IdleOptions>;
    return minGap + Math.random() * (maxGap - minGap);
  }

  private pick(prefixes: string[], loop: boolean): string | undefined {
    const hits = this.model().motionIndex.filter(
      (e) => e.loop === loop && prefixes.some((p) => e.name.startsWith(p))
    );
    return hits.length ? hits[Math.floor(Math.random() * hits.length)].name : undefined;
  }

  private play(name: string | undefined): void {
    if (!name || this.starting) return;
    this.starting = true;
    void this
      .model()
      .playMotion(name)
      .then(() => this.opts.onPlay?.(name))
      .finally(() => {
        this.starting = false;
      });
  }

  /** `busy` covers speaking and scripted reactions, which own the body. */
  update(dt: number, busy: boolean): void {
    if (busy) {
      this.timer = 0;
      return;
    }

    // nothing playing - fall back to the looping baseline
    if (this.model().motionIdle) {
      this.play(this.pick(['idle-'], true));
      return;
    }

    this.timer += dt;
    if (this.timer < this.next) return;
    this.timer = 0;
    this.next = this.gap();
    this.play(this.pick(this.sleeping ? SLEEPY : AMBIENT, false));
  }
}

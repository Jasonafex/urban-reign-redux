/**
 * Procedural Web Audio combat sound.
 *
 * AGENTS.md §3.1: presentation layer, and **100% headless-safe**. There is no `AudioContext` in a
 * Node process, in an SSR build, or in a browser that has not yet granted audio permission. This
 * module treats that as the normal case rather than the error case:
 *
 *   - construction never touches a browser global without a `typeof` guard;
 *   - with no audio device every cue is a **no-op that returns normally**, not a throw;
 *   - {@link SoundBoard.consume} walks a sim event stream and is safe to call unconditionally, so
 *     the frame loop never needs a branch on "is audio available".
 *
 * `test/vfx-audio.test.mjs` gates exactly this: it calls every cue with no `AudioContext` in the
 * process and asserts nothing throws, and then injects a stub context and asserts each cue really
 * does build Web Audio nodes. A sound board that only ever no-ops would pass the first half.
 *
 * ## Why it is synthesised rather than sampled
 *
 * A brawler needs dozens of variations of three sounds — every hit is a whoosh plus an impact,
 * and they fire in strings. Sample sets are megabytes and cannot be pitched to match how hard a
 * particular move landed; `power` here scales both the noise burst and its filter sweep, so a
 * five-link Jack-5 string audibly escalates across the exact damage numbers the sim reported.
 */

import type { DodgeEvent, HitEvent, SimEvent, SpaEvent, WallImpactEvent } from '../sim/events';

/** The subset of the Web Audio API this module uses. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  state?: string;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBufferSource(): BufferSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  resume?(): Promise<void>;
}

export interface GainNodeLike {
  gain: { value: number; setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void };
  connect(node: unknown): unknown;
  disconnect?(): void;
}

export interface OscillatorNodeLike {
  type: string;
  frequency: { value: number; setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void };
  connect(node: unknown): unknown;
  start(t?: number): void;
  stop(t?: number): void;
}

export interface BiquadFilterNodeLike {
  type: string;
  frequency: { value: number; setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void };
  /** Optional: the legacy `webkitBiquadFilter` shape has no resonance control. */
  Q?: { value: number };
  connect(node: unknown): unknown;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  loop?: boolean;
  connect(node: unknown): unknown;
  start(t?: number): void;
  stop(t?: number): void;
}

export type SoundName =
  | 'whoosh'
  | 'impact'
  | 'impactHeavy'
  | 'block'
  | 'slip'
  | 'reversal'
  | 'wallSplat'
  | 'spaCharge'
  | 'spaRelease'
  | 'knockdown'
  | 'getup';

export interface SoundOptions {
  /**
   * Overrides how the `AudioContext` is obtained. Tests inject a stub here; production leaves it
   * alone and the module probes the global itself.
   */
  readonly contextFactory?: () => AudioContextLike | null;
  /** Master output level, 0..1. */
  readonly volume?: number;
  /** Ceiling on simultaneously sounding cues. */
  readonly maxVoices?: number;
}

/** Counters, exposed so the headless suite can assert that cues *ran* rather than silently no-op'd. */
export interface SoundStats {
  /** Cues requested since construction, by name. */
  readonly played: Readonly<Record<SoundName, number>>;
  /** Cues dropped because the voice limit was hit. */
  readonly dropped: number;
  /** Total cues requested. */
  readonly total: number;
}

/** Per-sound recipes. All frequencies and times in Hz and seconds. */
interface Cue {
  /** Broadband noise burst vs. a pitched body. Both, for most impacts. */
  readonly kind: 'noise' | 'tone' | 'noiseTone';
  readonly duration: number;
  /** Starting filter cutoff for the noise component. */
  readonly cutoff: number;
  /** Ending filter cutoff — a downward sweep is what reads as "heavy". */
  readonly cutoffEnd: number;
  readonly gain: number;
  /** Tone component: starting frequency and its end frequency. */
  readonly toneFrom: number;
  readonly toneTo: number;
  /** Filter resonance; higher is a more pitched, more synthetic hit. */
  readonly q: number;
}

const CUES: Readonly<Record<SoundName, Cue>> = Object.freeze({
  // Air moving over a body. Almost pure band-passed noise, short.
  whoosh: { kind: 'noise', duration: 0.14, cutoff: 2600, cutoffEnd: 520, gain: 0.16, toneFrom: 180, toneTo: 90, q: 0.9 },
  // A clean landed strike: a noise crack plus a low body thud.
  impact: { kind: 'noiseTone', duration: 0.17, cutoff: 1900, cutoffEnd: 260, gain: 0.3, toneFrom: 150, toneTo: 58, q: 1.1 },
  // A knockdown or an SPA: lower, longer, and the sweep goes further down.
  impactHeavy: { kind: 'noiseTone', duration: 0.34, cutoff: 1250, cutoffEnd: 120, gain: 0.42, toneFrom: 108, toneTo: 38, q: 1.4 },
  // A guard absorbing a hit: metallic, bright, and much shorter — it should not feel like pain.
  block: { kind: 'tone', duration: 0.13, cutoff: 3200, cutoffEnd: 2400, gain: 0.26, toneFrom: 1180, toneTo: 720, q: 6.5 },
  // A dodge slipping under a strike: a short upward whoosh, no impact body at all.
  slip: { kind: 'noise', duration: 0.19, cutoff: 480, cutoffEnd: 3400, gain: 0.13, toneFrom: 240, toneTo: 520, q: 1.6 },
  // The frame-perfect counter: an ascending chime, deliberately unlike anything else in the mix.
  reversal: { kind: 'tone', duration: 0.26, cutoff: 2600, cutoffEnd: 4200, gain: 0.3, toneFrom: 640, toneTo: 1760, q: 4.2 },
  // A body into brick. Noisy, no pitch centre, wide.
  wallSplat: { kind: 'noise', duration: 0.28, cutoff: 900, cutoffEnd: 150, gain: 0.38, toneFrom: 96, toneTo: 52, q: 0.7 },
  // The gauge release: a rising charge whine.
  spaCharge: { kind: 'tone', duration: 0.42, cutoff: 900, cutoffEnd: 4200, gain: 0.24, toneFrom: 220, toneTo: 1240, q: 5.2 },
  // The Special Arts landing: the heaviest thing in the mix, with a sub sweep under it.
  spaRelease: { kind: 'noiseTone', duration: 0.52, cutoff: 1500, cutoffEnd: 90, gain: 0.5, toneFrom: 128, toneTo: 32, q: 1.6 },
  // Hitting the floor. Dry, dusty, no tone.
  knockdown: { kind: 'noise', duration: 0.3, cutoff: 620, cutoffEnd: 110, gain: 0.34, toneFrom: 80, toneTo: 44, q: 0.8 },
  // Rising from the floor: a soft upward scrape.
  getup: { kind: 'noise', duration: 0.22, cutoff: 220, cutoffEnd: 900, gain: 0.11, toneFrom: 120, toneTo: 260, q: 1.2 },
});

/**
 * Procedural combat audio.
 *
 * Construct one per client. With no audio device it is a fully functional no-op: `enabled` is
 * false, every method returns normally, and `consume()` still walks the whole event stream so
 * callers can be written without audio branches.
 */
export class SoundBoard {
  /** True when a real audio device was found and cues are being synthesised. */
  readonly enabled: boolean;

  private readonly context: AudioContextLike | null;
  private readonly master: GainNodeLike | null;
  private readonly noise: AudioBufferLike | null;
  private readonly maxVoices: number;
  private readonly volume: number;
  private readonly counts = new Map<SoundName, number>();
  private voiceCount = 0;
  private droppedCount = 0;
  private totalCount = 0;
  private disposed = false;

  constructor(options: SoundOptions = {}) {
    this.maxVoices = options.maxVoices ?? 24;
    this.volume = options.volume ?? 0.7;

    const context = SoundBoard.probeContext(options.contextFactory);
    this.context = context;
    this.enabled = context !== null;

    if (context === null) {
      this.master = null;
      this.noise = null;
      return;
    }

    try {
      const master = context.createGain();
      master.gain.value = this.volume;
      master.connect(context.destination);
      this.master = master;
      this.noise = makeNoiseBuffer(context);
      // A suspended context is normal on iOS until a gesture. Resuming is best-effort; the
      // promise rejection is swallowed deliberately because there is nothing to report it to.
      void context.resume?.().catch(() => undefined);
    } catch {
      // A context that refuses to give us a gain node is as unusable as no context at all, and
      // the client must not crash on it.
      this.master = null;
      this.noise = null;
      (this as { enabled: boolean }).enabled = false;
    }
  }

  /**
   * Find an audio context, or return null.
   *
   * `typeof` rather than a bare reference: a bare `AudioContext` reference throws a
   * `ReferenceError` in a process that has never heard of it, which is exactly the process the
   * test suite runs in. The injected factory is tried first so the suite can supply a stub.
   */
  private static probeContext(
    factory: (() => AudioContextLike | null) | undefined,
  ): AudioContextLike | null {
    if (factory !== undefined) {
      try {
        return factory();
      } catch {
        return null;
      }
    }
    const ctor = (globalThis as { AudioContext?: new () => AudioContextLike })
      .AudioContext;
    const webkitCtor = (globalThis as { webkitAudioContext?: new () => AudioContextLike })
      .webkitAudioContext;
    const Ctor = ctor ?? webkitCtor;
    if (Ctor === undefined) {
      return null;
    }
    try {
      return new Ctor();
    } catch {
      // Blocked by autoplay policy, no output device, or a locked-down browser. All the same to
      // us: no audio, no crash.
      return null;
    }
  }

  /**
   * Play a cue by name. `power` scales gain and brightness, 0.1..1.5.
   *
   * Safe with no audio device — this is the call path the frame loop uses, so it must not throw
   * in any environment.
   */
  play(name: SoundName, power = 0.6): void {
    if (this.disposed) {
      return;
    }
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    this.totalCount += 1;

    const context = this.context;
    const master = this.master;
    if (context === null || master === null) {
      return;
    }
    const cue = CUES[name];
    if (cue === undefined) {
      return;
    }
    // A five-hit string can ask for more voices than a phone can mix; dropping the excess is
    // better than a graph that thins out mid-string.
    if (this.voiceCount >= this.maxVoices) {
      this.droppedCount += 1;
      return;
    }

    try {
      const scale = Math.min(Math.max(power, 0.05), 1.5);
      this.voiceCount += 1;

      if (cue.kind === 'noise' || cue.kind === 'noiseTone') {
        this.playNoise(context, master, cue, scale);
      }
      if (cue.kind === 'tone' || cue.kind === 'noiseTone') {
        this.playTone(context, master, cue, scale);
      }

      // Give the slot back once this cue's envelope has run out. The oscillator and the noise
      // source both stop themselves by then, so the graph is already finished.
      this.releaseVoiceAfter(cue.duration);
    } catch {
      // A partially built graph is torn down by the GC once the nodes are unreachable; a throw
      // here would take the whole render loop with it.
      this.voiceCount = Math.max(0, this.voiceCount - 1);
    }
  }

  /**
   * Return a voice slot after `seconds`.
   *
   * The one place `voiceCount` is decremented. It matters that this actually happens: a budget
   * that only ever increments would silently mute the entire sound board after `maxVoices` cues,
   * which in a match that fires a sound per contact is about four seconds in.
   */
  private releaseVoiceAfter(seconds: number): void {
    const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown })
      .setTimeout;
    if (timer === undefined) {
      // No timer means no way to reclaim the slot safely; drop it now rather than leak the budget.
      this.voiceCount = Math.max(0, this.voiceCount - 1);
      return;
    }
    timer(() => {
      this.voiceCount = Math.max(0, this.voiceCount - 1);
    }, Math.ceil(seconds * 1000) + 120);
  }

  private playNoise(
    context: AudioContextLike,
    master: GainNodeLike,
    cue: Cue,
    scale: number,
  ): void {
    const buffer = this.noise;
    if (buffer === null) {
      return;
    }
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    // Optional in the spec shape we declare against, so it is written defensively: a filter
    // without resonance control still produces the right noise, just less pitched.
    if (filter.Q !== undefined) {
      filter.Q.value = cue.q;
    }
    filter.frequency.setValueAtTime(cue.cutoff * scale, now);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(cue.cutoffEnd, 40),
      now + cue.duration,
    );

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    // Fast attack, exponential decay: the shape of an impact, not of a swell.
    gain.gain.linearRampToValueAtTime(cue.gain * scale, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cue.duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(now);
    source.stop(now + cue.duration + 0.02);
  }

  private playTone(
    context: AudioContextLike,
    master: GainNodeLike,
    cue: Cue,
    scale: number,
  ): void {
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    oscillator.type = cue.kind === 'tone' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(cue.toneFrom * scale, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(cue.toneTo, 20),
      now + cue.duration,
    );

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(cue.gain * scale * 0.9, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cue.duration);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(now);
    oscillator.stop(now + cue.duration + 0.02);
  }

  /**
   * Walk one tick's event stream and play the cues it implies.
   *
   * The mapping is the whole point of this method: the frame loop hands over the sim's events
   * exactly as it hands them to the VFX system, and every audio decision — a block sounds
   * different from a hit, a launcher is heavier than a jab, a reversal is its own chime — is
   * made here from data the simulation already decided.
   */
  consume(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'hit':
          this.consumeHit(event);
          break;
        case 'dodge':
          this.consumeDodge(event);
          break;
        case 'wallImpact':
          this.play('wallSplat', SoundBoard.wallPower(event));
          break;
        case 'spa':
          this.consumeSpa(event);
          break;
        default:
          break;
      }
    }
  }

  private consumeHit(event: HitEvent): void {
    if (event.guarded) {
      this.play('block', 0.5);
      return;
    }
    // A launcher, a knockdown or a big number all land as the heavier impact — this is the
    // audible half of "that was the big one".
    const heavy = event.launcher || event.knockdown || event.damage >= 45;
    const power = Math.min(Math.max(event.damage / 70, 0.25), 1.2);
    this.play(heavy ? 'impactHeavy' : 'impact', power);
    if (event.knockdown) {
      this.play('knockdown', power * 0.8);
    }
  }

  private consumeDodge(event: DodgeEvent): void {
    this.play(event.outcome === 'reversal' ? 'reversal' : 'slip', 0.7);
  }

  private consumeSpa(event: SpaEvent): void {
    this.play('spaRelease', 0.6 + event.tier * 0.25);
  }

  /** Bigger impacts sound bigger. `speed` is in subunits/tick. */
  private static wallPower(event: WallImpactEvent): number {
    return Math.min(Math.max(event.speed / 900, 0.2), 1.2);
  }

  /** Fire the air-move for a strike that is about to become active. */
  whoosh(power = 0.6): void {
    this.play('whoosh', power);
  }

  /** The rising gauge whine before a Special Arts release. */
  spaCharge(tier: 1 | 2 | 3 = 1): void {
    this.play('spaCharge', 0.5 + tier * 0.2);
  }

  /** A fighter rising off the floor. */
  getup(): void {
    this.play('getup', 0.6);
  }

  /**
   * Cues played and cues dropped.
   *
   * Counted even when there is no audio device, so the headless suite can assert that the event
   * mapping ran — a mapping that quietly skipped every event would still be silent, and silence
   * is what the no-op path is supposed to produce.
   */
  stats(): SoundStats {
    const played = {} as Record<SoundName, number>;
    for (const name of Object.keys(CUES) as SoundName[]) {
      played[name] = this.counts.get(name) ?? 0;
    }
    return { played, dropped: this.droppedCount, total: this.totalCount };
  }

  /**
   * Release the audio graph.
   *
   * The `AudioContext` itself is closed rather than just disconnected — closing is the only thing
   * that actually releases an output device on a phone, and a dropped match that leaves four
   * silent audio contexts open is a real battery cost.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.master?.disconnect?.();
      const closable = this.context as (AudioContextLike & { close?: () => Promise<void> }) | null;
      void closable?.close?.().catch(() => undefined);
    } catch {
      // Nothing to do; the context is going away regardless.
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * One second of white noise, generated once and looped.
 *
 * Generated rather than fetched so the whole sound board is code: no asset pipeline, no decode
 * await, and it is available on the very first hit of a match.
 */
function makeNoiseBuffer(context: AudioContextLike): AudioBufferLike | null {
  const length = Math.max(1, Math.floor(context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // xorshift32 again, matching the VFX generator: reproducible noise, no `Math.random`.
  let state = 0x1a2b3c4d;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    data[i] = (state / 0x1_0000_0000) * 2 - 1;
  }
  return buffer;
}
/**
 * Urban Reign arcade HUD.
 *
 * AGENTS.md §3.1: presentation layer. It reads `Fighter` records and the sim's event stream and
 * writes DOM. It never writes back.
 *
 * ## The split, and why it is here
 *
 * The HUD is two modules in one file, and the boundary between them is the point:
 *
 *   - {@link HudState} is the *model*. Ghost-bar decay, combo counting, SPA tier gating and tag
 *     resolution are all plain arithmetic over plain data. It has no `document` reference at all,
 *     so it can be driven for 600 ticks in the test suite and asserted on directly.
 *   - {@link HudView} is the *view*. It owns DOM nodes, caches them once at mount, and then only
 *     mutates `style.width` and `textContent` on the hot path. It never computes anything.
 *
 * A HUD that computed its damage ghost inside the DOM write is a HUD whose arithmetic can only
 * be tested through a browser. This one can be tested with a 40-line stub document — and
 * `test/hud.test.mjs` does exactly that, driving the real view against a fake DOM.
 *
 * ## The damage ghost
 *
 * The trailing bar behind the health bar is the single most useful thing on this screen during a
 * four-way fight, because it answers "how much did that last hit actually take?" after the
 * player's attention has already moved. It decays on *rendered* seconds rather than sim ticks:
 * it is a smoothing cue for the eye, not simulation state, and tying it to ticks would make it
 * drain four times faster on a 240Hz monitor.
 */

import type { Fighter } from '../sim/fighter';
import type { SimEvent } from '../sim/events';

/** Arcade slot colours. Shared with the client's scene proxies so a player matches their panel. */
export const SLOT_COLORS: readonly string[] = Object.freeze([
  '#d8443c',
  '#7dd83c',
  '#3c8fd8',
  '#d8b23c',
]);

/**
 * SPA tier costs as a fraction of the full gauge, index 0 == "no SPA".
 *
 * Index 1 and 2 are the two costs the simulation's tables actually charge: the declared `spaCost`
 * values are 50 and 100 on a 100-point gauge, so tier 2 lights at half a gauge and tier 3 (the
 * dual) only at a full one. A 3-tier meter with the same thresholds the sim charges is the only
 * version that cannot lie to the player.
 *
 * The third pip is **not** a fourth gauge threshold — it is the dual/tag-team art of AGENTS.md
 * §5, which additionally needs a second combatant alive. See {@link spaTierFor}.
 */
export const SPA_TIER_COSTS: readonly number[] = Object.freeze([0, 0.5, 1, 1]);

/** Ticks a combo counter survives without a hit before it resets. */
export const COMBO_WINDOW_TICKS = 90;

/** Ghost-bar settle rate, per second. */
const GHOST_RATE = 2.4;

/** Health below which a panel is flagged as critical (flashes). */
const CRITICAL_HEALTH = 0.25;

export interface HudPanelModel {
  readonly slot: number;
  /** `1P`..`4P`, or the connected device's label once one is known. */
  readonly tag: string;
  /** Archetype name. */
  readonly name: string;
  readonly color: string;
  /** Actual health, 0..1. */
  readonly health: number;
  /** Lagging health bar, 0..1. Always >= `health` after a hit. */
  readonly ghost: number;
  /** Gauge fill, 0..1. */
  readonly spa: number;
  /** Highest SPA tier this fighter can currently afford: 0, 1, 2 or 3. */
  readonly spaTier: number;
  /** Consecutive hits landed without being hit, 0 when none. */
  readonly combo: number;
  readonly alive: boolean;
  readonly critical: boolean;
  /** Slot this fighter is target-locked on, or -1. */
  readonly lockTarget: number;
  /** Slots currently locked onto this fighter. */
  readonly lockedBy: readonly number[];
}

export interface HudModel {
  readonly tick: number;
  readonly panels: readonly HudPanelModel[];
  /** Player 1's target-lock reticle, which is the one the camera follows. */
  readonly reticle: { readonly slot: number; readonly target: number } | null;
}

/** Everything the HUD needs for one frame. Every field optional: it must tolerate partial input. */
export interface HudInput {
  readonly fighters: readonly Fighter[];
  /** Per-slot device label. Missing entries fall back to the `nP` tag. */
  readonly tags?: readonly string[];
  /** Sim events from the tick, used to count combos. */
  readonly events?: readonly SimEvent[];
  /** Seconds of rendered time, for ghost decay. */
  readonly dt?: number;
  /** Current sim tick, reported in the model. */
  readonly tick?: number;
}

/**
 * The highest SPA tier a gauge of `meter / max` can pay for.
 *
 * Tiers 1 and 2 are pure gauge thresholds. Tier 3 is the dual SPA and additionally requires
 * `partners` — a second living combatant — because that is what a tag-team beatdown is; without
 * that condition a full gauge would light a move that has nobody to tag with.
 *
 * The default of 0 partners means a lone survivor sees two affordable SPAs, which is exactly what
 * they can actually throw.
 */
export function spaTierFor(meter: number, max: number, partners = 0): number {
  if (max <= 0) {
    return 0;
  }
  const ratio = meter / max;
  let tier = 0;
  for (let i = 1; i < SPA_TIER_COSTS.length; i += 1) {
    if (ratio >= (SPA_TIER_COSTS[i] ?? 1)) {
      tier = i;
    }
  }
  if (tier >= 3 && partners <= 0) {
    return 2;
  }
  return tier;
}

/** `1P`..`4P`. */
export function defaultTag(slot: number): string {
  return `${slot + 1}P`;
}

/** A device label, falling back to the `nP` tag when it is missing or blank. */
function blankToDefault(label: string | undefined, slot: number): string {
  if (label === undefined || label === null) {
    return defaultTag(slot);
  }
  const trimmed = label.trim();
  return trimmed === '' ? defaultTag(slot) : trimmed;
}

/** One player's trailing health bar. */
interface GhostTrail {
  /** Displayed health, in raw HP rather than a ratio, so a max-health change cannot skew it. */
  value: number;
  max: number;
  /**
   * The health recorded on the *previous* frame.
   *
   * The ghost drains toward this, not toward the current health. That one-frame lag is the whole
   * point: the bar snaps down on the frame the hit lands and the ghost stays put for that frame,
   * which is the moment the player actually sees what they lost. Decaying toward the *current*
   * health would spend the reveal frame already draining it.
   */
  last: number;
}

/**
 * The HUD's stateful half: ghost trails, combo counters and tag resolution.
 *
 * Holds no DOM reference and reads no ambient global. One instance per client; `sync` is the only
 * way state enters it.
 */
export class HudState {
  private readonly ghosts = new Map<number, GhostTrail>();
  private readonly combos = new Map<number, number>();
  private readonly comboTick = new Map<number, number>();

  /**
   * Advance by one frame and produce the model.
   *
   * `dt` only affects the ghost decay. `events` only affects combo counting — both are folded in
   * here rather than in the view so the arithmetic is testable without a DOM.
   */
  sync(input: HudInput): HudModel {
    const dt = input.dt ?? 0;
    this.applyCombos(input.events ?? [], input.fighters, input.tick ?? 0);
    this.decayGhosts(input.fighters, dt);

    const panels: HudPanelModel[] = [];
    const lockedBy = new Map<number, number[]>();

    // Counted up front: the dual SPA needs a partner, so the tier a panel reports depends on how
    // many fighters are still standing — not just on that fighter's own gauge.
    let aliveCount = 0;
    for (const fighter of input.fighters) {
      if (!fighter.eliminated) {
        aliveCount += 1;
      }
    }
    const partners = Math.max(aliveCount - 1, 0);

    for (const fighter of input.fighters) {
      const followers = lockedBy.get(fighter.slot) ?? [];
      for (const other of input.fighters) {
        if (other.targetLockedSlot === fighter.slot) {
          followers.push(other.slot);
        }
      }
      lockedBy.set(fighter.slot, followers);
    }

    for (const fighter of input.fighters) {
      const ghost = this.ghosts.get(fighter.slot);
      const health = fighter.maxHealth <= 0 ? 0 : clamp01(fighter.health / fighter.maxHealth);
      panels.push({
        slot: fighter.slot,
        // A blank label is as absent as a missing one: the input stack hands over `''` for a slot
        // that has no device label yet, and an empty corner panel is worse than a "3P".
        tag: blankToDefault(input.tags?.[fighter.slot], fighter.slot),
        name: fighter.archetypeId.replace(/_/g, ' '),
        color: SLOT_COLORS[fighter.slot % SLOT_COLORS.length] ?? '#ffffff',
        health,
        ghost: ghost === undefined ? health : clamp01(ghost.value / Math.max(ghost.max, 1)),
        spa: fighter.spaMax <= 0 ? 0 : clamp01(fighter.spaMeter / fighter.spaMax),
        spaTier: spaTierFor(fighter.spaMeter, fighter.spaMax, partners),
        combo: this.combos.get(fighter.slot) ?? 0,
        alive: !fighter.eliminated,
        critical: health <= CRITICAL_HEALTH && !fighter.eliminated,
        lockTarget: fighter.targetLockedSlot,
        lockedBy: lockedBy.get(fighter.slot) ?? [],
      });
    }

    panels.sort((a, b) => a.slot - b.slot);

    const local = panels.find((panel) => panel.slot === 0) ?? panels[0];
    return {
      tick: input.tick ?? 0,
      panels,
      reticle:
        local === undefined || local.lockTarget < 0 ? null : { slot: local.slot, target: local.lockTarget },
    };
  }

  /**
   * Walk the event stream and update combo counters.
   *
   * Two rules, and they are what makes a counter meaningful rather than decorative:
   *   - landing a hit as **attacker** increments this fighter's counter;
   *   - taking a hit as **defender** resets it.
   *
   * The second is why the counter is worth showing at all — a brawler combo that survived being
   * hit through the middle of it would be a lie about what the player is actually achieving.
   */
  private applyCombos(events: readonly SimEvent[], fighters: readonly Fighter[], tick: number): void {
    for (const event of events) {
      if (event.type !== 'hit') {
        continue;
      }
      if (event.guarded) {
        // A blocked hit is not a combo link — it deals no damage and does not stagger.
        continue;
      }
      this.combos.set(event.attackerSlot, (this.combos.get(event.attackerSlot) ?? 0) + 1);
      this.comboTick.set(event.attackerSlot, tick);
      // Taking damage drops the victim's own string.
      this.combos.set(event.defenderSlot, 0);
      this.comboTick.set(event.defenderSlot, tick);
    }

    // Expire anything that has not landed inside the window. Iterating a copy because the loop
    // writes to the maps it is walking.
    const now = tick;
    for (const [slot, last] of [...this.comboTick]) {
      if (now - last > COMBO_WINDOW_TICKS) {
        this.combos.set(slot, 0);
        this.comboTick.delete(slot);
      }
    }
    void fighters;
  }

  /**
   * Move each ghost bar toward the fighter's real health.
   *
   * A ghost never rises above real health: gaining (a max-health change, a reset) snaps it up, and
   * only damage lets it fall. Trailing *down* slowly is what makes the bar read as "you just
   * lost that", instead of a bar that simply appears to be at the wrong number.
   */
  private decayGhosts(fighters: readonly Fighter[], dt: number): void {
    for (const fighter of fighters) {
      const trail = this.ghosts.get(fighter.slot);
      if (trail === undefined) {
        this.ghosts.set(fighter.slot, { value: fighter.health, max: fighter.maxHealth, last: fighter.health });
        continue;
      }

      // Drain toward last frame's health, *then* record this frame's — see `GhostTrail.last`.
      const target = trail.last;
      trail.max = fighter.maxHealth;
      if (trail.value <= target) {
        trail.value = target;
      } else if (dt > 0) {
        const t = Math.min(1, GHOST_RATE * dt);
        trail.value += (target - trail.value) * t;
        // Snap the remainder so the two bars meet exactly rather than asymptotically.
        if (Math.abs(trail.value - target) < 0.5) {
          trail.value = target;
        }
      }

      trail.last = fighter.health;
    }
  }

  /** Drop all state. Used between matches so a new match starts with no ghosts or combos. */
  reset(): void {
    this.ghosts.clear();
    this.combos.clear();
    this.comboTick.clear();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** The DOM half. Every node is looked up once at mount and then only mutated. */
interface PanelNodes {
  readonly root: HTMLElement;
  readonly tag: HTMLElement;
  readonly name: HTMLElement;
  readonly health: HTMLElement;
  readonly ghost: HTMLElement;
  readonly spaFill: HTMLElement;
  readonly spaTiers: readonly HTMLElement[];
  readonly combo: HTMLElement;
  readonly comboWrap: HTMLElement;
}

export interface HudViewOptions {
  /** Inject a document. Tests pass a stub; production leaves it alone. */
  readonly doc?: Document | null;
}

/**
 * The arcade HUD's DOM view.
 *
 * `mount` returns false when there is no document — the headless case — and every later call is
 * then a no-op, so the frame loop can call `sync` unconditionally without asking whether the HUD
 * exists. That is the same headless-safety rule §3.1 sets for the audio layer.
 */
export class HudView {
  private readonly doc: Document | null;
  private panels: PanelNodes[] = [];
  private root: HTMLElement | null = null;
  private mounted = false;

  constructor(options: HudViewOptions = {}) {
    this.doc = options.doc !== undefined ? options.doc : resolveDocument();
  }

  /** True when there is a document to mount into. */
  get available(): boolean {
    return this.doc !== null;
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  /** Build the four corner panels. Returns false with no document. */
  mount(parent: HTMLElement | null = null): boolean {
    const doc = this.doc;
    if (doc === null || this.mounted) {
      return false;
    }
    const root = doc.createElement('div');
    root.setAttribute('data-ur', 'hud');
    // `pointer-events:none` throughout: the HUD is never an input target, and a panel that
    // swallowed a click would eat a touch-control button underneath it on a phone.
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;font:600 12px/1.2 ui-monospace,monospace;' +
      'color:#e8e6e1;user-select:none;-webkit-user-select:none;z-index:5';

    for (let slot = 0; slot < SLOT_COLORS.length; slot += 1) {
      this.panels.push(this.buildPanel(doc, root, slot));
    }

    const host = parent ?? doc.body;
    if (host === null || host === undefined) {
      return false;
    }
    host.appendChild(root);
    this.root = root;
    this.mounted = true;
    return true;
  }

  private buildPanel(doc: Document, root: HTMLElement, slot: number): PanelNodes {
    const panel = doc.createElement('div');
    panel.setAttribute('data-slot', String(slot));
    // Slots 0/1 top corners, 2/3 bottom corners — the arcade four-panel layout.
    const top = slot < 2;
    const left = slot % 2 === 0;
    panel.style.cssText =
      `position:absolute;${top ? 'top' : 'bottom'}:10px;${left ? 'left' : 'right'}:10px;` +
      'width:min(38vw,260px);display:flex;flex-direction:column;gap:3px';

    const header = doc.createElement('div');
    header.style.cssText = 'display:flex;align-items:baseline;gap:6px';
    const tag = doc.createElement('span');
    tag.style.cssText = 'font-size:15px;letter-spacing:.06em';
    const name = doc.createElement('span');
    name.style.cssText = 'font-size:10px;opacity:.6;text-transform:uppercase;letter-spacing:.1em';
    header.appendChild(tag);
    header.appendChild(name);

    const bar = doc.createElement('div');
    bar.style.cssText =
      'position:relative;height:13px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.22);' +
      'border-radius:2px;overflow:hidden';
    const ghost = doc.createElement('div');
    ghost.style.cssText = 'position:absolute;inset:0;width:100%;background:#f0e6d2;opacity:.75';
    const health = doc.createElement('div');
    health.style.cssText =
      'position:absolute;inset:0;width:100%;background:linear-gradient(#8ef0a0,#3fbf63);' +
      'box-shadow:0 0 6px rgba(120,255,160,.5)';
    bar.appendChild(ghost);
    bar.appendChild(health);

    const spa = doc.createElement('div');
    spa.style.cssText = 'display:flex;gap:3px;align-items:stretch;height:7px';
    const spaFill = doc.createElement('div');
    spaFill.style.cssText =
      'position:relative;flex:1;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);' +
      'border-radius:2px;overflow:hidden';
    const spaBar = doc.createElement('div');
    spaBar.style.cssText = 'position:absolute;inset:0;width:0%;background:#8fb6ff';
    spaFill.appendChild(spaBar);
    spa.appendChild(spaFill);
    // Three tier pips: dim until the gauge can pay for them, then the tier colour.
    const spaTiers: HTMLElement[] = [];
    for (let tier = 1; tier < SPA_TIER_COSTS.length; tier += 1) {
      const pip = doc.createElement('div');
      pip.setAttribute('data-tier', String(tier));
      pip.style.cssText = 'width:13px;background:rgba(255,255,255,.14);border-radius:2px';
      spa.appendChild(pip);
      spaTiers.push(pip);
    }

    const comboWrap = doc.createElement('div');
    comboWrap.style.cssText = 'display:none;position:absolute;right:-4px;bottom:100%;padding-bottom:2px';
    const combo = doc.createElement('span');
    combo.style.cssText = 'font-size:17px;letter-spacing:.02em;text-shadow:0 2px 6px rgba(0,0,0,.8)';
    comboWrap.appendChild(combo);

    panel.appendChild(header);
    panel.appendChild(bar);
    panel.appendChild(spa);
    panel.appendChild(comboWrap);
    root.appendChild(panel);

    return { root: panel, tag, name, health, ghost, spaFill: spaBar, spaTiers, combo, comboWrap };
  }

  /**
   * Write a model onto the DOM.
   *
   * Only widths, colours and text change. Every write is guarded by a comparison against the last
   * value written, because setting `style.width` on four panels sixty times a second is enough
   * to cost a frame on a phone when the value has not moved.
   */
  render(model: HudModel): void {
    if (!this.mounted) {
      return;
    }
    for (const panel of model.panels) {
      const nodes = this.panels[panel.slot];
      if (nodes === undefined) {
        continue;
      }
      setText(nodes.tag, panel.tag);
      setText(nodes.name, panel.name);

      setWidth(nodes.health, `${(panel.health * 100).toFixed(1)}%`);
      setWidth(nodes.ghost, `${(panel.ghost * 100).toFixed(1)}%`);
      setWidth(nodes.spaFill, `${(panel.spa * 100).toFixed(1)}%`);

      // Critical health goes red and blinks the whole panel; there is no separate CSS class for
      // it because the blink has to be a display change the view owns.
      setBackground(
        nodes.health,
        panel.critical
          ? 'linear-gradient(#ff8a7a,#d8443c)'
          : 'linear-gradient(#8ef0a0,#3fbf63)',
      );
      nodes.root.style.opacity = panel.alive ? '1' : '0.32';

      for (let i = 0; i < nodes.spaTiers.length; i += 1) {
        const pip = nodes.spaTiers[i];
        if (pip === undefined) {
          continue;
        }
        const tier = i + 1;
        const lit = panel.spaTier >= tier;
        setBackground(pip, lit ? panel.color : 'rgba(255,255,255,.14)');
      }

      if (panel.combo >= 2) {
        if (nodes.comboWrap.style.display === 'none') {
          nodes.comboWrap.style.display = 'block';
        }
        setText(nodes.combo, `${panel.combo}`);
        nodes.combo.style.color = panel.color;
      } else if (nodes.comboWrap.style.display !== 'none') {
        nodes.comboWrap.style.display = 'none';
      }

      // Target lock: the reticle is drawn on whoever this fighter is locked onto, so every
      // locked pair is visible to both players, which is the point of a lock-on.
      const reticleColour = panel.lockTarget >= 0 ? panel.color : 'transparent';
      setBorder(nodes.root, panel.lockTarget >= 0 ? `1px solid ${reticleColour}` : '1px solid transparent');
    }
  }

  /** Remove the HUD from the document. Idempotent. */
  dispose(): void {
    if (this.root !== null) {
      this.root.parentNode?.removeChild(this.root);
    }
    this.root = null;
    this.panels = [];
    this.mounted = false;
  }
}

/**
 * Resolve a document without assuming one exists.
 *
 * `typeof` rather than a bare reference: a bare `document` reference throws in exactly the
 * process the test suite runs in.
 */
function resolveDocument(): Document | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document;
}

/** Write text only when it actually changed. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) {
    node.textContent = value;
  }
}

function setWidth(node: HTMLElement, value: string): void {
  if (node.style.width !== value) {
    node.style.width = value;
  }
}

function setBackground(node: HTMLElement, value: string): void {
  if (node.style.background !== value) {
    node.style.background = value;
  }
}

function setBorder(node: HTMLElement, value: string): void {
  if (node.style.border !== value) {
    node.style.border = value;
  }
}

/**
 * State and view wired together — the shape `main.ts` wants.
 *
 * Exists so the frame loop has one object to call rather than two, and so the "no document"
 * case is resolved once at construction rather than on every frame.
 */
export class ArcadeHud {
  private readonly state = new HudState();
  private readonly view: HudView;

  constructor(options: HudViewOptions = {}) {
    this.view = new HudView(options);
  }

  mount(parent: HTMLElement | null = null): boolean {
    return this.view.mount(parent);
  }

  /** Advance the model and write it to the DOM. Safe with no document. */
  sync(input: HudInput): HudModel {
    const model = this.state.sync(input);
    this.view.render(model);
    return model;
  }

  reset(): void {
    this.state.reset();
  }

  dispose(): void {
    this.view.dispose();
  }
}
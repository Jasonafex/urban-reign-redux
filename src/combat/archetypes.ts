/**
 * Character archetypes — Brad Hawk, Jack-5, Jin Kazama and Bryan Fury.
 *
 * ## Provenance
 *
 * Every chain below is a port of a record in `runtime/combat-trial13/spec.py`, whose docstring
 * states the rule this file encodes: *"Each nested group is one button input. Multiple source
 * records in one group are automatic hits of one animation."* `automatic_hits.py` then spells out
 * what that means mechanically — one input, several distinct actions, "earlier hits stagger; only
 * the final hit applies the requested finishing reaction" — which is exactly the
 * `chainNextMode: 'automatic'` + `stagger` encoding used here.
 *
 * Ported as written, with `sourceIds`, `limbs`, `automatic` and `finish` carried through:
 *
 *   | Character    | spec.py key         | Chains                                                   |
 *   |--------------|---------------------|----------------------------------------------------------|
 *   | Jack-5       | `('Jack5', …)`      | Rushing Uppercut Left, Double Hammer, Cemaho Chop, Piston Gun, Rocket Uppercut |
 *   | Jin Kazama   | `('Jin', …)`        | Kazama Style 5 Hit Combo, Savage Sword, Knee Popper to Sidekick, Thrust to Roundhouse, Double Chamber Punch |
 *   | Bryan Fury   | `('Bryan', …)`      | Gatling Combination, Vulcan Cannon, Double Body Blow, Lair's Dance, Mid Kick to Rush, Python Crush, Anaconda Bite |
 *
 * Two archetypes' numbers come from the other Trial 13 modules rather than `spec.py` itself:
 * Jack-5's five-level Gigaton charge (first windup 28 frames, 24-frame loop, one gauge cost,
 * `damage × (1 + 0.4·i)`) comes from `gigaton_charge.py`, the Rotary Catapult from
 * `throw_patch.py`/`grab_patch.py`, and Bryan's four-stage 150-damage SPA 1 from `bryan_spa.py`.
 * The reaction classification applied to each link — Gatling's fourth hit staggering, Jack-5's
 * side chain launching, Jin's neutral and side chains ending heavy — comes from
 * `balance.py`/`refinements.py`, along with its damage floors (light 20, medium 30, launch 35,
 * heavy 45, sweep 40), which are the reason the per-link damage numbers here are not round.
 *
 * **Brad Hawk has no Trial 13 source.** `spec.py` has no `Brad` entry (the only `Brad` string in
 * the Trial 13 tree is the name of whoever requested Leon's punch chain), so his moveset is
 * authored against AGENTS.md §5 — a fast, low-damage parkour brawler — and every one of his
 * moves is marked `origin: 'authored'`. Nothing in this file claims a lineage it does not have.
 *
 * AGENTS.md §3.1: pure data. No DOM, no clock, no randomness, no imports from `src/sim`.
 */

import {
  move,
  type GuardLevel,
  type MoveDef,
  type MoveKind,
  type MoveOrigin,
  type MoveStance,
} from './defs';

// ---------------------------------------------------------------------------------------------
// Chain model
// ---------------------------------------------------------------------------------------------

/**
 * One press of one chain. `automatic: true` means the link follows the previous one without an
 * input — the `automatic=True` groups of `spec.py`. Otherwise the link is a hit-confirm branch
 * and pressing it after a whiff is refused.
 */
export interface ChainLink {
  readonly moveId: string;
  readonly automatic: boolean;
}

export interface ChainDef {
  /** Stable identifier, `${archetypeId}/${stance}/${slug}`. */
  readonly id: string;
  readonly archetypeId: string;
  readonly stance: MoveStance;
  /** `move(label, …)` in spec.py. */
  readonly label: string;
  /** `move(…, source, …)` in spec.py — the character the animation was taken from. */
  readonly source: string;
  /** `ids` in spec.py — the original animation records, in order. */
  readonly sourceIds: readonly number[];
  /** `limbs` in spec.py — one per source record. */
  readonly limbs: readonly string[];
  /** `finish` in spec.py. */
  readonly finish: 'launch' | 'stagger' | 'sweep' | 'knockback' | null;
  readonly links: readonly ChainLink[];
  /** Whether a bare stance press selects this chain. */
  readonly stanceDefault: boolean;
  readonly origin: MoveOrigin;
}

/** Build a `ChainDef` in the shape `spec.py` writes it, so the two can be read side by side. */
function chain(options: {
  archetypeId: string;
  stance: MoveStance;
  slug: string;
  /**
   * Move-id prefix for this chain's links. Separate from `archetypeId` because move ids are
   * authored to read like the chain (`jin_kazama_style_5_hit_combo_1`, not
   * `jin_kazama_kazama_style_5_hit_combo_1`) and the two must not be derived from each other.
   */
  prefix: string;
  label: string;
  source: string;
  sourceIds: readonly number[];
  limbs: readonly string[];
  finish?: ChainDef['finish'];
  automatic?: boolean;
  stanceDefault?: boolean;
  origin: MoveOrigin;
}): ChainDef {
  const automatic = options.automatic ?? false;
  return Object.freeze({
    id: `${options.archetypeId}/${options.stance}/${options.slug}`,
    archetypeId: options.archetypeId,
    stance: options.stance,
    label: options.label,
    source: options.source,
    sourceIds: Object.freeze([...options.sourceIds]),
    limbs: Object.freeze([...options.limbs]),
    finish: options.finish ?? null,
    // Every source record is its own action; `automatic` decides whether the player presses
    // between them.
    links: Object.freeze(options.sourceIds.map((_, index) => Object.freeze({
      moveId: `${options.prefix}_${options.slug}_${index + 1}`,
      automatic,
    }))),
    stanceDefault: options.stanceDefault ?? false,
    origin: options.origin,
  });
}

// ---------------------------------------------------------------------------------------------
// Brad Hawk — authored (no Trial 13 source)
// ---------------------------------------------------------------------------------------------

const BRAD_HAWK_MOVES: readonly MoveDef[] = [
  // Neutral — "Hawk Barrage": a fast three-hit confirm string. Everything is a light reaction
  // until the last link, which is what makes the whole string worth confirming.
  move({
    id: 'brad_hawk_barrage_1', name: 'Hawk Jab', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 4, active: 2, recovery: 8, hitstop: 7, damage: 16, hitstun: 12, blockstun: 10,
    reach: 1.2, knockback: 55, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'brad_hawk_barrage_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', origin: 'authored',
  }),
  move({
    id: 'brad_hawk_barrage_2', name: 'Hawk Cross', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 5, active: 2, recovery: 10, hitstop: 8, damage: 22, hitstun: 14, blockstun: 11,
    reach: 1.3, knockback: 75, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'brad_hawk_barrage_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', origin: 'authored',
  }),
  move({
    id: 'brad_hawk_barrage_3', name: 'Hawk Finisher', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 8, active: 3, recovery: 14, hitstop: 12, damage: 34, hitstun: 20, blockstun: 15,
    reach: 1.6, knockback: 150, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RF', origin: 'authored',
  }),

  // Up — "Rising Knee": the launcher, then the aerial follow that actually juggles.
  move({
    id: 'brad_hawk_rising_knee_1', name: 'Rising Knee', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 6, active: 3, recovery: 16, hitstop: 12, damage: 28, hitstun: 20, blockstun: 14,
    reach: 1.3, knockback: 140, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
    chainNext: 'brad_hawk_rising_knee_2', chainNextMode: 'hitConfirm', limb: 'RF', origin: 'authored',
  }),
  // Aerial follow-ups reach further than their grounded counterpart on purpose: the launcher has
  // already shoved the victim away, so a juggle tool that only covered standing distance could
  // never be the second hit.
  move({
    id: 'brad_hawk_rising_knee_2', name: 'Hawk Air Slam', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 4, active: 4, recovery: 12, hitstop: 11, damage: 30, hitstun: 18, blockstun: 12,
    reach: 2, knockback: 40, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    airOnly: true, limb: 'LF', origin: 'authored',
  }),

  // Down — one committed sweep. The long recovery is the cost of the low read.
  move({
    id: 'brad_hawk_slide_tackle_1', name: 'Slide Tackle', stance: 'down', kind: 'sweep', guard: 'low',
    startup: 9, active: 3, recovery: 18, hitstop: 12, damage: 26, hitstun: 16, blockstun: 13,
    reach: 1.7, knockback: 60, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', origin: 'authored',
  }),

  // Side — "Spin Cycle": the mover's option when he would rather not commit to the barrage.
  move({
    id: 'brad_hawk_spin_cycle_1', name: 'Spin Cycle', stance: 'side', kind: 'strike', guard: 'high',
    startup: 7, active: 3, recovery: 12, hitstop: 10, damage: 24, hitstun: 15, blockstun: 12,
    reach: 1.6, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'brad_hawk_spin_cycle_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', origin: 'authored',
  }),
  move({
    id: 'brad_hawk_spin_cycle_2', name: 'Spin Cycle Finish', stance: 'side', kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 16, hitstop: 12, damage: 32, hitstun: 19, blockstun: 14,
    reach: 1.8, knockback: 140, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RF', origin: 'authored',
  }),

  move({
    id: 'brad_hawk_throw', name: 'Hawk Throw', stance: 'neutral', kind: 'grab', guard: 'throw',
    startup: 6, active: 2, recovery: 18, hitstop: 16, damage: 42, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LH', origin: 'authored',
  }),
  move({
    id: 'brad_hawk_reversal', name: 'Parkour Reversal', stance: 'neutral', kind: 'reversal', guard: 'throw',
    startup: 4, active: 2, recovery: 22, hitstop: 20, damage: 50, hitstun: 24, blockstun: 0,
    reach: 1.4, knockback: 180, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', origin: 'authored',
  }),
  move({
    id: 'brad_hawk_spa1', name: 'SPA 1 — Hawk Talon', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 8, active: 6, recovery: 26, hitstop: 20, damage: 130, hitstun: 36, blockstun: 20,
    reach: 2.1, knockback: 280, knockdown: false, launcher: false, spaCost: 50, spaTier: 1,
    limb: 'RF', origin: 'authored',
  }),
  move({
    id: 'brad_hawk_spa2', name: 'SPA 2 — Falcon Break', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 12, active: 10, recovery: 30, hitstop: 16, damage: 110, hitstun: 28, blockstun: 26,
    reach: 3.4, knockback: 380, knockdown: true, launcher: false, spaCost: 100, spaTier: 2,
    hitsAll: true, limb: 'LF', origin: 'authored',
  }),
];

const BRAD_HAWK_CHAINS: readonly ChainDef[] = [
  chain({
    archetypeId: 'brad_hawk', stance: 'neutral', slug: 'barrage', prefix: 'brad_hawk', label: 'Hawk Barrage',
    source: 'Brad Hawk', sourceIds: [0, 0, 0], limbs: ['RH', 'LH', 'RF'], stanceDefault: true,
    origin: 'authored',
  }),
  chain({
    archetypeId: 'brad_hawk', stance: 'up', slug: 'rising_knee', prefix: 'brad_hawk', label: 'Rising Knee',
    source: 'Brad Hawk', sourceIds: [0, 0], limbs: ['RF', 'LF'], stanceDefault: true,
    origin: 'authored',
  }),
  chain({
    archetypeId: 'brad_hawk', stance: 'down', slug: 'slide_tackle', prefix: 'brad_hawk', label: 'Slide Tackle',
    source: 'Brad Hawk', sourceIds: [0], limbs: ['LF'], stanceDefault: true,
    origin: 'authored',
  }),
  chain({
    archetypeId: 'brad_hawk', stance: 'side', slug: 'spin_cycle', prefix: 'brad_hawk', label: 'Spin Cycle',
    source: 'Brad Hawk', sourceIds: [0, 0], limbs: ['LF', 'RF'], stanceDefault: true,
    origin: 'authored',
  }),
];

// ---------------------------------------------------------------------------------------------
// Jack-5 — robot. Slow, armoured, enormous damage, and the only archetype with a charge.
// ---------------------------------------------------------------------------------------------

const JACK5_MOVES: readonly MoveDef[] = [
  // Neutral 1 — spec.py ('Jack5','neutral') "Rushing Uppercut Left", ids [405,462,444,466].
  // balance.py classes every link but the last as light, the last as heavy.
  move({
    id: 'jack5_rushing_uppercut_left_1', name: 'Rushing Uppercut Left 1', stance: 'neutral',
    kind: 'strike', guard: 'high',
    startup: 8, active: 3, recovery: 14, hitstop: 11, damage: 26, hitstun: 16, blockstun: 13,
    reach: 1.5, knockback: 80, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_rushing_uppercut_left_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Jack5', sourceActionId: 405, origin: 'trial13',
  }),
  move({
    id: 'jack5_rushing_uppercut_left_2', name: 'Rushing Uppercut Left 2', stance: 'neutral',
    kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 16, hitstop: 12, damage: 30, hitstun: 18, blockstun: 14,
    reach: 1.6, knockback: 100, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_rushing_uppercut_left_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Jack5', sourceActionId: 462, origin: 'trial13',
  }),
  move({
    id: 'jack5_rushing_uppercut_left_3', name: 'Rushing Uppercut Left 3', stance: 'neutral',
    kind: 'strike', guard: 'high',
    startup: 11, active: 4, recovery: 18, hitstop: 13, damage: 36, hitstun: 21, blockstun: 16,
    reach: 1.7, knockback: 130, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_rushing_uppercut_left_4', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Jack5', sourceActionId: 444, origin: 'trial13',
  }),
  move({
    id: 'jack5_rushing_uppercut_left_4', name: 'Rushing Uppercut Left 4', stance: 'neutral',
    kind: 'strike', guard: 'high',
    startup: 13, active: 4, recovery: 22, hitstop: 16, damage: 46, hitstun: 26, blockstun: 20,
    reach: 1.9, knockback: 190, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Jack5', sourceActionId: 466, origin: 'trial13',
  }),

  // Neutral 2 — "Double Hammer", ids [362,477]. The terminal is Jack-5's heavy neutral
  // (`classify('Jack5',0,-1,'heavy')` in balance.py).
  move({
    id: 'jack5_double_hammer_1', name: 'Double Hammer 1', stance: 'neutral',
    kind: 'strike', guard: 'high',
    startup: 12, active: 4, recovery: 18, hitstop: 14, damage: 34, hitstun: 20, blockstun: 16,
    reach: 1.7, knockback: 120, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_double_hammer_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Jack5', sourceActionId: 362, origin: 'trial13',
  }),
  move({
    id: 'jack5_double_hammer_2', name: 'Double Hammer 2', stance: 'neutral',
    kind: 'strike', guard: 'high',
    startup: 16, active: 5, recovery: 24, hitstop: 18, damage: 52, hitstun: 30, blockstun: 22,
    reach: 2, knockback: 220, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Jack5', sourceActionId: 477, origin: 'trial13',
  }),

  // Side 1 — "Cemaho Chop", id [549].
  move({
    id: 'jack5_cemaho_chop_1', name: 'Cemaho Chop', stance: 'side', kind: 'strike', guard: 'high',
    startup: 10, active: 4, recovery: 16, hitstop: 13, damage: 38, hitstun: 22, blockstun: 16,
    reach: 1.6, knockback: 140, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Jack5', sourceActionId: 549, origin: 'trial13',
  }),

  // Side 2 — "Piston Gun", ids [380..384], `automatic=True, finish='stagger'`. One button, five
  // distinct actions, four of them staggering (automatic_hits.py: earlier hits stagger, only the
  // final hit applies the finishing reaction).
  move({
    id: 'jack5_piston_gun_1', name: 'Piston Gun 1', stance: 'side', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 8, damage: 14, hitstun: 10, blockstun: 9,
    reach: 1.7, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_piston_gun_2', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jack5', sourceActionId: 380, origin: 'trial13',
  }),
  move({
    id: 'jack5_piston_gun_2', name: 'Piston Gun 2', stance: 'side', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 8, damage: 14, hitstun: 10, blockstun: 9,
    reach: 1.7, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_piston_gun_3', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jack5', sourceActionId: 381, origin: 'trial13',
  }),
  move({
    id: 'jack5_piston_gun_3', name: 'Piston Gun 3', stance: 'side', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 8, damage: 14, hitstun: 10, blockstun: 9,
    reach: 1.7, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_piston_gun_4', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jack5', sourceActionId: 382, origin: 'trial13',
  }),
  move({
    id: 'jack5_piston_gun_4', name: 'Piston Gun 4', stance: 'side', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 8, damage: 14, hitstun: 10, blockstun: 9,
    reach: 1.7, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jack5_piston_gun_5', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jack5', sourceActionId: 383, origin: 'trial13',
  }),
  move({
    id: 'jack5_piston_gun_5', name: 'Piston Gun 5', stance: 'side', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 10, damage: 18, hitstun: 14, blockstun: 11,
    reach: 1.7, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    stagger: true, limb: 'RH', source: 'Jack5', sourceActionId: 384, origin: 'trial13',
  }),

  // Side 3 — "Rocket Uppercut", id [578], `finish='launch'`. refinements.py gives it the native
  // high uppercut launch reaction rather than the low kick flip, and balance.py confirms the
  // Jack-5 side chain terminates on a launch (`classify('Jack5',3,-1,'launch')` — direction 3 is
  // the *side* input). It is an uppercut, but it answers to the side button.
  move({
    id: 'jack5_rocket_uppercut_1', name: 'Rocket Uppercut', stance: 'side', kind: 'launcher',
    guard: 'mid',
    startup: 14, active: 5, recovery: 26, hitstop: 18, damage: 58, hitstun: 30, blockstun: 18,
    reach: 1.5, knockback: 260, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Jack5', sourceActionId: 578, origin: 'trial13',
  }),

  // Up — authored. spec.py routes no `('Jack5','up')` chain (his launcher is filed under the side
  // input), but the 4-way directional read (AGENTS.md §5) still needs one.
  move({
    id: 'jack5_servo_launch_1', name: 'Servo Launch', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 12, active: 4, recovery: 22, hitstop: 16, damage: 44, hitstun: 28, blockstun: 17,
    reach: 1.4, knockback: 220, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
    limb: 'LH', origin: 'authored',
  }),

  // Gigaton — gigaton_charge.py: five releases off one gauge charge, damage
  // `round(base * (1 + 0.4 * i))`, and `full_final_recovery` on the last one.
  move({
    id: 'jack5_gigaton_1', name: 'Gigaton Hammer Lv.1', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 8, active: 6, recovery: 30, hitstop: 20, damage: 90, hitstun: 34, blockstun: 22,
    reach: 2.4, knockback: 300, knockdown: true, launcher: false, spaCost: 50, spaTier: 1,
    chargeLevel: 1, limb: 'RH', source: 'Jack5', sourceActionId: 4204, origin: 'trial13',
  }),
  move({
    id: 'jack5_gigaton_2', name: 'Gigaton Hammer Lv.2', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 8, active: 6, recovery: 34, hitstop: 22, damage: 126, hitstun: 36, blockstun: 24,
    reach: 2.4, knockback: 320, knockdown: true, launcher: false, spaCost: 0, spaTier: 1,
    chargeLevel: 2, limb: 'RH', source: 'Jack5', sourceActionId: 4204, origin: 'trial13',
  }),
  move({
    id: 'jack5_gigaton_3', name: 'Gigaton Hammer Lv.3', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 8, active: 6, recovery: 38, hitstop: 24, damage: 162, hitstun: 38, blockstun: 25,
    reach: 2.4, knockback: 340, knockdown: true, launcher: false, spaCost: 0, spaTier: 1,
    chargeLevel: 3, limb: 'RH', source: 'Jack5', sourceActionId: 4204, origin: 'trial13',
  }),
  move({
    id: 'jack5_gigaton_4', name: 'Gigaton Hammer Lv.4', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 8, active: 6, recovery: 42, hitstop: 26, damage: 198, hitstun: 40, blockstun: 26,
    reach: 2.4, knockback: 360, knockdown: true, launcher: false, spaCost: 0, spaTier: 1,
    chargeLevel: 4, limb: 'RH', source: 'Jack5', sourceActionId: 4204, origin: 'trial13',
  }),
  move({
    id: 'jack5_gigaton_5', name: 'Gigaton Hammer Lv.5', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 8, active: 7, recovery: 48, hitstop: 28, damage: 234, hitstun: 42, blockstun: 28,
    reach: 2.4, knockback: 400, knockdown: true, launcher: false, spaCost: 0, spaTier: 1,
    chargeLevel: 5, limb: 'RH', source: 'Jack5', sourceActionId: 4204, origin: 'trial13',
  }),

  // Down — authored. spec.py routes no `('Jack5','down')` chain, but the 4-way directional read
  // (AGENTS.md §5) is not optional, so he gets the grounded armoured sweep his weight implies.
  move({
    id: 'jack5_ground_grinder_1', name: 'Ground Grinder', stance: 'down', kind: 'sweep',
    guard: 'low',
    startup: 14, active: 4, recovery: 24, hitstop: 16, damage: 48, hitstun: 26, blockstun: 19,
    reach: 1.8, knockback: 80, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', origin: 'authored',
  }),

  // Default throw — TWEAKS['jack5_default_throw'] = "Rotary Catapult with paired victim
  // animation"; throw_patch.py drives the pair over 144 frames.
  move({
    id: 'jack5_rotary_catapult', name: 'Rotary Catapult', stance: 'neutral', kind: 'grab',
    guard: 'throw',
    startup: 12, active: 3, recovery: 40, hitstop: 20, damage: 95, hitstun: 0, blockstun: 0,
    reach: 1.2, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LH', source: 'Jack5', sourceActionId: 3112, origin: 'trial13',
  }),
  move({
    id: 'jack5_reversal', name: 'Servo Reversal', stance: 'neutral', kind: 'reversal', guard: 'throw',
    startup: 6, active: 2, recovery: 26, hitstop: 20, damage: 58, hitstun: 26, blockstun: 0,
    reach: 1.5, knockback: 200, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Jack5', sourceActionId: 3112, origin: 'trial13',
  }),
  move({
    id: 'jack5_spa1', name: 'SPA 1 — Rocket Lariat', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 10, active: 8, recovery: 28, hitstop: 20, damage: 150, hitstun: 36, blockstun: 22,
    reach: 2.3, knockback: 320, knockdown: false, launcher: false, spaCost: 50, spaTier: 1,
    limb: 'RH', source: 'Jack5', sourceActionId: 3009, origin: 'trial13',
  }),
  move({
    id: 'jack5_spa2', name: 'SPA 2 — Overdrive Crush', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 14, active: 10, recovery: 32, hitstop: 16, damage: 135, hitstun: 28, blockstun: 26,
    reach: 3.6, knockback: 400, knockdown: true, launcher: false, spaCost: 100, spaTier: 2,
    hitsAll: true, limb: 'LF', source: 'Jack5', sourceActionId: 1524, origin: 'trial13',
  }),
];

const JACK5_CHAINS: readonly ChainDef[] = [
  chain({
    archetypeId: 'jack5', stance: 'neutral', slug: 'rushing_uppercut_left', prefix: 'jack5',
    label: 'Rushing Uppercut Left', source: 'Jack5', sourceIds: [405, 462, 444, 466],
    limbs: ['LH', 'RH', 'LH', 'RH'], stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'jack5', stance: 'neutral', slug: 'double_hammer', prefix: 'jack5', label: 'Double Hammer',
    source: 'Jack5', sourceIds: [362, 477], limbs: ['LH', 'RH'], origin: 'trial13',
  }),
  chain({
    archetypeId: 'jack5', stance: 'side', slug: 'piston_gun', prefix: 'jack5', label: 'Piston Gun',
    source: 'Jack5', sourceIds: [380, 381, 382, 383, 384], limbs: ['RH', 'RH', 'RH', 'RH', 'RH'],
    finish: 'stagger', automatic: true, stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'jack5', stance: 'side', slug: 'cemaho_chop', prefix: 'jack5', label: 'Cemaho Chop',
    source: 'Jack5', sourceIds: [549], limbs: ['RH'], origin: 'trial13',
  }),
  chain({
    archetypeId: 'jack5', stance: 'side', slug: 'rocket_uppercut', prefix: 'jack5',
    label: 'Rocket Uppercut', source: 'Jack5', sourceIds: [578], limbs: ['RH'], finish: 'launch',
    origin: 'trial13',
  }),
  chain({
    archetypeId: 'jack5', stance: 'up', slug: 'servo_launch', prefix: 'jack5', label: 'Servo Launch',
    source: 'Jack5', sourceIds: [0], limbs: ['LH'], stanceDefault: true, origin: 'authored',
  }),
  chain({
    archetypeId: 'jack5', stance: 'down', slug: 'ground_grinder', prefix: 'jack5',
    label: 'Ground Grinder', source: 'Jack5', sourceIds: [0], limbs: ['LF'],
    stanceDefault: true, origin: 'authored',
  }),
];

// ---------------------------------------------------------------------------------------------
// Jin Kazama — martial artist. Fastest archetype, weakest links, longest strings.
// ---------------------------------------------------------------------------------------------

const JIN_MOVES: readonly MoveDef[] = [
  // Side 1 — "Kazama Style 5 Hit Combo", ids [342,346,349,354,357]. Not automatic, so five
  // presses, five confirms.
  move({
    id: 'jin_kazama_style_5_hit_combo_1', name: 'Kazama Style 5 Hit 1', stance: 'side',
    kind: 'strike', guard: 'high',
    startup: 5, active: 2, recovery: 9, hitstop: 7, damage: 14, hitstun: 11, blockstun: 10,
    reach: 1.2, knockback: 40, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_kazama_style_5_hit_combo_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Jin', sourceActionId: 342, origin: 'trial13',
  }),
  move({
    id: 'jin_kazama_style_5_hit_combo_2', name: 'Kazama Style 5 Hit 2', stance: 'side',
    kind: 'strike', guard: 'high',
    startup: 5, active: 2, recovery: 9, hitstop: 7, damage: 15, hitstun: 11, blockstun: 10,
    reach: 1.2, knockback: 45, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_kazama_style_5_hit_combo_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', source: 'Jin', sourceActionId: 346, origin: 'trial13',
  }),
  move({
    id: 'jin_kazama_style_5_hit_combo_3', name: 'Kazama Style 5 Hit 3', stance: 'side',
    kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 10, hitstop: 8, damage: 16, hitstun: 12, blockstun: 11,
    reach: 1.3, knockback: 50, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_kazama_style_5_hit_combo_4', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Jin', sourceActionId: 349, origin: 'trial13',
  }),
  move({
    id: 'jin_kazama_style_5_hit_combo_4', name: 'Kazama Style 5 Hit 4', stance: 'side',
    kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 10, hitstop: 8, damage: 18, hitstun: 13, blockstun: 11,
    reach: 1.3, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_kazama_style_5_hit_combo_5', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Jin', sourceActionId: 354, origin: 'trial13',
  }),
  move({
    id: 'jin_kazama_style_5_hit_combo_5', name: 'Kazama Style 5 Hit 5', stance: 'side',
    kind: 'strike', guard: 'high',
    startup: 8, active: 3, recovery: 14, hitstop: 12, damage: 28, hitstun: 20, blockstun: 15,
    reach: 1.7, knockback: 130, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RF', source: 'Jin', sourceActionId: 357, origin: 'trial13',
  }),

  // Side 2 — "Savage Sword", ids [540,541,542]. balance.py classifies the terminal heavy.
  move({
    id: 'jin_savage_sword_1', name: 'Savage Sword 1', stance: 'side', kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 14, hitstop: 11, damage: 26, hitstun: 17, blockstun: 13,
    reach: 1.5, knockback: 80, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_savage_sword_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Jin', sourceActionId: 540, origin: 'trial13',
  }),
  move({
    id: 'jin_savage_sword_2', name: 'Savage Sword 2', stance: 'side', kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 14, hitstop: 11, damage: 28, hitstun: 18, blockstun: 14,
    reach: 1.6, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_savage_sword_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Jin', sourceActionId: 541, origin: 'trial13',
  }),
  move({
    id: 'jin_savage_sword_3', name: 'Savage Sword 3', stance: 'side', kind: 'strike', guard: 'high',
    startup: 13, active: 4, recovery: 20, hitstop: 15, damage: 44, hitstun: 28, blockstun: 20,
    reach: 2, knockback: 200, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', source: 'Jin', sourceActionId: 542, origin: 'trial13',
  }),

  // Neutral 1 — "Knee Popper to Sidekick", ids [467,468].
  move({
    id: 'jin_knee_popper_to_sidekick_1', name: 'Knee Popper', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 6, active: 2, recovery: 10, hitstop: 8, damage: 18, hitstun: 13, blockstun: 11,
    reach: 1.3, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_knee_popper_to_sidekick_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', source: 'Jin', sourceActionId: 467, origin: 'trial13',
  }),
  move({
    id: 'jin_knee_popper_to_sidekick_2', name: 'Sidekick', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 7, active: 3, recovery: 13, hitstop: 10, damage: 26, hitstun: 17, blockstun: 13,
    reach: 1.6, knockback: 100, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', source: 'Jin', sourceActionId: 468, origin: 'trial13',
  }),

  // Neutral 2 — "Thrust to Roundhouse", ids [481,490].
  move({
    id: 'jin_thrust_to_roundhouse_1', name: 'Thrust', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 7, active: 2, recovery: 11, hitstop: 9, damage: 20, hitstun: 14, blockstun: 12,
    reach: 1.6, knockback: 70, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_thrust_to_roundhouse_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Jin', sourceActionId: 481, origin: 'trial13',
  }),
  move({
    id: 'jin_thrust_to_roundhouse_2', name: 'Roundhouse', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 9, active: 3, recovery: 15, hitstop: 12, damage: 30, hitstun: 19, blockstun: 15,
    reach: 1.9, knockback: 140, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RF', source: 'Jin', sourceActionId: 490, origin: 'trial13',
  }),

  // Neutral 3 — "Double Chamber Punch", ids [497,498], `automatic=True`: one button, two
  // contacts. The last link carries the heavy reaction balance.py asks for on the Jin neutral
  // chain (`classify('Jin',0,-1,'heavy')`), without knocking down.
  move({
    id: 'jin_double_chamber_punch_1', name: 'Chamber Punch 1', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 6, active: 2, recovery: 8, hitstop: 8, damage: 17, hitstun: 12, blockstun: 10,
    reach: 1.4, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'jin_double_chamber_punch_2', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jin', sourceActionId: 497, origin: 'trial13',
  }),
  move({
    id: 'jin_double_chamber_punch_2', name: 'Chamber Punch 2', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 6, active: 2, recovery: 10, hitstop: 10, damage: 26, hitstun: 16, blockstun: 13,
    reach: 1.4, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LH', source: 'Jin', sourceActionId: 498, origin: 'trial13',
  }),

  // Up — authored. spec.py has no Jin up chain; the launcher and its aerial follow are needed
  // for Jin to participate in juggles at all.
  move({
    id: 'jin_rising_fang_1', name: 'Rising Fang', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 7, active: 3, recovery: 18, hitstop: 13, damage: 30, hitstun: 22, blockstun: 14,
    reach: 1.3, knockback: 180, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
    chainNext: 'jin_rising_fang_2', chainNextMode: 'hitConfirm', limb: 'RF', origin: 'authored',
  }),
  move({
    id: 'jin_rising_fang_2', name: 'Air Fang', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 4, active: 3, recovery: 10, hitstop: 10, damage: 24, hitstun: 16, blockstun: 12,
    reach: 2, knockback: 40, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    airOnly: true, limb: 'LF', origin: 'authored',
  }),

  // Down — remaining_moves.py: the first Jin down link is a sweep and the chain ends on the
  // `T13-Jin-getup` rise, so the whole down string is one committed sweep whose recovery is the
  // kip-up.
  move({
    id: 'jin_low_slide_1', name: 'Kazama Low Slide', stance: 'down', kind: 'sweep', guard: 'low',
    startup: 8, active: 3, recovery: 16, hitstop: 11, damage: 22, hitstun: 15, blockstun: 12,
    reach: 1.7, knockback: 60, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', source: 'Jin', sourceActionId: 1719, origin: 'trial13',
  }),

  // SPA 2 — the flurry. Four automatic contacts off one gauge spend; only the first pays.
  move({
    id: 'jin_flurry_1', name: 'SPA 2 Flurry 1', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 8, active: 2, recovery: 6, hitstop: 10, damage: 30, hitstun: 20, blockstun: 14,
    reach: 1.8, knockback: 0, knockdown: false, launcher: false, spaCost: 100, spaTier: 2,
    chainNext: 'jin_flurry_2', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jin', sourceActionId: 1719, origin: 'authored',
  }),
  move({
    id: 'jin_flurry_2', name: 'SPA 2 Flurry 2', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 10, damage: 32, hitstun: 20, blockstun: 15,
    reach: 1.8, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 2,
    chainNext: 'jin_flurry_3', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Jin', sourceActionId: 1719, origin: 'authored',
  }),
  move({
    id: 'jin_flurry_3', name: 'SPA 2 Flurry 3', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 6, active: 2, recovery: 6, hitstop: 11, damage: 36, hitstun: 22, blockstun: 16,
    reach: 1.8, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 2,
    chainNext: 'jin_flurry_4', chainNextMode: 'automatic', stagger: true,
    limb: 'LF', source: 'Jin', sourceActionId: 1719, origin: 'authored',
  }),
  move({
    id: 'jin_flurry_4', name: 'SPA 2 Flurry 4', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 10, active: 4, recovery: 18, hitstop: 18, damage: 47, hitstun: 34, blockstun: 22,
    reach: 1.8, knockback: 220, knockdown: true, launcher: false, spaCost: 0, spaTier: 2,
    limb: 'RF', source: 'Jin', sourceActionId: 1719, origin: 'authored',
  }),

  move({
    id: 'jin_throw', name: 'Kazama Throw', stance: 'neutral', kind: 'grab', guard: 'throw',
    startup: 5, active: 2, recovery: 18, hitstop: 16, damage: 40, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LH', source: 'Jin', sourceActionId: 1719, origin: 'authored',
  }),
  move({
    id: 'jin_reversal', name: 'Tiger Reversal', stance: 'neutral', kind: 'reversal', guard: 'throw',
    startup: 4, active: 2, recovery: 24, hitstop: 20, damage: 52, hitstun: 26, blockstun: 0,
    reach: 1.5, knockback: 200, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', source: 'Jin', sourceActionId: 1719, origin: 'authored',
  }),
];

const JIN_CHAINS: readonly ChainDef[] = [
  chain({
    archetypeId: 'jin_kazama', stance: 'side', slug: 'kazama_style_5_hit_combo', prefix: 'jin',
    label: 'Kazama Style 5 Hit Combo', source: 'Jin', sourceIds: [342, 346, 349, 354, 357],
    limbs: ['LH', 'LF', 'RH', 'LH', 'RF'], stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'jin_kazama', stance: 'side', slug: 'savage_sword', prefix: 'jin', label: 'Savage Sword',
    source: 'Jin', sourceIds: [540, 541, 542], limbs: ['RH', 'RH', 'LF'], origin: 'trial13',
  }),
  chain({
    archetypeId: 'jin_kazama', stance: 'neutral', slug: 'double_chamber_punch', prefix: 'jin',
    label: 'Double Chamber Punch', source: 'Jin', sourceIds: [497, 498], limbs: ['RH', 'LH'],
    automatic: true, stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'jin_kazama', stance: 'neutral', slug: 'knee_popper_to_sidekick', prefix: 'jin',
    label: 'Knee Popper to Sidekick', source: 'Jin', sourceIds: [467, 468], limbs: ['LF', 'LF'],
    origin: 'trial13',
  }),
  chain({
    archetypeId: 'jin_kazama', stance: 'neutral', slug: 'thrust_to_roundhouse', prefix: 'jin',
    label: 'Thrust to Roundhouse', source: 'Jin', sourceIds: [481, 490], limbs: ['LH', 'RF'],
    origin: 'trial13',
  }),
  chain({
    archetypeId: 'jin_kazama', stance: 'up', slug: 'rising_fang', prefix: 'jin', label: 'Rising Fang',
    source: 'Jin', sourceIds: [0, 0], limbs: ['RF', 'LF'], stanceDefault: true, origin: 'authored',
  }),
  chain({
    archetypeId: 'jin_kazama', stance: 'down', slug: 'low_slide', prefix: 'jin', label: 'Kazama Low Slide',
    source: 'Jin', sourceIds: [1719], limbs: ['LF'], stanceDefault: true, origin: 'authored',
  }),
];

// ---------------------------------------------------------------------------------------------
// Bryan Fury — drone pilot. Mid damage, very fast strings, a 150-damage four-stage SPA 1.
// ---------------------------------------------------------------------------------------------

const BRYAN_MOVES: readonly MoveDef[] = [
  // Neutral 1 — "Gatling Combination", spec.py ('Kiryu','neutral') with source 'Bryan',
  // ids [409,530,531,552], limbs LF,RH,LH,RF. refinements.py is explicit: "Gatling's fourth
  // hit must stagger", and balance.py makes links 2 and 3 medium reactions.
  move({
    id: 'bryan_gatling_1', name: 'Gatling 1', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 8, hitstop: 8, damage: 18, hitstun: 13, blockstun: 11,
    reach: 1.4, knockback: 50, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_gatling_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', source: 'Bryan', sourceActionId: 409, origin: 'trial13',
  }),
  move({
    id: 'bryan_gatling_2', name: 'Gatling 2', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 6, active: 2, recovery: 8, hitstop: 8, damage: 19, hitstun: 13, blockstun: 11,
    reach: 1.4, knockback: 55, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_gatling_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Bryan', sourceActionId: 530, origin: 'trial13',
  }),
  move({
    id: 'bryan_gatling_3', name: 'Gatling 3', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 7, active: 2, recovery: 9, hitstop: 9, damage: 21, hitstun: 14, blockstun: 12,
    reach: 1.5, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_gatling_4', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 531, origin: 'trial13',
  }),
  move({
    id: 'bryan_gatling_4', name: 'Gatling 4', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 12, hitstop: 11, damage: 30, hitstun: 19, blockstun: 15,
    reach: 1.7, knockback: 120, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    stagger: true, limb: 'RF', source: 'Bryan', sourceActionId: 552, origin: 'trial13',
  }),

  // Neutral 2 — "Python Crush", ids [597,601], limbs RH,LF.
  move({
    id: 'bryan_python_crush_1', name: 'Python Crush 1', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 8, active: 3, recovery: 14, hitstop: 11, damage: 26, hitstun: 17, blockstun: 14,
    reach: 1.5, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_python_crush_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Bryan', sourceActionId: 597, origin: 'trial13',
  }),
  move({
    id: 'bryan_python_crush_2', name: 'Python Crush 2', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 12, active: 4, recovery: 20, hitstop: 16, damage: 44, hitstun: 28, blockstun: 20,
    reach: 2, knockback: 210, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', source: 'Bryan', sourceActionId: 601, origin: 'trial13',
  }),

  // Side 1 — "Vulcan Cannon", ids [474,501,502,503], LH on all four. spec.py does not mark it
  // automatic, so it is four confirmed shots rather than one held trigger.
  move({
    id: 'bryan_vulcan_cannon_1', name: 'Vulcan Cannon 1', stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 7, active: 2, recovery: 9, hitstop: 9, damage: 24, hitstun: 15, blockstun: 12,
    reach: 1.9, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_vulcan_cannon_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 474, origin: 'trial13',
  }),
  move({
    id: 'bryan_vulcan_cannon_2', name: 'Vulcan Cannon 2', stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 7, active: 2, recovery: 9, hitstop: 9, damage: 25, hitstun: 16, blockstun: 13,
    reach: 1.9, knockback: 65, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_vulcan_cannon_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 501, origin: 'trial13',
  }),
  move({
    id: 'bryan_vulcan_cannon_3', name: 'Vulcan Cannon 3', stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 8, active: 2, recovery: 10, hitstop: 10, damage: 26, hitstun: 16, blockstun: 13,
    reach: 2, knockback: 70, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_vulcan_cannon_4', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 502, origin: 'trial13',
  }),
  move({
    id: 'bryan_vulcan_cannon_4', name: 'Vulcan Cannon 4', stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 11, active: 4, recovery: 16, hitstop: 13, damage: 40, hitstun: 26, blockstun: 19,
    reach: 2.2, knockback: 170, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LH', source: 'Bryan', sourceActionId: 503, origin: 'trial13',
  }),

  // Side 2 — "Double Body Blow", ids [474,504], limbs LH,RH.
  move({
    id: 'bryan_double_body_blow_1', name: 'Double Body Blow 1', stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 9, active: 3, recovery: 14, hitstop: 11, damage: 28, hitstun: 18, blockstun: 15,
    reach: 1.5, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_double_body_blow_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 474, origin: 'trial13',
  }),
  move({
    id: 'bryan_double_body_blow_2', name: 'Double Body Blow 2', stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 12, active: 4, recovery: 18, hitstop: 14, damage: 42, hitstun: 27, blockstun: 20,
    reach: 1.8, knockback: 180, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Bryan', sourceActionId: 504, origin: 'trial13',
  }),

  // Side 3 — "Lair's Dance", ids [369,560,513,512,508]. balance.py terminates the Bryan side
  // chain on a *heavy* reaction (`for d in [0,3]: classify('Bryan',d,-1,'heavy')` — 0 neutral,
  // 3 side), while the launch belongs to his up chain. So this finisher is big but does not
  // knock down: it is the end of a string, not a reset.
  move({
    id: 'bryan_lairs_dance_1', name: "Lair's Dance 1", stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 7, active: 2, recovery: 9, hitstop: 8, damage: 20, hitstun: 14, blockstun: 12,
    reach: 1.4, knockback: 50, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_lairs_dance_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 369, origin: 'trial13',
  }),
  move({
    id: 'bryan_lairs_dance_2', name: "Lair's Dance 2", stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 7, active: 2, recovery: 9, hitstop: 8, damage: 21, hitstun: 14, blockstun: 12,
    reach: 1.4, knockback: 55, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_lairs_dance_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RF', source: 'Bryan', sourceActionId: 560, origin: 'trial13',
  }),
  move({
    id: 'bryan_lairs_dance_3', name: "Lair's Dance 3", stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 8, active: 2, recovery: 10, hitstop: 9, damage: 23, hitstun: 15, blockstun: 13,
    reach: 1.5, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_lairs_dance_4', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Bryan', sourceActionId: 513, origin: 'trial13',
  }),
  move({
    id: 'bryan_lairs_dance_4', name: "Lair's Dance 4", stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 8, active: 2, recovery: 10, hitstop: 9, damage: 25, hitstun: 16, blockstun: 14,
    reach: 1.5, knockback: 70, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_lairs_dance_5', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 512, origin: 'trial13',
  }),
  move({
    id: 'bryan_lairs_dance_5', name: "Lair's Dance 5", stance: 'side', kind: 'strike',
    guard: 'high',
    startup: 12, active: 5, recovery: 22, hitstop: 17, damage: 54, hitstun: 36, blockstun: 24,
    reach: 1.8, knockback: 210, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Bryan', sourceActionId: 508, origin: 'trial13',
  }),

  // Neutral 3 — "Mid Kick to Rush", ids [409,530,531,545].
  move({
    id: 'bryan_mid_kick_to_rush_1', name: 'Mid Kick to Rush 1', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 6, active: 2, recovery: 9, hitstop: 8, damage: 19, hitstun: 14, blockstun: 12,
    reach: 1.3, knockback: 50, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_mid_kick_to_rush_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', source: 'Bryan', sourceActionId: 409, origin: 'trial13',
  }),
  move({
    id: 'bryan_mid_kick_to_rush_2', name: 'Mid Kick to Rush 2', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 7, active: 2, recovery: 10, hitstop: 9, damage: 22, hitstun: 15, blockstun: 13,
    reach: 1.4, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_mid_kick_to_rush_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'RH', source: 'Bryan', sourceActionId: 530, origin: 'trial13',
  }),
  move({
    id: 'bryan_mid_kick_to_rush_3', name: 'Mid Kick to Rush 3', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 8, active: 2, recovery: 11, hitstop: 9, damage: 24, hitstun: 16, blockstun: 13,
    reach: 1.5, knockback: 70, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_mid_kick_to_rush_4', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 531, origin: 'trial13',
  }),
  move({
    id: 'bryan_mid_kick_to_rush_4', name: 'Mid Kick to Rush 4', stance: 'neutral', kind: 'strike',
    guard: 'high',
    startup: 11, active: 3, recovery: 15, hitstop: 13, damage: 34, hitstun: 22, blockstun: 17,
    reach: 1.7, knockback: 140, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Bryan', sourceActionId: 545, origin: 'trial13',
  }),

  // Up — "Anaconda Bite", ids [409,572,593], `finish='launch'`.
  move({
    id: 'bryan_anaconda_bite_1', name: 'Anaconda Bite 1', stance: 'up', kind: 'strike',
    guard: 'high',
    startup: 6, active: 2, recovery: 9, hitstop: 8, damage: 20, hitstun: 14, blockstun: 12,
    reach: 1.3, knockback: 50, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_anaconda_bite_2', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', source: 'Bryan', sourceActionId: 409, origin: 'trial13',
  }),
  move({
    id: 'bryan_anaconda_bite_2', name: 'Anaconda Bite 2', stance: 'up', kind: 'strike',
    guard: 'high',
    startup: 7, active: 2, recovery: 10, hitstop: 9, damage: 23, hitstun: 15, blockstun: 13,
    reach: 1.4, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    chainNext: 'bryan_anaconda_bite_3', chainNextMode: 'hitConfirm', stagger: true,
    limb: 'LF', source: 'Bryan', sourceActionId: 572, origin: 'trial13',
  }),
  move({
    id: 'bryan_anaconda_bite_3', name: 'Anaconda Bite 3', stance: 'up', kind: 'launcher',
    guard: 'mid',
    startup: 12, active: 4, recovery: 20, hitstop: 16, damage: 46, hitstun: 30, blockstun: 18,
    reach: 1.7, knockback: 260, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Bryan', sourceActionId: 593, origin: 'trial13',
  }),

  // Down — authored. spec.py routes no `('Bryan','down')` chain, so his low read is written here
  // to keep the 4-way directional read (AGENTS.md §5) complete for every archetype.
  move({
    id: 'bryan_drone_dive_1', name: 'Drone Dive Kick', stance: 'down', kind: 'sweep',
    guard: 'low',
    startup: 9, active: 3, recovery: 17, hitstop: 12, damage: 24, hitstun: 16, blockstun: 13,
    reach: 1.7, knockback: 60, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LF', origin: 'authored',
  }),

  // SPA 1 — bryan_spa.py: four private stages, gauge charged once on the first, 150 total
  // damage weighted across the stages, `full_final_recovery` on the last. The native ISO cost is
  // 400 of 1000, i.e. 40% of the bar.
  move({
    id: 'bryan_spa1_1', name: 'SPA 1 Stage 1', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 8, active: 2, recovery: 8, hitstop: 10, damage: 34, hitstun: 18, blockstun: 13,
    reach: 1.8, knockback: 0, knockdown: false, launcher: false, spaCost: 40, spaTier: 1,
    chainNext: 'bryan_spa1_2', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Bryan', sourceActionId: 3002, origin: 'trial13',
  }),
  move({
    id: 'bryan_spa1_2', name: 'SPA 1 Stage 2', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 7, active: 2, recovery: 7, hitstop: 10, damage: 36, hitstun: 18, blockstun: 13,
    reach: 1.8, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 1,
    chainNext: 'bryan_spa1_3', chainNextMode: 'automatic', stagger: true,
    limb: 'RH', source: 'Bryan', sourceActionId: 3002, origin: 'trial13',
  }),
  move({
    id: 'bryan_spa1_3', name: 'SPA 1 Stage 3', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 7, active: 2, recovery: 7, hitstop: 10, damage: 38, hitstun: 19, blockstun: 14,
    reach: 1.8, knockback: 0, knockdown: false, launcher: false, spaCost: 0, spaTier: 1,
    chainNext: 'bryan_spa1_4', chainNextMode: 'automatic', stagger: true,
    limb: 'LH', source: 'Bryan', sourceActionId: 3002, origin: 'trial13',
  }),
  move({
    id: 'bryan_spa1_4', name: 'SPA 1 Finisher', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 11, active: 4, recovery: 24, hitstop: 18, damage: 42, hitstun: 32, blockstun: 20,
    reach: 1.8, knockback: 210, knockdown: true, launcher: false, spaCost: 0, spaTier: 1,
    limb: 'LH', source: 'Bryan', sourceActionId: 3002, origin: 'trial13',
  }),

  move({
    id: 'bryan_throw', name: 'Drone Throw', stance: 'neutral', kind: 'grab', guard: 'throw',
    startup: 7, active: 2, recovery: 18, hitstop: 16, damage: 44, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'RH', source: 'Bryan', sourceActionId: 369, origin: 'authored',
  }),
  move({
    id: 'bryan_reversal', name: 'Drone Reversal', stance: 'neutral', kind: 'reversal',
    guard: 'throw',
    startup: 5, active: 2, recovery: 22, hitstop: 20, damage: 50, hitstun: 24, blockstun: 0,
    reach: 1.5, knockback: 190, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    limb: 'LH', source: 'Bryan', sourceActionId: 369, origin: 'authored',
  }),
  move({
    id: 'bryan_spa2', name: 'SPA 2 — Aerial Barrage', stance: 'neutral', kind: 'special',
    guard: 'high',
    startup: 13, active: 10, recovery: 32, hitstop: 16, damage: 125, hitstun: 30, blockstun: 26,
    reach: 3.5, knockback: 380, knockdown: true, launcher: false, spaCost: 100, spaTier: 2,
    hitsAll: true, limb: 'RF', source: 'Bryan', sourceActionId: 3002, origin: 'authored',
  }),
];

const BRYAN_CHAINS: readonly ChainDef[] = [
  chain({
    archetypeId: 'bryan_fury', stance: 'neutral', slug: 'gatling', prefix: 'bryan', label: 'Gatling Combination',
    source: 'Bryan', sourceIds: [409, 530, 531, 552], limbs: ['LF', 'RH', 'LH', 'RF'],
    stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'neutral', slug: 'python_crush', prefix: 'bryan', label: 'Python Crush',
    source: 'Bryan', sourceIds: [597, 601], limbs: ['RH', 'LF'], origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'neutral', slug: 'mid_kick_to_rush', prefix: 'bryan',
    label: 'Mid Kick to Rush', source: 'Bryan', sourceIds: [409, 530, 531, 545],
    limbs: ['LF', 'RH', 'LH', 'RH'], origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'side', slug: 'vulcan_cannon', prefix: 'bryan', label: 'Vulcan Cannon',
    source: 'Bryan', sourceIds: [474, 501, 502, 503], limbs: ['LH', 'LH', 'LH', 'LH'],
    stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'side', slug: 'lairs_dance', prefix: 'bryan', label: "Lair's Dance",
    source: 'Bryan', sourceIds: [369, 560, 513, 512, 508], limbs: ['LH', 'RF', 'RH', 'LH', 'RH'],
    origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'side', slug: 'double_body_blow', prefix: 'bryan',
    label: 'Double Body Blow', source: 'Bryan', sourceIds: [474, 504], limbs: ['LH', 'RH'],
    origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'up', slug: 'anaconda_bite', prefix: 'bryan', label: 'Anaconda Bite',
    source: 'Bryan', sourceIds: [409, 572, 593], limbs: ['LF', 'LF', 'RH'], finish: 'launch',
    stanceDefault: true, origin: 'trial13',
  }),
  chain({
    archetypeId: 'bryan_fury', stance: 'down', slug: 'drone_dive', prefix: 'bryan',
    label: 'Drone Dive Kick', source: 'Bryan', sourceIds: [0], limbs: ['LF'],
    stanceDefault: true, origin: 'authored',
  }),
];

// ---------------------------------------------------------------------------------------------
// Archetype records
// ---------------------------------------------------------------------------------------------

/**
 * A five-tier charge move (gigaton_charge.py). `firstWindupFrames` and `loopFrames` are the
 * ISO's own `end` values — 28 for the first windup, 24 for every repeat — so the level a release
 * comes out at is the ISO's level, not a re-tuned approximation of it.
 */
export interface ChargeProfile {
  /** Move id that enters the charge hold. */
  readonly chainEntry: string;
  /** Gauge required to begin holding. */
  readonly minGauge: number;
  readonly firstWindupFrames: number;
  readonly loopFrames: number;
  readonly maxLevel: number;
  /** Beyond this the charge fires on its own at `maxLevel`. */
  readonly maxHoldFrames: number;
  /** Release move ids, index 0 == level 1. */
  readonly releases: readonly string[];
}

export interface CharacterArchetype {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly maxHealth: number;
  /** Walking speed in subunits per tick. Integer, so it stays bit-identical. */
  readonly walkSpeed: number;
  readonly throwMoveId: string;
  readonly reversalMoveId: string;
  readonly charge: ChargeProfile | null;
  /** Chains per stance, in input-priority order: the first is that stance's default. */
  readonly chains: Readonly<Record<MoveStance, readonly ChainDef[]>>;
}

function byStance(all: readonly ChainDef[]): Record<MoveStance, readonly ChainDef[]> {
  return {
    neutral: Object.freeze(all.filter((c) => c.stance === 'neutral')),
    up: Object.freeze(all.filter((c) => c.stance === 'up')),
    down: Object.freeze(all.filter((c) => c.stance === 'down')),
    side: Object.freeze(all.filter((c) => c.stance === 'side')),
  };
}

export const ARCHETYPES: readonly CharacterArchetype[] = Object.freeze([
  Object.freeze({
    id: 'brad_hawk',
    name: 'Brad Hawk',
    title: 'Parkour brawler — fastest strings, weakest links',
    maxHealth: 1000,
    walkSpeed: 99,
    throwMoveId: 'brad_hawk_throw',
    reversalMoveId: 'brad_hawk_reversal',
    charge: null,
    chains: byStance(BRAD_HAWK_CHAINS),
  }),
  Object.freeze({
    id: 'jack5',
    name: 'Jack-5',
    title: 'S.A.P. — armoured, five-level Gigaton charge',
    maxHealth: 1150,
    walkSpeed: 72,
    throwMoveId: 'jack5_rotary_catapult',
    reversalMoveId: 'jack5_reversal',
    // gigaton_charge.py: first windup 28 frames, repeat loop 24, five levels, one gauge cost
    // charged on level 1 (`cost if i==0 else 0`). Level 5 needs 28 + 4*24 = 124 held frames.
    charge: Object.freeze({
      chainEntry: 'jack5_gigaton',
      minGauge: 50,
      firstWindupFrames: 28,
      loopFrames: 24,
      maxLevel: 5,
      maxHoldFrames: 28 + 5 * 24,
      releases: Object.freeze([
        'jack5_gigaton_1',
        'jack5_gigaton_2',
        'jack5_gigaton_3',
        'jack5_gigaton_4',
        'jack5_gigaton_5',
      ]),
    }),
    chains: byStance(JACK5_CHAINS),
  }),
  Object.freeze({
    id: 'jin_kazama',
    name: 'Jin Kazama',
    title: 'Kazama Style — longest strings, SPA 2 flurry',
    maxHealth: 950,
    walkSpeed: 108,
    throwMoveId: 'jin_throw',
    reversalMoveId: 'jin_reversal',
    charge: null,
    chains: byStance(JIN_CHAINS),
  }),
  Object.freeze({
    id: 'bryan_fury',
    name: 'Bryan Fury',
    title: 'Drone pilot — Gatling strings, 150-damage SPA 1',
    maxHealth: 1080,
    walkSpeed: 86,
    throwMoveId: 'bryan_throw',
    reversalMoveId: 'bryan_reversal',
    charge: null,
    chains: byStance(BRYAN_CHAINS),
  }),
]);

export const ARCHETYPE_MOVES: readonly MoveDef[] = Object.freeze([
  ...BRAD_HAWK_MOVES,
  ...JACK5_MOVES,
  ...JIN_MOVES,
  ...BRYAN_MOVES,
]);

export const ARCHETYPE_CHAINS: readonly ChainDef[] = Object.freeze([
  ...BRAD_HAWK_CHAINS,
  ...JACK5_CHAINS,
  ...JIN_CHAINS,
  ...BRYAN_CHAINS,
]);

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

const ARCHETYPES_BY_ID: ReadonlyMap<string, CharacterArchetype> = new Map(
  ARCHETYPES.map((archetype) => [archetype.id, archetype]),
);
const CHAINS_BY_ID: ReadonlyMap<string, ChainDef> = new Map(
  ARCHETYPE_CHAINS.map((chainDef) => [chainDef.id, chainDef]),
);

/** Every move id that belongs to a chain, mapped to the chain it belongs to. */
const MOVE_CHAINS: ReadonlyMap<string, string> = new Map(
  ARCHETYPE_CHAINS.flatMap((chainDef) => chainDef.links.map((link) => [link.moveId, chainDef.id])),
);

export function getArchetype(id: string): CharacterArchetype | undefined {
  return ARCHETYPES_BY_ID.get(id);
}

export function getChain(id: string): ChainDef | undefined {
  return CHAINS_BY_ID.get(id);
}

/** Chain a move belongs to, or undefined for baseline moves and standalone specials. */
export function chainOfMove(moveId: string): ChainDef | undefined {
  const chainId = MOVE_CHAINS.get(moveId);
  return chainId === undefined ? undefined : CHAINS_BY_ID.get(chainId);
}

export function chainOfMoveId(moveId: string): string | undefined {
  return MOVE_CHAINS.get(moveId);
}

/**
 * The move a bare stance press selects for an archetype.
 *
 * The chain flagged `stanceDefault` wins, and only if there is none does declaration order decide.
 * Preferring the flag means inserting a new chain above an existing one cannot silently change what
 * the stance button does — array position stops being load-bearing.
 */
export function defaultChainMoveId(archetypeId: string, stance: MoveStance): string | undefined {
  const archetype = ARCHETYPES_BY_ID.get(archetypeId);
  const chains = archetype?.chains[stance];
  if (chains === undefined || chains.length === 0) {
    return undefined;
  }
  const chosen = chains.find((chainDef) => chainDef.stanceDefault) ?? chains[0];
  return chosen?.links[0]?.moveId;
}

/** Every opener available to an archetype in a stance, default chain first. */
export function chainOpeners(archetypeId: string, stance: MoveStance): readonly string[] {
  const archetype = ARCHETYPES_BY_ID.get(archetypeId);
  const chains = archetype?.chains[stance];
  if (archetype === undefined || chains === undefined) {
    return [];
  }
  const ordered = [
    ...chains.filter((chainDef) => chainDef.stanceDefault),
    ...chains.filter((chainDef) => !chainDef.stanceDefault),
  ];
  return Object.freeze(ordered.map((chainDef) => chainDef.links[0]?.moveId ?? '').filter((id) => id !== ''));
}

/** Charge profile of an archetype, or null when it has no charged move. */
export function chargeProfileOf(archetypeId: string): ChargeProfile | null {
  return ARCHETYPES_BY_ID.get(archetypeId)?.charge ?? null;
}

/** Reversal a frame-perfect dodge counter throws into. */
export function reversalOf(archetypeId: string): string | undefined {
  return ARCHETYPES_BY_ID.get(archetypeId)?.reversalMoveId;
}

export const STANCES: readonly MoveStance[] = Object.freeze(['neutral', 'up', 'down', 'side']);

/** Type guards used by the sim when it resolves an `attack` input. */
export function isStance(value: string): value is MoveStance {
  return value === 'neutral' || value === 'up' || value === 'down' || value === 'side';
}

/** Kinds, re-exported so the report can validate table data without importing `defs` twice. */
export const MOVE_KINDS: readonly MoveKind[] = Object.freeze([
  'strike', 'low', 'launcher', 'sweep', 'grab', 'reversal', 'special',
]);

export const GUARD_LEVELS: readonly GuardLevel[] = Object.freeze([
  'high', 'mid', 'low', 'unblockable', 'throw',
]);

/** Sanity aid for the report: every declared stance value must be one of the four. */
export const VALID_STANCES: ReadonlySet<string> = new Set(STANCES);

// `MoveDef`, `MoveStance` and `MoveOrigin` are *not* re-exported from here: `moveset.ts` already
// re-exports them from `defs`, and exporting the same names from two modules makes a bundled
// `export *` ambiguous.
/**
 * Articulated procedural character rigs.
 *
 * AGENTS.md §3.1: this is the presentation layer, so it may touch Three.js — and it must never
 * write back into simulation state. Everything here *reads* a `Fighter` record and the `MoveDef`
 * it is currently executing; nothing in this file is ever handed a `MatchRunner`, and nothing it
 * produces can change a future tick.
 *
 * ## Why the pose is a pure function
 *
 * The interesting part of a procedural rig is not the geometry, it is the decision "what pose is
 * this fighter in, and how far through it are they". That decision is split out into
 * {@link poseFor}, a pure function of `(Fighter, MoveDef | null)` that returns plain numbers. The
 * Three.js rig is then a dumb applier of those numbers.
 *
 * That split is what makes the animation gate-able at all: `test/character-mesh.test.mjs` drives
 * `poseFor` with synthetic fighters and asserts on joint angles, with no renderer, no scene and no
 * browser. A rig whose posing lived inside `update()` could only be tested by walking a scene
 * graph and reading Euler values back off `Object3D`s, which tests a Three.js API rather than the
 * animation.
 *
 * ## Timing
 *
 * Every phase comes from sim ticks — `stateFrame`, `movePhaseFrame`, and the move's declared
 * `startup`/`active`/`recovery` — never from a wall clock. A strike therefore plays at exactly the
 * speed the frame data declares, and it plays identically on a 30Hz phone and a 240Hz monitor,
 * which is the same determinism contract §3.2 holds the simulation to, applied to the visual.
 */

import * as THREE from 'three';
import { FP_SCALE, GETUP_FRAMES } from '../config';
import { getArchetype } from '../combat/archetypes';
import { getMove, type MoveDef } from '../combat/moveset';
import type { Fighter } from '../sim/fighter';

/** Which pose a fighter is in, resolved from `state` + `currentMove`. */
export type PoseName =
  | 'idle'
  | 'walk'
  | 'strike'
  | 'guard'
  | 'dodge'
  | 'launched'
  | 'knockdown'
  | 'getup'
  | 'charge'
  | 'hitstun';

/** Every articulated joint a rig exposes. Each maps 1:1 onto an `Object3D` pivot. */
export type JointName =
  | 'torso'
  | 'head'
  | 'shoulderL'
  | 'elbowL'
  | 'shoulderR'
  | 'elbowR'
  | 'hipL'
  | 'kneeL'
  | 'hipR'
  | 'kneeR';

/** Euler angles in radians, ordered `[x, y, z]`. */
export type Euler = readonly [number, number, number];

/** A complete pose: joint angles plus how the whole body sits relative to the floor. */
export interface RigPose {
  readonly name: PoseName;
  /** 0..1 through this pose's own duration. Derived from sim ticks, never a clock. */
  readonly phase: number;
  readonly joints: Readonly<Record<JointName, Euler>>;
  /** Vertical offset of the body root, in world units. */
  readonly rootLift: number;
  /** Whole-body forward lean, radians. Positive leans toward the facing direction. */
  readonly rootPitch: number;
  /** Whole-body side lean, radians. */
  readonly rootRoll: number;
  /** Which side is throwing the strike, when this is a strike pose. */
  readonly strikeSide: 'left' | 'right' | null;
  /** True while the pose is in the strike's active frames (the contact window). */
  readonly active: boolean;
}

const BASE_JOINTS: Record<JointName, Euler> = {
  // A brawler's ready stance: weight back, elbows in, slight forward pitch.
  torso: [0, 0, 0.05],
  head: [0, 0, -0.04],
  shoulderL: [0.1, 0, 0.12],
  elbowL: [0, 0, 0.38],
  shoulderR: [-0.1, 0, 0.12],
  elbowR: [0, 0, 0.38],
  hipL: [0, 0, 0.02],
  kneeL: [0, 0, 0.12],
  hipR: [0, 0, -0.02],
  kneeR: [0, 0, 0.12],
};

const IDLE_JOINTS: Readonly<Record<JointName, Euler>> = Object.freeze({ ...BASE_JOINTS });

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function lerpEuler(from: Euler, to: Euler, t: number): Euler {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function joints(overrides: Partial<Record<JointName, Euler>>): Record<JointName, Euler> {
  return { ...BASE_JOINTS, ...overrides };
}

/** Rest pose, shared by everything that has not decided to animate yet. */
function restPose(): Record<JointName, Euler> {
  return { ...BASE_JOINTS };
}

// -------------------------------------------------------------------------------------------
// Poses
// -------------------------------------------------------------------------------------------

/**
 * Windup: the limb pulls back and the elbow closes, so the strike has somewhere to come from.
 * Sampled on the frames where the sim reports `startup` — which is exactly the window the frame
 * data says the player is committed to and cannot cancel out of.
 *
 * Note the asymmetry between the axes: a **positive Z** angle swings a limb forward toward the
 * facing direction and a negative one swings it back, and that is true for the left limb and the
 * right limb alike. The per-side `sign` therefore only ever applies to the X axis (abduction, out
 * to the side) — putting it on Z would make every right-handed strike throw backwards.
 */
function windupPose(side: 'left' | 'right', isLeg: boolean): Record<JointName, Euler> {
  const sign = side === 'left' ? 1 : -1;
  if (isLeg) {
    return joints({
      hipL: [0, 0, -0.35],
      kneeL: [0, 0, 0.55],
      hipR: [0, 0, -0.3],
      kneeR: [0, 0, 0.5],
      torso: [0, 0, -0.12 * sign],
    });
  }
  return joints({
    shoulderL: [0.14 * sign, 0, -0.42],
    elbowL: [0, 0, 0.95],
    shoulderR: [-0.14 * sign, 0, -0.42],
    elbowR: [0, 0, 0.95],
    torso: [0, 0, -0.12 * sign],
  });
}

/**
 * Full extension: the leading limb is out along the facing direction and the elbow/knee is
 * straight, with the trailing limb following at a shorter reach. The straight leading limb is the
 * point — an elbow still bent at the moment of contact is what makes a procedural punch read as a
 * shove.
 */
function extendPose(side: 'left' | 'right', isLeg: boolean): Record<JointName, Euler> {
  const sign = side === 'left' ? 1 : -1;
  const lead = side === 'left';
  if (isLeg) {
    return joints({
      hipL: [0, 0, lead ? 1.15 : 0.95],
      kneeL: [0, 0, lead ? 0.02 : 0.06],
      hipR: [0, 0, lead ? 0.95 : 1.15],
      kneeR: [0, 0, lead ? 0.06 : 0.02],
      torso: [0, 0, 0.16],
    });
  }
  return joints({
    shoulderL: [0.06 * sign, 0, lead ? 1.5 : 1.15],
    elbowL: [0, 0, lead ? 0.04 : 0.2],
    shoulderR: [-0.06 * sign, 0, lead ? 1.15 : 1.5],
    elbowR: [0, 0, lead ? 0.2 : 0.04],
    torso: [0, 0, 0.18],
  });
}

/**
 * Recovery: everything falls back toward the ready stance.
 *
 * Arms and legs both come down together rather than only the limb that threw — a strike is
 * recovering the whole body, and leaving the trailing limbs where they were is what makes a
 * procedural rig snap back instead of settling.
 */
function recoveryPose(side: 'left' | 'right'): Record<JointName, Euler> {
  const sign = side === 'left' ? 1 : -1;
  return joints({
    shoulderL: [0.1 * sign, 0, 0.5],
    elbowL: [0, 0, 0.4],
    shoulderR: [-0.1 * sign, 0, 0.5],
    elbowR: [0, 0, 0.4],
    hipL: [0, 0, 0.3],
    kneeL: [0, 0, 0.3],
    hipR: [0, 0, 0.3],
    kneeR: [0, 0, 0.3],
  });
}

/** Joint names for one side, so the strike overrides can address the limb the sim named. */
function jointsFor(side: 'left' | 'right') {
  return side === 'left'
    ? {
        hip: 'hipL',
        knee: 'kneeL',
        otherHip: 'hipR',
        otherKnee: 'kneeR',
        shoulder: 'shoulderL',
        otherShoulder: 'shoulderR',
      }
    : {
        hip: 'hipR',
        knee: 'kneeR',
        otherHip: 'hipL',
        otherKnee: 'kneeL',
        shoulder: 'shoulderR',
        otherShoulder: 'shoulderL',
      };
}

/**
 * Which side of the body a move throws from, and whether it is an arm or a leg.
 *
 * `MoveDef.limb` is the ported `spec.py` limb tag — `'LH'`, `'RH'`, `'LF'`, `'RF'` — where the
 * first letter is the side and the second is hand or foot. An unlabelled move defaults to the
 * right hand, which is what an unknown id should degrade to rather than throwing a left hook.
 */
export function strikeLimbOf(move: MoveDef | null): { side: 'left' | 'right'; isLeg: boolean } {
  const limb = move?.limb ?? 'RH';
  const side: 'left' | 'right' = limb.startsWith('L') ? 'left' : 'right';
  return { side, isLeg: limb.length > 1 && limb[1] === 'F' };
}

/**
 * Resolve the pose for one fighter on one frame.
 *
 * Pure: the same `(fighter, move)` pair always yields the same pose, on any machine, at any
 * refresh rate. `move` may be omitted — the caller can let this look the definition up — and
 * passing `null` for a fighter that is mid-stun is exactly as valid as passing a definition.
 */
export function poseFor(fighter: Fighter, move?: MoveDef | null): RigPose {
  const def = move === undefined ? (fighter.currentMove === null ? null : (getMove(fighter.currentMove) ?? null)) : move;
  const phase = framePhase(fighter, def);

  switch (fighter.state) {
    case 'down':
      return {
        name: 'knockdown',
        phase,
        // Flat on the back, head away from the floor: `rootPitch` past a quarter turn is what
        // puts the whole body on the ground without needing a separate lying-down rig.
        joints: joints({
          torso: [0, 0, 0.05],
          head: [0, 0, -0.2],
          shoulderL: [0.5, 0, 0.9],
          elbowL: [0, 0, 0.3],
          shoulderR: [-0.5, 0, 0.9],
          elbowR: [0, 0, 0.3],
          hipL: [0, 0, 0.18],
          kneeL: [0, 0, 0.3],
          hipR: [0, 0, 0.18],
          kneeR: [0, 0, 0.3],
        }),
        rootLift: -0.55,
        rootPitch: -1.5,
        rootRoll: 0.12,
        strikeSide: null,
        active: false,
      };

    case 'getup': {
      // Progress comes from `stateFrame`, **not** from `framePhase`. A fighter rising off the
      // floor has no `currentMove`, so the move-phase helper returns 0 for the whole window and
      // the get-up animation would never animate at all.
      const progress = clamp01(fighter.stateFrame / Math.max(GETUP_FRAMES, 1));
      return {
        name: 'getup',
        phase: progress,
        // Rises from flat toward the ready stance across `GETUP_FRAMES`. Deliberately slower
        // than it looks like it needs to be: the whole window is invulnerable, so reading as
        // "still getting up" is the correct information for the other player.
        joints: joints({
          torso: [0, 0, 0.5 * (1 - progress)],
          shoulderL: [0.3, 0, 0.5 * (1 - progress)],
          elbowL: [0, 0, 0.6 * (1 - progress) + 0.3],
          shoulderR: [-0.3, 0, 0.5 * (1 - progress)],
          elbowR: [0, 0, 0.6 * (1 - progress) + 0.3],
          hipL: [0, 0, 0.9 * (1 - progress) + 0.05],
          kneeL: [0, 0, 1.5 * (1 - progress) + 0.15],
          hipR: [0, 0, 0.9 * (1 - progress) + 0.05],
          kneeR: [0, 0, 1.5 * (1 - progress) + 0.15],
        }),
        rootLift: -0.55 * (1 - progress),
        rootPitch: -1.5 * (1 - progress),
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };
    }

    case 'launched': {
      // Tumbling, not standing. Limbs trail outward and the body is thrown back along the launch
      // direction; `vy` only decides how fast the arc reads, never which way the rig faces.
      const tumble = fighter.vy > 0 ? 1 : 0.4;
      return {
        name: 'launched',
        phase,
        joints: joints({
          torso: [0, 0, -0.35 * tumble],
          head: [0, 0, 0.25 * tumble],
          shoulderL: [0.4, 0, -1.1 * tumble],
          elbowL: [0, 0, 0.5],
          shoulderR: [-0.4, 0, -1.1 * tumble],
          elbowR: [0, 0, 0.5],
          hipL: [0, 0, -0.6 * tumble],
          kneeL: [0, 0, 0.7 * tumble],
          hipR: [0, 0, -0.35 * tumble],
          kneeR: [0, 0, 0.5 * tumble],
        }),
        rootLift: 0,
        rootPitch: -0.7 * tumble,
        rootRoll: 0.25 * tumble,
        strikeSide: null,
        active: false,
      };
    }

    case 'dodge_high':
    case 'dodge_low': {
      const slipping = fighter.stateFrame < 12;
      const high = fighter.state === 'dodge_high';
      // A slip is a head/shoulder drop — the body goes *under* the strike rather than away from
      // it. The low dodge is the hop that clears a sweep.
      const tuck = slipping ? 1 : 0.35;
      return {
        name: 'dodge',
        phase,
        joints: joints({
          torso: [0, 0, (high ? 0.75 : 0.25) * tuck],
          head: [0, 0, (high ? 0.45 : 0.1) * tuck],
          shoulderL: [0.3, 0, (high ? 1.1 : -0.5) * tuck],
          elbowL: [0, 0, 0.9 * tuck + 0.2],
          shoulderR: [-0.3, 0, (high ? 1.1 : -0.5) * tuck],
          elbowR: [0, 0, 0.9 * tuck + 0.2],
          hipL: [0, 0, (high ? 0.45 : -0.35) * tuck],
          kneeL: [0, 0, 0.75 * tuck + 0.1],
          hipR: [0, 0, (high ? 0.45 : -0.35) * tuck],
          kneeR: [0, 0, 0.75 * tuck + 0.1],
        }),
        rootLift: high ? -0.25 * tuck : 0.12 * tuck,
        rootPitch: 0,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };
    }

    case 'blockstun':
      return {
        name: 'guard',
        phase,
        // Shielded: forearms stacked in front of the face and the chest turned in. Reads as
        // "this one is holding", which is the information a block has to communicate.
        joints: joints({
          torso: [0, 0, 0.22],
          head: [0, 0, 0.1],
          shoulderL: [0.5, 0, 1.15],
          elbowL: [0, 0, 1.5],
          shoulderR: [-0.5, 0, 1.15],
          elbowR: [0, 0, 1.5],
          hipL: [0, 0, 0.25],
          kneeL: [0, 0, 0.3],
          hipR: [0, 0, 0.1],
          kneeR: [0, 0, 0.25],
        }),
        rootLift: -0.08,
        rootPitch: 0.12,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };

    case 'hitstun':
      // Recoiling away from the contact. The lean is the only thing that changes: a flailing
      // procedural rig reads as a bug, a single sharp recoil reads as an impact.
      return {
        name: 'hitstun',
        phase,
        joints: joints({
          torso: [0, 0, -0.42],
          head: [0, 0, -0.3],
          shoulderL: [0.2, 0, -0.55],
          elbowL: [0, 0, 0.5],
          shoulderR: [-0.2, 0, -0.7],
          elbowR: [0, 0, 0.6],
          hipL: [0, 0, -0.25],
          kneeL: [0, 0, 0.35],
          hipR: [0, 0, 0.3],
          kneeR: [0, 0, 0.2],
        }),
        rootLift: -0.06,
        rootPitch: -0.3,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };

    case 'charging': {
      // Jack-5's five-level Gigaton hold. Rises and coils the deeper the hold goes, so a player
      // *sees* which tier they are about to release without reading the HUD.
      //
      // Progress is measured against the archetype's own declared `maxHoldFrames`, so the coil
      // reaches full depth exactly when the sim would fire the level-5 release. Like the get-up
      // this cannot use `framePhase`: a charge hold clears `currentMove`.
      const profile = getArchetype(fighter.archetypeId)?.charge ?? null;
      const window = profile === null ? 60 : Math.max(profile.maxHoldFrames, 1);
      const hold = clamp01(fighter.chargeFrames / window);
      return {
        name: 'charge',
        phase: hold,
        joints: joints({
          torso: [0, 0, -0.2 - 0.12 * hold],
          head: [0, 0, 0.2 + 0.1 * hold],
          shoulderL: [0.6, 0, -0.9 - 0.5 * hold],
          elbowL: [0, 0, 1.7],
          shoulderR: [-0.6, 0, -0.9 - 0.5 * hold],
          elbowR: [0, 0, 1.7],
          hipL: [0, 0, 0.35],
          kneeL: [0, 0, 0.6],
          hipR: [0, 0, 0.35],
          kneeR: [0, 0, 0.6],
        }),
        rootLift: 0.06 * hold,
        rootPitch: -0.1 * hold,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };
    }

    case 'walk': {
      // A stride cycle whose period is fixed in ticks, not seconds of wall clock. Two steps per
      // cycle: the counter wraps on 30 ticks, which at 60Hz is a half-second step cadence.
      const cycle = (fighter.stateFrame % 30) / 30;
      const swing = Math.sin(cycle * Math.PI * 2);
      const arm = swing * 0.55;
      const lift = Math.max(0, Math.sin(cycle * Math.PI * 4)) * 0.06;
      return {
        name: 'walk',
        phase: cycle,
        joints: joints({
          torso: [0, 0, 0.09],
          head: [0, 0, -0.06],
          shoulderL: [0.1, 0, -arm],
          elbowL: [0, 0, 0.35 + Math.max(0, arm) * 0.4],
          shoulderR: [-0.1, 0, arm],
          elbowR: [0, 0, 0.35 + Math.max(0, -arm) * 0.4],
          hipL: [0, 0, swing * 0.62],
          kneeL: [0, 0, 0.14 + Math.max(0, -swing) * 0.7],
          hipR: [0, 0, -swing * 0.62],
          kneeR: [0, 0, 0.14 + Math.max(0, swing) * 0.7],
        }),
        rootLift: lift,
        rootPitch: 0,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };
    }

    case 'idle': {
      // Breathing, on a 90-tick period so four fighters do not all rise and fall on the same
      // frame. The slot offsets the phase; nothing else in the rig reads the slot.
      const breath = Math.sin(((fighter.stateFrame + fighter.slot * 22) % 90) / 90 * Math.PI * 2);
      return {
        name: 'idle',
        phase: (fighter.stateFrame % 90) / 90,
        joints: joints({
          torso: [0, 0, 0.05 + breath * 0.02],
          head: [0, 0, -0.04 - breath * 0.02],
        }),
        rootLift: breath * 0.015,
        rootPitch: 0,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };
    }

    case 'startup':
    case 'active':
    case 'recovery':
      return strikePoseFor(fighter, def, phase);

    default:
      return {
        name: 'idle',
        phase,
        joints: restPose(),
        rootLift: 0,
        rootPitch: 0,
        rootRoll: 0,
        strikeSide: null,
        active: false,
      };
  }
}

/**
 * How far through its own move a fighter is, 0..1, and — separately — whether this frame is the
 * contact window. Both are derived from the *declared* frame counts, not from a measured duration,
 * so the animation cannot drift away from the frame data the balance report prints.
 */
function framePhase(fighter: Fighter, def: MoveDef | null): number {
  if (def === null) {
    return 0;
  }
  const total = def.startup + def.active + def.recovery;
  if (total <= 0) {
    return 0;
  }
  return clamp01(fighter.movePhaseFrame / total);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function strikePoseFor(fighter: Fighter, def: MoveDef | null, phase: number): RigPose {
  if (def === null) {
    // A move id with no definition cannot be posed from frame data. Falling back to the ready
    // stance keeps an unknown id from producing a rig at an arbitrary angle.
    return {
      name: 'strike',
      phase: 0,
      joints: restPose(),
      rootLift: 0,
      rootPitch: 0,
      rootRoll: 0,
      strikeSide: null,
      active: false,
    };
  }

  const { side, isLeg } = strikeLimbOf(def);
  const sign = side === 'left' ? 1 : -1;
  const frame = fighter.movePhaseFrame;
  const isActive = fighter.state === 'active';

  // A SPA is thrown with both hands, and a crowd-clearing one is thrown wide. A 360 needs to
  // read as a sweep of the whole body, not as a bigger jab.
  const isCrowdClear = def.hitsAll === true;
  const isLauncher = def.kind === 'launcher';
  const isGrab = def.kind === 'grab' || def.guard === 'throw';
  const isSweep = def.kind === 'sweep' || def.kind === 'low';

  const windup = windupPose(side, isLeg && !isLauncher);
  const extend = extendPose(side, isLeg && !isLauncher);

  let blend: Record<JointName, Euler>;
  let active = isActive;

  if (frame < def.startup) {
    // Startup: pull back. Normalised by `startup - 1` rather than `startup` so frame 0 is exactly
    // the ready stance and the *last* startup frame is exactly full wind-up — the strike leaves
    // its windup already loaded at the moment it becomes active. Dividing by `startup` instead
    // leaves the pose a fraction short at both ends and never actually reaches full extension.
    const t = def.startup <= 1 ? 1 : frame / (def.startup - 1);
    blend = lerpJoints(IDLE_JOINTS, windup, t);
  } else if (frame < def.startup + def.active) {
    // Active: first frame is the windup, last frame is full extension — the contact window spans
    // the gesture from cocked to fully thrown, which is what the declared `active` frames mean.
    const span = Math.max(def.active - 1, 1);
    const t = (frame - def.startup) / span;
    blend = lerpJoints(windup, extend, clamp01(t));
    active = true;
  } else {
    // Recovery: extension back to the ready stance across the declared recovery frames.
    const span = Math.max(def.recovery - 1, 1);
    const t = clamp01((frame - def.startup - def.active) / span);
    blend = lerpJoints(extend, recoveryPose(side), t);
  }

  if (isGrab || def.kind === 'special' || isCrowdClear) {
    blend = applyBothArms(blend, isCrowdClear, sign);
  }

  const limb = jointsFor(side);
  if (isLauncher) {
    // A launcher has to visibly *lift*: the strike-side leg rises with the knee and the torso
    // arches back. Addressing the strike-side joint by name matters here — `spec.py` files some
    // launchers under the right limb and some under the left, and a hard-coded knee would throw
    // half of them with the wrong leg.
    blend = joints({
      ...blend,
      torso: [blend.torso[0], blend.torso[1], blend.torso[2] - 0.25],
      [limb.hip]: [0, 0, 1.35],
      [limb.knee]: [0, 0, 0.05],
      [limb.otherHip]: [0, 0, 0.15],
      [limb.shoulder]: [0.3 * sign, 0, -0.5],
      [limb.otherShoulder]: [-0.3 * sign, 0, -0.3],
    });
  }
  if (isSweep && !isLauncher) {
    // Sweeps sit low and reach — the whole reason a high guard does not stop them.
    blend = joints({
      ...blend,
      [limb.hip]: [0, 0, 1.3],
      [limb.knee]: [0, 0, 0.03],
      [limb.otherKnee]: [0, 0, 0.45],
      torso: [0, 0, 0.3],
    });
  }

  const lift = (isLauncher && active ? 0.22 : 0) + (def.kind === 'special' && active ? 0.1 : 0);

  return {
    name: 'strike',
    phase,
    joints: blend,
    rootLift: lift,
    rootPitch: isLauncher ? -0.18 : 0.12 * (active ? 1 : 0),
    rootRoll: 0,
    strikeSide: isGrab || def.kind === 'special' || isCrowdClear ? null : side,
    active,
  };
}

/** Both arms thrown forward — grabs, SPAs, and the wide body of a crowd-clearer. */
function applyBothArms(
  pose: Record<JointName, Euler>,
  wide: boolean,
  sign: number,
): Record<JointName, Euler> {
  const reach = wide ? 1.25 : 1.55;
  const spread = wide ? 0.95 : 0.15;
  return joints({
    ...pose,
    shoulderL: [spread, 0, reach],
    elbowL: [0, 0, wide ? 0.5 : 0.08],
    shoulderR: [-spread, 0, reach],
    elbowR: [0, 0, wide ? 0.5 : 0.08],
    torso: [0, 0, 0.16 * sign],
  });
}

function lerpJoints(
  from: Readonly<Record<JointName, Euler>>,
  to: Readonly<Record<JointName, Euler>>,
  t: number,
): Record<JointName, Euler> {
  const blended = {} as Record<JointName, Euler>;
  for (const name of Object.keys(from) as JointName[]) {
    blended[name] = lerpEuler(from[name], to[name], t);
  }
  return blended;
}

// -------------------------------------------------------------------------------------------
// Rig specs — the four Trial 13 archetypes
// -------------------------------------------------------------------------------------------

export interface RigPalette {
  readonly skin: number;
  readonly cloth: number;
  readonly accent: number;
  /** Metallic parts: cyber arms, armour, visor. */
  readonly cyber: number;
  readonly hair: number;
}

export interface RigSpec {
  readonly archetypeId: string;
  readonly name: string;
  /** Whole-body height multiplier. Jack-5 is enormous; Jin is the smallest. */
  readonly scale: number;
  /** Half the shoulder span, in world units, at `scale` 1. */
  readonly shoulderHalf: number;
  readonly armUpper: number;
  readonly armLower: number;
  readonly armRadius: number;
  readonly legUpper: number;
  readonly legLower: number;
  readonly legRadius: number;
  readonly torsoDepth: number;
  readonly torsoHeight: number;
  readonly headRadius: number;
  /** Torso width multiplier — the read for "this one is built like a wall". */
  readonly bulk: number;
  readonly palette: RigPalette;
  /** True for the cyber-arm archetypes; drives the metal forearms and the visor glow. */
  readonly cyberArms: boolean;
}

const SPECS: Readonly<Record<string, RigSpec>> = Object.freeze({
  // A fast, lean parkour brawler. Narrow shoulders, long limbs, nothing armoured.
  brad_hawk: Object.freeze({
    archetypeId: 'brad_hawk',
    name: 'Brad Hawk',
    scale: 1,
    shoulderHalf: 0.26,
    armUpper: 0.34,
    armLower: 0.32,
    armRadius: 0.072,
    legUpper: 0.44,
    legLower: 0.44,
    legRadius: 0.088,
    torsoDepth: 0.19,
    torsoHeight: 0.56,
    headRadius: 0.13,
    bulk: 0.95,
    palette: Object.freeze({
      skin: 0xc99873,
      cloth: 0x2b3550,
      accent: 0xd8443c,
      cyber: 0x8a8f99,
      hair: 0x2a2622,
    }),
    cyberArms: false,
  }),
  // The wall. Enormous shoulders, long heavy arms, a torso two of everyone else's width, and
  // cyber forearms — the silhouette has to read as "do not trade blows with this one" at the
  // distance the framing camera actually keeps.
  jack5: Object.freeze({
    archetypeId: 'jack5',
    name: 'Jack-5',
    scale: 1.22,
    shoulderHalf: 0.5,
    armUpper: 0.44,
    armLower: 0.42,
    armRadius: 0.13,
    legUpper: 0.44,
    legLower: 0.42,
    legRadius: 0.13,
    torsoDepth: 0.32,
    torsoHeight: 0.62,
    headRadius: 0.14,
    bulk: 1.55,
    palette: Object.freeze({
      skin: 0x9aa0aa,
      cloth: 0x5a6068,
      accent: 0xf07a12,
      cyber: 0xb9bec7,
      hair: 0x3a3f47,
    }),
    cyberArms: true,
  }),
  // The technician: white gi, gauntlets, a red belt. Leanest build of the four.
  jin_kazama: Object.freeze({
    archetypeId: 'jin_kazama',
    name: 'Jin Kazama',
    scale: 0.97,
    shoulderHalf: 0.27,
    armUpper: 0.35,
    armLower: 0.33,
    armRadius: 0.075,
    legUpper: 0.46,
    legLower: 0.46,
    legRadius: 0.09,
    torsoDepth: 0.2,
    torsoHeight: 0.58,
    headRadius: 0.132,
    bulk: 0.92,
    palette: Object.freeze({
      skin: 0xd9a982,
      cloth: 0xe8e6e1,
      accent: 0xb8222a,
      cyber: 0x7c1f24,
      hair: 0x1d1a17,
    }),
    cyberArms: false,
  }),
  // Cyber soldier: armour plates over a dark undersuit, visor instead of eyes.
  bryan_fury: Object.freeze({
    archetypeId: 'bryan_fury',
    name: 'Bryan Fury',
    scale: 1.12,
    shoulderHalf: 0.38,
    armUpper: 0.38,
    armLower: 0.36,
    armRadius: 0.095,
    legUpper: 0.46,
    legLower: 0.45,
    legRadius: 0.11,
    torsoDepth: 0.26,
    torsoHeight: 0.6,
    headRadius: 0.135,
    bulk: 1.28,
    palette: Object.freeze({
      skin: 0x8d8f86,
      cloth: 0x3d4438,
      accent: 0xc2a03a,
      cyber: 0x6f7a83,
      hair: 0x24282a,
    }),
    cyberArms: true,
  }),
});

/**
 * The spec for an archetype id.
 *
 * Falls back to Brad Hawk's proportions for an unknown id — the same defensive shape as
 * `createFighter`, which falls back to the Phase 0 defaults for an archetype it has never heard
 * of. The frame-measurement harness spawns `'frame_probe'` and the test harness spawns
 * `'probe'`, and neither may be a special case here.
 */
export function rigSpecFor(archetypeId: string): RigSpec {
  return SPECS[archetypeId] ?? (SPECS['brad_hawk'] as RigSpec);
}

/** Every archetype id that has a dedicated rig, in roster order. */
export const RIG_ARCHETYPES: readonly string[] = Object.freeze([
  'brad_hawk',
  'jack5',
  'jin_kazama',
  'bryan_fury',
]);

// -------------------------------------------------------------------------------------------
// The rig
// -------------------------------------------------------------------------------------------

/**
 * One articulated fighter.
 *
 * Built facing **local +X**, matching the scene-proxy convention the client already used, so
 * `rotation.y = ±π/2` maps the facing flag straight onto the world without a correction. Arms hang
 * down `-Y`; the shoulder and elbow hinge about **Z** (the body's left-right axis for an X-facing
 * rig), so a positive shoulder angle swings a limb toward the facing direction.
 *
 * `dispose()` releases every geometry and material this rig created. It does not remove the rig
 * from its parent — the caller owns scene membership — and it is idempotent.
 */
export class CharacterRig {
  readonly group: THREE.Group;
  readonly spec: RigSpec;
  /** Joint pivots, keyed exactly like `RigPose.joints`. */
  readonly joints: Record<JointName, THREE.Object3D>;

  /** The pose applied by the most recent {@link update}. Read by the animation gate. */
  pose: RigPose;

  private readonly body: THREE.Object3D;
  private readonly disposables: { dispose(): void }[] = [];
  private disposed = false;

  constructor(archetypeId: string, slot = 0) {
    this.spec = rigSpecFor(archetypeId);
    this.pose = {
      name: 'idle',
      phase: 0,
      joints: restPose(),
      rootLift: 0,
      rootPitch: 0,
      rootRoll: 0,
      strikeSide: null,
      active: false,
    };

    const spec = this.spec;
    this.group = new THREE.Group();
    this.group.name = `rig:${spec.archetypeId}:${slot}`;

    this.body = new THREE.Group();
    this.group.add(this.body);

    const s = spec.scale;
    const jointNodes: Partial<Record<JointName, THREE.Object3D>> = {};

    // -- torso ---------------------------------------------------------------------------
    const hipHeight = spec.legUpper + spec.legLower;
    const pelvis = this.mesh(
      spec.bulk * 0.19 * s,
      0.16 * s,
      spec.torsoDepth * s,
      spec.palette.cloth,
    );
    pelvis.position.y = hipHeight * s;
    this.body.add(pelvis);

    const torsoPivot = new THREE.Group();
    torsoPivot.position.y = hipHeight * s + 0.08 * s;
    this.body.add(torsoPivot);
    jointNodes['torso'] = torsoPivot;

    const torso = this.mesh(
      spec.bulk * 0.235 * s,
      spec.torsoHeight * s,
      spec.torsoDepth * s,
      spec.palette.cloth,
    );
    torso.position.y = (spec.torsoHeight * s) / 2;
    torsoPivot.add(torso);

    // Shoulder pauldrons: the single strongest silhouette cue in a 4-player free-for-all.
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? 1 : -1;
      const pauldron = this.mesh(
        0.15 * spec.bulk * s,
        0.15 * s,
        0.22 * s,
        spec.cyberArms ? spec.palette.cyber : spec.palette.cloth,
      );
      pauldron.position.set(0, spec.torsoHeight * s * 0.92, sign * spec.shoulderHalf * spec.bulk * s * 0.92);
      torsoPivot.add(pauldron);
    }

    // Accent stripe — the per-archetype colour the player identifies at a glance.
    const stripe = this.mesh(
      0.06 * s,
      spec.torsoHeight * s * 0.8,
      spec.torsoDepth * s * 1.02,
      spec.palette.accent,
    );
    stripe.position.set(0, (spec.torsoHeight * s) / 2, 0);
    torsoPivot.add(stripe);

    // -- head ---------------------------------------------------------------------------
    const headPivot = new THREE.Group();
    headPivot.position.y = spec.torsoHeight * s + 0.06 * s;
    torsoPivot.add(headPivot);
    jointNodes['head'] = headPivot;

    const head = this.mesh(
      spec.headRadius * 2 * s,
      spec.headRadius * 2.15 * s,
      spec.headRadius * 2 * s,
      spec.palette.skin,
    );
    head.position.y = spec.headRadius * s;
    headPivot.add(head);

    const hair = this.mesh(
      spec.headRadius * 2.05 * s,
      spec.headRadius * 0.85 * s,
      spec.headRadius * 2.05 * s,
      spec.palette.hair,
    );
    hair.position.y = spec.headRadius * s * 1.72;
    headPivot.add(hair);

    if (spec.cyberArms) {
      // Visor band. Only the cyber archetypes get one, which is itself a character read.
      const visor = this.mesh(
        spec.headRadius * 2.02 * s,
        spec.headRadius * 0.4 * s,
        spec.headRadius * 2.02 * s,
        spec.palette.accent,
      );
      visor.position.y = spec.headRadius * s * 1.12;
      headPivot.add(visor);
    }

    // -- arms ---------------------------------------------------------------------------
    const shoulderY = spec.torsoHeight * s * 0.88;
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? 1 : -1;
      const shoulder = new THREE.Group();
      shoulder.position.set(
        0,
        shoulderY,
        sign * spec.shoulderHalf * spec.bulk * s,
      );
      torsoPivot.add(shoulder);
      jointNodes[side === 'L' ? 'shoulderL' : 'shoulderR'] = shoulder;

      const upper = this.mesh(
        spec.armRadius * 2 * s,
        spec.armUpper * s,
        spec.armRadius * 2 * s,
        spec.palette.skin,
      );
      upper.position.y = -spec.armUpper * s * 0.5;
      shoulder.add(upper);

      const elbow = new THREE.Group();
      elbow.position.y = -spec.armUpper * s;
      shoulder.add(elbow);
      jointNodes[side === 'L' ? 'elbowL' : 'elbowR'] = elbow;

      // Jack-5 and Bryan get metal forearms; the human archetypes get skin.
      const lower = this.mesh(
        spec.armRadius * 2.08 * s,
        spec.armLower * s,
        spec.armRadius * 2.08 * s,
        spec.cyberArms ? spec.palette.cyber : spec.palette.skin,
      );
      lower.position.y = -spec.armLower * s * 0.5;
      elbow.add(lower);

      // Gauntlet: Jin's red wraps, Jack's and Bryan's armoured cuffs. Thinner than the forearm
      // so it reads as a separate part rather than a colour change on the same cylinder.
      const cuff = this.mesh(
        spec.armRadius * 2.5 * s,
        spec.armRadius * 1.3 * s,
        spec.armRadius * 2.5 * s,
        spec.palette.accent,
      );
      cuff.position.y = -spec.armLower * s * 0.92;
      elbow.add(cuff);
    }

    // -- legs ---------------------------------------------------------------------------
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? 1 : -1;
      const hip = new THREE.Group();
      hip.position.set(0, hipHeight * s, sign * 0.11 * spec.bulk * s);
      this.body.add(hip);
      jointNodes[side === 'L' ? 'hipL' : 'hipR'] = hip;

      const thigh = this.mesh(
        spec.legRadius * 2 * s,
        spec.legUpper * s,
        spec.legRadius * 2 * s,
        spec.palette.cloth,
      );
      thigh.position.y = -spec.legUpper * s * 0.5;
      hip.add(thigh);

      const knee = new THREE.Group();
      knee.position.y = -spec.legUpper * s;
      hip.add(knee);
      jointNodes[side === 'L' ? 'kneeL' : 'kneeR'] = knee;

      const shin = this.mesh(
        spec.legRadius * 1.8 * s,
        spec.legLower * s,
        spec.legRadius * 1.8 * s,
        spec.palette.cloth,
      );
      shin.position.y = -spec.legLower * s * 0.5;
      knee.add(shin);

      const foot = this.mesh(
        spec.legRadius * 2.3 * s,
        spec.legRadius * 1.1 * s,
        spec.legRadius * 3.4 * s,
        spec.palette.cyber,
      );
      foot.position.set(spec.legRadius * 0.8 * s, -spec.legLower * s - spec.legRadius * 0.4 * s, 0);
      knee.add(foot);
    }

    this.joints = jointNodes as Record<JointName, THREE.Object3D>;
    this.applyPose(this.pose);
  }

  /**
   * Read a fighter's state and re-pose the rig.
   *
   * Reads only. The `Fighter` handed in is the simulation's own record and is never written to —
   * position is copied out in world units, facing is copied out as a rotation, and nothing else
   * is touched.
   *
   * `move` may be passed to avoid a table lookup when the caller already has it (the frame loop
   * does, since it walks the event stream); omit it and the rig resolves the definition itself.
   */
  update(fighter: Fighter, move?: MoveDef | null): RigPose {
    this.group.position.set(fighter.x / FP_SCALE, fighter.y / FP_SCALE, fighter.z / FP_SCALE);
    this.group.rotation.y = fighter.facing === 1 ? Math.PI / 2 : -Math.PI / 2;
    this.group.visible = !fighter.eliminated;

    const pose = poseFor(fighter, move);
    this.pose = pose;
    this.applyPose(pose);
    return pose;
  }

  private applyPose(pose: RigPose): void {
    this.body.position.y = pose.rootLift;
    // Pitch and roll share the same axis on an X-facing rig, so they combine into one Z angle:
    // a tumbling `launched` pose leans back (negative pitch) and rolls onto its side at once.
    this.body.rotation.set(0, 0, pose.rootPitch + pose.rootRoll);

    for (const name of Object.keys(this.joints) as JointName[]) {
      const angles = pose.joints[name];
      const node = this.joints[name];
      if (angles === undefined || node === undefined) {
        continue;
      }
      node.rotation.set(angles[0], angles[1], angles[2]);
    }
  }

  /** Build a box mesh, remembering its geometry and material for {@link dispose}. */
  private mesh(
    width: number,
    height: number,
    depth: number,
    color: number,
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.62,
      metalness: specMetallic(color),
    });
    this.disposables.push(geometry, material);
    return new THREE.Mesh(geometry, material);
  }

  /**
   * Release every geometry and material this rig created.
   *
   * Idempotent, and it does not detach the rig from its parent — scene membership is the caller's
   * business, and a `dispose()` that silently unhooked a node from a live scene would make the
   * "dispose then reuse" mistake fail in a confusing way instead of an obvious one.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables.length = 0;
  }

  /** True once {@link dispose} has run. */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Cheap "is this colour a metal?" heuristic.
 *
 * The palette is hand-picked rather than sampled from a texture, so this only has to separate the
 * four archetypes' cyber parts from their skin and cloth — a luminance split at 0.45 puts Jack's
 * and Bryan's greys, plus every accent stripe, on the metallic side.
 */
function specMetallic(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.45 ? 0.55 : 0.05;
}

/**
 * One rig per player slot.
 *
 * Keyed by slot rather than held in an array because the frame loop looks rigs up by the slot on
 * a `Fighter` record, and because a LAN session swaps the entire world out from under the scene:
 * {@link rebuild} throws away every rig and builds a fresh set for a new roster, rather than
 * letting a rig outlive the fighter it was standing in for.
 */
export class CharacterRoster {
  private readonly rigs = new Map<number, CharacterRig>();

  constructor(private readonly scene: THREE.Object3D) {}

  /** Build rigs for every fighter and add them to the scene. Idempotent per roster. */
  build(fighters: readonly Fighter[]): void {
    this.rigs.clear();
    for (const fighter of fighters) {
      const rig = new CharacterRig(fighter.archetypeId, fighter.slot);
      this.scene.add(rig.group);
      this.rigs.set(fighter.slot, rig);
    }
  }

  /**
   * Re-pose every rig from the current fighter records.
   *
   * Pass `moves` to skip the per-frame move-table lookup when the caller already resolved the
   * definitions; entries may be missing or `null` for a fighter with no move running.
   */
  update(
    fighters: readonly Fighter[],
    moves?: ReadonlyMap<number, MoveDef | null>,
  ): void {
    for (const fighter of fighters) {
      const rig = this.rigs.get(fighter.slot);
      if (rig === undefined) {
        continue;
      }
      rig.update(fighter, moves === undefined ? undefined : (moves.get(fighter.slot) ?? null));
    }
  }

  get(slot: number): CharacterRig | undefined {
    return this.rigs.get(slot);
  }

  /** Every rig currently in the scene. */
  all(): CharacterRig[] {
    return [...this.rigs.values()];
  }

  /** Remove every rig from the scene and release its GPU resources. */
  dispose(): void {
    for (const rig of this.rigs.values()) {
      this.scene.remove(rig.group);
      rig.dispose();
    }
    this.rigs.clear();
  }
}
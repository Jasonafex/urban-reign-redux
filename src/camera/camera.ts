/**
 * Dynamic 4-player framing camera.
 *
 * AGENTS.md §3.1: presentation layer. It reads fighter positions and writes to a
 * `THREE.PerspectiveCamera`; it never writes to a fighter.
 *
 * ## What this camera is solving
 *
 * Urban Reign is four combatants in a 18x18 arena, and the camera has to keep *all of the living
 * ones* legible — that is the whole difference between a brawler and a fighting game. Three
 * problems follow from that, and each has a named piece of code below:
 *
 *   1. **Centring.** The midpoint of the living fighters, not of the arena and not of the local
 *      player. See {@link framingFor}.
 *   2. **Zoom.** A fixed boom cannot frame two fighters in the corners and two in the middle at
 *      the same time. The required distance is solved from the fighters' bounding box against the
 *      camera's actual field of view and aspect, so the framing is correct at any window shape —
 *      which matters because this runs on phones in portrait. See {@link distanceForBox}.
 *   3. **Impact.** A hit that does not move the frame does not read as a hit. See {@link shake}.
 *
 * The framing decision is a **pure function** ({@link framingFor}), separated from the smoothing
 * and the shake for the same reason the rig's posing is: so the "does it frame everyone" question
 * can be answered by an assertion rather than by reading Euler values off a live camera.
 */

import * as THREE from 'three';
import { FP_SCALE, RENDER } from '../config';
import type { Fighter } from '../sim/fighter';

/** A fighter's bounding volume in world units — the box the camera has to keep on screen. */
export const FIGHTER_BOUNDS = Object.freeze({
  /** Half-extent of the capsule in x/z. */
  radius: 0.6,
  /** Height of the tallest point above the fighter's feet. */
  height: 2.1,
  /** Headroom above the tallest point, so nobody's head touches the top edge. */
  headroom: 0.8,
  /** Depth below the floor, so the feet are not on the bottom edge. */
  underfoot: 1.2,
});

/** How fast the boom chases its target distance. Higher is tighter, lower is calmer. */
const DISTANCE_SMOOTHING = 4.2;
/** How fast the look-at point chases the centroid. */
const CENTRE_SMOOTHING = 5.5;
/** How fast trauma drains, per second. */
const TRAUMA_DECAY = 1.6;
/** Trauma below this is not worth displacing the camera for. */
const TRAUMA_FLOOR = 0.001;

/** The framing decision for one frame, in world units. */
export interface Framing {
  /** Midpoint of the living fighters' bounding box, in world units. */
  readonly centreX: number;
  readonly centreZ: number;
  /** Mean height of the living fighters — camera pitches down further for a juggle. */
  readonly centreY: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  /** Minimum distance from which the whole box fits the frustum. */
  readonly distance: number;
  /** How many fighters the framing was computed from. */
  readonly count: number;
}

/** What the camera is looking at, before any smoothing. */
export interface FramingSubject {
  readonly x: number;
  readonly z: number;
  /** Bottom of the fighter's bounding volume. */
  readonly y: number;
  readonly height: number;
}

/**
 * Solve the framing for a set of subjects.
 *
 * Returns `count: 0` and a default wide shot when nothing is alive — a finished match should
 * pull back and show the arena, not snap to the origin or keep the last dead fighter's corner.
 *
 * This is the function the camera gate asserts on. It is exported, pure, and takes plain numbers
 * rather than `Fighter` records so it can be driven directly with synthetic positions.
 */
export function framingFor(
  subjects: readonly FramingSubject[],
  // Annotated `number` rather than left to infer: `RENDER` is `as const`, so an unannotated
  // default would pin the parameter to the literal type `55` and reject any other FOV.
  verticalFovDeg: number = RENDER.fov,
  aspect = 16 / 9,
): Framing {
  if (subjects.length === 0) {
    return {
      centreX: 0,
      centreZ: 0,
      centreY: 0,
      halfWidth: ARENA_FALLBACK_HALF,
      halfDepth: ARENA_FALLBACK_HALF,
      distance: RENDER.cameraDistance * 2.2,
      count: 0,
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumY = 0;
  let sumTop = 0;

  for (const subject of subjects) {
    const r = FIGHTER_BOUNDS.radius;
    if (subject.x - r < minX) minX = subject.x - r;
    if (subject.x + r > maxX) maxX = subject.x + r;
    if (subject.z - r < minZ) minZ = subject.z - r;
    if (subject.z + r > maxZ) maxZ = subject.z + r;
    sumY += subject.y;
    sumTop += subject.y + subject.height;
  }

  const centreX = (minX + maxX) / 2;
  const centreZ = (minZ + maxZ) / 2;
  const centreY = sumY / subjects.length;

  return {
    centreX,
    centreZ,
    centreY,
    halfWidth: (maxX - minX) / 2,
    halfDepth: (maxZ - minZ) / 2,
    distance: distanceForBox(
      (maxX - minX) / 2,
      (maxZ - minZ) / 2,
      sumTop / subjects.length + FIGHTER_BOUNDS.headroom - centreY + FIGHTER_BOUNDS.underfoot,
      verticalFovDeg,
      aspect,
    ),
    count: subjects.length,
  };
}

/** Half-extent used for the "everybody is dead" shot: the whole arena. */
const ARENA_FALLBACK_HALF = 9;

/**
 * The distance at which a box of the given half-extents fills the frustum.
 *
 * Solved from both axes and the *worse* of the two, because a camera that frames the horizontal
 * extent while cropping a fighter's head has still failed. The vertical axis is measured from the
 * camera's own boom height rather than from the floor, which is what keeps the pitch honest as
 * the action rises into a juggle.
 */
export function distanceForBox(
  halfWidth: number,
  halfDepth: number,
  halfHeight: number,
  verticalFovDeg: number = RENDER.fov,
  aspect = 16 / 9,
): number {
  const verticalFov = (verticalFovDeg * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(aspect, 0.05));

  // Horizontal: the widest subject is `halfWidth + halfDepth` across the view plane once the
  // camera is angled at 45°, which is the worst case for a square arena.
  const horizontalSpan = halfWidth + halfDepth;
  const horizontalDistance = horizontalSpan / Math.tan(horizontalFov / 2);
  const verticalDistance = halfHeight / Math.tan(verticalFov / 2);

  const solved = Math.max(horizontalDistance, verticalDistance, RENDER.cameraDistance * 0.75);
  return Math.min(solved, RENDER.far * 0.5);
}

/**
 * Frame-rate independent exponential smoothing factor.
 *
 * `1 - exp(-rate * dt)` rather than a fixed `lerp(a, b, 0.1)`: a fixed fraction per *frame* makes
 * the camera twice as fast on a 120Hz monitor as on a 60Hz one, which is precisely the class of
 * bug §3.2 forbids elsewhere in this codebase.
 */
function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * Math.max(dt, 0));
}

/**
 * Seeded value noise for shake, in [-1, 1].
 *
 * Deterministic in `t` and `seed` — no `Math.random`, no `Math.sin` hash. Two clients running the
 * same tick stream see the same camera shake, which is what keeps a LAN replay watchable.
 */
export function shakeNoise(t: number, seed: number): number {
  // Cheap smooth noise: two hashed floors lerped against each other. Integer-hashed so it does
  // not depend on floating-point transcendental results, matching the sim's discipline.
  const t0 = Math.floor(t);
  const blend = t - t0;
  const a = hash1((t0 + seed) | 0);
  const b = hash1((t0 + 1 + seed) | 0);
  const smooth = blend * blend * (3 - 2 * blend);
  return (a + (b - a) * smooth) * 2 - 1;
}

function hash1(value: number): number {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 0x1_0000_0000;
}

/**
 * Build the presentation camera and the rig that drives it.
 *
 * One factory for both, because the two are always used as a pair and a caller that builds its
 * own `PerspectiveCamera` has to re-derive `RENDER.fov` / `RENDER.near` / `RENDER.far` to match.
 * The aspect starts at 16:9 and is expected to be corrected by the client's resize handler.
 */
export function createFramingCamera(aspect = 16 / 9): {
  camera: THREE.PerspectiveCamera;
  framing: FramingCamera;
} {
  const camera = new THREE.PerspectiveCamera(RENDER.fov, aspect, RENDER.near, RENDER.far);
  return { camera, framing: new FramingCamera(camera) };
}

/**
 * The framing camera.
 *
 * Wrap one around a `PerspectiveCamera` and drive it from the frame loop:
 *
 * ```ts
 * const framing = new FramingCamera(camera);
 * framing.update(runner.fighters, dtSeconds);
 * framing.shake(0.6); // on a heavy hit
 * ```
 */
export class FramingCamera {
  /** Trauma accumulator, 0..1. Exposed so a test can assert that shake actually decays. */
  trauma = 0;

  /** The most recent solved framing. */
  framing: Framing;

  private elapsed = 0;
  private centre = new THREE.Vector3();
  private distance: number;
  private readonly shakeSeed: number;
  private disposed = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    shakeSeed = 0x51ade,
  ) {
    this.shakeSeed = shakeSeed;
    this.framing = framingFor([]);
    this.distance = this.framing.distance;
    this.centre.set(0, 0, 0);
    this.applyImmediate();
  }

  /**
   * Solve the framing from the living fighters and drive the camera toward it.
   *
   * `dt` is seconds of rendered time. Eliminated fighters are excluded — including them would
   * keep a dead player in frame and zoom out over nobody for the rest of the match.
   */
  update(fighters: readonly Fighter[], dt: number): Framing {
    if (this.disposed) {
      return this.framing;
    }

    const subjects: FramingSubject[] = [];
    for (const fighter of fighters) {
      if (fighter.eliminated) {
        continue;
      }
      subjects.push({
        x: fighter.x / FP_SCALE,
        z: fighter.z / FP_SCALE,
        y: fighter.y / FP_SCALE,
        height: FIGHTER_BOUNDS.height,
      });
    }

    const framing = framingFor(subjects, this.camera.fov, this.camera.aspect);
    this.framing = framing;

    const step = smoothing(CENTRE_SMOOTHING, dt);
    this.centre.x += (framing.centreX - this.centre.x) * step;
    this.centre.z += (framing.centreZ - this.centre.z) * step;
    this.centre.y += (framing.centreY - this.centre.y) * step;

    // The boom length chases a bit more slowly than the look-at point: a distance that snapped
    // while the centre drifted would read as a zoom, which is a much more obvious artefact than
    // either half on its own.
    this.distance += (framing.distance - this.distance) * smoothing(DISTANCE_SMOOTHING, dt);

    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.elapsed += dt;
    this.applyImmediate();

    return framing;
  }

  /**
   * Add impact trauma, 0..1.
   *
   * Trauma is *added* and clamped rather than set, because a five-hit string fires five hits in
   * under a second and each should pile on. Shake displacement scales with trauma squared, so a
   * light hit is barely felt while a knockout is unmistakable.
   */
  shake(amount: number): void {
    if (this.disposed || !(amount > 0)) {
      return;
    }
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Trauma converted to a positional offset. Exposed for the camera gate. */
  shakeOffset(): { x: number; y: number; z: number } {
    if (this.trauma <= TRAUMA_FLOOR) {
      return { x: 0, y: 0, z: 0 };
    }
    const amount = this.trauma * this.trauma;
    const t = this.elapsed * 26;
    return {
      x: shakeNoise(t, this.shakeSeed) * amount * 0.42,
      y: shakeNoise(t, this.shakeSeed + 101) * amount * 0.3,
      z: shakeNoise(t, this.shakeSeed + 211) * amount * 0.24,
    };
  }

  /** Write the current smoothed state onto the camera. */
  private applyImmediate(): void {
    const offset = this.shakeOffset();
    const height = RENDER.cameraHeight + offset.y;
    // Pull back and up: the boom is behind the look-at point along +Z, raised, so the arena's
    // near wall never eclipses the fight.
    this.camera.position.set(
      this.centre.x + offset.x,
      height,
      this.centre.z + this.distance + offset.z,
    );
    this.camera.lookAt(this.centre.x + offset.x, this.centre.y + RENDER.cameraLookHeight, this.centre.z);
  }

  /** Current camera position, without a scene to render into. Exposed for the camera gate. */
  get position(): THREE.Vector3 {
    return this.camera.position;
  }

  /** Current boom length. */
  get boom(): number {
    return this.distance;
  }

  dispose(): void {
    this.disposed = true;
    this.trauma = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
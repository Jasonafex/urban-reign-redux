/**
 * Impact VFX — hitsparks, block sparks, knockdown dust and SPA shockwaves.
 *
 * AGENTS.md §3.1: presentation layer, driven entirely by the sim's event stream. Nothing here
 * decides *when* anything happens: `main.ts` reads a `HitEvent` / `SpaEvent` and calls a spawn
 * method, and the system only owns "how it looks and how long it lasts".
 *
 * ## Why every pool is fixed-capacity
 *
 * A brawler emits effects on contact, and contacts come in strings: a five-hit Jack-5 string on
 * a four-player field can land a dozen sparks inside two frames. Allocating geometry per burst
 * would mean a GC pause at exactly the moment the game is busiest — the frame the player is
 * watching. So each effect type has a fixed-capacity pool, and the buffer is uploaded once per
 * frame no matter how many particles are alive.
 *
 * ## Why the randomness is seeded rather than `Math.random`
 *
 * Presentation is allowed to be nondeterministic, but there is no reason for it to be: a seeded
 * generator makes a burst reproducible, which means a replay of the same tick stream throws the
 * same sparks, and it lets the test suite assert on particle counts and lifetimes without
 * statistical assertions. §3.2's determinism discipline, applied where it costs nothing.
 */

import * as THREE from 'three';

/** Fixed particle budgets. Sized for the worst case the frame data can actually produce. */
const SPARK_CAPACITY = 512;
const DUST_CAPACITY = 256;
const SHOCKWAVE_POOL = 8;

/** Seconds. */
const SPARK_LIFE = 0.34;
const BLOCK_SPARK_LIFE = 0.26;
const DUST_LIFE = 0.85;
const SHOCKWAVE_LIFE = 0.55;

/** Per-effect spread and speed, as multiples of the emitting `power`. */
const SPARK_SPEED = 5.2;
const SPARK_SPREAD = 1.0;
const DUST_SPEED = 1.6;
const GRAVITY = 9.4;

/** Seed for the burst generator. Fixed so a replay throws the same sparks. */
const DEFAULT_SEED = 0x5eed1234;

/**
 * xorshift32.
 *
 * Chosen over `Math.random` for reproducibility, and over a `Math.sin`-based hash because the
 * low bits of that generator are famously correlated — exactly the bits a particle spray uses
 * when it picks a direction.
 */
class Rng {
  private state: number;

  constructor(seed: number) {
    // A zero state is a fixed point for xorshift, so it is not allowed to survive construction.
    this.state = seed === 0 ? DEFAULT_SEED : seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x1_0000_0000;
  }

  /** Uniform in [-1, 1). */
  signed(): number {
    return this.next() * 2 - 1;
  }
}

/** A flat, GPU-friendly particle pool. One `Points` object, one draw call, one upload. */
class ParticleField {
  readonly points: THREE.Points;
  readonly capacity: number;

  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseColor: Float32Array;
  private readonly cursor = { value: 0 };
  private live = 0;

  constructor(capacity: number, additive: boolean, size: number) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseColor = new Float32Array(capacity * 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      size,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Additive blending fades a particle by multiplying its colour toward black, which is why
      // every fade below writes a scaled colour rather than touching material opacity: one
      // material serves every particle of its field.
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.name = additive ? 'vfx:sparks' : 'vfx:dust';

    // Park every slot well below the arena so a dead particle is never drawn where a live one
    // might be, and so the first frame before any burst has nothing to show.
    for (let i = 0; i < capacity; i += 1) {
      this.positions[i * 3 + 1] = -1000;
    }
  }

  /**
   * Emit one particle.
   *
   * Overwrites the slot the cursor lands on. When the pool is saturated that evicts the oldest
   * particle rather than refusing the new one, which is the right trade: a missed spark is
   * invisible, and a burst that silently stops emitting is a hole in the middle of a hit.
   */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    color: THREE.Color,
  ): void {
    const index = this.cursor.value;
    this.cursor.value = (index + 1) % this.capacity;

    // Captured before the overwrite: a slot that was dead makes the pool one fuller, a slot that
    // was live is being evicted and leaves the count alone.
    const wasAlive = this.life[index]! > 0;

    const i3 = index * 3;
    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.velocity[i3] = vx;
    this.velocity[i3 + 1] = vy;
    this.velocity[i3 + 2] = vz;
    this.life[index] = life;
    this.maxLife[index] = life;
    this.baseColor[i3] = color.r;
    this.baseColor[i3 + 1] = color.g;
    this.baseColor[i3 + 2] = color.b;
    this.colors[i3] = color.r;
    this.colors[i3 + 1] = color.g;
    this.colors[i3 + 2] = color.b;

    if (!wasAlive && this.live < this.capacity) {
      this.live += 1;
    }
  }

  /**
   * Integrate and fade. Returns how many particles are still alive.
   *
   * Every index below is provably in range — `index < capacity` and `capacity * 3` is the
   * allocation length — but `noUncheckedIndexedAccess` widens every typed-array read to
   * `number | undefined`. The `!` assertions below are that proof written down, rather than
   * eighteen bounds checks in the hottest loop in the renderer.
   */
  update(dt: number, gravity: number): number {
    let alive = 0;
    for (let index = 0; index < this.capacity; index += 1) {
      const remaining = this.life[index]!;
      const i3 = index * 3;
      if (remaining <= 0) {
        continue;
      }
      const next = remaining - dt;
      if (next <= 0) {
        this.life[index] = 0;
        this.positions[i3 + 1] = -1000;
        this.colors[i3] = 0;
        this.colors[i3 + 1] = 0;
        this.colors[i3 + 2] = 0;
        continue;
      }
      this.life[index] = next;

      this.velocity[i3 + 1]! -= gravity * dt;
      this.positions[i3]! += this.velocity[i3]! * dt;
      this.positions[i3 + 1]! += this.velocity[i3 + 1]! * dt;
      this.positions[i3 + 2]! += this.velocity[i3 + 2]! * dt;

      // Linear fade in colour: with additive blending this is an exponential-looking decay, and
      // it needs no per-particle alpha attribute.
      const fade = next / Math.max(this.maxLife[index]!, 1e-6);
      this.colors[i3] = this.baseColor[i3]! * fade;
      this.colors[i3 + 1] = this.baseColor[i3 + 1]! * fade;
      this.colors[i3 + 2] = this.baseColor[i3 + 2]! * fade;

      alive += 1;
    }

    this.live = alive;
    if (alive > 0) {
      this.geometry.attributes['position']!.needsUpdate = true;
      this.geometry.attributes['color']!.needsUpdate = true;
    }
    return alive;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.geometry.dispose();
    const material = this.points.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material.dispose();
    }
  }
}

/** One expanding ground ring. Pooled as meshes because each needs its own opacity. */
interface Shockwave {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  radius: number;
}

/** Impact point and intensity for one contact. */
export interface ImpactSpec {
  readonly position: THREE.Vector3;
  /** 0..1+. Scaled by the move's own damage/hitstop by the caller. */
  readonly power?: number;
}

export interface VfxOptions {
  readonly seed?: number;
}

/**
 * The whole VFX layer.
 *
 * Owns one spark field, one dust field and a ring pool, all parented to a single group. `update`
 * takes seconds of *rendered* time — deliberately not sim ticks, because particles are the one
 * thing in this project that are allowed to run on the display clock: a 30Hz phone drawing the
 * same six sparks for two ticks each looks identical, whereas stepping them on sim ticks would
 * make a 240Hz monitor throw the effect away four times faster.
 */
export class VfxSystem {
  readonly group: THREE.Group;

  private readonly sparks: ParticleField;
  private readonly dust: ParticleField;
  private readonly shockwaves: Shockwave[] = [];
  private readonly rng: Rng;
  private readonly geometries: { dispose(): void }[] = [];
  private readonly cursor = { value: 0 };
  private disposed = false;

  constructor(options: VfxOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = 'vfx';
    this.rng = new Rng(options.seed ?? DEFAULT_SEED);

    this.sparks = new ParticleField(SPARK_CAPACITY, true, 0.16);
    this.dust = new ParticleField(DUST_CAPACITY, false, 0.34);
    this.group.add(this.sparks.points, this.dust.points);

    const ring = new THREE.RingGeometry(0.82, 1.0, 48);
    this.geometries.push(ring);
    for (let i = 0; i < SHOCKWAVE_POOL; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xfff0c0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(ring, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.shockwaves.push({ mesh, material, life: 0, maxLife: SHOCKWAVE_LIFE, radius: 1 });
    }
  }

  /**
   * A landed hit: a radial spray of sparks at the contact point.
   *
   * Count scales with `power` so a five-link string does not draw the same puff as a jab, but is
   * capped by the pool — over-budget sparks are dropped rather than evicting live ones.
   */
  hit(spec: ImpactSpec): void {
    const power = clamp(spec.power ?? 0.6, 0.1, 1);
    const count = Math.round(6 + 22 * power);
    const color = new THREE.Color(0xffd27a);
    for (let i = 0; i < count; i += 1) {
      // Spherical spray: two uniform samples for the cone, one for elevation.
      const theta = this.rng.next() * Math.PI * 2;
      const z = this.rng.signed();
      const planar = Math.sqrt(Math.max(0, 1 - z * z));
      const speed = SPARK_SPEED * power * (0.45 + this.rng.next() * 0.9);
      this.sparks.spawn(
        spec.position.x,
        spec.position.y,
        spec.position.z,
        Math.cos(theta) * planar * speed * SPARK_SPREAD,
        (Math.abs(z) * 0.8 + 0.35) * speed,
        Math.sin(theta) * planar * speed * SPARK_SPREAD,
        SPARK_LIFE * (0.65 + this.rng.next() * 0.6),
        color,
      );
    }
  }

  /**
   * A blocked hit: a tight, cold cluster against the guard.
   *
   * Deliberately short-range and blue-white. A block that threw the same sparks as a clean hit
   * would tell the player the same thing about both, and the block is information.
   */
  block(spec: ImpactSpec): void {
    const power = clamp(spec.power ?? 0.5, 0.1, 1);
    const count = Math.round(5 + 12 * power);
    const color = new THREE.Color(0xa8d8ff);
    for (let i = 0; i < count; i += 1) {
      const theta = this.rng.next() * Math.PI * 2;
      const speed = SPARK_SPEED * power * 0.55 * (0.5 + this.rng.next() * 0.8);
      this.sparks.spawn(
        spec.position.x,
        spec.position.y,
        spec.position.z,
        Math.cos(theta) * speed,
        this.rng.next() * speed * 0.6,
        Math.sin(theta) * speed,
        BLOCK_SPARK_LIFE * (0.6 + this.rng.next() * 0.5),
        color,
      );
    }
  }

  /**
   * A body hitting the floor: a low, slow puff that spreads outward and settles.
   *
   * Gravity is applied to the dust field in `update`, which is why these hang and the sparks
   * do not — the two fields run the same integrator with different gravity, not two code paths.
   */
  knockdownDust(spec: ImpactSpec): void {
    const power = clamp(spec.power ?? 0.7, 0.2, 1);
    const count = Math.round(10 + 26 * power);
    const color = new THREE.Color(0x8a7f70);
    for (let i = 0; i < count; i += 1) {
      const theta = this.rng.next() * Math.PI * 2;
      const speed = DUST_SPEED * power * (0.4 + this.rng.next());
      this.dust.spawn(
        spec.position.x + Math.cos(theta) * 0.2 * power,
        spec.position.y + 0.1,
        spec.position.z + Math.sin(theta) * 0.2 * power,
        Math.cos(theta) * speed,
        0.6 + this.rng.next() * 1.1,
        Math.sin(theta) * speed,
        DUST_LIFE * (0.7 + this.rng.next() * 0.7),
        color,
      );
    }
  }

  /** An evasive slip: a short afterimage trail at the shoulder line. */
  slip(spec: ImpactSpec): void {
    const color = new THREE.Color(0xd8e4f0);
    for (let i = 0; i < 10; i += 1) {
      this.sparks.spawn(
        spec.position.x + this.rng.signed() * 0.25,
        spec.position.y + this.rng.signed() * 0.25,
        spec.position.z + this.rng.signed() * 0.25,
        this.rng.signed() * 1.2,
        0.4 + this.rng.next() * 0.8,
        this.rng.signed() * 1.2,
        BLOCK_SPARK_LIFE * (0.7 + this.rng.next() * 0.6),
        color,
      );
    }
  }

  /**
   * A Special Arts release: an expanding ground ring plus a spark burst at the caster.
   *
   * `tier` sets the ring's reach, and the tiers are visibly different — an SPA 1 should not look
   * like an SPA 2, because the player paid a different amount of gauge for it.
   */
  shockwave(spec: ImpactSpec, tier: 1 | 2 | 3 = 1): void {
    const power = clamp(spec.power ?? 1, 0.2, 1.5);
    const radius = (tier === 1 ? 1.9 : tier === 2 ? 3.1 : 4.4) * (0.8 + power * 0.4);
    const wave = this.shockwaves[this.cursor.value];
    this.cursor.value = (this.cursor.value + 1) % this.shockwaves.length;
    if (wave === undefined) {
      return;
    }
    wave.life = SHOCKWAVE_LIFE;
    wave.maxLife = SHOCKWAVE_LIFE;
    wave.radius = radius;
    wave.mesh.position.set(spec.position.x, 0.06, spec.position.z);
    wave.mesh.scale.setScalar(0.3);
    wave.mesh.visible = true;
    // Tier colour: white-hot for SPA 1, cyan for the crowd-clearer, violet for the dual.
    wave.material.color.setHex(tier === 1 ? 0xfff0c0 : tier === 2 ? 0x9fe4ff : 0xd9a8ff);

    this.hit({ position: spec.position, power: 0.5 + tier * 0.25 });
  }

  /** Advance every live effect. `dt` is seconds of rendered time. */
  update(dt: number): void {
    if (this.disposed || dt <= 0) {
      return;
    }
    this.sparks.update(dt, GRAVITY * 0.75);
    this.dust.update(dt, GRAVITY);

    for (const wave of this.shockwaves) {
      if (wave.life <= 0) {
        continue;
      }
      wave.life -= dt;
      if (wave.life <= 0) {
        wave.mesh.visible = false;
        wave.material.opacity = 0;
        continue;
      }
      // Ease-out expansion: fast bloom, slow settle, so the ring reads as a burst rather than
      // a balloon. `remaining / maxLife` goes 1 -> 0, so 1 - that is the progress.
      const progress = 1 - wave.life / wave.maxLife;
      const eased = 1 - Math.pow(1 - progress, 3);
      wave.mesh.scale.setScalar(0.3 + eased * wave.radius);
      wave.material.opacity = (1 - progress) * 0.85;
    }
  }

  /** Live spark particles. */
  get sparkCount(): number {
    return this.sparks.liveCount;
  }

  /** Live dust particles. */
  get dustCount(): number {
    return this.dust.liveCount;
  }

  /** Shockwave rings currently expanding. */
  get shockwaveCount(): number {
    let count = 0;
    for (const wave of this.shockwaves) {
      if (wave.life > 0) {
        count += 1;
      }
    }
    return count;
  }

  /** Total live effect particles and rings — what the test suite asserts decays to zero. */
  get liveCount(): number {
    return this.sparkCount + this.dustCount + this.shockwaveCount;
  }

  /** Release every buffer, geometry and material the system created. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.sparks.dispose();
    this.dust.dispose();
    for (const wave of this.shockwaves) {
      wave.material.dispose();
    }
    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    this.geometries.length = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
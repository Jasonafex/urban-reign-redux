/**
 * The 3D urban arena.
 *
 * AGENTS.md §3.1: presentation layer. Reads one constant — `ARENA_HALF_EXTENT` — and builds
 * geometry around it. The perimeter walls sit exactly where the simulation's clamp puts a fighter,
 * so what the player sees bouncing off a wall is the same wall the sim clamped them against, not
 * a decorative one a unit or two away.
 *
 * ## Why nothing here is measured
 *
 * The stage is static: no animated props, no scrolling textures, no clock. Everything a frame of
 * the arena depends on is fixed at build time, which keeps the per-frame cost of drawing the
 * world at zero and keeps `dispose()` a simple, complete release of GPU memory.
 */

import * as THREE from 'three';
import { ARENA_HALF_EXTENT } from '../config';

/** Wall height. Tall enough to read as a building edge, short enough not to cage the camera. */
const WALL_HEIGHT = 3.6;
const WALL_THICKNESS = 0.5;

/** Everything the stage builds, so the caller can dispose it or re-tune the lighting. */
export interface Stage {
  /** Add to the scene. Holds every mesh, light and helper. */
  readonly group: THREE.Group;
  /** Directional key light, exposed so the client can retune intensity without rebuilding. */
  readonly key: THREE.DirectionalLight;
  /** Warm point lights at each streetlight head. */
  readonly lamps: readonly THREE.PointLight[];
  /** World-space half extent of the playfield, equal to `ARENA_HALF_EXTENT`. */
  readonly halfExtent: number;
  /** Release every geometry and material the stage created. Idempotent. */
  dispose(): void;
}

/**
 * Build the arena.
 *
 * Two dressings of the same playfield — an alleyway and a warehouse — because AGENTS.md §5 calls
 * for both and they read very differently at the framing camera's distance: the alley is vertical
 * and close (walls, fire escapes, a chain-link section), the warehouse is open and horizontal
 * (racking, crates, a loading dock). One of each is placed in opposite quadrants of the same
 * square, so the four spawn points at the corners are split between them.
 */
export function buildStage(): Stage {
  const group = new THREE.Group();
  group.name = 'stage';

  const disposables: { dispose(): void }[] = [];
  let disposed = false;

  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const material = (color: number, roughness = 0.8, metalness = 0.05): THREE.Material =>
    track(new THREE.MeshStandardMaterial({ color, roughness, metalness }));

  const box = (
    width: number,
    height: number,
    depth: number,
    color: number,
    options: { roughness?: number; metalness?: number } = {},
  ): THREE.Mesh => {
    const geometry = track(new THREE.BoxGeometry(width, height, depth));
    const mesh = new THREE.Mesh(
      geometry,
      material(color, options.roughness ?? 0.8, options.metalness ?? 0.05),
    );
    mesh.position.y = height / 2;
    group.add(mesh);
    return mesh;
  };

  // -------------------------------------------------------------------------------------------
  // Ground: wet asphalt with a lighter apron marking the playfield edge.
  // -------------------------------------------------------------------------------------------

  const apron = ARENA_HALF_EXTENT + 6;
  const ground = new THREE.Mesh(
    track(new THREE.PlaneGeometry(apron * 2, apron * 2)),
    material(0x15181d, 0.55, 0.15),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // Painted boundary line, just inside the walls — the visual read of "this is the arena".
  const lineMaterial = track(
    new THREE.MeshBasicMaterial({ color: 0x6f7a4a, transparent: true, opacity: 0.5 }),
  );
  const lineGeometry = track(new THREE.PlaneGeometry(ARENA_HALF_EXTENT * 2, 0.12));
  for (const [x, z, rotate] of [
    [0, -ARENA_HALF_EXTENT + 0.35, 0],
    [0, ARENA_HALF_EXTENT - 0.35, 0],
    [-ARENA_HALF_EXTENT + 0.35, 0, Math.PI / 2],
    [ARENA_HALF_EXTENT - 0.35, 0, Math.PI / 2],
  ] as const) {
    const stripe = new THREE.Mesh(lineGeometry, lineMaterial);
    stripe.rotation.x = -Math.PI / 2;
    stripe.rotation.z = rotate;
    stripe.position.set(x, 0.01, z);
    group.add(stripe);
  }

  // -------------------------------------------------------------------------------------------
  // Perimeter walls — exactly on `ARENA_HALF_EXTENT`, the sim's clamp.
  // -------------------------------------------------------------------------------------------

  const span = ARENA_HALF_EXTENT * 2;
  const brick = material(0x3b3733, 0.92, 0.02);
  const concrete = material(0x4a4d52, 0.88, 0.03);

  /** A wall panel: brick base, concrete cap, and a course line at fighter head height. */
  const wall = (x: number, z: number, width: number, depth: number, mat: THREE.Material): void => {
    const geometry = track(new THREE.BoxGeometry(width, WALL_HEIGHT, depth));
    const panel = new THREE.Mesh(geometry, mat);
    panel.position.set(x, WALL_HEIGHT / 2, z);
    panel.receiveShadow = true;
    group.add(panel);

    // Capping course: gives the wall a top edge instead of an infinite slab.
    const cap = new THREE.Mesh(
      track(new THREE.BoxGeometry(width + 0.18, 0.16, depth + 0.18)),
      concrete,
    );
    cap.position.set(x, WALL_HEIGHT + 0.08, z);
    group.add(cap);
  };

  wall(0, -ARENA_HALF_EXTENT, span + WALL_THICKNESS * 2, WALL_THICKNESS, brick);
  wall(0, ARENA_HALF_EXTENT, span + WALL_THICKNESS * 2, WALL_THICKNESS, brick);
  wall(-ARENA_HALF_EXTENT, 0, WALL_THICKNESS, span, concrete);
  wall(ARENA_HALF_EXTENT, 0, WALL_THICKNESS, span, concrete);

  // -------------------------------------------------------------------------------------------
  // Alleyway dressing (negative-X / negative-Z quadrant)
  // -------------------------------------------------------------------------------------------

  // Dumpsters. Placed tight to the wall so they frame the fight instead of occupying it.
  for (const [x, z, height] of [
    [-ARENA_HALF_EXTENT + 0.9, -4.2, 1.15],
    [-5.6, -ARENA_HALF_EXTENT + 0.9, 1.0],
  ] as const) {
    const bin = box(1.9, height, 1.35, 0x2f4a3a, { roughness: 0.75, metalness: 0.35 });
    bin.position.set(x, height / 2, z);
    // Lid, tilted a few degrees — a perfectly flat lid reads as a crate, not a dumpster.
    const lid = box(2.0, 0.1, 1.45, 0x273a2d, { roughness: 0.75, metalness: 0.35 });
    lid.position.set(x + 0.06, height + 0.06, z);
    lid.rotation.z = 0.05;
  }

  // Fire escape: landings and a ladder on the alley's back wall.
  const steel = material(0x565a60, 0.6, 0.7);
  for (const level of [2.2, 4.0]) {
    const landing = new THREE.Mesh(track(new THREE.BoxGeometry(2.4, 0.12, 1.5)), steel);
    landing.position.set(-ARENA_HALF_EXTENT + 1.3, level, -3.2);
    group.add(landing);
    for (let i = 0; i < 4; i += 1) {
      const rail = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, 1.0, 0.08)), steel);
      rail.position.set(-ARENA_HALF_EXTENT + 0.25, level + 0.5, -4.0 + i * 0.5);
      group.add(rail);
    }
    const kick = new THREE.Mesh(track(new THREE.BoxGeometry(2.4, 0.5, 0.08)), steel);
    kick.position.set(-ARENA_HALF_EXTENT + 1.3, level + 0.25, -3.95);
    group.add(kick);
  }
  for (const step of [0, 1, 2, 3, 4, 5]) {
    const rung = new THREE.Mesh(track(new THREE.BoxGeometry(0.7, 0.06, 0.06)), steel);
    rung.position.set(-ARENA_HALF_EXTENT + 0.9, 0.5 + step * 0.6, -1.6);
    group.add(rung);
  }

  // Air-conditioning units and a pipe run — vertical interest on the brick walls.
  for (const [x, y, z] of [
    [-ARENA_HALF_EXTENT + 0.7, 1.5, -1.0],
    [-ARENA_HALF_EXTENT + 0.7, 3.0, -6.2],
    [2.5, 2.6, -ARENA_HALF_EXTENT + 0.7],
  ] as const) {
    const ac = box(0.85, 0.7, 0.85, 0x8d8b84, { roughness: 0.7, metalness: 0.4 });
    ac.position.set(x, y, z);
  }
  const pipe = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.07, 7.5, 8)), steel);
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set(0, WALL_HEIGHT - 0.35, -ARENA_HALF_EXTENT + 0.35);
  group.add(pipe);

  // -------------------------------------------------------------------------------------------
  // Warehouse dressing (positive-X / positive-Z quadrant)
  // -------------------------------------------------------------------------------------------

  // Steel racking: uprights, beams and a few pallets of crates.
  for (let bay = 0; bay < 3; bay += 1) {
    const z = 3.2 + bay * 2.6;
    for (const x of [ARENA_HALF_EXTENT - 1.0, ARENA_HALF_EXTENT - 3.0]) {
      const upright = box(0.16, 3.4, 0.16, 0x7a5230, { roughness: 0.85 });
      upright.position.set(x, 1.7, z);
      upright.position.x = x;
      upright.position.z = z;
    }
    for (const level of [1.1, 2.2, 3.3]) {
      const beam = box(2.1, 0.14, 0.9, 0x6b4a2c, { roughness: 0.85 });
      beam.position.set(ARENA_HALF_EXTENT - 2.0, level, z);
      if (bay !== 1) {
        const pallet = box(1.5, 0.9, 0.85, 0x8a6a3e, { roughness: 0.9 });
        pallet.position.set(ARENA_HALF_EXTENT - 2.0, level + 0.52, z);
      }
    }
  }

  // Loading dock: a raised platform and a roller door on the far wall.
  const dock = box(4.2, 0.9, 3.0, 0x55585c, { roughness: 0.9 });
  dock.position.set(3.2, 0.45, ARENA_HALF_EXTENT - 1.8);
  for (let slat = 0; slat < 7; slat += 1) {
    const slatMesh = box(3.4, 0.22, 0.1, 0x6d7176, { roughness: 0.7, metalness: 0.5 });
    slatMesh.position.set(6.2, 0.3 + slat * 0.3, ARENA_HALF_EXTENT - 0.28);
  }

  // Loose crates near the middle, low enough to be kicked over rather than walls to hide behind.
  for (const [x, z, height] of [
    [4.6, 1.2, 0.75],
    [5.4, 0.3, 0.55],
  ] as const) {
    const crate = box(0.85, height, 0.85, 0x7d5f38, { roughness: 0.92 });
    crate.position.set(x, height / 2, z);
  }

  // -------------------------------------------------------------------------------------------
  // Streetlights
  // -------------------------------------------------------------------------------------------

  const poleMat = material(0x2f3238, 0.55, 0.6);
  const glowMat = track(new THREE.MeshBasicMaterial({ color: 0xffe6b0 }));
  const lamps: THREE.PointLight[] = [];

  const streetlight = (x: number, z: number): void => {
    const pole = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.09, 0.13, 5.4, 10)),
      poleMat,
    );
    pole.position.set(x, 2.7, z);
    group.add(pole);

    const arm = new THREE.Mesh(track(new THREE.BoxGeometry(0.9, 0.12, 0.12)), poleMat);
    arm.position.set(x + (x < 0 ? 0.45 : -0.45), 5.35, z);
    group.add(arm);

    const head = new THREE.Mesh(track(new THREE.BoxGeometry(0.55, 0.18, 0.42)), glowMat);
    head.position.set(x + (x < 0 ? 0.8 : -0.8), 5.24, z);
    group.add(head);

    // A real point light, but only four of them and with a short range: the fallback for the
    // streetlight is the key light, so a machine that drops the point lights still looks lit.
    const lamp = new THREE.PointLight(0xffd9a0, 18, 14, 2);
    lamp.position.set(x + (x < 0 ? 0.8 : -0.8), 5.0, z);
    group.add(lamp);
    lamps.push(lamp);
  };

  streetlight(-ARENA_HALF_EXTENT + 1.2, -2.6);
  streetlight(ARENA_HALF_EXTENT - 1.2, 2.6);

  // -------------------------------------------------------------------------------------------
  // Lighting
  // -------------------------------------------------------------------------------------------

  const hemisphere = new THREE.HemisphereLight(0x9fb4d8, 0x241d16, 0.85);
  group.add(hemisphere);

  const key = new THREE.DirectionalLight(0xfff2dd, 1.25);
  key.position.set(-7, 15, -9);
  group.add(key);

  // Cold rim from the opposite corner: separates silhouettes from the brick at the framing
  // camera's shallow angle, which is where the four fighters spend most of the match.
  const rim = new THREE.DirectionalLight(0x86a8d8, 0.7);
  rim.position.set(9, 7, 10);
  group.add(rim);

  return {
    group,
    key,
    lamps,
    halfExtent: ARENA_HALF_EXTENT,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const item of disposables) {
        item.dispose();
      }
      disposables.length = 0;
    },
  };
}
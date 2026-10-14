/**
 * Phase 4 presentation gate — articulated character rigs (`npm test`).
 *
 * Runs the real `src/render/character.ts` headlessly, with no WebGL context and no browser
 * globals. Three.js builds scene graphs, geometries and materials fine in Node — only
 * `WebGLRenderer` needs a GL context — so this suite constructs actual rigs and asserts on the
 * actual object graph rather than on a mock.
 *
 * Covered:
 *   - every one of the four Trial 13 archetypes builds a rig, and an unknown id falls back rather
 *     than throwing (the frame-measurement harness spawns `'frame_probe'`)
 *   - `poseFor` is pure and total: every `FighterState` resolves to a named pose
 *   - each pose does what it claims — a strike extends the striking limb, a guard closes the
 *     forearms, a knockdown lays the body flat, a launch throws it backward
 *   - strike timing is driven by the *declared* frame data, so the animation cannot drift from the
 *     numbers the balance report prints
 *   - `update` reads sim state without writing to it (AGENTS.md §3.1)
 *   - `dispose()` releases every geometry and material, and is idempotent
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadRender, loadSim } from '../tools/load-sim.mjs';

const render = await loadRender();
const sim = await loadSim();

const {
  CharacterRig,
  CharacterRoster,
  poseFor,
  rigSpecFor,
  strikeLimbOf,
  RIG_ARCHETYPES,
} = render;
const { createFighter, setState, DT, FP_SCALE, ARCHETYPES, MOVESET, getMove } = sim;

after(cleanup);

/** A fighter in a known state, positioned somewhere harmless. */
function fighter(overrides = {}) {
  return {
    ...createFighter(0, 'brad_hawk', 0, 0),
    ...overrides,
  };
}

/** Mid-move fighter: `currentMove` set and `movePhaseFrame` at a chosen frame. */
function inMove(moveId, frame, overrides = {}) {
  const base = fighter({ currentMove: moveId, movePhaseFrame: frame, ...overrides });
  if (frame < getMove(moveId).startup) setState(base, 'startup');
  else if (frame < getMove(moveId).startup + getMove(moveId).active) setState(base, 'active');
  else setState(base, 'recovery');
  return base;
}

/** Both `FighterState` values a humanoid can hold, for exhaustiveness checks. */
const ALL_STATES = [
  'idle',
  'walk',
  'startup',
  'active',
  'recovery',
  'hitstun',
  'blockstun',
  'launched',
  'down',
  'getup',
  'dodge_high',
  'dodge_low',
  'charging',
];

test('all four archetypes build a rig with a full joint set', () => {
  for (const archetype of ARCHETYPES) {
    const rig = new CharacterRig(archetype.id, archetype.id === 'jack5' ? 1 : 0);
    const joints = Object.keys(rig.joints).sort();
    assert.deepEqual(
      joints,
      [
        'elbowL',
        'elbowR',
        'head',
        'hipL',
        'hipR',
        'kneeL',
        'kneeR',
        'shoulderL',
        'shoulderR',
        'torso',
      ],
      `${archetype.id} is missing joints`,
    );
    assert.equal(rig.pose.name, 'idle', `${archetype.id} did not start in idle`);
    rig.dispose();
  }
  assert.equal(RIG_ARCHETYPES.length, ARCHETYPES.length);
});

test('an unknown archetype id falls back instead of throwing', () => {
  // The measurement harness and several tests spawn 'probe' / 'frame_probe'. A rig that threw on
  // an unknown id would take down the whole frame loop for a test-only character.
  for (const id of ['probe', 'frame_probe', '', 'opponent']) {
    const rig = new CharacterRig(id);
    assert.equal(rig.spec.archetypeId, 'brad_hawk', `no fallback for '${id}'`);
    rig.dispose();
  }
});

test('the four archetypes read as four different silhouettes', () => {
  const specs = RIG_ARCHETYPES.map((id) => rigSpecFor(id));

  // Jack-5 is specified as the wall: widest shoulders, largest bulk.
  const jack = rigSpecFor('jack5');
  for (const id of RIG_ARCHETYPES) {
    const other = rigSpecFor(id);
    if (id === 'jack5') continue;
    assert.ok(jack.shoulderHalf > other.shoulderHalf, `Jack-5's shoulders are not widest vs ${id}`);
    assert.ok(jack.bulk > other.bulk, `Jack-5 is not bulkier than ${id}`);
  }

  // Jack-5 and Bryan are the cyber archetypes; Brad and Jin are not. This drives the metal
  // forearms and the visor, which is a gameplay-visible read and not decoration.
  assert.equal(jack.cyberArms, true);
  assert.equal(rigSpecFor('bryan_fury').cyberArms, true);
  assert.equal(rigSpecFor('brad_hawk').cyberArms, false);
  assert.equal(rigSpecFor('jin_kazama').cyberArms, false);

  // Jin's gi is white, Jack's accent is orange — the two must not resolve to the same colour.
  assert.notEqual(rigSpecFor('jin_kazama').palette.cloth, rigSpecFor('jack5').palette.cloth);

  assert.ok(new Set(specs.map((s) => s.name)).size === 4);
});

test('poseFor is pure: the same fighter and move always give the same pose', () => {
  const subject = inMove('brad_hawk_barrage_1', 5);
  const first = poseFor(subject, getMove('brad_hawk_barrage_1'));
  const second = poseFor(subject, getMove('brad_hawk_barrage_1'));
  assert.deepEqual(first, second);

  // And it must not have touched the fighter while deciding.
  const before = JSON.stringify(subject);
  poseFor(subject, getMove('brad_hawk_barrage_1'));
  assert.equal(JSON.stringify(subject), before, 'poseFor mutated the fighter record');
});

test('every FighterState resolves to a named pose', () => {
  for (const state of ALL_STATES) {
    const pose = poseFor(fighter({ state, currentMove: 'brad_hawk_barrage_1', movePhaseFrame: 3 }));
    assert.equal(typeof pose.name, 'string', `${state} produced no pose name`);
    for (const [joint, angles] of Object.entries(pose.joints)) {
      assert.equal(angles.length, 3, `${state}/${joint} is not an euler triple`);
      for (const angle of angles) {
        assert.ok(Number.isFinite(angle), `${state}/${joint} has a non-finite angle`);
      }
    }
    assert.ok(Number.isFinite(pose.rootLift), `${state} rootLift is not finite`);
    assert.ok(Number.isFinite(pose.rootPitch), `${state} rootPitch is not finite`);
  }
});

test('a strike extends the striking limb and straightens its elbow', () => {
  const def = getMove('brad_hawk_barrage_1');
  const side = strikeLimbOf(def).side;
  const shoulder = `shoulder${side === 'left' ? 'L' : 'R'}`;
  const elbow = `elbow${side === 'left' ? 'L' : 'R'}`;

  const idle = poseFor(fighter({ state: 'idle' }));
  // Sampled on the *last* active frame: that is where the declared gesture is fully thrown. A
  // mid-window sample would only ever see it half-extended, which is the pose the rig passes
  // through rather than the one it lands on.
  const active = poseFor(inMove('brad_hawk_barrage_1', def.startup + def.active - 1));

  assert.equal(active.name, 'strike');
  assert.equal(active.strikeSide, side, `limb '${def.limb}' should throw from the ${side}`);
  assert.equal(active.active, true, 'the contact frame must report active');

  // A positive Z angle swings a limb toward the facing direction, and the contact frame is the
  // one place that angle must be large.
  assert.ok(
    active.joints[shoulder][2] > idle.joints[shoulder][2] + 0.8,
    'the striking shoulder did not extend',
  );
  assert.ok(
    active.joints[elbow][2] < idle.joints[elbow][2] - 0.2,
    'the striking elbow did not straighten',
  );
});

test('strike timing is driven by the declared frame data', () => {
  for (const def of MOVESET) {
    const startup = poseFor(inMove(def.id, 0), def);
    const active = poseFor(inMove(def.id, def.startup), def);
    const recovery = poseFor(inMove(def.id, def.startup + def.active + 1), def);

    // Startup winds up: the elbow is more closed than at rest. Scoped to one-limb strikes —
    // a grab, a reversal or a Special throws with both arms already straight at every phase, so
    // "wind up by closing the elbow" is not the gesture those moves make. The predicate mirrors
    // the two-handed branch in `strikePoseFor` exactly.
    const twoHanded =
      def.kind === 'grab' || def.guard === 'throw' || def.kind === 'special' || def.hitsAll === true;
    const { side } = strikeLimbOf(def);
    const elbow = `elbow${side === 'left' ? 'L' : 'R'}`;
    const restAngle = IDLE_ELBOW.get(elbow)[2];
    if (!twoHanded) {
      assert.ok(
        Math.abs(startup.joints[elbow][2]) >= Math.abs(restAngle) - 1e-9,
        `${def.id}: startup elbow ${startup.joints[elbow][2]} is more open than the ready stance ${restAngle}`,
      );
    }

    // Contact happens exactly on the first active frame, not before and not after.
    assert.equal(active.active, true, `${def.id}: frame ${def.startup} is not the contact frame`);
    assert.equal(recovery.active, false, `${def.id}: recovery frame still reports active`);

    // Phase tracks the declared total, so the animation cannot drift from the report's numbers.
    assert.ok(active.phase >= def.startup / (def.startup + def.active + def.recovery) - 1e-9);
  }
});

/** Ready-stance elbow angles, captured once from a real idle pose. */
const IDLE_ELBOW = (() => {
  const pose = poseFor(fighter({ state: 'idle' }));
  return new Map(Object.entries(pose.joints));
})();

test('the four-way directional branches produce visibly different strikes', () => {
  // AGENTS.md §5: neutral, up, down and side must not animate the same. A sweep has to reach with
  // a leg and sit low; a launcher has to lift.
  const jab = poseFor(inMove('brad_hawk_barrage_1', getMove('brad_hawk_barrage_1').startup), getMove('brad_hawk_barrage_1'));
  const sweep = poseFor(inMove('brad_hawk_slide_tackle_1', getMove('brad_hawk_slide_tackle_1').startup), getMove('brad_hawk_slide_tackle_1'));
  const launcher = poseFor(inMove('brad_hawk_rising_knee_1', getMove('brad_hawk_rising_knee_1').startup), getMove('brad_hawk_rising_knee_1'));

  assert.equal(strikeLimbOf(getMove('brad_hawk_slide_tackle_1')).isLeg, true, 'sweep should be a leg');
  assert.equal(strikeLimbOf(getMove('brad_hawk_barrage_1')).isLeg, false, 'jab should be an arm');

  assert.ok(launcher.rootLift > jab.rootLift, 'a launcher must lift the body');
  assert.ok(launcher.rootPitch < 0, 'a launcher must arch the torso back');
  assert.ok(
    Math.abs(sweep.joints.hipL[2]) > Math.abs(jab.joints.hipL[2]),
    'the sweep must reach further with the hip than the jab does',
  );
});

test('a crowd-clearing SPA throws both arms and no strike side', () => {
  const def = getMove('brad_hawk_spa2');
  assert.equal(def.hitsAll, true);
  const pose = poseFor(inMove('brad_hawk_spa2', def.startup + 1), def);
  const rest = IDLE_ELBOW;
  assert.ok(pose.joints.shoulderL[2] > 0.8, 'left arm did not come forward');
  assert.ok(pose.joints.shoulderR[2] > 0.8, 'right arm did not come forward');
  assert.ok(
    pose.joints.shoulderL[0] > rest.get('shoulderL')[0],
    'a 360 has to open the arms wide, not just reach',
  );
});

test('defensive and airborne states read as themselves', () => {
  const rest = IDLE_ELBOW;

  const guard = poseFor(fighter({ state: 'blockstun' }));
  assert.equal(guard.name, 'guard');
  assert.ok(
    guard.joints.elbowL[2] > rest.get('elbowL')[2],
    'a guard must close the forearms further than the ready stance',
  );

  const high = poseFor(fighter({ state: 'dodge_high', stateFrame: 3 }));
  const low = poseFor(fighter({ state: 'dodge_low', stateFrame: 3 }));
  assert.equal(high.name, 'dodge');
  assert.notDeepEqual(high.joints, low.joints, 'high and low dodges animate identically');

  const launched = poseFor(fighter({ state: 'launched', vy: 420 }));
  assert.equal(launched.name, 'launched');
  assert.ok(launched.rootPitch < 0, 'a launched fighter must be thrown backward');

  const down = poseFor(fighter({ state: 'down' }));
  assert.equal(down.name, 'knockdown');
  assert.ok(Math.abs(down.rootPitch) > 1, 'a knockdown must lay the body flat');
  assert.ok(down.rootLift < 0, 'a knockdown must drop the body toward the floor');

  const getup = poseFor(fighter({ state: 'getup', stateFrame: 0 }));
  assert.equal(getup.name, 'getup');
  // Lying flat is a large negative pitch; standing up means that pitch returns toward zero.
  assert.ok(
    poseFor(fighter({ state: 'getup', stateFrame: 17 })).rootPitch > getup.rootPitch,
    'the get-up must progress from flat toward standing across the window',
  );
  // And the whole window has to be *used*: a rig that ignores `stateFrame` freezes at frame 0.
  assert.notDeepEqual(
    poseFor(fighter({ state: 'getup', stateFrame: 9 })).joints,
    getup.joints,
    'the get-up animation does not respond to stateFrame',
  );

  const charge = poseFor(fighter({ state: 'charging', archetypeId: 'jack5', chargeFrames: 0 }));
  assert.equal(charge.name, 'charge');
  assert.ok(
    poseFor(fighter({ state: 'charging', archetypeId: 'jack5', chargeFrames: 120 })).rootPitch <
      charge.rootPitch,
    'a deeper Gigaton hold must coil further',
  );
});

test('update copies position and facing onto the rig without touching the fighter', () => {
  const rig = new CharacterRig('bryan_fury', 3);
  const subject = fighter({
    slot: 3,
    archetypeId: 'bryan_fury',
    x: 3 * FP_SCALE,
    y: FP_SCALE,
    z: -5 * FP_SCALE,
    facing: -1,
  });
  const before = JSON.stringify(subject);

  rig.update(subject);

  assert.equal(rig.group.position.x, 3);
  assert.equal(rig.group.position.y, 1);
  assert.equal(rig.group.position.z, -5);
  assert.equal(rig.group.rotation.y, -Math.PI / 2);
  assert.equal(JSON.stringify(subject), before, 'update wrote back into simulation state');

  // An eliminated fighter is hidden rather than removed: the sim keeps the record, and a rig that
  // vanished would leave the HUD talking about a fighter nobody can see.
  const dead = fighter({ eliminated: true });
  rig.update(dead);
  assert.equal(rig.group.visible, false);
  rig.dispose();
});

test('update applies the pose to the actual joint pivots', () => {
  const rig = new CharacterRig('brad_hawk');
  const def = getMove('brad_hawk_barrage_1');
  const pose = rig.update(inMove('brad_hawk_barrage_1', def.startup + 1), def);

  for (const [name, angles] of Object.entries(pose.joints)) {
    const pivot = rig.joints[name];
    assert.equal(pivot.rotation.x, angles[0], `${name}.x was not applied`);
    assert.equal(pivot.rotation.z, angles[2], `${name}.z was not applied`);
  }
  rig.dispose();
});

test('dispose releases every geometry and material, and is idempotent', () => {
  const rig = new CharacterRig('jack5', 1);

  // Walk the scene graph and count what has to go.
  const geometries = new Set();
  const materials = new Set();
  rig.group.traverse((node) => {
    const mesh = node;
    if (mesh.geometry !== undefined) geometries.add(mesh.geometry);
    if (mesh.material !== undefined) materials.add(mesh.material);
  });
  assert.ok(geometries.size > 0, 'the rig built no geometry');
  assert.ok(materials.size > 0, 'the rig built no materials');

  const disposedGeometries = [];
  const disposedMaterials = [];
  for (const geometry of geometries) {
    const original = geometry.dispose.bind(geometry);
    geometry.dispose = () => {
      disposedGeometries.push(geometry);
      original();
    };
  }
  for (const material of materials) {
    const original = material.dispose.bind(material);
    material.dispose = () => {
      disposedMaterials.push(material);
      original();
    };
  }

  rig.dispose();
  assert.equal(rig.isDisposed, true);
  assert.equal(disposedGeometries.length, geometries.size, 'a geometry was not released');
  assert.equal(disposedMaterials.length, materials.size, 'a material was not released');

  // Idempotent: a second dispose must not double-release or throw.
  assert.doesNotThrow(() => rig.dispose());
  assert.equal(disposedGeometries.length, geometries.size);
});

test('the roster builds one rig per fighter and rebuilds without leaking', () => {
  // A minimal scene: `CharacterRoster` only needs add/remove, and using a stub rather than a real
  // `THREE.Scene` is what lets the test assert on *membership* rather than on geometry.
  const added = [];
  const removed = [];
  const scene = {
    add: (node) => added.push(node),
    remove: (node) => removed.push(node),
  };

  const runnerFighters = ARCHETYPES.map((archetype, slot) =>
    createFighter(slot, archetype.id, slot, slot),
  );

  const roster = new CharacterRoster(scene);
  roster.build(runnerFighters);
  assert.equal(added.length, 4);
  for (const fighter of runnerFighters) {
    assert.ok(roster.get(fighter.slot), `no rig for slot ${fighter.slot}`);
  }

  // Updating walks every rig and poses it.
  roster.update(runnerFighters);
  assert.equal(roster.all().length, 4);

  // A LAN session swapping the world rebuilds rather than reuses: every old rig must be removed
  // from the scene and disposed, not left in it.
  roster.dispose();
  assert.equal(removed.length, 4);
  for (const rig of roster.all()) {
    assert.equal(rig.isDisposed, true);
  }
  assert.equal(roster.all().length, 0);
});
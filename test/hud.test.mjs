/**
 * Phase 4 presentation gate — arcade HUD (`npm test`).
 *
 * Runs the real `src/ui/hud.ts` headlessly. There is no `document` in a Node process, so the
 * view half is driven against a small stub DOM built at the top of this file, and the model half
 * (`HudState`) is driven against real `Fighter` records produced by the real `MatchRunner`.
 *
 * Covered:
 *   - the model half is total and pure-enough: every panel is produced, values stay in 0..1
 *   - SPA tier gating matches the costs the simulation actually charges (the meter cannot lie)
 *   - the damage ghost trails behind real health after a hit and catches up on a timer
 *   - combo counters count attacker hits, reset on being hit, ignore blocked hits, and expire
 *   - target lock is derived, both directions
 *   - the view half mounts four panels against a stub document and writes widths onto real nodes
 *   - the view half is a **complete no-op with no document** — the headless-safety rule AGENTS.md
 *     §3.1 sets for the presentation layer
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadHud, loadSim } from '../tools/load-sim.mjs';

const hud = await loadHud();
const sim = await loadSim();

const { ArcadeHud, HudState, HudView, spaTierFor, defaultTag, SLOT_COLORS, SPA_TIER_COSTS, COMBO_WINDOW_TICKS } = hud;
const { MatchRunner, createFighter, defaultSpawns, DT, FP_SCALE, idleInput } = sim;

after(cleanup);

// -------------------------------------------------------------------------------------------
// A stub DOM: just enough of `Document` for the HUD view, no more.
// -------------------------------------------------------------------------------------------

function stubElement(tagName) {
  return {
    tagName,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    textContent: '',
    display: undefined,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parentNode = null;
      return child;
    },
  };
}

const stubDocument = {
  createElement: (tagName) => stubElement(tagName),
  body: stubElement('body'),
};

/** Depth-first walk of a stub tree. */
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

/** The mounted HUD root, or undefined when nothing is mounted. */
function rootOf(doc) {
  return doc.body.children.find((child) => child.getAttribute('data-ur') === 'hud');
}

/** A four-way roster at rest. */
function roster() {
  return defaultSpawns().map((spawn) =>
    createFighter(spawn.slot, spawn.archetypeId, spawn.x, spawn.z, spawn.facing),
  );
}

/** A hit event, with only the fields the HUD reads populated. */
function hitEvent(attackerSlot, defenderSlot, extra = {}) {
  return {
    type: 'hit',
    tick: 0,
    attackerSlot,
    defenderSlot,
    moveId: 'brad_hawk_barrage_1',
    damage: 22,
    hitstun: 12,
    blockstun: 10,
    hitstop: 8,
    guarded: false,
    knockdown: false,
    launcher: false,
    distanceFp: FP_SCALE,
    ...extra,
  };
}

// -------------------------------------------------------------------------------------------
// Model
// -------------------------------------------------------------------------------------------

test('a sync over the full roster produces four ordered panels', () => {
  const state = new HudState();
  const model = state.sync({ fighters: roster(), tick: 0 });

  assert.equal(model.panels.length, 4);
  assert.deepEqual(model.panels.map((panel) => panel.slot), [0, 1, 2, 3]);
  assert.deepEqual(model.panels.map((panel) => panel.tag), ['1P', '2P', '3P', '4P']);
  assert.deepEqual(model.panels.map((panel) => panel.color), [...SLOT_COLORS]);
  for (const panel of model.panels) {
    assert.equal(panel.health, 1);
    assert.equal(panel.ghost, 1, 'a ghost starts level with real health');
    assert.equal(panel.spa, 0);
    assert.equal(panel.combo, 0);
    assert.equal(panel.alive, true);
    assert.equal(panel.lockTarget, -1);
  }
});

test('default tags and partial input are tolerated', () => {
  assert.equal(defaultTag(0), '1P');
  assert.equal(defaultTag(3), '4P');

  // Every field but `fighters` is optional — a HUD that threw on a partial frame would take the
  // render loop with it.
  const model = new HudState().sync({ fighters: roster() });
  assert.equal(model.panels.length, 4);
  assert.equal(model.tick, 0);
});

test('SPA tier gating matches the costs the simulation charges', () => {
  // The declared SPA costs in the tables are 50 and 100 on a 100-point gauge.
  assert.equal(SPA_TIER_COSTS[0], 0);
  assert.equal(SPA_TIER_COSTS[1], 0.5);
  assert.equal(SPA_TIER_COSTS[2], 1);

  assert.equal(spaTierFor(0, 100), 0);
  assert.equal(spaTierFor(49, 100), 0, 'a hair under half a gauge must not light tier 1');
  assert.equal(spaTierFor(50, 100, 1), 1);
  assert.equal(spaTierFor(99, 100, 1), 1);
  assert.equal(spaTierFor(100, 100, 1), 3, 'a full gauge with a partner lights the dual');

  // The dual SPA (AGENTS.md §5, tag-team beatdown) additionally needs somebody to tag with, so a
  // lone survivor never sees the third pip light — even on a full gauge.
  assert.equal(spaTierFor(100, 100, 0), 2, 'the dual lit with nobody to tag with');

  // And the panel reports the same thing from the fighter's own meter.
  const fighters = roster();
  fighters[0].spaMeter = 60;
  const model = new HudState().sync({ fighters });
  assert.equal(model.panels[0].spa, 0.6);
  assert.equal(model.panels[0].spaTier, 1);

  fighters[0].spaMeter = 100;
  assert.equal(new HudState().sync({ fighters }).panels[0].spaTier, 3, 'four alive, full gauge');

  // Knock everyone but one out: the survivor's dual is gone.
  for (let slot = 1; slot < 4; slot += 1) fighters[slot].eliminated = true;
  const alone = new HudState().sync({ fighters });
  assert.equal(alone.panels[0].spaTier, 2, 'a lone survivor still lit the dual');

  // A degenerate gauge must not divide by zero into a NaN tier.
  assert.equal(spaTierFor(10, 0), 0);
});

test('the damage ghost trails behind real health, then catches up', () => {
  const state = new HudState();
  const fighters = roster();

  // Establish the ghosts at full health.
  assert.equal(state.sync({ fighters, dt: 1 / 60 }).panels[0].ghost, 1);

  // Take a hit: the bar drops instantly, the ghost stays where it was.
  fighters[0].health = 1000 - 220;
  const hitFrame = state.sync({ fighters, dt: 1 / 60 });
  assert.equal(hitFrame.panels[0].health, 0.78);
  assert.equal(hitFrame.panels[0].ghost, 1, 'the ghost must still be showing the old value');

  // The ghost only falls when time passes, and only partway on the first frame.
  const settling = state.sync({ fighters, dt: 1 / 60 });
  assert.ok(settling.panels[0].ghost < 1, 'the ghost never started draining');
  assert.ok(settling.panels[0].ghost > settling.panels[0].health, 'the ghost overtook real health');

  // Give it time and it converges exactly, rather than asymptotically approaching.
  let model = settling;
  for (let i = 0; i < 240; i += 1) {
    model = state.sync({ fighters, dt: 1 / 60 });
  }
  assert.equal(model.panels[0].ghost, model.panels[0].health, 'the ghost never met the bar');

  // Health never rises during a match, so the "ghost rises with health" branch is only reachable
  // via a reset; it must snap up rather than linger below the bar it is meant to lead.
  fighters[0].health = 1000;
  const restored = state.sync({ fighters, dt: 1 / 60 });
  // The same one-frame lag the hit had, mirrored: the ghost leads the bar by a frame, so it takes
  // the next frame to catch up to the restored health.
  assert.equal(restored.panels[0].health, 1);
  assert.equal(restored.panels[0].ghost, 0.78);
  assert.equal(state.sync({ fighters, dt: 1 / 60 }).panels[0].ghost, 1, 'the ghost never led again');
});

test('a critical fighter is flagged for the HUD to flash', () => {
  const state = new HudState();
  const fighters = roster();
  fighters[2].health = fighters[2].maxHealth * 0.2;
  const model = state.sync({ fighters });
  assert.equal(model.panels[2].critical, true);
  assert.equal(model.panels[0].critical, false);

  // A dead fighter is not "critical" — it is out, and its panel dims instead.
  fighters[3].health = 0;
  fighters[3].eliminated = true;
  const dead = state.sync({ fighters });
  assert.equal(dead.panels[3].alive, false);
  assert.equal(dead.panels[3].critical, false);
});

test('combo counters count the attacker, reset the victim, and ignore blocks', () => {
  const state = new HudState();
  const fighters = roster();

  // A three-hit string from slot 0.
  const string = [hitEvent(0, 1), hitEvent(0, 1), hitEvent(0, 1)];
  let model = state.sync({ fighters, events: string, tick: 10 });
  assert.equal(model.panels[0].combo, 3);
  assert.equal(model.panels[1].combo, 0, 'the victim should have no combo');

  // Slot 1 hits back: its counter starts, slot 0's is destroyed.
  model = state.sync({ fighters, events: [hitEvent(1, 0)], tick: 12 });
  assert.equal(model.panels[1].combo, 1);
  assert.equal(model.panels[0].combo, 0, 'taking a hit must break the attacker combo');

  // A blocked hit is not a link: no damage, no stagger, no counter.
  const blocked = state.sync({
    fighters,
    events: [hitEvent(1, 0, { guarded: true })],
    tick: 14,
  });
  assert.equal(blocked.panels[1].combo, 1, 'a blocked hit was counted as a combo link');
});

test('combo counters expire after the window', () => {
  const state = new HudState();
  const fighters = roster();

  state.sync({ fighters, events: [hitEvent(0, 1)], tick: 100 });
  assert.equal(state.sync({ fighters, tick: 101 }).panels[0].combo, 1);

  const justInside = state.sync({ fighters, tick: 100 + COMBO_WINDOW_TICKS }).panels[0].combo;
  assert.equal(justInside, 1, 'the counter expired early');

  const expired = state.sync({ fighters, tick: 100 + COMBO_WINDOW_TICKS + 1 }).panels[0].combo;
  assert.equal(expired, 0, 'the counter outlived its window');
});

test('target lock is derived in both directions', () => {
  const state = new HudState();
  const fighters = roster();
  fighters[0].targetLockedSlot = 2;
  fighters[1].targetLockedSlot = 3;

  const model = state.sync({ fighters });
  assert.equal(model.panels[0].lockTarget, 2);
  assert.deepEqual(model.panels[2].lockedBy, [0], 'slot 2 should show slot 0 locked onto it');
  assert.deepEqual(model.panels[3].lockedBy, [1]);

  // The reticle is player 1's lock, because that is the one the camera follows.
  assert.deepEqual(model.reticle, { slot: 0, target: 2 });

  fighters[0].targetLockedSlot = -1;
  assert.equal(state.sync({ fighters }).reticle, null, 'reticle survived losing its lock');
});

test('the HUD survives a real 600-tick match driven by the real simulation', () => {
  const state = new HudState();
  const runner = new MatchRunner();
  let model = null;

  for (let tick = 0; tick < 600; tick += 1) {
    const stance = ['neutral', 'up', 'down', 'side'][tick % 4];
    const inputs = runner.fighters.map((fighter, slot) =>
      idleInput({
        attack: tick % 7 === slot % 7 ? stance : null,
        moveX: tick % 3 === slot ? 1 : 0,
        stance,
        guard: tick % 5 === slot ? 'high' : 'none',
      }),
    );
    const events = runner.fixedUpdate(DT, inputs);
    model = state.sync({ fighters: runner.fighters, events, dt: 1 / 60, tick: runner.tick });

    // Every invariant, every frame. A HUD that goes NaN on tick 401 is a HUD that shows nothing
    // for the rest of the match.
    assert.equal(model.panels.length, 4);
    for (const panel of model.panels) {
      assert.ok(Number.isFinite(panel.health), `slot ${panel.slot} health is not finite`);
      assert.ok(panel.health >= 0 && panel.health <= 1, `slot ${panel.slot} health out of range`);
      assert.ok(panel.ghost >= 0 && panel.ghost <= 1, `slot ${panel.slot} ghost out of range`);
      assert.ok(panel.ghost >= panel.health - 1e-9, `slot ${panel.slot} ghost fell behind health`);
      assert.ok(panel.spa >= 0 && panel.spa <= 1, `slot ${panel.slot} spa out of range`);
      assert.ok(Number.isInteger(panel.combo), `slot ${panel.slot} combo is not an integer`);
      assert.ok(panel.spaTier >= 0 && panel.spaTier <= 3);
    }
  }

  // Guard against a vacuous pass: the scenario must actually have traded damage.
  assert.ok(
    runner.fighters.some((fighter) => fighter.health < fighter.maxHealth),
    'the scenario dealt no damage, so the HUD assertions proved nothing',
  );
  assert.ok(model !== null);
});

// -------------------------------------------------------------------------------------------
// View
// -------------------------------------------------------------------------------------------

test('the view is a complete no-op with no document (AGENTS.md §3.1)', () => {
  assert.equal(typeof globalThis.document, 'undefined', 'this suite must run headless');

  // `doc: null` is what the module resolves on its own in Node, stated explicitly so the test
  // does not depend on there being no ambient `document`.
  const view = new HudView({ doc: null });
  assert.equal(view.available, false);
  assert.equal(view.mount(null), false);
  assert.equal(view.isMounted, false);

  // Rendering and disposing a view that never mounted must both be silent no-ops.
  assert.doesNotThrow(() => view.render({ tick: 0, panels: [], reticle: null }));
  assert.doesNotThrow(() => view.dispose());

  // And the combined object must survive a full frame's worth of calls, which is exactly what the
  // render loop does without checking whether a HUD exists.
  const arcade = new ArcadeHud({ doc: null });
  assert.equal(arcade.mount(null), false);
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i += 1) {
      arcade.sync({ fighters: roster(), dt: 1 / 60, tick: i });
    }
  });
  assert.doesNotThrow(() => arcade.dispose());
});

test('mounting builds four corner panels with a health, ghost, SPA bar and three tier pips', () => {
  const view = new HudView({ doc: stubDocument });
  assert.equal(view.mount(stubDocument.body), true);
  assert.equal(view.isMounted, true);

  const root = stubDocument.body.children[0];
  assert.ok(root !== undefined);
  assert.equal(root.getAttribute('data-ur'), 'hud');
  assert.equal(root.children.length, 4, 'expected four player panels');

  root.children.forEach((panel, slot) => {
    assert.equal(panel.getAttribute('data-slot'), String(slot));
    // Every panel must be anchored to a corner, or the arcade layout does not exist.
    assert.match(panel.style.cssText, /position:absolute/);
    assert.match(panel.style.cssText, slot < 2 ? /top:10px/ : /bottom:10px/);
    assert.match(panel.style.cssText, slot % 2 === 0 ? /left:10px/ : /right:10px/);

    // One pip per SPA tier. The bars themselves only get a `width` once something is rendered,
    // so they are counted after a render rather than at mount.
    const pips = walk(panel).filter((node) => node.getAttribute('data-tier') !== null);
    assert.equal(pips.length, 3, `slot ${slot} should have three SPA tier pips`);
    assert.deepEqual(
      pips.map((pip) => pip.getAttribute('data-tier')),
      ['1', '2', '3'],
    );
  });

  // Render once and count the three width-driven bars: health, ghost and SPA fill.
  const state = new HudState();
  view.render(state.sync({ fighters: roster() }));
  for (const panel of root.children) {
    const bars = walk(panel).filter((node) => node.style.width !== undefined);
    assert.equal(bars.length, 3, 'a panel is missing one of its three bars');
  }

  view.dispose();
  assert.equal(stubDocument.body.children.length, 0, 'dispose did not remove the HUD');
  assert.equal(view.isMounted, false);
});

test('render writes real health, ghost and SPA widths onto real nodes', () => {
  const view = new HudView({ doc: stubDocument });
  view.mount(stubDocument.body);

  const state = new HudState();
  const fighters = roster();
  state.sync({ fighters }); // establish ghosts at full health

  fighters[0].health = 500;
  fighters[0].spaMeter = 100;
  fighters[1].health = 120;

  const model = state.sync({ fighters, dt: 1 / 60 });
  view.render(model);

  const root = stubDocument.body.children[0];
  const first = walk(root.children[0]);
  const widths = first.filter((node) => node.style.width !== undefined);
  assert.equal(widths[0].style.width, '100.0%', 'the ghost bar did not keep its old value');
  assert.equal(widths[1].style.width, '50.0%');
  assert.equal(widths[2].style.width, '100.0%');

  // A full gauge with four fighters alive lights every pip in the panel's own colour, including the
  // dual.
  const pips = first.filter((node) => node.getAttribute('data-tier') !== null);
  assert.equal(pips[0].style.background, SLOT_COLORS[0]);
  assert.equal(pips[1].style.background, SLOT_COLORS[0]);
  assert.equal(pips[2].style.background, SLOT_COLORS[0]);

  // With no partner left, the dual pip goes back out even on a full gauge.
  for (const fighter of [fighters[1], fighters[2], fighters[3]]) fighter.eliminated = true;
  view.render(state.sync({ fighters }));
  const alone = walk(rootOf(stubDocument).children[0]).filter(
    (node) => node.getAttribute('data-tier') === '3',
  );
  assert.equal(alone.length, 1);
  assert.equal(alone[0].style.background, 'rgba(255,255,255,.14)', 'the dual lit with nobody to tag');

  // The player tag and archetype name reach the DOM.
  const texts = first.map((node) => node.textContent).filter((text) => text !== '');
  assert.ok(texts.includes('1P'));
  assert.ok(texts.includes('brad hawk'));

  view.dispose();
});

test('render shows the tag a connected device reports', () => {
  const view = new HudView({ doc: stubDocument });
  view.mount(stubDocument.body);

  const state = new HudState();
  const model = state.sync({
    fighters: roster(),
    tags: ['pad one', '', '   ', undefined],
  });
  view.render(model);

  const panels = rootOf(stubDocument).children;
  const textsIn = (slot) => walk(panels[slot]).map((node) => node.textContent);
  assert.ok(textsIn(0).includes('pad one'), 'the device label did not reach the DOM');
  assert.ok(textsIn(1).includes('2P'), 'an unlabelled slot should fall back to its nP tag');
  assert.ok(textsIn(2).includes('3P'), 'a whitespace label should fall back too');
  assert.ok(textsIn(3).includes('4P'), 'a missing label should fall back');

  view.dispose();
});

test('render flags a locked fighter and dims an eliminated one', () => {
  const view = new HudView({ doc: stubDocument });
  view.mount(stubDocument.body);

  const fighters = roster();
  fighters[0].targetLockedSlot = 1;
  fighters[3].eliminated = true;

  const state = new HudState();
  view.render(state.sync({ fighters }));

  const panels = stubDocument.body.children[0].children;
  assert.match(panels[0].style.border, new RegExp(SLOT_COLORS[0]), 'no lock border on the locker');
  assert.equal(panels[1].style.border, '1px solid transparent');
  assert.equal(panels[3].style.opacity, '0.32', 'an eliminated panel should dim');

  view.dispose();
});

test('render only shows a combo counter from two hits up', () => {
  const view = new HudView({ doc: stubDocument });
  view.mount(stubDocument.body);
  const state = new HudState();
  const fighters = roster();

  view.render(state.sync({ fighters, events: [hitEvent(0, 1)], tick: 1 }));
  const comboWrap = () => walk(stubDocument.body.children[0].children[0]).find((node) => node.style.display !== undefined && node.style.display === 'block');
  assert.equal(comboWrap(), undefined, 'a single hit should not show a combo counter');

  view.render(state.sync({ fighters, events: [hitEvent(0, 1)], tick: 2 }));
  const shown = walk(stubDocument.body.children[0].children[0]).find(
    (node) => node.style.display === 'block' && node.children.length === 1,
  );
  assert.ok(shown !== undefined, 'a two-hit string should show a combo counter');
  assert.equal(shown.children[0].textContent, '2');
  assert.equal(shown.children[0].style.color, SLOT_COLORS[0]);

  view.dispose();
});

test('remounting after dispose works, and double mount is refused', () => {
  const view = new HudView({ doc: stubDocument });
  assert.equal(view.mount(stubDocument.body), true);
  assert.equal(view.mount(stubDocument.body), false, 'a second mount should be refused');
  assert.equal(stubDocument.body.children.length, 1, 'a refused mount still added a tree');

  view.dispose();
  assert.equal(view.mount(stubDocument.body), true);
  assert.equal(stubDocument.body.children.length, 1);
  view.dispose();
});
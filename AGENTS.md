# AGENTS.md — Urban Reign Web Operating Protocol

This document governs autonomous and pair-programming agents (Antigravity, MiniMax `mcode`, local LLMs like Qwen on Strata) working on the **urban-reign-web** codebase. All agents must adhere to these directives.

---

## 1. Subagent Delegation & Review Contract

When a parent agent delegates tasks to a subagent (such as running `mcode exec`):

### 1.1 The Mandatory Subagent Audit Rule
The parent agent **MUST NEVER** blindly accept or skim a subagent's return message.
When a subagent reports back:
1. **Analyze the Report**: Scrutinize the subagent's summary for:
   - Any bugs, edge cases, or traps the subagent claimed to have uncovered or resolved.
   - Any unhandled design decisions, deferred tasks, or caveats noted in the output.
   - Any deviations from the target branch (e.g. subagent creating a feature branch or PR instead of committing directly to `main`).
2. **Inspect the Code Diff**: Audit the actual changes on disk (`git diff`, `git status`, or `view_file`):
   - Confirm whether claimed fixes actually exist in the code.
   - Ensure the fixes are architecturally sound, adhere to existing types, and do not introduce regressions.
3. **Remediate and Rework**: If any bugs, partial fixes, unaddressed edge cases, or regressions remain, the parent agent **MUST immediately rework and fix them** before proceeding with further phases or user handoff.
4. **Merge and Push to `main`**: If the subagent created a feature branch or PR, the parent agent must verify the tests, merge the branch into `main`, and push `main` to `origin/main`.

### 1.2 Multi-Agent Hierarchy
- **Primary Implementation Engine**: MiniMax `mcode` CLI (`mcode exec --permission full "<prompt>"`) where tokens are free.
- **Local Fallback Engine**: Local Qwen 3.8B running on Strata (`http://127.0.0.1:8090/v1`) if `mcode` runs out of tokens or is unavailable.
- **Parent Agent Role**: System architect, reviewer, quality gatekeeper, and release manager. Issues clear high-level goals, audits every commit, and ensures the repo stays clean.

---

## 2. Execution & Concurrency Rules

- **Zero Background Polling**: Agents **MUST NEVER** run busy-wait loops, sleep loops, or status-polling scripts in shells or subagents. Launch asynchronous tasks, stop tool calls, and rely on reactive system notifications when commands complete.
- **Always Ship on `main`**: All completed and verified work must land on `main` and be pushed to `origin/main`. Working trees must be left clean.
- **Preserve Documentation Integrity**: Maintain existing inline comments, design rationales, and test suite comments. Do not delete explanatory context.

---

## 3. Core Architectural Invariants

### 3.1 Strict Separation of Simulation vs. Presentation
- **Simulation Core (`src/combat/`, `src/sim/`, `src/arena/`)**:
  - Deterministic 60Hz integer-tick fixed simulation (`fixedUpdate(dt = 1/60)`).
  - All moves, archetypes, chains, and stages are pure data (`MOVESET`, `CHAINS`, `CharacterArchetype`, `StageDef`).
  - **ZERO dependencies on DOM, Three.js, WebGL, or Web Audio APIs.** The simulation must run identically in headless Node test runners, replay diffing tools, and network peers.
- **Presentation Layer (`src/render/`, `src/audio/`, `src/ui/`, `src/camera/`)**:
  - Visuals, procedural strike/grapple poses, particle VFX, camera tracking, Web Audio sound synthesis, HUD, and 3D urban stage geometry.
  - Consumes event streams (`HitEvent`, `WallImpact`, `DodgeEvent`, `SpaEvent`) emitted by the sim; **MUST NEVER** mutate or feed back into simulation state.
  - Headless/Node-safe: All audio and DOM access must gracefully no-op when `AudioContext`, `window`, or `document` are undefined.

### 3.2 Determinism & Replay Fidelity
- The simulation must remain bit-identical across runs, platforms, and display refresh rates (30Hz, 60Hz, 120Hz, 144Hz, 240Hz).
- Never use wall-clock time (`Date.now()`, `performance.now()`) inside physics, combat, or input buffering.
- `MatchRunner.stateHash()` must cover every state property that influences future ticks (positions, velocities, state, stateFrame, health, spaMeter, eliminated, juggleCount, hitstop, hitConnect, stunRemaining, blockstunLeft, facing, currentMove, targetLockedSlot).

### 3.3 Networking & Rollback Netcode (`src/net/`)
- **Deterministic Snapshots**: `saveSnapshot(runner)` and `restoreSnapshot(runner, snapshot)` must achieve exact round-trip fidelity:
  $$\text{stateHash}(\text{restore}(\text{save}(runner))) \equiv \text{stateHash}(runner)$$
- **Speculative Rollback**: Local player executes with 0 input delay. Remote peers are predicted (repeating last known input). When remote packets arrive, if predictions differ, rewind to the earliest poisoned tick, apply the verified inputs, re-simulate forward with `runner.step()`, and re-snapshot on the corrected lineage.
- **House LAN Auto-Discovery & Zero-Config Access**:
  - Hosted locally via Vite/Node server with WebSocket relay.
  - Provides LAN IP address and on-screen QR code so players anywhere in the house can open the browser on phone/tablet/laptop.
  - Supports on-screen virtual touch arcade controls for mobile devices, physical Gamepads (via Gamepad API), and split keyboards.

---

## 4. The 4-Gate Verification Rule

Before any phase or feature change is considered complete and merged to `main`, all four gates must pass:

1. **`npm test`**:
   - All test suites must pass 100% with 0 failures.
   - Any new mechanic, archetype, stage, or netcode feature must include a dedicated automated test suite in `test/` wired into `package.json`.
2. **`npm run typecheck`**:
   - Zero TypeScript diagnostics (`tsc --noEmit`).
3. **`npm run build`**:
   - Production Vite client bundle must compile cleanly (`tsc && vite build`).
4. **`npm run report`**:
   - Combat and frame-data balance report must confirm zero discrepancies between theoretical moveset data and measured simulation outcomes.

---

## 5. Urban Reign Game Design Reference

Urban Reign is modeled on Namco's 2005 3D multiplayer brawler engine:
- **Free-Roam 3D Arena & Multi-Opponent Brawling**: Unconstrained 3D movement in urban stages (alleyways, parking lots, warehouses). Support for 4 simultaneous combatants in Free-For-All or 2v2 Tag teams.
- **Target Locking & Seamless Target Switching**: Dedicated target cycle (L2/R2 / bumper / stick flick) allowing attacks to redirect mid-string across multiple surrounding adversaries.
- **4-Way Directional Branching Combos**: Directional attacks (Neutral, Up, Down, Side) with branching strings, aerial launchers, low sweeps, staggers, and knockbacks (sourced directly from `runtime/combat-trial13/spec.py`).
- **High/Low Dodge & Reversals**:
  - Neutral/Up Dodge: slips and counters high/mid strikes.
  - Down Dodge: low parry / evasive hop over sweeps.
  - Reversals: Frame-perfect timing on incoming impacts executes immediate counter-throws.
- **Grabs & Ground Control**: High/low standing grapples, behind-the-back tackles, and grounded mount attacks.
- **Special Arts (SPA Gauge)**:
  - SPA 1 (Lethal single-target strike).
  - SPA 2 (360-degree crowd clearer / emergency escape).
  - SPA 3 / Dual SPA (Tag-team beatdown).
- **Weapons & Environment Interactions**: Bats, pipes, blades, wall runs, rebound kicks, and wall-splat bounces.

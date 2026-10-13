/**
 * House-LAN wire protocol.
 *
 * AGENTS.md §3.3 asks for a local WebSocket relay, and this file is the contract both ends of it
 * speak. It is deliberately the *dumbest* module in `src/net/`: pure data, pure functions, no
 * sockets, no clocks, no randomness, no DOM. Everything here is a total function over its input,
 * which is what lets `test/lan.test.mjs` prove the properties below in Node with no browser and no
 * server running.
 *
 * ## Why input deserialisation is defensive rather than trusting
 *
 * `MatchRunner.handleAttack` throws a `RangeError` on an unknown move id, which is the right
 * behaviour for a local caller and catastrophic for a network one: a single malformed packet from
 * one peer would otherwise tear down every other player's simulation mid-match. So
 * `decodeInput` is a *validator*, not a parser. It only returns an input when the move id is
 * actually in `MOVESET` (or is a stance, the chain sentinel, or an archetype's charge entry), the
 * movement axes are finite numbers clamped to the eight-way table the simulation reads, and the
 * stance/guard/dodge enums are members. Anything else is `null`, and the caller substitutes a
 * neutral input rather than believing the sender.
 *
 * That is not paranoia for its own sake: a house LAN also contains the roommate's laptop, and
 * "this frame was garbage" must degrade to "this frame was nothing", never to "the game crashed".
 *
 * ## Why movement is quantised on the wire
 *
 * The simulation already snaps movement to an eight-way table, so quantising to eighths before
 * it goes out costs the player nothing and buys exactness: `0.375` is exactly representable in
 * binary floating point, so two peers comparing inputs with `===` agree. Without it, a peer that
 * compared `0.37499999999` against `0.375` would disagree, roll back, re-simulate, disagree again,
 * and burn the whole rollback window on float noise that never changes the outcome.
 */

import { ARCHETYPES, STANCES, chargeProfileOf } from '../combat/archetypes';
import { MOVESET } from '../combat/moveset';
import type { FrameInput } from '../sim/runner';

/**
 * Bumped whenever a message shape changes incompatibly. A peer whose `v` differs is rejected
 * rather than silently mis-parsed — a wire format that half-works is how rollback bugs are born.
 */
export const PROTOCOL_VERSION = 1;

/** Default TCP port for the local relay (AGENTS.md §3.3). */
export const DEFAULT_RELAY_PORT = 8765;

/** AGENTS.md §5: four simultaneous combatants, so four peers per house relay. */
export const MAX_PLAYERS = 4;

/** Slots are 0..3; anything outside is a malformed packet. */
export function isValidSlot(slot: unknown): slot is number {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < MAX_PLAYERS;
}

/** Why a relay refused a `hello`. */
export type RejectCode = 'version' | 'full' | 'name' | 'room' | 'protocol';

export const REJECT_CODES: readonly RejectCode[] = Object.freeze([
  'version',
  'full',
  'name',
  'room',
  'protocol',
]);

// -------------------------------------------------------------------------------------------
// Wire input
// -------------------------------------------------------------------------------------------

export type WireGuard = 'none' | 'high' | 'low';
export type WireDodge = 'none' | 'high' | 'low';
export type WireStance = 'neutral' | 'up' | 'down' | 'side';

/**
 * Compact `FrameInput` for the wire. Field names are deliberately short — an input packet is the
 * highest-frequency message in the protocol and every byte is sent once per player per tick.
 */
export interface WireInput {
  /** Movement X, quantised to `-1..1` in eighths. */
  readonly x: number;
  /** Movement Z, quantised to `-1..1` in eighths. */
  readonly z: number;
  /** Move id, stance, chain sentinel or charge entry — or `null` for "no press". */
  readonly atk: string | null;
  readonly st: WireStance;
  readonly gd: WireGuard;
  readonly dg: WireDodge;
}

/** Movement is quantised to eighths; see the module header for why. */
export const MOVE_QUANTUM = 8;

/** Hard cap on an attack token's length, before any other validation. */
export const MAX_ATTACK_LENGTH = 64;

/**
 * Move ids are lowercase snake case (`brad_hawk_punch_1`). Restricting the charset is what makes
 * the decoder safe without a denylist: a token that cannot contain a dot, a brace or an uppercase
 * letter can never be a path traversal or a prototype key.
 */
const ATTACK_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * Keys that are meaningful on a plain object but meaningless as a move id. They already fail the
 * charset check, but naming them documents that the rejection is deliberate rather than incidental.
 */
const RESERVED_TOKENS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The sentinel meaning "start the chain for my current stance". Mirrors `runner.CHAIN_PRESS`.
 *
 * Declared before `VALID_ATTACKS` because the sentinel is itself a legal attack token: it is not a
 * move id, not a stance and not a charge entry, but `handleAttack` resolves it against the
 * fighter's own archetype, so omitting it here would silently strip every chain press on the wire
 * and turn every combo in a LAN match into a jab.
 */
export const CHAIN_ATTACK = 'chain';

/**
 * Every string the simulation will accept as `FrameInput.attack`.
 *
 * `handleAttack` accepts a move id, a stance, the chain sentinel, or an archetype's charge entry
 * (Jack-5's Gigaton hold). Anything outside this set would make the runner throw, so the set is
 * built once from the same tables the runner reads.
 */
const VALID_ATTACKS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const def of MOVESET) {
    set.add(def.id);
  }
  for (const stance of STANCES) {
    set.add(stance);
  }
  for (const archetype of ARCHETYPES) {
    const profile = chargeProfileOf(archetype.id);
    if (profile !== null) {
      set.add(profile.chainEntry);
    }
  }
  set.add(CHAIN_ATTACK);
  return Object.freeze(set);
})();

/** Stances, for cheap membership tests. */
const VALID_STANCES: ReadonlySet<string> = new Set(STANCES);
const VALID_GUARDS: ReadonlySet<string> = new Set<WireGuard>(['none', 'high', 'low']);
const VALID_DODGES: ReadonlySet<string> = new Set<WireDodge>(['none', 'high', 'low']);

/** The wire form of "no input at all", used for a departed peer and for unvalidated packets. */
export const NEUTRAL_WIRE_INPUT: WireInput = Object.freeze({
  x: 0,
  z: 0,
  atk: null,
  st: 'neutral',
  gd: 'none',
  dg: 'none',
});

/**
 * Clamp to `-1..1` and snap to the nearest eighth.
 *
 * The negative-zero case is explicit because `-0 === 0` is true in JavaScript but `Object.is`
 * and JSON round-trips treat them differently; normalising here means the rollback engine's
 * `inputsEqual` never has to think about it.
 */
export function quantiseAxis(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
  const snapped = Math.round(clamped * MOVE_QUANTUM) / MOVE_QUANTUM;
  return snapped === 0 ? 0 : snapped;
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Is this token something `MatchRunner.handleAttack` will accept without throwing? */
export function isValidAttack(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ATTACK_LENGTH &&
    !RESERVED_TOKENS.has(value) &&
    ATTACK_PATTERN.test(value) &&
    VALID_ATTACKS.has(value)
  );
}

/**
 * Project a local `FrameInput` onto the wire.
 *
 * Total: any input, however malformed, encodes to something decodable. Encoding is where the
 * local layer is allowed to *fix* an input (a NaN axis becomes 0); decoding is where an input is
 * allowed to be *rejected*.
 */
export function encodeInput(input: FrameInput): WireInput {
  const attack = input.attack;
  return {
    x: quantiseAxis(input.moveX),
    z: quantiseAxis(input.moveZ),
    atk: attack !== null && attack !== undefined && isValidAttack(attack) ? attack : null,
    st: VALID_STANCES.has(input.stance) ? (input.stance as WireStance) : 'neutral',
    gd: VALID_GUARDS.has(input.guard) ? (input.guard as WireGuard) : 'none',
    dg: VALID_DODGES.has(input.dodge) ? (input.dodge as WireDodge) : 'none',
  };
}

/**
 * Validate an untrusted value into a `WireInput`, or return `null` if it is not one.
 *
 * This is the boundary check. The contract is deliberately all-or-nothing: a packet with a good
 * stance but a `NaN` axis is rejected outright rather than partially repaired, so a corrupt packet
 * is visibly absent instead of silently half-applied on one peer and fully applied on another.
 */
export function decodeWireInput(value: unknown): WireInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;

  const x = raw['x'];
  const z = raw['z'];
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof z !== 'number' || !Number.isFinite(z)) {
    return null;
  }

  const atk = raw['atk'];
  if (atk !== null && !isValidAttack(atk)) {
    return null;
  }
  const st = raw['st'];
  const gd = raw['gd'];
  const dg = raw['dg'];
  if (typeof st !== 'string' || !VALID_STANCES.has(st)) {
    return null;
  }
  if (typeof gd !== 'string' || !VALID_GUARDS.has(gd)) {
    return null;
  }
  if (typeof dg !== 'string' || !VALID_DODGES.has(dg)) {
    return null;
  }

  return {
    x: quantiseAxis(x),
    z: quantiseAxis(z),
    atk,
    st: st as WireStance,
    gd: gd as WireGuard,
    dg: dg as WireDodge,
  };
}

/** Project a validated wire input onto the shape the simulation consumes. */
export function inputFromWire(wire: WireInput): FrameInput {
  return {
    moveX: wire.x,
    moveZ: wire.z,
    attack: wire.atk,
    stance: wire.st,
    guard: wire.gd,
    dodge: wire.dg,
  };
}

/** Validate an untrusted value straight into a `FrameInput`, or `null`. */
export function decodeInput(value: unknown): FrameInput | null {
  const wire = decodeWireInput(value);
  return wire === null ? null : inputFromWire(wire);
}

/**
 * Reduce a locally-sampled input to the exact bytes peers will receive, then back to a `FrameInput`.
 *
 * This exists for one specific, load-bearing reason. If the local peer simulated tick *T* with a
 * raw gamepad axis reading of `0.30000000000000004` while the relay broadcast the quantised `0.375`,
 * then every time the local peer rolled back it would replay tick *T* from the raw value, resimulate
 * to the same state it started from, and disagree with every remote peer about a tick that had not
 * even changed. The divergence would be silent, permanent, and would burn the whole rollback window
 * re-simulating to a conclusion that never arrives.
 *
 * Canonicalising at the edge of the rollback engine means the value a peer predicts, the value it
 * stores, and the value it simulates are the same object contents by construction. Prediction
 * equality then means real equality.
 *
 * Total by construction: `encodeInput` already repairs anything `FrameInput` can legally hold, so
 * there is nothing left here that can fail.
 */
export function canonicalizeInput(input: FrameInput): FrameInput {
  return inputFromWire(encodeInput(input));
}

/** Neutral input, frozen. Exported so callers need not import the simulation just to stand still. */
export const NEUTRAL_FRAME_INPUT: FrameInput = Object.freeze({
  moveX: 0,
  moveZ: 0,
  attack: null,
  stance: 'neutral',
  guard: 'none',
  dodge: 'none',
});

/**
 * Byte-exact input equality, used by the rollback engine to decide whether a prediction was wrong.
 *
 * Compares quantised numbers with `!==` and enums by value. `-0` is normalised by `quantiseAxis`
 * on the way in, so no special case is needed here.
 */
export function inputsEqual(a: WireInput, b: WireInput): boolean {
  return a.x === b.x && a.z === b.z && a.atk === b.atk && a.st === b.st && a.gd === b.gd && a.dg === b.dg;
}

/**
 * Byte-exact `FrameInput` equality.
 *
 * Only meaningful on inputs that have been through `canonicalizeInput` — which is precisely the
 * invariant the rollback engine maintains, and the reason this can be a plain `===` comparison of
 * six fields rather than a fuzzy tolerance check.
 */
export function frameInputsEqual(a: FrameInput, b: FrameInput): boolean {
  return (
    a.moveX === b.moveX &&
    a.moveZ === b.moveZ &&
    a.attack === b.attack &&
    a.stance === b.stance &&
    a.guard === b.guard &&
    a.dodge === b.dodge
  );
}

// -------------------------------------------------------------------------------------------
// Messages
// -------------------------------------------------------------------------------------------

export const MESSAGE_TYPES = Object.freeze([
  'hello',
  'welcome',
  'roster',
  'stage',
  'reject',
  'ready',
  'start',
  'input',
  'sync',
  'desync',
  'ping',
  'pong',
  'lan-ip',
  'lan-ip-reply',
] as const);

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** One row of the house roster, as broadcast to everyone on every change. */
export interface RosterEntry {
  readonly slot: number;
  readonly name: string;
  readonly connected: boolean;
}

/** A player's claimed `stateHash()` for one tick, as reported by the relay's audit. */
export interface HashClaim {
  readonly slot: number;
  readonly hash: string;
}

export type NetMessage =
  /** Client → relay: "I am `name`, I want room `room`". */
  | { readonly t: 'hello'; readonly v: number; readonly name: string; readonly room: string }
  /** Relay → client: slot assigned, room accepted, stage chosen. */
  | { readonly t: 'welcome'; readonly v: number; readonly slot: number; readonly room: string; readonly stage: string }
  /** Relay → everyone: who is in which slot right now. */
  | { readonly t: 'roster'; readonly entries: readonly RosterEntry[] }
  /** Relay → everyone: the arena the room settled on. */
  | { readonly t: 'stage'; readonly stage: string; readonly seed: number }
  /** Relay → client: the `hello` was refused. Terminal for that connection. */
  | { readonly t: 'reject'; readonly code: RejectCode; readonly reason: string }
  /** Client → relay → everyone: this player's start button is up or down. */
  | { readonly t: 'ready'; readonly slot: number; readonly ready: boolean }
  /** Relay → everyone: everyone is ready, the match begins on `tick`. */
  | { readonly t: 'start'; readonly tick: number; readonly stage: string; readonly seed: number }
  /** Client → relay → everyone: the input this player produced for `tick`. */
  | { readonly t: 'input'; readonly tick: number; readonly slot: number; readonly input: WireInput }
  /** Client → relay: my `stateHash()` at `tick`, for the desync audit. */
  | { readonly t: 'sync'; readonly tick: number; readonly hash: string }
  /** Relay → everyone: two peers disagree about `tick`. Carries both hashes so either can localise it. */
  | { readonly t: 'desync'; readonly tick: number; readonly claims: readonly HashClaim[] }
  /** Latency probe. `at` is the sender's clock and is never compared across peers. */
  | { readonly t: 'ping'; readonly seq: number; readonly at: number }
  | { readonly t: 'pong'; readonly seq: number; readonly at: number }
  /** Client → relay: "what addresses can the rest of the house reach you on?" */
  | { readonly t: 'lan-ip'; readonly v: number }
  /** Relay → client: the joinable LAN URLs, already formatted. */
  | { readonly t: 'lan-ip-reply'; readonly port: number; readonly urls: readonly string[] };

/**
 * Largest message the relay will encode or accept.
 *
 * An `input` packet is well under 100 characters, so 4 KiB is generous by an order of magnitude
 * and still small enough that a flood cannot exhaust a phone's heap before the relay drops it.
 * The budget is counted in UTF-16 code units, which is the unit `JSON.stringify` produces and the
 * unit both ends of this protocol measure in; the byte count on the wire is never larger than
 * twice this, so the real limit is tighter than advertised, which is the safe direction.
 */
export const MAX_MESSAGE_BYTES = 4096;

/** Display names are for the HUD roster only, but are still length-capped and stripped. */
export const MAX_NAME_LENGTH = 24;

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Strip control characters and clamp length. A name is shown in a `<div>`, never parsed. */
export function sanitizeName(value: unknown, fallback = 'guest'): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex -- the point is to *remove* control characters.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length === 0 ? fallback : cleaned.slice(0, MAX_NAME_LENGTH);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && /^[0-9a-f]+$/.test(value);
}

function isRejectCode(value: unknown): value is RejectCode {
  return typeof value === 'string' && (REJECT_CODES as readonly string[]).includes(value);
}

function parseStringList(value: unknown, max: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 200) {
      return null;
    }
    out.push(item);
  }
  return Object.freeze(out);
}

/**
 * Validate an untrusted envelope into a `NetMessage`, or `null` if it is not one.
 *
 * Accepts the raw JSON text (what a WebSocket `data` payload actually is) or an already-parsed
 * value, and never throws: a peer that sends garbage gets silence, not an exception on the thread
 * that is also rendering the match.
 */
export function decodeMessage(raw: unknown): NetMessage | null {
  let value: unknown = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (text.length > MAX_MESSAGE_BYTES) {
      return null;
    }
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    // A parsed envelope still went over a socket, so it is held to the same size budget.
    try {
      if (JSON.stringify(raw).length > MAX_MESSAGE_BYTES) {
        return null;
      }
    } catch {
      return null; // cyclic or non-serialisable: not something a peer is allowed to send
    }
  } else {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const t = obj['t'];
  if (!isMessageType(t)) {
    return null;
  }

  switch (t) {
    case 'hello': {
      if (!isFiniteNumber(obj['v']) || !Number.isInteger(obj['v'])) {
        return null;
      }
      const name = sanitizeName(obj['name']);
      const room = sanitizeName(obj['room'], 'house');
      return { t, v: obj['v'], name, room };
    }
    case 'welcome': {
      if (!isFiniteNumber(obj['v']) || !isValidSlot(obj['slot'])) {
        return null;
      }
      return {
        t,
        v: obj['v'],
        slot: obj['slot'],
        room: sanitizeName(obj['room'], 'house'),
        stage: sanitizeName(obj['stage'], 'alley'),
      };
    }
    case 'roster': {
      const raw = obj['entries'];
      if (!Array.isArray(raw) || raw.length > MAX_PLAYERS) {
        return null;
      }
      const entries: RosterEntry[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) {
          return null;
        }
        const entry = item as Record<string, unknown>;
        if (!isValidSlot(entry['slot']) || typeof entry['connected'] !== 'boolean') {
          return null;
        }
        entries.push({ slot: entry['slot'], name: sanitizeName(entry['name']), connected: entry['connected'] });
      }
      return { t, entries: Object.freeze(entries) };
    }
    case 'stage': {
      if (!isFiniteNumber(obj['seed']) || !Number.isInteger(obj['seed'])) {
        return null;
      }
      return { t, stage: sanitizeName(obj['stage'], 'alley'), seed: obj['seed'] };
    }
    case 'reject': {
      if (!isRejectCode(obj['code'])) {
        return null;
      }
      return { t, code: obj['code'], reason: sanitizeName(obj['reason'], 'refused') };
    }
    case 'ready': {
      if (!isValidSlot(obj['slot']) || typeof obj['ready'] !== 'boolean') {
        return null;
      }
      return { t, slot: obj['slot'], ready: obj['ready'] };
    }
    case 'start': {
      if (!isFiniteNumber(obj['tick']) || !Number.isInteger(obj['tick']) || obj['tick'] < 0) {
        return null;
      }
      return { t, tick: obj['tick'], stage: sanitizeName(obj['stage'], 'alley'), seed: isFiniteNumber(obj['seed']) ? Math.trunc(obj['seed']) : 0 };
    }
    case 'input': {
      if (!isValidSlot(obj['slot']) || !isFiniteNumber(obj['tick']) || !Number.isInteger(obj['tick']) || obj['tick'] < 0) {
        return null;
      }
      const input = decodeWireInput(obj['input']);
      if (input === null) {
        return null;
      }
      return { t, tick: obj['tick'], slot: obj['slot'], input };
    }
    case 'sync': {
      if (!isHash(obj['hash']) || !isFiniteNumber(obj['tick']) || !Number.isInteger(obj['tick']) || obj['tick'] < 0) {
        return null;
      }
      return { t, tick: obj['tick'], hash: obj['hash'] };
    }
    case 'desync': {
      const raw = obj['claims'];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLAYERS || !isFiniteNumber(obj['tick'])) {
        return null;
      }
      const claims: HashClaim[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) {
          return null;
        }
        const claim = item as Record<string, unknown>;
        if (!isValidSlot(claim['slot']) || !isHash(claim['hash'])) {
          return null;
        }
        claims.push({ slot: claim['slot'], hash: claim['hash'] });
      }
      return { t, tick: Math.trunc(obj['tick']), claims: Object.freeze(claims) };
    }
    case 'ping':
    case 'pong': {
      if (!isFiniteNumber(obj['seq']) || !Number.isInteger(obj['seq']) || obj['seq'] < 0) {
        return null;
      }
      return { t, seq: obj['seq'], at: isFiniteNumber(obj['at']) ? obj['at'] : 0 };
    }
    case 'lan-ip': {
      if (!isFiniteNumber(obj['v']) || !Number.isInteger(obj['v'])) {
        return null;
      }
      return { t, v: obj['v'] };
    }
    case 'lan-ip-reply': {
      const urls = parseStringList(obj['urls'], 16);
      if (urls === null || !isFiniteNumber(obj['port']) || !Number.isInteger(obj['port'])) {
        return null;
      }
      return { t, port: clampInt(obj['port'], 0, 65535), urls };
    }
    default:
      return null;
  }
}

/**
 * Encode a message for transport.
 *
 * Throws on an oversized message rather than shipping it: an input packet cannot legitimately
 * exceed the budget, so this is a programming error caught at the sender instead of a truncated
 * packet that fails to parse at the receiver.
 */
export function encodeMessage(message: NetMessage): string {
  const text = JSON.stringify(message);
  if (text.length > MAX_MESSAGE_BYTES) {
    throw new RangeError(`Message '${message.t}' is ${text.length} bytes, over the ${MAX_MESSAGE_BYTES} budget.`);
  }
  return text;
}

/** Encode, returning `null` instead of throwing. Used on receive-adjacent paths. */
export function tryEncodeMessage(message: NetMessage): string | null {
  try {
    return encodeMessage(message);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// LAN address discovery (pure half)
// -------------------------------------------------------------------------------------------

/** The subset of Node's `os.networkInterfaces()` entries this module reads. */
export interface NetworkInterfaceInfo {
  readonly address?: string;
  /** String on older Node, numeric on newer. Both are accepted. */
  readonly family?: string | number;
  readonly internal?: boolean;
}

export type NetworkInterfaces = Readonly<Record<string, readonly NetworkInterfaceInfo[]>>;

/** Strict dotted-quad check. Rejects `1.2.3`, `1.2.3.4.5`, `256.0.0.1` and any hostname. */
export function isValidIPv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return false;
    }
    // Reject leading zeros: `010` is ambiguous (octal in some resolvers) and never a real LAN lease.
    if (part.length > 1 && part[0] === '0') {
      return false;
    }
  }
  return true;
}

/** RFC1918 ranges plus link-local, i.e. the addresses a phone on the same Wi-Fi can actually dial. */
export function isPrivateIPv4(value: string): boolean {
  if (!isValidIPv4(value)) {
    return false;
  }
  const [a, b] = value.split('.').map(Number);
  const first = a ?? 0;
  const second = b ?? 0;
  if (first === 10) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  return false;
}

/**
 * Choose the LAN addresses worth putting in a QR code.
 *
 * Loopback, virtual-adapter and IPv6 entries are dropped: a phone cannot use them, and a QR code
 * that encodes four dead addresses is worse than one that encodes the single address that works.
 * Results are sorted so the most likely interface (`192.168.*` on a home router) is first and
 * therefore the one the QR encodes.
 */
export function selectLanIPv4(interfaces: NetworkInterfaces): string[] {
  const seen = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries) {
      if (entry.internal === true || typeof entry.address !== 'string') {
        continue;
      }
      const family = entry.family;
      const isIpv4 = family === 'IPv4' || family === 4;
      if (!isIpv4 || !isPrivateIPv4(entry.address)) {
        continue;
      }
      seen.add(entry.address);
    }
  }
  return [...seen].sort();
}

/** `http://192.168.1.42:5173/?lan` — the string a phone types or a QR encodes. */
export function joinUrl(ip: string, port: number, path = '/?lan'): string {
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `http://${ip}:${clampInt(port, 1, 65535)}${safePath}`;
}

/** Every join URL for the addresses a relay found, in the order they should be offered. */
export function joinUrls(ips: readonly string[], port: number): string[] {
  return ips.map((ip) => joinUrl(ip, port));
}
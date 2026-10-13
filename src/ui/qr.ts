/**
 * QR codes for the house-LAN join URL (AGENTS.md §3.3, "on-screen QR code").
 *
 * Written from scratch on purpose. The engine ships `three` and `ws` and nothing else, and a QR
 * library would be the only dependency in the bundle that exists to serve one panel on the join
 * screen — so the encoder lives here instead, in a few hundred lines of integer arithmetic.
 *
 * Three properties the rest of the repo depends on:
 *
 *   - **Pure and headless.** No `document`, no `window`, no `Date.now()`, no `Math.random()`, no
 *     `Math.pow`. The matrix is a plain `boolean[][]`, so `test/qr.test.mjs` encodes, decodes and
 *     compares it in Node with no browser shim. The only DOM in the file is the optional `mountQr`
 *     painter at the bottom, which reports `false` instead of throwing when `document` is undefined.
 *   - **Deterministic.** The same string gives the same version, the same mask and the same matrix
 *     on every machine, every run. Mask selection takes the lowest of the eight penalty scores with
 *     ties broken by the lowest mask index, so nothing depends on iteration order or hash seeds.
 *   - **Spec-shaped, not a lookup table.** ISO/IEC 18004 byte mode, versions 1-10, all four
 *     error-correction levels, Reed-Solomon over GF(256), the standard two-module-wide zigzag data
 *     path, BCH(15,5) format information with its 0x5412 anti-all-zero mask, and BCH(18,6) version
 *     information from version 7 up.
 *
 * Versions stop at 10 because that is all a join URL needs: `http://192.168.1.42:5173/?lan#p2` is
 * 33 bytes, and version 10-H holds 119.
 */

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/** The symbol, frozen and DOM-free. `modules[y][x] === true` is a dark module. */
export interface QrCode {
  /** Side length in modules; always `4 * version + 17`. */
  readonly size: number;
  readonly version: number;
  readonly errorCorrection: QrErrorCorrection;
  readonly modules: readonly (readonly boolean[])[];
}

export interface QrEncodeOptions {
  readonly errorCorrection?: QrErrorCorrection;
  /** Smallest version the encoder may choose. Defaults to 1. */
  readonly minVersion?: number;
}

/** Highest version the table pack below covers. */
export const QR_MAX_VERSION = 10;

/**
 * The spec's four-module quiet zone, in modules. Every scanner assumes it is there, so the painter
 * draws it even though it is not part of `QrCode.modules`.
 */
const QUIET_ZONE = 4;

// -------------------------------------------------------------------------------------------
// Version tables (ISO/IEC 18004, tables 1 and 13-22). Index 0 is unused so the version number is
// the index.
// -------------------------------------------------------------------------------------------

/** Data + error-correction codewords per version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Error-correction codewords generated for each block, per level then version. */
const EC_CODEWORDS_PER_BLOCK: Readonly<Record<QrErrorCorrection, readonly number[]>> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

/** Reed-Solomon blocks the data codewords are split into, per level then version. */
const NUM_BLOCKS: Readonly<Record<QrErrorCorrection, readonly number[]>> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

/**
 * Alignment pattern centres, per version. Version 1 has none; 2-6 have one usable corner pattern;
 * 7 and up have three across. Spelled out rather than derived from `ceil` so the numbers can be
 * read against the standard's table instead of trusted to floating point.
 */
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [0], // unused, so the version number is the index
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Two-bit error-correction indicator used inside the format information. */
const EC_FORMAT_BITS: Readonly<Record<QrErrorCorrection, number>> = { L: 1, M: 0, Q: 3, H: 2 };

interface BlockLayout {
  /** Data codewords the symbol holds before interleaving. */
  readonly dataCodewords: number;
  /** Error-correction codewords appended to every block. */
  readonly ecPerBlock: number;
  /** Number of Reed-Solomon blocks the data is split into. */
  readonly blocks: number;
}

function blockLayout(version: number, ecc: QrErrorCorrection): BlockLayout {
  const total = TOTAL_CODEWORDS[version] ?? 0;
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[ecc][version] ?? 0;
  const blocks = NUM_BLOCKS[ecc][version] ?? 0;
  const dataCodewords = total - ecPerBlock * blocks;
  if (blocks <= 0 || ecPerBlock <= 0 || dataCodewords <= 0) {
    throw new RangeError(`version ${version} at level ${ecc} has no data capacity`);
  }
  return { dataCodewords, ecPerBlock, blocks };
}

// -------------------------------------------------------------------------------------------
// GF(256) arithmetic
// -------------------------------------------------------------------------------------------

/**
 * Galois field tables for the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), with 2 as
 * the field generator `alpha`. Addition is XOR; multiplication is a log/antilog lookup.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function seedGaloisTables(): void {
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    GF_EXP[power] = value;
    GF_LOG[value] = power;
    value <<= 1;
    // The product exceeds a byte, so reduce by the primitive polynomial.
    if ((value & 0x100) !== 0) {
      value ^= 0x11d;
    }
  }
  // Wrap the table so exponents up to 508 need no modulo.
  for (let power = 255; power < GF_EXP.length; power += 1) {
    GF_EXP[power] = GF_EXP[power - 255] ?? 0;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

/**
 * The Reed-Solomon generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)) with its leading
 * x^degree term dropped, highest power first. Multiplied out with plain polynomial arithmetic so
 * the code reads as the spec rather than as a magic table of 30 precomputed numbers.
 */
function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let power = 0; power < degree; power += 1) {
    const root = GF_EXP[power] ?? 0;
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let k = 0; k < poly.length; k += 1) {
      next[k] = (next[k] ?? 0) ^ (poly[k] ?? 0); // multiply by x
      next[k + 1] = (next[k + 1] ?? 0) ^ gfMul(poly[k] ?? 0, root); // multiply by the root
    }
    poly = next;
  }
  // The leading coefficient is always 1 and is dropped: the remainder never carries that power.
  return poly.slice(1);
}

/**
 * The error-correction codewords for one block: the remainder of the data polynomial divided by
 * the generator polynomial. Long division over GF(256), one `divisor.length` steps per byte.
 */
function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const remainder = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < divisor.length; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(divisor[i] ?? 0, factor);
    }
  }
  return remainder;
}

// -------------------------------------------------------------------------------------------
// BCH check codes: format and version information
// -------------------------------------------------------------------------------------------

/** BCH generator for the 15-bit format information: x^10 + x^8 + x^5 + x^4 + x^2 + x + 1. */
const FORMAT_GENERATOR = 0x537;

/** BCH generator for the 18-bit version information: x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1. */
const VERSION_GENERATOR = 0x1f25;

/**
 * `0x5412` is XORed into the finished format information so an all-zero word — which a quiet
 * finder pattern could otherwise produce — can never be printed.
 */
const FORMAT_MASK = 0x5412;

function bitLength(value: number): number {
  let length = 0;
  for (let rest = value; rest !== 0; rest >>>= 1) {
    length += 1;
  }
  return length;
}

/** Remainder of `value` divided by `generator`, done as binary long division over GF(2). */
function bchRemainder(value: number, generator: number): number {
  const degree = bitLength(generator) - 1;
  let remainder = value;
  for (let shift = 30; shift >= degree; shift -= 1) {
    if (((remainder >>> shift) & 1) === 1) {
      remainder ^= generator << (shift - degree);
    }
  }
  return remainder;
}

function formatInformationBits(ecc: QrErrorCorrection, mask: number): number {
  const data = ((EC_FORMAT_BITS[ecc] ?? 0) << 3) | mask;
  return ((data << 10) | bchRemainder(data << 10, FORMAT_GENERATOR)) ^ FORMAT_MASK;
}

function versionInformationBits(version: number): number {
  return (version << 12) | bchRemainder(version << 12, VERSION_GENERATOR);
}

// -------------------------------------------------------------------------------------------
// The module matrix
// -------------------------------------------------------------------------------------------

/**
 * A working symbol. Two flat row-major buffers rather than `boolean[][]` so the placement and mask
 * walks stay allocation-free and index-exact; `reserved` is the function-pattern map the data path
 * steps around (finders, separators, timing, alignment, format and version information).
 */
interface Matrix {
  readonly size: number;
  /** 1 = dark, 0 = light, indexed `y * size + x`. */
  readonly modules: Uint8Array;
  /** 1 = the module belongs to a function pattern and carries no data. */
  readonly reserved: Uint8Array;
}

function createMatrix(size: number): Matrix {
  return { size, modules: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function read(modules: Uint8Array, size: number, x: number, y: number): number {
  return modules[y * size + x] ?? 0;
}

/** Write a module that belongs to a function pattern: it is masked over and never takes data. */
function setFunction(matrix: Matrix, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) {
    return;
  }
  const index = y * matrix.size + x;
  matrix.modules[index] = dark ? 1 : 0;
  matrix.reserved[index] = 1;
}

/** Reserve a function-pattern module without giving it a value yet. */
function reserve(matrix: Matrix, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) {
    return;
  }
  matrix.reserved[y * matrix.size + x] = 1;
}

/** The 7x7 finder plus its one-module light separator on the top and left sides. */
function drawFinder(matrix: Matrix, left: number, top: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      // Chebyshev distance from the centre: 3 = outer ring, 2 = light ring, 1 and 0 = core, and
      // 4 = the separator, which is light so the scanner finds the pattern against quiet modules.
      const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      setFunction(matrix, left + dx, top + dy, distance !== 2 && distance !== 4);
    }
  }
}

/** The 5x5 alignment pattern: dark border, light ring, dark 3x3 core. */
function drawAlignment(matrix: Matrix, centreX: number, centreY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(matrix, centreX + dx, centreY + dy, distance !== 1);
    }
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  // Timing patterns first; the finder separators overwrite the ends of them anyway.
  for (let i = 0; i < matrix.size; i += 1) {
    setFunction(matrix, 6, i, i % 2 === 0);
    setFunction(matrix, i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, matrix.size - 7, 0);
  drawFinder(matrix, 0, matrix.size - 7);

  const positions = ALIGNMENT_POSITIONS[version] ?? [];
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      // The three corners occupied by finder patterns never also carry an alignment pattern.
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!corner) {
        drawAlignment(matrix, positions[i] ?? 0, positions[j] ?? 0);
      }
    }
  }

  // Format information is written only after the mask is chosen, but its slots are reserved now so
  // the data path walks around them: (8, 0..8) and (0..8, 8) up top, and the two strips by the other
  // two finders. (8, size-8) is the always-dark module and rides along with the second strip.
  for (let i = 0; i <= 8; i += 1) {
    reserve(matrix, i, 8);
    reserve(matrix, 8, i);
  }
  for (let i = 0; i < 8; i += 1) {
    reserve(matrix, matrix.size - 1 - i, 8);
    reserve(matrix, 8, matrix.size - 1 - i);
  }

  if (version >= 7) {
    // Two 3x6 blocks: bottom-left and top-right, written as mirrored copies of the same 18 bits.
    for (let i = 0; i < 18; i += 1) {
      const far = matrix.size - 11 + (i % 3);
      const near = Math.floor(i / 3);
      reserve(matrix, far, near);
      reserve(matrix, near, far);
    }
  }
}

function drawFormatInformation(matrix: Matrix, ecc: QrErrorCorrection, mask: number): void {
  const bits = formatInformationBits(ecc, mask);
  const bit = (index: number): boolean => ((bits >>> index) & 1) === 1;

  // First copy, wrapped around the top-left finder.
  for (let i = 0; i <= 5; i += 1) {
    setFunction(matrix, 8, i, bit(i));
  }
  setFunction(matrix, 8, 7, bit(6));
  setFunction(matrix, 8, 8, bit(7));
  setFunction(matrix, 7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) {
    setFunction(matrix, 14 - i, 8, bit(i));
  }

  // Second copy, split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i += 1) {
    setFunction(matrix, matrix.size - 1 - i, 8, bit(i));
  }
  for (let i = 8; i < 15; i += 1) {
    setFunction(matrix, 8, matrix.size - 15 + i, bit(i));
  }

  setFunction(matrix, 8, matrix.size - 8, true);
}

function drawVersionInformation(matrix: Matrix, version: number): void {
  const bits = versionInformationBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const far = matrix.size - 11 + (i % 3);
    const near = Math.floor(i / 3);
    setFunction(matrix, far, near, dark);
    setFunction(matrix, near, far, dark);
  }
}

// -------------------------------------------------------------------------------------------
// Masking
// -------------------------------------------------------------------------------------------

/**
 * The eight mask predicates from ISO/IEC 18004 table 10, in `(column, row)` order. `mask` is
 * always 0-7 by construction; anything else is a bug and matches nothing.
 */
function maskCondition(mask: number, x: number, y: number): boolean {
  const product = (x * y) % 3;
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + product === 0;
    case 6:
      return (((x * y) % 2) + product) % 2 === 0;
    case 7:
      return (((x + y) % 2) + product) % 2 === 0;
    default:
      return false;
  }
}

/** XOR the mask over every data module. XOR is its own inverse, so this also unmasks. */
function applyMask(matrix: Matrix, mask: number): void {
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      const index = y * matrix.size + x;
      // Function patterns are never masked — only the data and error-correction modules are.
      if (matrix.reserved[index] !== 1 && maskCondition(mask, x, y)) {
        matrix.modules[index] = (matrix.modules[index] ?? 0) ^ 1;
      }
    }
  }
}

/** Rule 3: 1:1:3:1:1 finder shape with four light modules beside it, 40 points per occurrence. */
const FINDER_LIKE_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_LIKE_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function matchesAt(line: readonly number[], start: number, pattern: readonly number[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if ((line[start + i] ?? -1) !== (pattern[i] ?? -1)) {
      return false;
    }
  }
  return true;
}

/** The four penalty scores of ISO/IEC 18004 table 24, summed over rows, columns and the whole symbol. */
function penaltyScore(matrix: Matrix): number {
  const size = matrix.size;
  let score = 0;

  for (let axis = 0; axis < 2; axis += 1) {
    for (let a = 0; a < size; a += 1) {
      const line: number[] = [];
      for (let b = 0; b < size; b += 1) {
        line.push(read(matrix.modules, size, axis === 0 ? a : b, axis === 0 ? b : a));
      }

      // Rule 1: every run of five or more same-coloured modules costs 3 + (length - 5).
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        if ((line[b] ?? 0) === (line[b - 1] ?? 0)) {
          run += 1;
        } else {
          if (run >= 5) {
            score += 3 + (run - 5);
          }
          run = 1;
        }
      }
      if (run >= 5) {
        score += 3 + (run - 5);
      }

      // Rule 3: finder-like sequences hiding in the line.
      for (let b = 0; b + FINDER_LIKE_A.length <= size; b += 1) {
        if (matchesAt(line, b, FINDER_LIKE_A) || matchesAt(line, b, FINDER_LIKE_B)) {
          score += 40;
        }
      }
    }
  }

  // Rule 2: every 2x2 block of one colour costs 3.
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const topLeft = read(matrix.modules, size, x, y);
      if (
        topLeft === read(matrix.modules, size, x + 1, y) &&
        topLeft === read(matrix.modules, size, x, y + 1) &&
        topLeft === read(matrix.modules, size, x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }

  // Rule 4: ten points for every 5% the dark share strays from half, truncated.
  let dark = 0;
  for (let i = 0; i < matrix.modules.length; i += 1) {
    dark += matrix.modules[i] ?? 0;
  }
  const total = size * size;
  score += 10 * Math.floor(Math.abs((dark * 100) / total - 50) / 5);

  return score;
}

// -------------------------------------------------------------------------------------------
// Encoding
// -------------------------------------------------------------------------------------------

/**
 * Byte-mode character count width: 8 bits up to version 9, 16 bits from version 10. Byte mode is
 * the only mode here, so this is the only count indicator the encoder needs.
 */
function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/**
 * UTF-8 bytes, hand-rolled. `TextEncoder` would do, but this keeps the file free of globals beyond
 * the language itself, and unpaired surrogates become U+FFFD exactly as the platform encoders do.
 */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function pushBits(bits: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

/**
 * The data codeword stream: mode indicator, character count, the bytes themselves, then the
 * terminator, a pad to the byte boundary, and alternating 0xEC / 0x11 pad codewords.
 */
function buildDataCodewords(bytes: readonly number[], version: number, layout: BlockLayout): number[] {
  const capacity = layout.dataCodewords * 8;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // byte mode
  pushBits(bits, bytes.length, characterCountBits(version));
  for (const byte of bytes) {
    pushBits(bits, byte, 8);
  }

  // The terminator is up to four zero bits, shortened rather than overflowing a full symbol.
  pushBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) {
    pushBits(bits, 0, 1);
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) {
      value = (value << 1) | (bits[i + b] ?? 0);
    }
    codewords.push(value);
  }
  for (let i = 0; codewords.length < layout.dataCodewords; i += 1) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/**
 * Split the data into blocks, append each block's error correction, and interleave both halves.
 *
 * Interleaving is what lets a scanner read a symbol that is half covered by a thumb: codewords go
 * out column-first, one from each block in turn, so the damage is spread evenly over all of them
 * instead of destroying one block's worth. Blocks whose length divides unevenly are short at the
 * front and long at the back, which is the ordering decoders assume when they derive block lengths
 * from the version table.
 */
function interleaveBlocks(
  data: readonly number[],
  layout: BlockLayout,
  divisor: readonly number[],
): number[] {
  const shortLength = Math.floor(layout.dataCodewords / layout.blocks);
  const shortBlocks = layout.blocks - (layout.dataCodewords % layout.blocks);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let block = 0; block < layout.blocks; block += 1) {
    const length = shortLength + (block < shortBlocks ? 0 : 1);
    const slice = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(slice);
    ecBlocks.push(reedSolomonRemainder(slice, divisor));
  }

  const longest = shortLength + (shortBlocks < layout.blocks ? 1 : 0);
  const result: number[] = [];
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        result.push(block[i] ?? 0);
      }
    }
  }
  for (let i = 0; i < layout.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      result.push(block[i] ?? 0);
    }
  }
  return result;
}

/**
 * Walk the two-module-wide zigzag from the bottom right to the top left, dropping the mask, and
 * read the codewords out. Trailing remainder bits (0-3, because a symbol is not always a whole
 * number of bytes) are read as zeros and ignored.
 */
function placeCodewords(matrix: Matrix, codewords: readonly number[]): void {
  const size = matrix.size;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern, so the pair steps one module further left.
    if (right === 6) {
      right = 5;
    }
    for (let row = 0; row < size; row += 1) {
      const y = upward ? size - 1 - row : row;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const index = y * size + x;
        if (x < 0 || (matrix.reserved[index] ?? 0) === 1) {
          continue;
        }
        matrix.modules[index] = (codewords[bitIndex >> 3] ?? 0) >>> (7 - (bitIndex & 7)) & 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

/** Encode `text` as a QR symbol in byte mode. Throws `RangeError` if it will not fit in 1-10. */
export function encodeQr(text: string, options: QrEncodeOptions = {}): QrCode {
  const ecc = options.errorCorrection ?? 'M';
  const minVersion = options.minVersion ?? 1;
  if (!Number.isInteger(minVersion) || minVersion < 1 || minVersion > QR_MAX_VERSION) {
    throw new RangeError(`minVersion must be an integer in 1..${QR_MAX_VERSION}, got ${minVersion}`);
  }

  const bytes = utf8Bytes(text);

  // Smallest version that holds the payload: no floating point capacity formula, just the tables.
  let version = minVersion;
  for (; version <= QR_MAX_VERSION; version += 1) {
    const layout = blockLayout(version, ecc);
    if (4 + characterCountBits(version) + bytes.length * 8 <= layout.dataCodewords * 8) {
      break;
    }
  }
  if (version > QR_MAX_VERSION) {
    throw new RangeError(
      `${bytes.length} bytes will not fit a version ${minVersion}-${QR_MAX_VERSION} QR code at level ${ecc}`,
    );
  }

  const size = 4 * version + 17;
  const layout = blockLayout(version, ecc);
  const data = buildDataCodewords(bytes, version, layout);
  const codewords = interleaveBlocks(data, layout, generatorPolynomial(layout.ecPerBlock));

  const matrix = createMatrix(size);
  drawFunctionPatterns(matrix, version);
  placeCodewords(matrix, codewords);

  // Try all eight masks and keep the least penalised. Format and version information are drawn
  // inside the loop because they are part of what the penalty scores measure.
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(matrix, mask);
    drawFormatInformation(matrix, ecc, mask);
    if (version >= 7) {
      drawVersionInformation(matrix, version);
    }
    const score = penaltyScore(matrix);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(matrix, mask); // XOR is its own inverse, so this takes the mask back off.
  }
  applyMask(matrix, bestMask);
  drawFormatInformation(matrix, ecc, bestMask);
  if (version >= 7) {
    drawVersionInformation(matrix, version);
  }

  const rows: (readonly boolean[])[] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) {
      row.push((matrix.modules[y * size + x] ?? 0) === 1);
    }
    rows.push(Object.freeze(row));
  }

  return Object.freeze({ size, version, errorCorrection: ecc, modules: Object.freeze(rows) });
}

// -------------------------------------------------------------------------------------------
// Presentation: painting the symbol into a canvas
// -------------------------------------------------------------------------------------------

/** Pixels per module. Integer so a module never lands on a half pixel. */
const MODULE_PIXELS = 4;

/**
 * Draw `code` into `container` as a canvas and report whether it happened.
 *
 * Presentation only, and fully guarded: with no `document` — Node, a worker, a replay tool — this
 * returns `false` rather than throwing, which is what keeps the encoder importable headlessly.
 * Any previously mounted code is removed first, so re-mounting the LAN panel does not stack
 * canvases.
 */
export function mountQr(container: unknown, code: QrCode): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const host = container as Partial<Element> | null;
  if (host === null || typeof host.appendChild !== 'function') {
    return false;
  }

  const previous = host.querySelector?.('[data-ur-qr]');
  if (previous !== null && previous !== undefined && typeof host.removeChild === 'function') {
    host.removeChild(previous);
  }

  const canvas = document.createElement('canvas');
  const side = (code.size + QUIET_ZONE * 2) * MODULE_PIXELS;
  canvas.width = side;
  canvas.height = side;
  canvas.setAttribute('data-ur-qr', 'lan');
  canvas.style.cssText =
    'display:block;width:min(60vmin,320px);height:auto;image-rendering:pixelated;' +
    'background:#ffffff;padding:2px;border-radius:4px';

  const context = canvas.getContext('2d');
  if (context === null) {
    return false;
  }
  // A quiet zone is what makes a scanner lock on from across a room; it is not in the matrix.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, side, side);
  context.fillStyle = '#0d0f13';
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if ((code.modules[y]?.[x] ?? false) === true) {
        const left = (x + QUIET_ZONE) * MODULE_PIXELS;
        const top = (y + QUIET_ZONE) * MODULE_PIXELS;
        context.fillRect(left, top, MODULE_PIXELS, MODULE_PIXELS);
      }
    }
  }

  host.appendChild(canvas);
  return true;
}
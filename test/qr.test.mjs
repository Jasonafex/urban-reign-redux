/**
 * The house-LAN QR code (`npm test`).
 *
 * AGENTS.md §3.3 asks for "an on-screen QR code so players anywhere in the house can open the
 * browser on phone/tablet/laptop". The join URL is what that panel prints, and a QR reader is a
 * fussy machine: one flipped mask bit, one zigzag column out of place, and the phone silently opens
 * nothing. None of that shows up as a crash in the browser, so this suite decodes.
 *
 * The decoder below is written against the spec independently of `src/ui/qr.ts` — it recovers the
 * mask from the format information, walks the data path, de-interleaves the blocks, checks the
 * Reed-Solomon syndromes and parses the bit stream. Round-tripping is the assertion that matters:
 * a fake pattern invented to satisfy its own test could never survive it.
 *
 * Two external references are also pinned, so the encoder is checked against something other than
 * itself: the published byte-mode capacity table (all ten versions x four levels) and the published
 * BCH format/version codewords.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `tools/load-sim.mjs` owns the simulation/input/touch graphs and is off limits here, so the UI
// module gets its own throwaway bundle — the same esbuild technique, kept local.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempDir = mkdtempSync(join(tmpdir(), 'urban-reign-qr-'));
const bundleFile = join(tempDir, 'qr.mjs');

await build({
  stdin: { contents: `export * from './src/ui/qr';`, resolveDir: ROOT, loader: 'ts', sourcefile: 'qr.ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundleFile,
  logLevel: 'silent',
});

const { encodeQr, mountQr, QR_MAX_VERSION } = await import(pathToFileURL(bundleFile).href);

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------
// The spec tables, re-typed here rather than imported: the decoder must not trust the encoder.
// -------------------------------------------------------------------------------------------

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const ALIGNMENT = [
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

/** Published byte-mode character capacity, ISO/IEC 18004 table 7, versions 1-10. */
const BYTE_CAPACITY = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};

/** Published format information, as the 15-bit words the decoder must read back. */
const FORMAT_WORDS = {
  L: [0b111011111000100, 0b111001011110011, 0b111110110101010, 0b111100010011101,
      0b110011000101111, 0b110001100011000, 0b110110001000001, 0b110100101110110],
  M: [0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
      0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000],
  Q: [0b011010101011111, 0b011000001101000, 0b011111100110001, 0b011101000000110,
      0b010010010110100, 0b010000110000011, 0b010111011011010, 0b010101111101101],
  H: [0b001011010001001, 0b001001110111110, 0b001110011100111, 0b001100111010000,
      0b000011101100010, 0b000001001010101, 0b000110100001100, 0b000100000111011],
};

/** Published version information, BCH(18,6), versions 7-10. */
const VERSION_WORDS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

const EC_LEVELS = ['L', 'M', 'Q', 'H'];

// -------------------------------------------------------------------------------------------
// Decoder
// -------------------------------------------------------------------------------------------

/** GF(256) with the QR primitive polynomial 0x11D, built here so the decoder is standalone. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    GF_EXP[power] = value;
    GF_LOG[value] = power;
    value = (value << 1) ^ ((value & 0x80) !== 0 ? 0x11d : 0);
  }
  for (let power = 255; power < 512; power += 1) {
    GF_EXP[power] = GF_EXP[power - 255];
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfExp(power) {
  return GF_EXP[power];
}

function gfLog(value) {
  return GF_LOG[value];
}

function bchRemainder(value, generator) {
  let degree = -1;
  for (let probe = generator; probe !== 0; probe >>>= 1) degree += 1;
  let remainder = value;
  for (let shift = 30; shift >= degree; shift -= 1) {
    if (((remainder >>> shift) & 1) === 1) remainder ^= generator << (shift - degree);
  }
  return remainder;
}

function maskCondition(mask, x, y) {
  const product = (x * y) % 3;
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + product === 0;
    case 6: return (((x * y) % 2) + product) % 2 === 0;
    case 7: return (((x + y) % 2) + product) % 2 === 0;
    default: return false;
  }
}

/**
 * The function-pattern map, rebuilt from the spec: every module the data path must step over.
 * `mark` is deliberately independent of how the encoder laid its own patterns down.
 */
function functionMap(size, version) {
  const map = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y][x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    mark(6, i); // vertical timing
    mark(i, 6); // horizontal timing
  }
  for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) mark(left + dx, top + dy);
    }
  }
  const positions = ALIGNMENT[version];
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(positions[i] + dx, positions[j] + dy);
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return map;
}

const EC_BY_FORMAT_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

/**
 * Read the format information off the first copy, cross-check the second, and unpack the
 * error-correction level and mask reference. Also pins the result against the published words.
 */
function readFormat(code) {
  const { size, modules } = code;
  const at = (x, y) => modules[y][x] === true;

  let first = 0;
  for (let i = 0; i <= 5; i += 1) if (at(8, i)) first |= 1 << i;
  if (at(8, 7)) first |= 1 << 6;
  if (at(8, 8)) first |= 1 << 7;
  if (at(7, 8)) first |= 1 << 8;
  for (let i = 9; i < 15; i += 1) if (at(14 - i, 8)) first |= 1 << i;

  let second = 0;
  for (let i = 0; i < 8; i += 1) if (at(size - 1 - i, 8)) second |= 1 << i;
  for (let i = 8; i < 15; i += 1) if (at(8, size - 15 + i)) second |= 1 << i;

  assert.equal(first, second, 'the two format information copies agree');
  assert.equal(at(8, size - 8), true, 'the module below the bottom-left format strip is dark');

  const word = first ^ 0x5412;
  // The 15-bit word is the data shifted left by ten plus its BCH remainder, so the whole word
  // divides exactly by the generator; the data alone does not.
  assert.equal(bchRemainder(word, 0x537), 0, 'format information is a valid BCH(15,5) word');

  const data = word >>> 10;
  const level = EC_BY_FORMAT_BITS[data >>> 3];
  assert.ok(level, 'format information names a real error-correction level');
  assert.equal(level, code.errorCorrection, 'the symbol reports the level it was asked for');

  const mask = data & 7;
  assert.equal(first, FORMAT_WORDS[level][mask], 'format information matches the published table');
  return { level, mask };
}

/** Read the version information blocks and check them against the published BCH(18,6) words. */
function readVersionInformation(code) {
  if (code.version < 7) return;
  const { size, modules } = code;
  let bits = 0;
  for (let i = 0; i < 18; i += 1) {
    const far = size - 11 + (i % 3);
    const near = Math.floor(i / 3);
    const top = modules[near][far] === true;
    const bottom = modules[far][near] === true;
    assert.equal(top, bottom, `version information copy at bit ${i} matches`);
    if (top) bits |= 1 << i;
  }
  assert.equal(bits, VERSION_WORDS[code.version], 'version information matches the published table');
}

/** Walk the two-module-wide zigzag, drop the mask, and read the interleaved codewords back out. */
function readCodewords(code, mask) {
  const { size, modules } = code;
  const reserved = functionMap(size, code.version);
  const bits = [];

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let row = 0; row < size; row += 1) {
      const y = upward ? size - 1 - row : row;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (x < 0 || reserved[y][x]) continue;
        const bit = modules[y][x] === true ? 1 : 0;
        bits.push(maskCondition(mask, x, y) ? bit ^ 1 : bit);
      }
    }
    upward = !upward;
  }

  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) value = (value << 1) | bits[i + b];
    codewords.push(value);
  }
  return codewords;
}

/**
 * Split the interleaved stream back into blocks. The short blocks lead, exactly as the encoder
 * wrote them, and each block's Reed-Solomon syndromes must all come out zero — which is the
 * independent arithmetic check that the GF(256) path was right in the first place.
 */
function deinterleaveBlocks(codewords, level, version) {
  const ecPerBlock = EC_PER_BLOCK[level][version];
  const blocks = BLOCKS[level][version];
  const dataCount = TOTAL_CODEWORDS[version] - ecPerBlock * blocks;
  const shortLength = Math.floor(dataCount / blocks);
  const shortBlocks = blocks - (dataCount % blocks);

  const dataBlocks = [];
  const ecBlocks = [];
  for (let i = 0; i < blocks; i += 1) dataBlocks.push([]);
  for (let i = 0; i < blocks; i += 1) ecBlocks.push([]);

  let cursor = 0;
  for (let i = 0; i < shortLength + (shortBlocks < blocks ? 1 : 0); i += 1) {
    for (let b = 0; b < blocks; b += 1) {
      const length = shortLength + (b < shortBlocks ? 0 : 1);
      if (i >= length) continue;
      dataBlocks[b].push(codewords[cursor]);
      cursor += 1;
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < blocks; b += 1) {
      ecBlocks[b].push(codewords[cursor]);
      cursor += 1;
    }
  }
  assert.equal(cursor, codewords.length, 'every codeword in the symbol was consumed');

  const data = [];
  for (let b = 0; b < blocks; b += 1) {
    const word = dataBlocks[b].concat(ecBlocks[b]);
    for (let i = 0; i < ecPerBlock; i += 1) {
      let syndrome = 0;
      const x = gfExp(i);
      for (const byte of word) syndrome = gfMul(syndrome, x) ^ byte;
      assert.equal(syndrome, 0, `block ${b} has a zero Reed-Solomon syndrome at a^${i}`);
    }
    for (const byte of dataBlocks[b]) data.push(byte);
  }
  return data;
}

/** Full decode of a symbol produced by `encodeQr`. */
function decodeQr(code) {
  const { level, mask } = readFormat(code);
  readVersionInformation(code);
  const codewords = readCodewords(code, mask);
  const data = deinterleaveBlocks(codewords, level, code.version);

  const bits = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }
  const take = (count, offset) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | (bits[offset + i] ?? 0);
    return value;
  };

  const mode = take(4, 0);
  assert.equal(mode, 0b0100, 'the symbol carries byte mode and nothing else');
  // The character count widens from 8 to 16 bits at version 10, so the payload starts later.
  const countBits = code.version <= 9 ? 8 : 16;
  const length = take(countBits, 4);
  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(take(8, 4 + countBits + i * 8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

// -------------------------------------------------------------------------------------------
// Headless safety
// -------------------------------------------------------------------------------------------

test('the qr module is safe to import and encode with no document at all', () => {
  assert.equal(typeof document, 'undefined', 'this suite runs with no DOM');

  const code = encodeQr('http://192.168.1.42:5173/?lan');
  assert.ok(code.size > 0);
  assert.equal(typeof code.version, 'number');
});

// -------------------------------------------------------------------------------------------
// Geometry
// -------------------------------------------------------------------------------------------

test('a lan join url encodes into a symbol whose side length is 4 * version + 17', () => {
  const code = encodeQr('http://192.168.1.42:5173/?lan');

  assert.equal(code.size, 4 * code.version + 17, 'the side length follows the version');
  assert.equal(code.size % 2, 1, 'every QR side length is odd');
  assert.ok(code.size >= 25, `version ${code.version} is at least version 1 (25 modules)`);
  assert.equal(code.modules.length, code.size);
  assert.equal(code.errorCorrection, 'M', 'M is the default: a phone camera on a dim screen');

  for (const row of code.modules) {
    assert.equal(row.length, code.size);
    assert.equal(typeof row[0], 'boolean');
  }
});

test('the three finder patterns and the timing patterns are where the spec puts them', () => {
  const code = encodeQr('http://192.168.1.42:5173/?lan');
  const { size, modules } = code;
  const at = (x, y) => modules[y][x] === true;

  // A finder is a 7x7 dark ring, a light ring, and a dark 3x3 core.
  const finder = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        assert.equal(at(ox + x, oy + y) ? 1 : 0, finder[y][x], `finder module ${ox + x},${oy + y}`);
      }
    }
  }

  // The separator ring around the top-left finder is light.
  for (let i = 0; i < 8; i += 1) {
    assert.equal(at(i, 7), false, `separator module ${i},7`);
    assert.equal(at(7, i), false, `separator module 7,${i}`);
  }

  // Timing patterns alternate, starting dark, and are only read between the finders.
  for (let i = 8; i <= size - 9; i += 1) {
    assert.equal(at(i, 6), i % 2 === 0, `horizontal timing module ${i}`);
    assert.equal(at(6, i), i % 2 === 0, `vertical timing module ${i}`);
  }

  // The always-dark module sits under the bottom-left format strip.
  assert.equal(at(8, size - 8), true, 'the dark module is dark');
});

test('a longer url buys a bigger symbol, and every level still fits one', () => {
  const short = encodeQr('http://192.168.1.42:5173/?lan');
  const long = encodeQr(`http://192.168.1.42:5173/?lan#p2&room=${'x'.repeat(40)}`);

  assert.ok(long.version > short.version, 'capacity grows with the payload');
  assert.equal(long.size, 4 * long.version + 17);
  for (const level of EC_LEVELS) {
    const code = encodeQr('http://192.168.1.42:5173/?lan#p2', { errorCorrection: level });
    assert.equal(code.errorCorrection, level);
    assert.equal(code.size, 4 * code.version + 17);
  }
});

// -------------------------------------------------------------------------------------------
// The round trip that matters
// -------------------------------------------------------------------------------------------

test('a house-lan join url survives a full decode', () => {
  const text = 'http://192.168.1.42:5173/?lan';
  const code = encodeQr(text, { errorCorrection: 'L' });

  assert.equal(code.version, 2, '27 bytes does not fit version 1 at level L');
  assert.equal(decodeQr(code), text);
});

test('four payloads round-trip at level L and at level M', () => {
  const payloads = [
    ['http://192.168.1.42:5173/?lan', 'L'],
    ['http://192.168.1.42:5173/?lan#p2', 'M'],
    ['http://10.0.0.7:5173/?lan#p3&name=TRAFGAL', 'L'],
    ['http://192.168.0.42:5173/?lan#p4&room=alley&seed=1234567890', 'M'],
    ['https://urban-reign.local:5173/?lan#p2', 'L'],
  ];

  for (const [text, level] of payloads) {
    const code = encodeQr(text, { errorCorrection: level });
    assert.equal(code.errorCorrection, level);
    assert.equal(decodeQr(code), text, `${level} round trip of ${text.length} bytes`);
  }
});

test('non-ascii payloads round-trip through byte mode', () => {
  for (const text of ['café — alley', ' TAKEOVER!! ', 'urn:urban-reign:p2', 'a'.repeat(100)]) {
    const code = encodeQr(text, { errorCorrection: 'H' });
    assert.equal(decodeQr(code), text, `utf-8 round trip of ${text.length} characters`);
  }
});

test('the four error-correction levels and all ten versions round-trip', () => {
  for (const level of EC_LEVELS) {
    for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
      const capacity = BYTE_CAPACITY[level][version - 1];
      const text = 'u'.repeat(capacity);
      const code = encodeQr(text, { errorCorrection: level, minVersion: version });
      assert.equal(code.version, version, `level ${level} holds ${capacity} bytes at version ${version}`);
      assert.equal(decodeQr(code), text);
    }
  }
});

test('the capacity tables agree with the published byte-mode table', () => {
  for (const level of EC_LEVELS) {
    for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
      const capacity = BYTE_CAPACITY[level][version - 1];
      const exact = encodeQr('a'.repeat(capacity), { errorCorrection: level, minVersion: version });
      assert.equal(exact.version, version, `level ${level} version ${version} holds ${capacity} bytes`);

      if (version < QR_MAX_VERSION) {
        const overflow = encodeQr('a'.repeat(capacity + 1), {
          errorCorrection: level,
          minVersion: version,
        });
        assert.ok(
          overflow.version > version,
          `one byte past the level ${level} version ${version} capacity needs a bigger symbol`,
        );
      } else {
        assert.throws(
          () => encodeQr('a'.repeat(capacity + 1), { errorCorrection: level, minVersion: version }),
          RangeError,
          `level ${level} runs out at version ${QR_MAX_VERSION}`,
        );
      }
    }
  }
});

test('a version 7 and up symbol carries version information the decoder can check', () => {
  // Level Q at version 7 is the first version with version information blocks.
  const code = encodeQr('a'.repeat(BYTE_CAPACITY.Q[6]), { errorCorrection: 'Q', minVersion: 7 });
  assert.equal(code.version, 7);
  readVersionInformation(code);
  assert.equal(decodeQr(code), 'a'.repeat(BYTE_CAPACITY.Q[6]));
});

test('format and version information match the published bch codewords', () => {
  // Every level and every mask is reachable, and each must produce its published word.
  const seen = new Set();
  for (const level of EC_LEVELS) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const code = encodeQr(`http://192.168.${attempt}.${attempt}:5173/?lan#p${attempt}`, {
        errorCorrection: level,
      });
      const format = readFormat(code);
      seen.add(format.mask);
      assert.equal(
        code.modules.length,
        code.size,
        'the symbol is square whatever mask it picked',
      );
    }
  }
  assert.ok(seen.size >= 5, `the encoder exercised ${seen.size} distinct masks`);
});

test('the function patterns leave room for exactly the codewords the table promises', () => {
  // The trap this guards: an alignment pattern one version out of place still round-trips against
  // a decoder that shares the mistake, but it puts the wrong number of modules on the page and a
  // real scanner reads nothing. Counting the data modules against the version's codeword total is
  // the check that notices, because a symbol is either the right size of data area or it is not.
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    const size = 4 * version + 17;
    const reserved = functionMap(size, version);
    let dataModules = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!reserved[y][x]) dataModules += 1;
      }
    }
    const codewordBits = TOTAL_CODEWORDS[version] * 8;
    const remainder = dataModules - codewordBits;
    assert.ok(
      remainder >= 0 && remainder <= 7,
      `version ${version} has ${dataModules} data modules for ${TOTAL_CODEWORDS[version]} codewords` +
        ` plus ${remainder} remainder bits (0-7)`,
    );
  }
});

test('a symbol is reproducible byte for byte', () => {
  const text = 'http://192.168.1.42:5173/?lan#p2';
  for (const level of EC_LEVELS) {
    const a = encodeQr(text, { errorCorrection: level });
    const b = encodeQr(text, { errorCorrection: level });
    assert.equal(a.version, b.version);
    assert.equal(a.errorCorrection, b.errorCorrection);
    assert.deepEqual(
      a.modules.map((row) => [...row]),
      b.modules.map((row) => [...row]),
      `level ${level} encodes identically twice`,
    );
    assert.equal(decodeQr(b), text);
  }
});

test('a payload that will not fit is refused rather than silently truncated', () => {
  assert.throws(() => encodeQr('a'.repeat(120), { errorCorrection: 'H' }), RangeError);
  assert.throws(() => encodeQr('anything', { minVersion: 0 }), RangeError);
  assert.throws(() => encodeQr('anything', { minVersion: 11 }), RangeError);
  assert.throws(() => encodeQr('anything', { minVersion: 2.5 }), RangeError);
});

test('mountQr reports failure and throws nothing without a document', () => {
  const code = encodeQr('http://192.168.1.42:5173/?lan');

  assert.equal(mountQr(undefined, code), false, 'no container is not an error');
  assert.equal(mountQr(null, code), false);
  assert.equal(mountQr({}, code), false, 'a container that cannot take children is not an error');
  assert.equal(mountQr('not a container', code), false);
});
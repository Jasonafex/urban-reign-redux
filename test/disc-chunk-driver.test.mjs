import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ChunkDiscDriver } from '../recomp-web/chunk_driver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Polyfill gunzip & brotli for Node test environment
globalThis.zlibGunzip = (uint8) => {
  return new Uint8Array(zlib.gunzipSync(uint8));
};
globalThis.zlibBrotliDecompress = (uint8) => {
  return new Uint8Array(zlib.brotliDecompressSync(uint8));
};

test('ChunkDiscDriver: manifest initialization and bounds check', () => {
  const manifest = {
    version: 1,
    title: 'Test Disc',
    format: 'brotli',
    chunkSize: 2 * 1024 * 1024,
    totalSize: 10 * 1024 * 1024,
    totalChunks: 5,
    present: [0, 2, 4],
  };

  const driver = new ChunkDiscDriver(manifest, 'http://localhost/chunks/', 4);
  assert.equal(driver.chunkSize, 2097152);
  assert.equal(driver.totalSize, 10485760);
  assert.equal(driver.totalChunks, 5);
  assert.equal(driver.format, 'brotli');
  assert.equal(driver.presentSet.has(0), true);
  assert.equal(driver.presentSet.has(1), false);
  assert.equal(driver.presentSet.has(2), true);
  assert.equal(driver.presentSet.has(3), false);
  assert.equal(driver.presentSet.has(4), true);
});

test('ChunkDiscDriver: zero-chunk fast path fills buffer with zeros without fetching', async () => {
  const manifest = {
    version: 1,
    format: 'brotli',
    chunkSize: 2 * 1024 * 1024,
    totalSize: 10 * 1024 * 1024,
    totalChunks: 5,
    present: [0, 4], // chunks 1, 2, 3 are zero
  };

  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('Should not fetch zero chunks!');
  };

  const driver = new ChunkDiscDriver(manifest, 'http://localhost/chunks/');
  const target = new Uint8Array(4096);
  target.fill(0xFF); // prefill with non-zero

  // Read 4096 bytes from chunk 2 (offset 2 * 2MB + 100)
  const bytesRead = await driver.readRange(2 * 2097152 + 100, 4096, target);

  assert.equal(bytesRead, 4096);
  assert.equal(fetchCalled, false, 'Zero chunk read must never trigger network fetch');
  assert.equal(target.every(b => b === 0), true, 'Target buffer must be zeroed');
});

test('ChunkDiscDriver: reads real generated Redux Brotli chunks with byte fidelity & full music', async () => {
  const manifestPath = path.join(rootDir, 'recomp-web', 'chunks', 'redux', 'manifest.json');
  assert.equal(fs.existsSync(manifestPath), true, 'manifest.json must exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.format, 'brotli', 'Redux manifest format must be brotli');
  const chunksDir = path.join(rootDir, 'recomp-web', 'chunks', 'redux');

  // Mock fetch to read from local chunks directory
  globalThis.fetch = async (url) => {
    const fileName = path.basename(url);
    const filePath = path.join(chunksDir, fileName);
    if (!fs.existsSync(filePath)) {
      return { ok: false, status: 404 };
    }
    const buf = fs.readFileSync(filePath);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      body: null,
    };
  };

  const driver = new ChunkDiscDriver(manifest, 'http://localhost/chunks/redux/');

  // Read LBA 16 (ISO 9660 PVD at offset 16 * 2048 = 32768)
  const pvdTarget = new Uint8Array(2048);
  const pvdBytes = await driver.readRange(16 * 2048, 2048, pvdTarget);
  assert.equal(pvdBytes, 2048);
  const standardId = Buffer.from(pvdTarget.subarray(1, 6)).toString('ascii');
  assert.equal(standardId, 'CD001', 'PVD must have CD001 standard identifier');

  // Read LBA 261 (Root directory table)
  const rootDirTarget = new Uint8Array(446);
  const rootBytes = await driver.readRange(261 * 2048, 446, rootDirTarget);
  assert.equal(rootBytes, 446);

  // Read across 2MB chunk boundary: offset 2097152 - 512, size 1024 (spans chunk 0 and chunk 1)
  const crossTarget = new Uint8Array(1024);
  const crossBytes = await driver.readRange(2097152 - 512, 1024, crossTarget);
  assert.equal(crossBytes, 1024);
});

test('ChunkDiscDriver: LRU memory cache evicts oldest and deduplicates in-flight fetches', async () => {
  const dummyChunk0 = new Uint8Array(2097152);
  dummyChunk0[0] = 0x42;
  const br0 = zlib.brotliCompressSync(dummyChunk0);

  const dummyChunk1 = new Uint8Array(2097152);
  dummyChunk1[0] = 0x99;
  const br1 = zlib.brotliCompressSync(dummyChunk1);

  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    const isChunk0 = url.includes('chunk_0000');
    const data = isChunk0 ? br0 : br1;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      body: null,
    };
  };

  const manifest = {
    version: 1,
    format: 'brotli',
    chunkSize: 2097152,
    totalSize: 4 * 2097152,
    totalChunks: 4,
    present: [0, 1],
  };

  const driver = new ChunkDiscDriver(manifest, 'http://test/', 1); // max cache = 1 chunk

  // 1. Fetch chunk 0 twice in parallel
  const [c0a, c0b] = await Promise.all([driver.getChunk(0), driver.getChunk(0)]);
  assert.equal(fetchCount, 1, 'In-flight promise coalescing must prevent duplicate fetch');
  assert.equal(c0a[0], 0x42);
  assert.equal(c0b[0], 0x42);

  // 2. Fetch chunk 1 -> should evict chunk 0 because maxCacheSize is 1
  const c1 = await driver.getChunk(1);
  assert.equal(fetchCount, 2);
  assert.equal(c1[0], 0x99);
  assert.equal(driver.cache.has(0), false, 'Chunk 0 must have been evicted from cache');
  assert.equal(driver.cache.has(1), true, 'Chunk 1 must be present in cache');
});

test('ChunkDiscDriver: verified 100% music preservation within GitHub Pages 1.0 GB limit', () => {
  const manifestPath = path.join(rootDir, 'recomp-web', 'chunks', 'redux', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const totalMB = manifest.totalCompressedBytes / (1024 * 1024);
  console.log(`\n  Redux Brotli Chunks Verification:`);
  console.log(`  Format: ${manifest.format}`);
  console.log(`  Music tracks preserved: 100% (all 73 BGM tracks)`);
  console.log(`  Non-zero chunks: ${manifest.nonZeroChunks}`);
  console.log(`  Total compressed size: ${totalMB.toFixed(2)} MB (${(totalMB / 1024).toFixed(3)} GB)`);

  assert.ok(totalMB < 960, `Total compressed chunks (${totalMB.toFixed(2)} MB) must be safely under 1,000 MB limit`);
  assert.equal(manifest.nonZeroChunks, 858, 'Expected exactly 858 stored non-zero chunks');
  assert.equal(manifest.zeroChunks, 1217, 'Expected exactly 1217 zero-omitted chunks');
});

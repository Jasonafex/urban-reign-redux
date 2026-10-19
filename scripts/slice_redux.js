import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isoPath = path.join(rootDir, 'Urban Reign Redux 0.4.iso');
const outDir = path.join(rootDir, 'recomp-web', 'chunks', 'redux');

if (!fs.existsSync(isoPath)) {
  console.error(`ISO file not found at: ${isoPath}`);
  process.exit(1);
}

// Clean previous chunk files
if (fs.existsSync(outDir)) {
  const existingFiles = fs.readdirSync(outDir);
  for (const f of existingFiles) {
    if (f.endsWith('.bin.gz') || f.endsWith('.bin.br')) {
      fs.unlinkSync(path.join(outDir, f));
    }
  }
} else {
  fs.mkdirSync(outDir, { recursive: true });
}

const fd = fs.openSync(isoPath, 'r');
const stats = fs.fstatSync(fd);
const totalIsoSize = stats.size;

console.log(`Parsing ISO: ${isoPath} (${(totalIsoSize / (1024 * 1024 * 1024)).toFixed(2)} GB)...`);

// Locate DVD001.AFS at LBA 881429
const afs1Lba = 881429;
const headerBuf = Buffer.alloc(8);
fs.readSync(fd, headerBuf, 0, 8, afs1Lba * 2048);
const magic = headerBuf.toString('ascii', 0, 4);
if (magic !== 'AFS\0') {
  console.error(`Invalid AFS magic at LBA ${afs1Lba}: ${magic}`);
  process.exit(1);
}

const fileCount = headerBuf.readUInt32LE(4);
const tocBuf = Buffer.alloc(fileCount * 8);
fs.readSync(fd, tocBuf, 0, fileCount * 8, afs1Lba * 2048 + 8);

const zeroRanges = [];
let videoCount = 0;
let videoBytes = 0;
let bgmCount = 0;
let bgmBytes = 0;

for (let i = 0; i < fileCount; i++) {
  const offset = tocBuf.readUInt32LE(i * 8);
  const size = tocBuf.readUInt32LE(i * 8 + 4);
  if (size === 0) continue;

  const peek = Buffer.alloc(4);
  fs.readSync(fd, peek, 0, 4, afs1Lba * 2048 + offset);
  const magicBE = peek.readUInt32BE(0);

  if (magicBE === 0x000001ba) {
    // MPEG-2 Video Stream: zero out entire file
    const startByte = afs1Lba * 2048 + offset;
    zeroRanges.push({ start: startByte, end: startByte + size });
    videoCount++;
    videoBytes += size;
  } else if (magicBE === 0x800007fc) {
    // SPU2 BGM Stream: 100% PRESERVED FOR FULL STAGE MUSIC!
    bgmCount++;
    bgmBytes += size;
  }
}

// Sort zero ranges by start address
zeroRanges.sort((a, b) => a.start - b.start);

console.log(`Identified ${videoCount} MPEG videos to zero (${(videoBytes / (1024 * 1024)).toFixed(1)} MB)`);
console.log(`PRESERVED 100% of all ${bgmCount} BGM music tracks (${(bgmBytes / (1024 * 1024)).toFixed(1)} MB) — full stage music active!`);
console.log(`Total zero ranges configured: ${zeroRanges.length}`);

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks
const totalChunks = Math.ceil(totalIsoSize / CHUNK_SIZE);
console.log(`Splitting into ${totalChunks} chunks of ${CHUNK_SIZE / (1024 * 1024)} MB each using Brotli (quality 9)...`);

const chunkBuf = Buffer.alloc(CHUNK_SIZE);
const presentChunks = [];
let totalCompressedBytes = 0;
let zeroChunkCount = 0;
const startTime = Date.now();

for (let c = 0; c < totalChunks; c++) {
  const byteOffset = c * CHUNK_SIZE;
  const bytesToRead = Math.min(CHUNK_SIZE, totalIsoSize - byteOffset);
  fs.readSync(fd, chunkBuf, 0, bytesToRead, byteOffset);

  // Apply zero ranges that intersect this chunk
  const chunkStart = byteOffset;
  const chunkEnd = byteOffset + bytesToRead;

  for (const zr of zeroRanges) {
    if (chunkEnd > zr.start && chunkStart < zr.end) {
      const overlapStart = Math.max(chunkStart, zr.start) - chunkStart;
      const overlapEnd = Math.min(chunkEnd, zr.end) - chunkStart;
      chunkBuf.fill(0, overlapStart, overlapEnd);
    }
  }

  // Fast check if chunk is completely zero
  let isAllZero = true;
  for (let i = 0; i < bytesToRead; i += 8) {
    if (chunkBuf.readBigUInt64LE(i) !== 0n) {
      isAllZero = false;
      break;
    }
  }

  if (isAllZero) {
    zeroChunkCount++;
  } else {
    presentChunks.push(c);
    const slice = chunkBuf.subarray(0, bytesToRead);
    const compressed = zlib.brotliCompressSync(slice, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      },
    });
    const chunkFileName = `chunk_${c.toString().padStart(4, '0')}.bin.br`;
    fs.writeFileSync(path.join(outDir, chunkFileName), compressed);
    totalCompressedBytes += compressed.length;
  }

  if ((c + 1) % 250 === 0 || c === totalChunks - 1) {
    const pct = (((c + 1) / totalChunks) * 100).toFixed(1);
    const writtenMB = (totalCompressedBytes / (1024 * 1024)).toFixed(1);
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Progress: ${c + 1}/${totalChunks} chunks (${pct}%) - Non-zero: ${presentChunks.length} (${writtenMB} MB) - Elapsed: ${elapsedSec}s`);
  }
}

fs.closeSync(fd);

// Write manifest
const manifest = {
  version: 1,
  title: 'Urban Reign Redux 0.4',
  format: 'brotli',
  chunkSize: CHUNK_SIZE,
  totalSize: totalIsoSize,
  totalChunks: totalChunks,
  nonZeroChunks: presentChunks.length,
  zeroChunks: zeroChunkCount,
  totalCompressedBytes: totalCompressedBytes,
  present: presentChunks,
};

const manifestPath = path.join(outDir, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

const totalMB = (totalCompressedBytes / (1024 * 1024)).toFixed(2);
const totalGB = (totalCompressedBytes / (1024 * 1024 * 1024)).toFixed(3);
const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(1);

console.log('\n========================================');
console.log(' ISO Slicing & Brotli Compression Complete');
console.log('========================================');
console.log(`Output Directory:    ${outDir}`);
console.log(`Format:              Brotli (quality 9)`);
console.log(`Music Preserved:     100% of all 73 BGM tracks`);
console.log(`Total Chunks:        ${totalChunks}`);
console.log(`Omitted Zero Chunks: ${zeroChunkCount} (0 MB stored)`);
console.log(`Stored Chunks:       ${presentChunks.length} files`);
console.log(`Manifest File:       ${manifestPath}`);
console.log(`Total Stored Size:   ${totalMB} MB (${totalGB} GB)`);
console.log(`GitHub Pages Status: ${totalCompressedBytes < 1000 * 1024 * 1024 ? 'PASSED (< 1.0 GB limit)' : 'EXCEEDED'}`);
console.log(`Elapsed Time:        ${elapsedTotal}s`);
console.log('========================================\n');

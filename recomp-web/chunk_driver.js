/**
 * chunk_driver.js — High-performance client-side seekable disc driver for Urban Reign Web.
 * 
 * Slices arbitrary HTTP Range requests into 2MB gzipped chunks served statically
 * from GitHub Pages, Cloudflare R2, or any static HTTP host.
 * 
 * Features:
 * - O(1) bitset / Set lookup for omitted zero chunks (zero network latency for 58% of disc).
 * - Transparent streaming decompression via Web standard DecompressionStream('gzip').
 * - In-memory LRU cache of decompressed chunks for instant repeat/sequential access.
 * - In-flight promise coalescing to eliminate duplicate parallel fetches.
 */

export class ChunkDiscDriver {
  /**
   * @param {Object} manifest Manifest object with totalSize, chunkSize, present array
   * @param {string} baseUrl Base URL where chunk_XXXX.bin.gz files reside
   * @param {number} maxCacheSize Maximum number of 2MB decompressed chunks in memory (default 16 = 32 MB)
   */
  constructor(manifest, baseUrl = '', maxCacheSize = 16) {
    this.version = manifest.version || 1;
    this.title = manifest.title || 'PS2 Disc';
    this.format = manifest.format || 'gzip';
    this.chunkSize = manifest.chunkSize || 2 * 1024 * 1024;
    this.totalSize = manifest.totalSize || 0;
    this.totalChunks = manifest.totalChunks || Math.ceil(this.totalSize / this.chunkSize);
    this.presentSet = new Set(manifest.present || []);
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : (baseUrl ? baseUrl + '/' : '');
    this.maxCacheSize = maxCacheSize;

    /** @type {Map<number, Uint8Array>} */
    this.cache = new Map();
    /** @type {Map<number, Promise<Uint8Array | null>>} */
    this.inflight = new Map();

    // Stats
    this.readsCount = 0;
    this.cacheHits = 0;
    this.networkFetches = 0;
    this.zeroSkips = 0;
  }

  /**
   * Fetch and decompress a specific chunk by index.
   * Returns null if the chunk is omitted (all zeros).
   * @param {number} chunkIndex 
   * @returns {Promise<Uint8Array | null>}
   */
  async getChunk(chunkIndex) {
    if (chunkIndex < 0 || chunkIndex >= this.totalChunks) {
      return null;
    }

    // Fast-path: Omitted zero chunk
    if (!this.presentSet.has(chunkIndex)) {
      this.zeroSkips++;
      return null;
    }

    // Check LRU cache
    if (this.cache.has(chunkIndex)) {
      this.cacheHits++;
      const val = this.cache.get(chunkIndex);
      // Move to back for LRU
      this.cache.delete(chunkIndex);
      this.cache.set(chunkIndex, val);
      return val;
    }

    // Check inflight request
    if (this.inflight.has(chunkIndex)) {
      return this.inflight.get(chunkIndex);
    }

    // Launch fetch
    this.networkFetches++;
    const promise = (async () => {
      const ext = this.format === 'brotli' ? '.bin.br' : '.bin.gz';
      const fileName = `chunk_${chunkIndex.toString().padStart(4, '0')}${ext}`;
      const url = this.baseUrl + fileName;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Failed to fetch chunk ${chunkIndex} from ${url}: HTTP ${resp.status}`);
      }

      let decompressed;
      if (this.format === 'brotli') {
        const ab = await resp.arrayBuffer();
        const raw = new Uint8Array(ab);
        let nativeSuccess = false;
        if (typeof DecompressionStream !== 'undefined') {
          try {
            const ds = new DecompressionStream('brotli');
            const stream = new Blob([ab]).stream().pipeThrough(ds);
            const arrayBuf = await new Response(stream).arrayBuffer();
            decompressed = new Uint8Array(arrayBuf);
            nativeSuccess = true;
          } catch (_) {
            nativeSuccess = false;
          }
        }
        if (!nativeSuccess) {
          if (typeof globalThis.BrotliDecode?.decompress === 'function') {
            decompressed = globalThis.BrotliDecode.decompress(raw);
          } else if (typeof globalThis.BrotliDecode === 'function') {
            decompressed = globalThis.BrotliDecode(raw);
          } else if (typeof globalThis.brotliDecompress === 'function') {
            decompressed = globalThis.brotliDecompress(raw);
          } else if (typeof globalThis.zlibBrotliDecompress === 'function') {
            decompressed = globalThis.zlibBrotliDecompress(raw);
          } else {
            console.error('No Brotli decompressor available for chunk', chunkIndex);
            decompressed = raw;
          }
        }
      } else {
        // Gzip path
        if (typeof DecompressionStream !== 'undefined' && resp.body) {
          const ds = new DecompressionStream('gzip');
          const stream = resp.body.pipeThrough(ds);
          const arrayBuf = await new Response(stream).arrayBuffer();
          decompressed = new Uint8Array(arrayBuf);
        } else {
          // Fallback for Node test environments or environments without resp.body streaming
          const ab = await resp.arrayBuffer();
          if (typeof globalThis.zlibGunzip === 'function') {
            decompressed = globalThis.zlibGunzip(new Uint8Array(ab));
          } else if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined') {
            const ds = new DecompressionStream('gzip');
            const blob = new Blob([ab]);
            const stream = blob.stream().pipeThrough(ds);
            const arrayBuf = await new Response(stream).arrayBuffer();
            decompressed = new Uint8Array(arrayBuf);
          } else {
            decompressed = new Uint8Array(ab);
          }
        }
      }

      // Maintain LRU cache limit
      if (this.cache.size >= this.maxCacheSize) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
      this.cache.set(chunkIndex, decompressed);
      this.inflight.delete(chunkIndex);
      return decompressed;
    })();

    this.inflight.set(chunkIndex, promise);
    return promise;
  }

  /**
   * Read an arbitrary byte range directly into a destination Uint8Array.
   * @param {number} offset Starting byte offset in the disc
   * @param {number} size Number of bytes to read
   * @param {Uint8Array} target Target buffer (e.g. Emscripten HEAPU8)
   * @param {number} targetOffset Destination offset in target
   * @returns {Promise<number>} Number of bytes written
   */
  async readRange(offset, size, target, targetOffset = 0) {
    this.readsCount++;
    if (offset >= this.totalSize || size <= 0) {
      return 0;
    }

    const available = Math.min(size, this.totalSize - offset);
    const startChunk = Math.floor(offset / this.chunkSize);
    const endChunk = Math.floor((offset + available - 1) / this.chunkSize);

    // Fast path: Check if all chunks in range are zero chunks
    let allZero = true;
    for (let c = startChunk; c <= endChunk; c++) {
      if (this.presentSet.has(c)) {
        allZero = false;
        break;
      }
    }

    if (allZero) {
      target.fill(0, targetOffset, targetOffset + available);
      this.zeroSkips++;
      return available;
    }

    // Fetch required chunks
    const chunkPromises = [];
    for (let c = startChunk; c <= endChunk; c++) {
      chunkPromises.push(this.getChunk(c));
    }
    const chunkData = await Promise.all(chunkPromises);

    // Splice chunks into target buffer
    let written = 0;
    for (let i = 0; i < chunkData.length; i++) {
      const c = startChunk + i;
      const cStart = c * this.chunkSize;
      const cEnd = cStart + this.chunkSize;

      const overlapStart = Math.max(offset, cStart);
      const overlapEnd = Math.min(offset + available, cEnd);
      const overlapLen = overlapEnd - overlapStart;

      if (overlapLen <= 0) continue;

      const destPos = targetOffset + (overlapStart - offset);
      const data = chunkData[i];

      if (!data) {
        // Zero chunk
        target.fill(0, destPos, destPos + overlapLen);
      } else {
        const srcPos = overlapStart - cStart;
        target.set(data.subarray(srcPos, srcPos + overlapLen), destPos);
      }
      written += overlapLen;
    }

    return written;
  }
}

/**
 * Helper to initialize a driver from a manifest JSON URL.
 * @param {string} manifestUrl 
 * @param {number} maxCacheSize 
 * @returns {Promise<ChunkDiscDriver>}
 */
export async function createChunkDriverFromUrl(manifestUrl, maxCacheSize = 16) {
  const resp = await fetch(manifestUrl);
  if (!resp.ok) {
    throw new Error(`Failed to load chunk manifest from ${manifestUrl}: HTTP ${resp.status}`);
  }
  const manifest = await resp.json();
  const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  return new ChunkDiscDriver(manifest, baseUrl, maxCacheSize);
}

if (typeof window !== 'undefined') {
  window.ChunkDiscDriver = ChunkDiscDriver;
  window.createChunkDriverFromUrl = createChunkDriverFromUrl;
}

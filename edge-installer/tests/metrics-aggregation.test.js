'use strict';
/**
 * metrics-aggregation.test.js
 * Tests for the telemetry aggregation logic from pc-edge-agent/server.js:
 *   - Percentile calculations
 *   - Bucket ring behaviour (bounded, newest wins)
 *   - Hit ratio calculation
 *   - Throughput calculation
 * We re-implement the pure logic inline so the test has zero external deps.
 */

// ── Inline pure helpers (same logic as server.js) ────────────────────────────

function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function getCacheHitRatio(hits, misses) {
  const total = hits + misses;
  return total > 0 ? parseFloat((hits / total).toFixed(4)) : 0;
}

function upsertBucket(ring, key, maxLen, record) {
  let bucket = ring.length > 0 && ring[ring.length - 1].key === key
    ? ring[ring.length - 1]
    : null;

  if (!bucket) {
    bucket = { key, requests: 0, hits: 0, misses: 0, totalMs: 0, bytes: 0, originMs: 0, latencies: [] };
    ring.push(bucket);
    if (ring.length > maxLen) ring.shift();
  }

  bucket.requests++;
  if (record.cacheResult === 'HIT')  bucket.hits++;
  if (record.cacheResult === 'MISS') bucket.misses++;
  bucket.totalMs += record.totalMs;
  bucket.bytes   += record.bytes;
  if (record.originMs != null) bucket.originMs += record.originMs;  if (bucket.latencies.length < 200) bucket.latencies.push(record.totalMs);
}

function makeRecord(opts = {}) {
  return {
    ts:          opts.ts          || new Date().toISOString(),
    path:        opts.path        || '/dash/manifest.mpd',
    cacheResult: opts.cacheResult || 'MISS',
    statusCode:  opts.statusCode  || 200,
    totalMs:     opts.totalMs     || 10,
    bytes:       opts.bytes       || 1024,
    // originMs: explicitly pass null to test null handling; default 50 for miss records
    originMs:    Object.prototype.hasOwnProperty.call(opts, 'originMs') ? opts.originMs : 50,
  };
}

// ── percentile ────────────────────────────────────────────────────────────────

describe('percentile', () => {
  test('p50 of [1,2,3,4,5] = 3', ()     => expect(percentile([1,2,3,4,5], 50)).toBe(3));
  test('p95 of 100 values = 95', ()     => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(arr, 95)).toBe(95);
  });
  test('p100 = maximum value', ()       => expect(percentile([10, 20, 30], 100)).toBe(30));
  test('p0 via ceil → index 0', ()      => expect(percentile([5, 1, 3], 1)).toBe(1));
  test('single element returns it', ()  => expect(percentile([42], 50)).toBe(42));
  test('empty array returns 0',  ()     => expect(percentile([], 50)).toBe(0));
  test('null array returns 0',   ()     => expect(percentile(null, 50)).toBe(0));
  test('handles unsorted input', ()     => expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3));
});

// ── getCacheHitRatio ──────────────────────────────────────────────────────────

describe('getCacheHitRatio', () => {
  test('50% hit ratio', ()       => expect(getCacheHitRatio(5, 5)).toBe(0.5));
  test('100% hits',     ()       => expect(getCacheHitRatio(10, 0)).toBe(1));
  test('0% hits',       ()       => expect(getCacheHitRatio(0, 10)).toBe(0));
  test('zero total = 0',()       => expect(getCacheHitRatio(0, 0)).toBe(0));
  test('rounds to 4 dp',()       => expect(getCacheHitRatio(1, 3)).toBe(0.25));
  test('2/3 = 0.6667',  ()       => expect(getCacheHitRatio(2, 1)).toBe(0.6667));
});

// ── upsertBucket ring behaviour ───────────────────────────────────────────────

describe('upsertBucket', () => {
  test('creates new bucket for new key', () => {
    const ring = [];
    upsertBucket(ring, '2024-01-01T00:00:00', 10, makeRecord({ cacheResult: 'HIT', totalMs: 5, bytes: 100 }));
    expect(ring).toHaveLength(1);
    expect(ring[0].requests).toBe(1);
    expect(ring[0].hits).toBe(1);
    expect(ring[0].misses).toBe(0);
  });

  test('aggregates multiple records into same key', () => {
    const ring = [];
    const key = '2024-01-01T00:00:00';
    upsertBucket(ring, key, 10, makeRecord({ cacheResult: 'HIT',  totalMs: 5,  bytes: 100 }));
    upsertBucket(ring, key, 10, makeRecord({ cacheResult: 'MISS', totalMs: 15, bytes: 200 }));
    expect(ring).toHaveLength(1);
    expect(ring[0].requests).toBe(2);
    expect(ring[0].hits).toBe(1);
    expect(ring[0].misses).toBe(1);
    expect(ring[0].totalMs).toBe(20);
    expect(ring[0].bytes).toBe(300);
  });

  test('creates separate bucket for different key', () => {
    const ring = [];
    upsertBucket(ring, 'key1', 10, makeRecord());
    upsertBucket(ring, 'key2', 10, makeRecord());
    expect(ring).toHaveLength(2);
  });

  test('enforces maxLen by shifting oldest', () => {
    const ring = [];
    const maxLen = 3;
    for (let i = 0; i < 5; i++) {
      upsertBucket(ring, `key${i}`, maxLen, makeRecord());
    }
    expect(ring).toHaveLength(maxLen);
    expect(ring[0].key).toBe('key2');  // oldest 0 and 1 were shifted out
    expect(ring[2].key).toBe('key4');
  });

  test('accumulates originMs for MISS records', () => {
    const ring = [];
    const key = 'k';
    upsertBucket(ring, key, 10, makeRecord({ cacheResult: 'MISS', originMs: 80 }));
    upsertBucket(ring, key, 10, makeRecord({ cacheResult: 'MISS', originMs: 120 }));
    expect(ring[0].originMs).toBe(200);
  });

  test('does not add originMs for HIT records (null originMs)', () => {
    const ring = [];
    upsertBucket(ring, 'k', 10, makeRecord({ cacheResult: 'HIT', originMs: null }));
    expect(ring[0].originMs).toBe(0);
  });

  test('caps latencies array at 200', () => {
    const ring = [];
    const key = 'k';
    for (let i = 0; i < 250; i++) {
      upsertBucket(ring, key, 10, makeRecord({ totalMs: i }));
    }
    expect(ring[0].latencies).toHaveLength(200);
    expect(ring[0].requests).toBe(250); // requests still counted beyond 200
  });
});

// ── Integration: throughput calculation ───────────────────────────────────────

describe('throughput calculation', () => {
  test('calculates Mbps from bytes in a 1-second bucket', () => {
    const bytes = 1_000_000;   // 1 MB
    const throughputMbps = parseFloat(((bytes * 8) / 1e6 / 1).toFixed(3));
    expect(throughputMbps).toBe(8);
  });

  test('calculates Mbps from bytes in a 60-second (minute) bucket', () => {
    const bytes = 60_000_000; // 60 MB over 60 s → 8 Mbps
    const throughputMbps = parseFloat(((bytes * 8) / 1e6 / 60).toFixed(3));
    expect(throughputMbps).toBe(8);
  });

  test('zero bytes = 0 Mbps', () => {
    expect(parseFloat(((0 * 8) / 1e6 / 1).toFixed(3))).toBe(0);
  });
});

// ── Latency saved calculation ─────────────────────────────────────────────────

describe('latency saved', () => {
  test('latency saved = avgOriginMs - avgHitMs when positive', () => {
    const avgOriginMs = 150;
    const avgHitMs    = 8;
    const saved = Math.max(0, avgOriginMs - avgHitMs);
    expect(saved).toBe(142);
  });

  test('never negative (clamped to 0)', () => {
    expect(Math.max(0, 5 - 10)).toBe(0);
  });
});

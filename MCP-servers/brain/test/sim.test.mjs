// PLAN-MEMORY-GRAPH-SIMILARITY-EDGES — unit tests for the embedding-similarity
// helpers. Pure functions only (no DB); run with `npm test` (node:test, no deps).
// Verifies the TS cosine/decode agree with src/memory/search.rs so the Brain graph
// and the Rust `mem similar` CLI produce identical numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, decodeEmbedding } from '../dist/queries.js';

const f32le = (arr) => {
  const buf = new ArrayBuffer(arr.length * 4);
  new Float32Array(buf).set(arr);
  return new Uint8Array(buf);
};

test('cosine: identical vectors → 1', () => {
  const v = new Float32Array([1, 2, 3]);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
});

test('cosine: orthogonal → 0', () => {
  assert.ok(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])) < 1e-6);
});

test('cosine: parallel (different magnitude) → 1', () => {
  assert.ok(Math.abs(cosine(new Float32Array([1, 2, 3]), new Float32Array([2, 4, 6])) - 1) < 1e-6);
});

test('cosine: known value cos([1,0,1],[0,1,1]) = 0.5', () => {
  assert.ok(Math.abs(cosine(new Float32Array([1, 0, 1]), new Float32Array([0, 1, 1])) - 0.5) < 1e-6);
});

test('cosine: length mismatch / empty / zero → 0 (matches Rust)', () => {
  assert.equal(cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3])), 0);
  assert.equal(cosine(new Float32Array([]), new Float32Array([])), 0);
  assert.equal(cosine(new Float32Array([0, 0]), new Float32Array([1, 1])), 0);
});

test('cosine: clamped to [0,1] for anti-parallel', () => {
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])), 0);
});

test('decodeEmbedding: round-trips f32 LE bytes', () => {
  const vals = [1.0, -2.5, 0.0, 42.0];
  const out = decodeEmbedding(f32le(vals));
  assert.equal(out.length, 4);
  for (let i = 0; i < vals.length; i++) assert.ok(Math.abs(out[i] - vals[i]) < 1e-6);
});

test('decodeEmbedding: null/short blobs → null', () => {
  assert.equal(decodeEmbedding(null), null);
  assert.equal(decodeEmbedding(undefined), null);
  assert.equal(decodeEmbedding(new Uint8Array([1, 2])), null); // < 4 bytes
});

test('decode + cosine compose: two BLOBs cosine correctly', () => {
  const a = decodeEmbedding(f32le([1, 0, 1]));
  const b = decodeEmbedding(f32le([0, 1, 1]));
  assert.ok(Math.abs(cosine(a, b) - 0.5) < 1e-6);
});

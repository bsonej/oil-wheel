import assert from "node:assert/strict";
import test from "node:test";
import { N } from "../src/grid.js";
import {
  FORM,
  HOLD,
  LETTER_TOTAL,
  RELEASE,
  distanceOutside,
  gaussianish,
  invSmooth,
  isLetterKey,
  letterEnvelope,
  maskToFields,
  smooth,
} from "../src/glyph.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test("the letter timeline forms, holds for 3 seconds, then releases", () => {
  assert.equal(HOLD, 3);
  assert.equal(LETTER_TOTAL, FORM + HOLD + RELEASE);
  assert.deepEqual(letterEnvelope(0), { phase: "form", env: 0, release: 0, done: false });
  assert.equal(letterEnvelope(FORM - 1e-9).phase, "form");
  assert.equal(letterEnvelope(FORM).phase, "hold");
  assert.equal(letterEnvelope(FORM).env, 1);
  assert.equal(letterEnvelope(FORM + HOLD - 1e-9).env, 1);
  assert.equal(letterEnvelope(FORM + HOLD).phase, "release");
  near(letterEnvelope(FORM + HOLD).env, 1);
  near(letterEnvelope(LETTER_TOTAL - 1e-9).env, 0, 1e-6);
  assert.deepEqual(letterEnvelope(LETTER_TOTAL), { phase: "idle", env: 0, release: 1, done: true });
});

test("the envelope only rises while forming and only falls while releasing", () => {
  let prev = -1;
  for (let t = 0; t <= FORM; t += 0.05) {
    const { env } = letterEnvelope(t);
    assert.ok(env >= prev - 1e-12);
    prev = env;
  }
  prev = 2;
  for (let t = FORM + HOLD; t < LETTER_TOTAL; t += 0.05) {
    const { env } = letterEnvelope(t);
    assert.ok(env <= prev + 1e-12);
    prev = env;
  }
});

test("invSmooth undoes smooth", () => {
  for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) near(invSmooth(smooth(x)), x, 1e-9);
  near(invSmooth(-1), 0, 1e-12); // clamped to the ends (floating point leaves ~1e-17 at 0)
  near(invSmooth(2), 1, 1e-12);
});

test("only A-Z count as letter keys", () => {
  for (const k of ["a", "Z", "m"]) assert.equal(isLetterKey(k), true, k);
  for (const k of ["1", " ", "Enter", "Escape", "ab", "", "é", undefined, null, 5]) assert.equal(isLetterKey(k), false, String(k));
});

function discMask(cx, cy, r) {
  const m = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * N + x] = 1;
  }
  return m;
}

test("distanceOutside is 0 inside the mask and grows away from it", () => {
  const d = distanceOutside(discMask(128, 128, 20));
  assert.equal(d[128 * N + 128], 0);
  assert.equal(d[128 * N + 140], 0);
  near(d[128 * N + 168], 168 - 148, 1.5); // 20 cells beyond the edge
  assert.ok(d[128 * N + 200] > d[128 * N + 168]);
});

test("gaussianish preserves total coverage away from the borders", () => {
  const src = discMask(128, 128, 15);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  near(sum(gaussianish(src, 6)) / sum(src), 1, 0.01);
});

test("maskToFields: sharp mask ~1 inside, ~0 far away; mid mask marks the neighbourhood; far field is a pull", () => {
  const { data, area } = maskToFields(discMask(128, 128, 30));
  const at = (x, y, ch) => data[(y * N + x) * 4 + ch];
  assert.ok(at(128, 128, 0) > 0.95, "sharp inside");
  assert.ok(at(20, 20, 0) < 0.01, "sharp far outside");
  assert.ok(at(128, 128, 1) > 0.9, "mid inside");
  assert.ok(at(20, 20, 1) < 0.03, "mid far outside is ~0, i.e. 'outside the letter'");
  assert.ok(at(128 + 38, 128, 1) > 0.03, "mid still reaches a few cells past the edge");
  assert.ok(at(20, 20, 2) < at(128 + 60, 128, 2), "the far field gets more negative the farther from the letter");
  assert.equal(at(10, 10, 3), 1);
  near(area, (Math.PI * 30 * 30) / (Math.PI * (N / 2 - 2) ** 2), 0.01);
});

test("a glyph mask is built bottom-row-first so letters are upright in the GL view", () => {
  // A mask that is only 'on' in the top rows of the canvas must land in the high rows of the field
  // once flipped by the builder, so build the flipped input directly and check it is preserved.
  const m = new Float32Array(N * N);
  for (let y = N - 40; y < N; y += 1) for (let x = 100; x < 156; x += 1) m[y * N + x] = 1;
  const { data } = maskToFields(m);
  assert.ok(data[((N - 20) * N + 128) * 4] > 0.9);
  assert.ok(data[(20 * N + 128) * 4] < 0.05);
});

import assert from "node:assert/strict";
import test from "node:test";
import { N } from "../src/grid.js";
import {
  GATHER_MAX,
  HOLD,
  RAMP,
  RELEASE,
  STABLE,
  WARP,
  advanceLetter,
  blendMould,
  blobDistance,
  blobRadius,
  dilate,
  distanceOutside,
  findHoles,
  gaussianish,
  invSmooth,
  isLetterKey,
  labelOil,
  letterView,
  maskToField,
  newLetterClock,
  releaseField,
  signedDistance,
  smooth,
  wheelCells,
} from "../src/glyph.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

function lcg(seed) {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function discMask(cx, cy, r) {
  const m = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * N + x] = 1;
  }
  return m;
}

const merge = (...masks) => masks.reduce((a, b) => a.map((v, i) => Math.max(v, b[i])));
const everywhere = () => new Uint8Array(N * N).fill(1);
const oilFrom = (mask) => mask.map((v) => (v > 0.5 ? 1 : -1));

// ------------------------------------------------------------------ timeline

test("the gather waits for one settled mass, then warp, hold, release, done", () => {
  const c = newLetterClock();
  assert.equal(c.phase, "gather");
  // Not unified: the gather just keeps going.
  for (let i = 0; i < 100; i += 1) advanceLetter(c, 0.05, false);
  assert.equal(c.phase, "gather");
  // Unified, but only briefly: the settle timer restarts when it breaks.
  for (let i = 0; i < 4; i += 1) advanceLetter(c, 0.05, true);
  advanceLetter(c, 0.05, false);
  assert.equal(c.stable, 0);
  assert.equal(c.phase, "gather");
  // Unified and staying so for STABLE seconds: the warp begins.
  let t = 0;
  while (c.phase === "gather" && t < 5) {
    advanceLetter(c, 0.05, true);
    t += 0.05;
  }
  assert.equal(c.phase, "warp");
  near(t, STABLE, 0.06);

  for (let i = 0; i < Math.ceil(WARP / 0.05) + 1; i += 1) advanceLetter(c, 0.05, true);
  assert.equal(c.phase, "hold");
  for (let i = 0; i < Math.ceil(HOLD / 0.05) + 1; i += 1) advanceLetter(c, 0.05, true);
  assert.equal(c.phase, "release");
  for (let i = 0; i < Math.ceil(RELEASE / 0.05) + 1; i += 1) advanceLetter(c, 0.05, true);
  assert.equal(c.phase, "idle");
  assert.equal(letterView(c).done, true);
});

test("the gather gives up waiting for a single mass after GATHER_MAX", () => {
  const c = newLetterClock();
  let t = 0;
  while (c.phase === "gather" && t < GATHER_MAX + 5) {
    advanceLetter(c, 0.1, false);
    t += 0.1;
  }
  assert.equal(c.phase, "warp");
  near(t, GATHER_MAX, 0.2);
});

test("the pull fades in during the gather, holds at full, and only lets go late in the release", () => {
  const c = newLetterClock();
  near(letterView(c).env, 0, 1e-12);
  let prev = 0;
  while (c.phase === "gather") {
    advanceLetter(c, 0.02, c.rampT > RAMP + 1);
    const { env, s } = letterView(c);
    assert.ok(env >= prev - 1e-12);
    assert.equal(s, 0, "no morphing during the gather");
    prev = env;
  }
  assert.equal(letterView(c).env, 1);
  while (c.phase === "warp") {
    advanceLetter(c, 0.02, true);
    assert.equal(letterView(c).env, 1);
  }
  while (c.phase === "hold") advanceLetter(c, 0.02, true);
  assert.equal(c.phase, "release");
  let wasMorphing = false;
  while (c.phase === "release") {
    advanceLetter(c, 0.02, true);
    const v = letterView(c);
    if (v.phase !== "release") break;
    if (c.t < 2.3) {
      assert.equal(v.env, 1, "the pull holds while the letter flows into its blobs");
      wasMorphing = true;
    }
  }
  assert.ok(wasMorphing);
});

test("a new key picks the pull up where it was", () => {
  const c = newLetterClock(0.6);
  near(letterView(c).env, 0.6, 1e-6);
});

test("invSmooth undoes smooth", () => {
  for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) near(invSmooth(smooth(x)), x, 1e-9);
  near(invSmooth(-1), 0, 1e-12);
  near(invSmooth(2), 1, 1e-12);
});

test("only A-Z count as letter keys", () => {
  for (const k of ["a", "Z", "m"]) assert.equal(isLetterKey(k), true, k);
  for (const k of ["1", " ", "Enter", "Escape", "ab", "", "é", undefined, null, 5]) assert.equal(isLetterKey(k), false, String(k));
});

// ------------------------------------------------------------------- fields

test("distanceOutside is 0 inside the mask and grows away from it", () => {
  const d = distanceOutside(discMask(128, 128, 20));
  assert.equal(d[128 * N + 128], 0);
  assert.equal(d[128 * N + 140], 0);
  near(d[128 * N + 168], 168 - 148, 1.5);
  assert.ok(d[128 * N + 200] > d[128 * N + 168]);
});

test("gaussianish preserves total coverage away from the borders", () => {
  const src = discMask(128, 128, 15);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  near(sum(gaussianish(src, 6)) / sum(src), 1, 0.01);
});

test("signedDistance is negative inside, positive outside, and roughly a distance", () => {
  const d = signedDistance(discMask(128, 128, 30));
  assert.ok(d[128 * N + 128] < -25, "deep inside");
  assert.ok(d[128 * N + 120] < 0);
  assert.ok(d[128 * N + 190] > 25, "well outside");
  near(d[128 * N + 128 + 60], 30, 3);
});

test("maskToField reports the covered area in cells", () => {
  const { area, sdf } = maskToField(discMask(128, 128, 30));
  near(area, Math.PI * 900, 80);
  assert.equal(sdf.length, N * N);
});

test("blobDistance and blobRadius describe a centred disc of a given area", () => {
  const r = blobRadius(5000);
  near(Math.PI * r * r, 5000, 1e-6);
  const d = blobDistance(r);
  assert.ok(d[(N / 2) * N + N / 2] < -r + 1.5);
  assert.ok(d[(N / 2) * N + N / 2 + Math.round(r) + 10] > 5);
});

test("blendMould keeps the mould's area equal to the oil, however far through the blend it is", () => {
  const cells = wheelCells();
  const letter = signedDistance(discMask(100, 120, 40)); // a stand-in shape that is nothing like the blob
  const blob = blobDistance(blobRadius(7000));
  const out = new Float32Array(N * N * 4);
  for (const s of [0, 0.25, 0.5, 0.75, 1]) {
    for (const area of [6000, 8000, 10000]) {
      blendMould(blob, letter, s, cells, area, out);
      let inside = 0;
      for (const i of cells) if (out[i * 4] < 0) inside += 1;
      near(inside / area, 1, 0.02);
    }
  }
});

test("blendMould at s = 0 and 1 is the start and end outline", () => {
  const cells = wheelCells();
  const a = blobDistance(blobRadius(7000));
  const b = signedDistance(discMask(110, 130, 45));
  const out = new Float32Array(N * N * 4);
  const shift = blendMould(a, a, 0, cells, 7000, out);
  near(shift, 0, 0.6);
  blendMould(a, b, 1, cells, Math.PI * 45 * 45, out);
  const i = 130 * N + 110;
  assert.ok(out[i * 4] < -30, "deep inside the end shape");
});

// ---------------------------------------------------------- reading the oil

test("labelOil counts separate pieces and ignores specks", () => {
  const p = oilFrom(merge(discMask(80, 128, 25), discMask(170, 128, 25), discMask(128, 60, 2)));
  const lab = labelOil(p, everywhere(), 25);
  assert.equal(lab.areas.length, 3);
  assert.equal(lab.big, 2, "the 2-cell-radius speck is too small to count");
  assert.equal(labelOil(oilFrom(merge(discMask(80, 128, 25), discMask(100, 128, 25))), everywhere()).big, 1, "touching discs are one piece");
  assert.equal(lab.largestId > 0, true);
  assert.equal(lab.areas[lab.largestId - 1], lab.largest);
});

test("labelOil sees no oil in an empty wheel", () => {
  const lab = labelOil(new Float32Array(N * N).fill(-1), everywhere());
  assert.equal(lab.big, 0);
  assert.equal(lab.largestId, 0);
});

test("findHoles finds carrier enclosed by oil but not carrier open to the edge", () => {
  const inside = new Uint8Array(N * N);
  for (const i of wheelCells()) inside[i] = 1;
  const ring = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const r = Math.hypot(x - 128, y - 128);
      if (r < 40 && r > 15) ring[y * N + x] = 1;
    }
  }
  let holes = findHoles(oilFrom(ring), inside);
  assert.equal(holes[128 * N + 128], 1, "the middle of the ring is a hole");
  assert.equal(holes[128 * N + 200], 0, "outside the ring is open");
  // Cut a channel through the ring: the middle is now open to the outside.
  for (let x = 60; x < 200; x += 1) for (let y = 125; y < 131; y += 1) ring[y * N + x] = 0;
  holes = findHoles(oilFrom(ring), inside);
  assert.equal(holes[128 * N + 128], 0);
});

test("dilate grows a mask by the given number of cells", () => {
  const m = new Uint8Array(N * N);
  m[128 * N + 128] = 1;
  const d = dilate(m, 3);
  assert.equal(d[128 * N + 131], 1);
  assert.equal(d[128 * N + 132], 0);
  assert.equal(d[(128 + 3) * N + 128], 1);
});

// ------------------------------------------------------------ release target

test("the release makes 1 to 4 blobs, all four counts turn up, and they hold the right amount of oil", () => {
  const seen = new Set();
  const cells = wheelCells();
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = lcg(seed * 7919);
    const area = 9000 + rng() * 2000;
    const { field, count, discs } = releaseField(rng, area);
    assert.ok(count >= 1 && count <= 4, `count ${count}`);
    assert.equal(discs.length, count);
    seen.add(count);
    let inside = 0;
    for (const i of cells) if (field[i] < 0) inside += 1;
    near(inside / area, 1, 0.03);
    for (const d of discs) {
      assert.ok(Math.hypot(d.x - N / 2, d.y - N / 2) + d.r < N / 2, "blob stays inside the glass");
    }
    for (let a = 0; a < discs.length; a += 1) {
      for (let b = a + 1; b < discs.length; b += 1) {
        assert.ok(Math.hypot(discs[a].x - discs[b].x, discs[a].y - discs[b].y) >= discs[a].r + discs[b].r, "blobs do not overlap");
      }
    }
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
});

test("the release honours a requested blob count", () => {
  for (const n of [1, 2, 3, 4]) assert.equal(releaseField(lcg(n), 10000, n).count, n);
});

test("a glyph mask is built bottom-row-first so letters are upright in the GL view", () => {
  const m = new Float32Array(N * N);
  for (let y = N - 40; y < N; y += 1) for (let x = 100; x < 156; x += 1) m[y * N + x] = 1;
  const { sdf } = maskToField(m);
  assert.ok(sdf[(N - 20) * N + 128] < 0, "inside the shape near the top rows");
  assert.ok(sdf[20 * N + 128] > 0, "outside near the bottom rows");
});

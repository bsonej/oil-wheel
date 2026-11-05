// Letter targets for the second oil layer.
//
// A key press runs the second layer's oil through four stages. Throughout, oil is only ever
// pushed around by a "mould" outline (nothing is created or destroyed except by the one
// unified mass gently growing or shrinking), so it stays liquid the whole way:
//   GATHER   every separate blob is drawn toward one round blob and they merge. This lasts
//            until the oil really is a single, compact, settled mass; only then does
//   WARP     the mould outline blend, smoothly, from the blob into the letter; then
//   HOLD     the letter is held; then
//   RELEASE  the letter's outline blends into 1 to 4 random blobs, and the pull fades so
//            they drift off on their own.
//
// The mould is a signed distance field (negative inside). Blending two signed distance
// fields gives a smooth, continuous in-between shape, and a level offset chosen every frame
// keeps the mould's area equal to the oil's volume so the oil fills it exactly.

import { N } from "./grid.js";

// ------------------------------------------------------------------ timeline

export const RAMP = 0.7; // seconds for the pull to fade in at the start
export const STABLE = 0.35; // the oil must stay one compact mass this long before the warp starts
export const GATHER_MAX = 10; // give up waiting for a single mass after this long and warp anyway
export const WARP = 2.4; // seconds for the blob to flow into the letter
export const HOLD = 3; // seconds the letter is held
export const RELEASE_MORPH = 2.4; // seconds for the letter to flow into its new blobs
export const RELEASE_FADE = 1.6; // seconds for the pull to let go so the blobs drift apart
export const RELEASE = RELEASE_MORPH + RELEASE_FADE;

export function smooth(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

// Inverse of smooth(): the t whose smooth(t) equals e.
export function invSmooth(e) {
  const c = Math.min(1, Math.max(0, e));
  return 0.5 - Math.sin(Math.asin(1 - 2 * c) / 3);
}

// The clock of one letter. `startEnv` lets a new key pick up the pull where the last one left it.
export function newLetterClock(startEnv = 0) {
  return { phase: "gather", t: 0, rampT: RAMP * invSmooth(startEnv), stable: 0 };
}

// Advance the clock by dt. `unified` says whether the oil is one compact mass right now; the
// gather only ends once it has been for STABLE seconds in a row (or GATHER_MAX has passed).
export function advanceLetter(c, dt, unified, warp = WARP) {
  c.t += dt;
  const go = (phase) => {
    c.phase = phase;
    c.t = 0;
  };
  if (c.phase === "gather") {
    c.rampT += dt;
    c.stable = unified ? c.stable + dt : 0;
    if (c.stable >= STABLE || c.t >= GATHER_MAX) go("warp");
  } else if (c.phase === "warp") {
    if (c.t >= warp) go("hold");
  } else if (c.phase === "hold") {
    if (c.t >= HOLD) go("release");
  } else if (c.phase === "release") {
    if (c.t >= RELEASE) go("idle");
  }
  return c;
}

// What the clock means for the simulation.
//   env   0..1 strength of the pull
//   s     0..1 progress of the current mould blend (warp: blob -> letter, release: letter -> blobs)
//   bump  0..1..0 while the pull lets go, to shake the blobs loose
export function letterView(c, warp = WARP) {
  switch (c.phase) {
    case "gather":
      return { phase: c.phase, env: smooth(c.rampT / RAMP), s: 0, bump: 0, done: false };
    case "warp":
      return { phase: c.phase, env: 1, s: smooth(c.t / warp), bump: 0, done: false };
    case "hold":
      return { phase: c.phase, env: 1, s: 1, bump: 0, done: false };
    case "release": {
      const u = (c.t - RELEASE_MORPH) / RELEASE_FADE;
      return {
        phase: c.phase,
        env: 1 - smooth(u),
        s: smooth(c.t / RELEASE_MORPH),
        bump: u > 0 ? Math.sin(Math.PI * Math.min(1, u)) : 0,
        done: false,
      };
    }
    default:
      return { phase: "idle", env: 0, s: 1, bump: 0, done: true };
  }
}

export function isLetterKey(key) {
  return typeof key === "string" && /^[a-z]$/i.test(key);
}

// ------------------------------------------------------------- field building

function boxBlurAxis(src, dst, r, horizontal) {
  const win = 2 * r + 1;
  for (let line = 0; line < N; line += 1) {
    let sum = 0;
    const at = (k) => {
      if (k < 0 || k >= N) return 0;
      return horizontal ? src[line * N + k] : src[k * N + line];
    };
    for (let k = -r; k <= r; k += 1) sum += at(k);
    for (let k = 0; k < N; k += 1) {
      const v = sum / win;
      if (horizontal) dst[line * N + k] = v;
      else dst[k * N + line] = v;
      sum += at(k + r + 1) - at(k - r);
    }
  }
}

// Three box blurs per axis approximate a Gaussian of the given sigma.
export function gaussianish(src, sigma) {
  const r = Math.max(1, Math.round((Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2));
  const a = Float32Array.from(src);
  const b = new Float32Array(N * N);
  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurAxis(a, b, r, true);
    boxBlurAxis(b, a, r, false);
  }
  return a;
}

// Distance (in cells) from each pixel to the nearest mask pixel; 0 inside the mask.
export function distanceOutside(mask) {
  const INF = 1e6;
  const d = new Float32Array(N * N);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] > 0.5 ? 0 : INF;
  const D = 1.4142;
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = y * N + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - N] + 1);
        if (x > 0) v = Math.min(v, d[i - N - 1] + D);
        if (x < N - 1) v = Math.min(v, d[i - N + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = N - 1; y >= 0; y -= 1) {
    for (let x = N - 1; x >= 0; x -= 1) {
      const i = y * N + x;
      let v = d[i];
      if (x < N - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < N - 1) {
        v = Math.min(v, d[i + N] + 1);
        if (x < N - 1) v = Math.min(v, d[i + N + 1] + D);
        if (x > 0) v = Math.min(v, d[i + N - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

// Signed distance (cells; negative inside the mask), smoothed a little so corners are liquid.
export function signedDistance(mask) {
  const outside = distanceOutside(mask);
  const inverted = new Float32Array(N * N);
  for (let i = 0; i < inverted.length; i += 1) inverted[i] = mask[i] > 0.5 ? 0 : 1;
  const inside = distanceOutside(inverted);
  const d = new Float32Array(N * N);
  for (let i = 0; i < d.length; i += 1) {
    const v = mask[i] > 0.5 ? -(inside[i] - 0.5) : outside[i] - 0.5;
    d[i] = Math.max(-140, Math.min(140, v));
  }
  return gaussianish(d, 2.5);
}

// A coverage mask (row 0 = bottom of the view) -> its signed distance field.
// `area` is the number of covered cells.
export function maskToField(mask) {
  let covered = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] > 0.5) covered += 1;
  return { sdf: signedDistance(mask), area: covered };
}

// Signed distance to a disc centred in the view.
export function blobDistance(radius) {
  const d = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) d[y * N + x] = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) - radius;
  }
  return d;
}

// Radius of the disc with the given area (cells).
export const blobRadius = (area) => Math.sqrt(Math.max(0, area) / Math.PI);

// Indices of the cells inside the circular glass (the same circle the simulation uses).
export function wheelCells() {
  const r = N / 2 - 2;
  const out = [];
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const dx = x + 0.5 - N / 2;
      const dy = y + 0.5 - N / 2;
      if (dx * dx + dy * dy < r * r) out.push(y * N + x);
    }
  }
  return Int32Array.from(out);
}

const BINS = 2048;
const RANGE = 160;
const hist = new Float32Array(BINS);

// The mould between two outlines (s = 0 is dFrom, s = 1 is dTo), written into out[i * 4]:
// blended signed distance, shifted so that exactly `area` cells of the glass are inside it.
// Returns the shift applied. `cells` = wheelCells().
export function blendMould(dFrom, dTo, s, cells, area, out) {
  hist.fill(0);
  const n = N * N;
  for (let i = 0; i < n; i += 1) out[i * 4] = dFrom[i] + (dTo[i] - dFrom[i]) * s;
  for (let k = 0; k < cells.length; k += 1) {
    const v = out[cells[k] * 4];
    const b = Math.floor(((v + RANGE) / (2 * RANGE)) * BINS);
    hist[b < 0 ? 0 : b >= BINS ? BINS - 1 : b] += 1;
  }
  let acc = 0;
  let shift = RANGE;
  for (let b = 0; b < BINS; b += 1) {
    if (acc + hist[b] >= area) {
      shift = -RANGE + ((b + (area - acc) / Math.max(1, hist[b])) / BINS) * 2 * RANGE;
      break;
    }
    acc += hist[b];
  }
  for (let i = 0; i < n; i += 1) out[i * 4] -= shift;
  return shift;
}

// ------------------------------------------------------------- reading the oil

// Connected pieces of oil (p > 0, 4-connected) among the cells inside the glass.
// `big` counts the pieces of at least `minArea` cells; smaller specks are too small to count as a blob.
export function labelOil(p, inside, minArea = 15) {
  const label = new Int32Array(N * N);
  const queue = new Int32Array(N * N);
  const areas = [];
  for (let start = 0; start < N * N; start += 1) {
    if (!inside[start] || !(p[start] > 0) || label[start]) continue;
    const id = areas.length + 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % N;
      const y = (i - x) / N;
      if (x > 0 && inside[i - 1] && p[i - 1] > 0 && !label[i - 1]) (label[i - 1] = id), (queue[tail++] = i - 1);
      if (x < N - 1 && inside[i + 1] && p[i + 1] > 0 && !label[i + 1]) (label[i + 1] = id), (queue[tail++] = i + 1);
      if (y > 0 && inside[i - N] && p[i - N] > 0 && !label[i - N]) (label[i - N] = id), (queue[tail++] = i - N);
      if (y < N - 1 && inside[i + N] && p[i + N] > 0 && !label[i + N]) (label[i + N] = id), (queue[tail++] = i + N);
    }
    areas.push(tail);
  }
  return {
    label,
    areas,
    big: areas.filter((a) => a >= minArea).length,
    largest: areas.reduce((m, a) => Math.max(m, a), 0),
    largestId: areas.length ? areas.indexOf(areas.reduce((m, a) => Math.max(m, a), 0)) + 1 : 0,
    total: areas.reduce((sum, a) => sum + a, 0),
  };
}

// Carrier cells that are completely enclosed by oil (not connected to the carrier at the glass edge).
export function findHoles(p, inside) {
  const reached = new Uint8Array(N * N);
  const queue = new Int32Array(N * N);
  let head = 0;
  let tail = 0;
  const carrier = (i) => inside[i] && !(p[i] > 0);
  const edge = (i) => {
    const x = i % N;
    const y = (i - x) / N;
    return x === 0 || y === 0 || x === N - 1 || y === N - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - N] || !inside[i + N];
  };
  for (let i = N; i < N * N - N; i += 1) {
    if (carrier(i) && !reached[i] && edge(i)) {
      reached[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % N;
    const y = (i - x) / N;
    if (x > 0 && carrier(i - 1) && !reached[i - 1]) (reached[i - 1] = 1), (queue[tail++] = i - 1);
    if (x < N - 1 && carrier(i + 1) && !reached[i + 1]) (reached[i + 1] = 1), (queue[tail++] = i + 1);
    if (y > 0 && carrier(i - N) && !reached[i - N]) (reached[i - N] = 1), (queue[tail++] = i - N);
    if (y < N - 1 && carrier(i + N) && !reached[i + N]) (reached[i + N] = 1), (queue[tail++] = i + N);
  }
  const holes = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i += 1) if (carrier(i) && !reached[i]) holes[i] = 1;
  return holes;
}

// Cells within `steps` cells (4-connected) of the marked ones.
export function dilate(mask, steps) {
  let cur = Uint8Array.from(mask);
  for (let k = 0; k < steps; k += 1) {
    const next = Uint8Array.from(cur);
    for (let i = 0; i < N * N; i += 1) {
      if (!cur[i]) continue;
      const x = i % N;
      const y = (i - x) / N;
      if (x > 0) next[i - 1] = 1;
      if (x < N - 1) next[i + 1] = 1;
      if (y > 0) next[i - N] = 1;
      if (y < N - 1) next[i + N] = 1;
    }
    cur = next;
  }
  return cur;
}

// ------------------------------------------------------------- release target

// Signed distance to a random handful (1 to 4) of round blobs that together hold `area` cells.
// `rng` returns numbers in [0, 1). Blobs never touch each other or the glass.
export function releaseField(rng, area, count = 1 + Math.floor(rng() * 4)) {
  const weights = Array.from({ length: count }, () => 0.6 + rng() * 0.8);
  const sum = weights.reduce((a, b) => a + b, 0);
  // Biggest first: they are the hardest to fit.
  const radii = weights.map((w) => Math.sqrt(((area * w) / sum) / Math.PI)).sort((x, y) => y - x);
  const wheel = N / 2 - 2;
  const discs = [];
  for (const r of radii) {
    const limit = Math.max(0, wheel - r - 8);
    let best = null;
    let bestClear = -Infinity;
    for (let tries = 0; tries < 1000 && bestClear < 10; tries += 1) {
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * limit;
      const c = { x: N / 2 + Math.cos(a) * d, y: N / 2 + Math.sin(a) * d, r };
      // Gap to the nearest blob already placed (as large as can be if there is none).
      const clear = discs.reduce((m, o) => Math.min(m, Math.hypot(o.x - c.x, o.y - c.y) - o.r - r), Infinity);
      if (clear > bestClear) {
        best = c;
        bestClear = clear;
      }
    }
    discs.push(best);
  }
  const field = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      let d = 1e9;
      for (const c of discs) d = Math.min(d, Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) - c.r);
      field[y * N + x] = d;
    }
  }
  return { field, count, discs };
}

const FONT = '900 100px "Arial Black", "Helvetica Neue", Arial, sans-serif';
const MAX_H = 150; // glyph box, in cells (the wheel is ~252 cells across)
const MAX_W = 170;

// Draw one letter, bold and centred, into a coverage mask (needs a DOM canvas).
export function drawGlyphMask(ch, doc = document) {
  const canvas = doc.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(ch);
  const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const s = Math.min(MAX_H / h, MAX_W / w);
  const cx = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
  const cy = (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
  ctx.setTransform(s, 0, 0, s, N / 2 - s * cx, N / 2 - s * cy);
  ctx.fillStyle = "#fff";
  ctx.fillText(ch, 0, 0);
  const pixels = ctx.getImageData(0, 0, N, N).data;
  const mask = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      mask[(N - 1 - y) * N + x] = pixels[(y * N + x) * 4 + 3] / 255; // flip: GL row 0 is the bottom
    }
  }
  return mask;
}

export function buildGlyphData(ch, doc = document) {
  return maskToField(drawGlyphMask(ch, doc));
}

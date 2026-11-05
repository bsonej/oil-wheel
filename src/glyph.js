// Letter targets for the second oil layer.
//
// A key press turns a letter into three fields the simulation can chase:
//   R = sharp mask   (shapes the edge)
//   G = mid mask     (captures nearby oil; also marks "outside the letter")
//   B = -distance    (a unit-strength pull from anywhere in the wheel)
// plus a timeline: the oil morphs into the letter, holds, then lets go.

import { N } from "./grid.js";

// ------------------------------------------------------------------ timeline

export const FORM = 6; // seconds for the oil to gather into the letter (slow enough to read as flow)
export const HOLD = 3; // seconds the letter is held
export const RELEASE = 4; // seconds for it to let go and spread back out
export const LETTER_TOTAL = FORM + HOLD + RELEASE;

export function smooth(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

// Inverse of smooth(): the t whose smooth(t) equals e.
export function invSmooth(e) {
  const c = Math.min(1, Math.max(0, e));
  return 0.5 - Math.sin(Math.asin(1 - 2 * c) / 3);
}

// Where a letter is in its life `t` seconds after the key press.
//   env     0..1 strength of the pull (1 while forming is complete and during the hold)
//   release 0..1 progress through the release (0 before it starts)
export function letterEnvelope(t, form = FORM) {
  if (t >= form + HOLD + RELEASE) return { phase: "idle", env: 0, release: 1, done: true };
  if (t < form) return { phase: "form", env: smooth(t / form), release: 0, done: false };
  if (t < form + HOLD) return { phase: "hold", env: 1, release: 0, done: false };
  const u = (t - form - HOLD) / RELEASE;
  return { phase: "release", env: 1 - smooth(u), release: u, done: false };
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

// A coverage mask (row 0 = bottom of the view) -> the RGBA field data the shaders sample.
// `area` is the letter's share of the wheel disk.
export function maskToFields(mask) {
  let covered = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] > 0.5) covered += 1;
  const sharp = gaussianish(mask, 2.4);
  const mid = gaussianish(mask, 10);
  const dist = distanceOutside(mask);
  const far = new Float32Array(N * N);
  for (let i = 0; i < far.length; i += 1) far[i] = -Math.min(dist[i], 140);
  const farSmooth = gaussianish(far, 3);
  const data = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i += 1) {
    data[i * 4] = sharp[i];
    data[i * 4 + 1] = mid[i];
    data[i * 4 + 2] = farSmooth[i];
    data[i * 4 + 3] = 1;
  }
  const radius = N / 2 - 2;
  return { data, area: covered / (Math.PI * radius * radius) };
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
  return maskToFields(drawGlyphMask(ch, doc));
}

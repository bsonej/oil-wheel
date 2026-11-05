// Oil Wheel: a liquid-wheel lava projector simulated on the GPU (WebGL2).
//
// Physical model (one simulation per glass layer, two layers stacked in the wheel):
//   * Two immiscible liquids (oil / carrier) as a Cahn-Hilliard phase field:
//     surface tension rounds blobs, interfaces stay crisp, volume is conserved.
//   * The liquids sit in a thin gap between glass panes, so flow is Hele-Shaw
//     (Darcy) flow: velocity = mobility * (force - grad p), div u = 0.
//     Forces: surface tension (mu * grad phi), buoyancy, and a slow stirring field.
//   * The wheel turns slowly, so gravity rotates in the wheel frame.
//   * Optics: each layer is a translucent dye filter, so the layers multiply and
//     the overlap becomes a third colour. Meniscus lensing darkens/brightens the
//     blob edges. A lamp hotspot, glass rim, halo bloom and grain finish it.

import { N } from "./grid.js";
import {
  BREAK_WARP,
  WARP,
  advanceBreak,
  advanceLetter,
  blendMould,
  blobDistance,
  blobRadius,
  breakView,
  buildGlyphData,
  dilate,
  findHoles,
  isLetterKey,
  labelOil,
  letterView,
  newBreakClock,
  newLetterClock,
  releaseField,
  signedDistance,
  splitField,
  wheelCells,
} from "./glyph.js";

export { N };
export const DEFAULT_PALETTE = {
  oilA: "#ff3d81",
  oilB: "#3fd6ff",
  oilC: "#ffd23f", // only used when the optional third layer is switched on
  fluid: "#6b3cff",
  lamp: "#fff1dc",
  ambient: "#07070f",
};

const WHEEL_TEX = 1024;
const DISK_FRAC = 0.3; // wheel disk radius as a fraction of the wheel texture side

export function hexToVec(hex) {
  const clean = String(hex || "#000000").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const v = Number.parseInt(full, 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// ---------------------------------------------------------------- CPU helpers

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insideWheel(x, y) {
  const dx = x + 0.5 - N / 2;
  const dy = y + 0.5 - N / 2;
  const r = N / 2 - 2;
  return dx * dx + dy * dy < r * r;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(rng, cell, octaves) {
  const out = new Float32Array(N * N);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o += 1) {
    const cs = cell / 2 ** o;
    const g = Math.ceil(N / cs) + 3;
    const lattice = new Float32Array(g * g);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = rng();
    for (let y = 0; y < N; y += 1) {
      const fy = y / cs;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      for (let x = 0; x < N; x += 1) {
        const fx = x / cs;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const a = lattice[y0 * g + x0];
        const b = lattice[y0 * g + x0 + 1];
        const c = lattice[(y0 + 1) * g + x0];
        const d = lattice[(y0 + 1) * g + x0 + 1];
        out[y * N + x] += amp * ((a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

// Initial oil blobs with an exact oil area fraction.
export function makeInitialPhase(seed, fraction, cell = 34) {
  const noise = valueNoise(mulberry32(seed), cell, 3);
  const samples = [];
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) if (insideWheel(x, y)) samples.push(noise[y * N + x]);
  }
  samples.sort((a, b) => a - b);
  const thr = samples[Math.floor((1 - fraction) * (samples.length - 1))];
  const phi = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = y * N + x;
      phi[i] = insideWheel(x, y) ? Math.max(-1, Math.min(1, (noise[i] - thr) * 40)) : -1;
    }
  }
  return phi;
}

// ------------------------------------------------------------------- shaders

const VERT = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define N ${N}
const float FN = float(N);
const ivec2 EX = ivec2(1, 0);
const ivec2 EY = ivec2(0, 1);
out vec4 o;
bool fluid(ivec2 c){
  if (c.x < 0 || c.y < 0 || c.x >= N || c.y >= N) return false;
  vec2 d = vec2(c) + 0.5 - 0.5 * FN;
  float r = 0.5 * FN - 2.0;
  return dot(d, d) < r * r;
}
vec2 rot(vec2 v, float a){
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const FS_MU = `${HEAD}
uniform sampler2D uPhi;
uniform float uEps2;
float ph(ivec2 c, float fb){ return fluid(c) ? texelFetch(uPhi, c, 0).r : fb; }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(0.0); return; }
  float p = texelFetch(uPhi, c, 0).r;
  float lap = ph(c + EX, p) + ph(c - EX, p) + ph(c + EY, p) + ph(c - EY, p) - 4.0 * p;
  o = vec4(p * p * p - p - uEps2 * lap, 0.0, 0.0, 1.0);
}`;

const FS_PHI = `${HEAD}
uniform sampler2D uPhi;
uniform sampler2D uMu;
uniform float uK;
float mu(ivec2 c){ return texelFetch(uMu, c, 0).r; }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(-1.0); return; }
  float p = texelFetch(uPhi, c, 0).r;
  float m = mu(c);
  float s = 0.0;
  if (fluid(c + EX)) s += mu(c + EX) - m;
  if (fluid(c - EX)) s += mu(c - EX) - m;
  if (fluid(c + EY)) s += mu(c + EY) - m;
  if (fluid(c - EY)) s += mu(c - EY) - m;
  o = vec4(clamp(p + uK * s, -1.3, 1.3), 0.0, 0.0, 1.0);
}`;

const FS_FORCE = `${HEAD}
uniform sampler2D uPhi;
uniform sampler2D uMu;
uniform sampler2D uIcon;
uniform vec2 uGdown;
uniform float uBuoy;
uniform float uTheta;
uniform float uMould;
uniform float uStir;
uniform float uTime;
uniform float uSeed;
float ph(ivec2 c, float fb){ return fluid(c) ? texelFetch(uPhi, c, 0).r : fb; }
// Slow divergence-free stirring: velocity = curl of a drifting streamfunction.
vec2 stir(vec2 x, float t){
  vec2 v = vec2(0.0);
  const vec2 K[4] = vec2[4](vec2(2.0, 1.0), vec2(-1.0, 3.0), vec2(3.0, -2.0), vec2(-3.0, -2.0));
  const float W[4] = float[4](0.31, -0.23, 0.17, -0.41);
  for (int i = 0; i < 4; i++) {
    float ph0 = dot(K[i], x) + W[i] * t + uSeed * float(i + 1);
    float a = cos(ph0) / length(K[i]);
    v += vec2(K[i].y, -K[i].x) * a;
  }
  return v;
}
// The mould: signed distance (cells, negative inside) in the view frame.
float mouldAt(vec2 viewCells){ return texture(uIcon, (viewCells + 0.5 * FN) / FN).r; }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(0.0); return; }
  float p = texelFetch(uPhi, c, 0).r;
  float m = texelFetch(uMu, c, 0).r;
  vec2 g = 0.5 * vec2(ph(c + EX, p) - ph(c - EX, p), ph(c + EY, p) - ph(c - EY, p));
  vec2 f = m * g;                                   // surface tension (Korteweg)
  float oil = clamp(0.5 * (p + 1.0), 0.0, 1.0);
  f -= uBuoy * oil * uGdown;                        // buoyancy of the oil phase
  vec2 v = rot(vec2(c) + 0.5 - 0.5 * FN, uTheta);   // wheel frame -> view frame
  // Oil outside the mould is pushed toward it (a steady push, easing in over a few cells);
  // oil inside feels nothing, so the incompressible flow spreads it to fill the mould.
  float e = mouldAt(v);
  vec2 ge = 0.5 * vec2(mouldAt(v + vec2(1.0, 0.0)) - mouldAt(v - vec2(1.0, 0.0)),
                       mouldAt(v + vec2(0.0, 1.0)) - mouldAt(v - vec2(0.0, 1.0)));
  vec2 inward = -ge / max(length(ge), 0.4);
  f += oil * uMould * smoothstep(0.0, 5.0, e) * rot(inward, -uTheta);
  f += uStir * stir((vec2(c) + 0.5) / FN * 6.2831853, uTime);
  o = vec4(f, 0.0, 1.0);
}`;

const FS_DIV = `${HEAD}
uniform sampler2D uF;
uniform sampler2D uPD;
vec2 F(ivec2 c){ return texelFetch(uF, c, 0).xy; }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(0.0); return; }
  vec2 f = F(c);
  float d = 0.0;
  if (fluid(c + EX)) d += 0.5 * (f.x + F(c + EX).x);
  if (fluid(c - EX)) d -= 0.5 * (f.x + F(c - EX).x);
  if (fluid(c + EY)) d += 0.5 * (f.y + F(c + EY).y);
  if (fluid(c - EY)) d -= 0.5 * (f.y + F(c - EY).y);
  o = vec4(texelFetch(uPD, c, 0).r, d, 0.0, 1.0);
}`;

const FS_JACOBI = `${HEAD}
uniform sampler2D uPD;
uniform float uDamp;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(0.0); return; }
  float d = texelFetch(uPD, c, 0).g;
  float s = 0.0;
  float n = 0.0;
  if (fluid(c + EX)) { s += texelFetch(uPD, c + EX, 0).r; n += 1.0; }
  if (fluid(c - EX)) { s += texelFetch(uPD, c - EX, 0).r; n += 1.0; }
  if (fluid(c + EY)) { s += texelFetch(uPD, c + EY, 0).r; n += 1.0; }
  if (fluid(c - EY)) { s += texelFetch(uPD, c - EY, 0).r; n += 1.0; }
  o = vec4(n > 0.0 ? uDamp * (s - d) / n : 0.0, d, 0.0, 1.0);
}`;

const FS_VEL = `${HEAD}
uniform sampler2D uF;
uniform sampler2D uPD;
uniform float uMob;
uniform float uMax;
vec2 F(ivec2 c){ return texelFetch(uF, c, 0).xy; }
float P(ivec2 c){ return texelFetch(uPD, c, 0).r; }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(0.0); return; }
  float p0 = P(c);
  vec2 f0 = F(c);
  float xr = 0.0, xl = 0.0, yu = 0.0, yd = 0.0;
  if (fluid(c + EX)) xr = 0.5 * (f0.x + F(c + EX).x) - (P(c + EX) - p0);
  if (fluid(c - EX)) xl = 0.5 * (f0.x + F(c - EX).x) - (p0 - P(c - EX));
  if (fluid(c + EY)) yu = 0.5 * (f0.y + F(c + EY).y) - (P(c + EY) - p0);
  if (fluid(c - EY)) yd = 0.5 * (f0.y + F(c - EY).y) - (p0 - P(c - EY));
  vec2 u = uMob * 0.5 * vec2(xr + xl, yu + yd);
  float l = length(u);
  if (l > uMax) u *= uMax / l;
  o = vec4(u, 0.0, 1.0);
}`;

const FS_ADVECT = `${HEAD}
uniform sampler2D uPhi;
uniform sampler2D uVel;
uniform float uBias;
uniform sampler2D uHome;
uniform float uRestore;
uniform sampler2D uFill;
uniform float uFillRate;
float T(ivec2 i){ return texelFetch(uPhi, clamp(i, ivec2(0), ivec2(N - 1)), 0).r; }
float samp(vec2 x){
  vec2 g = x - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  return mix(mix(T(i), T(i + EX), f.x), mix(T(i + EY), T(i + ivec2(1, 1)), f.x), f.y);
}
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (!fluid(c)) { o = vec4(-1.0); return; }
  vec2 u = texelFetch(uVel, c, 0).xy;
  float p = samp(vec2(c) + 0.5 - u);
  p += uBias * (1.0 - p * p);                 // volume regulator (acts at interfaces)
  p += uFillRate * texelFetch(uFill, c, 0).r * (1.0 - p);   // close gaps enclosed inside the oil
  // If a layer ever runs low, condense fresh oil where a noise pattern says so.
  float home = texelFetch(uHome, c, 0).r;
  p += uRestore * clamp(home, 0.0, 1.0) * (1.0 - p);
  o = vec4(clamp(p, -1.3, 1.3), 0.0, 0.0, 1.0);
}`;

const FS_COPY = `${HEAD}
uniform sampler2D uPhi;
void main(){
  vec2 v = texelFetch(uPhi, ivec2(gl_FragCoord.xy), 0).rg;
  o = vec4(v, fluid(ivec2(gl_FragCoord.xy)) ? 1.0 : 0.0, 1.0);
}`;

const FS_WHEEL = `${HEAD}
uniform sampler2D uPA;
uniform sampler2D uPB;
uniform sampler2D uPC;
uniform float uThird;
uniform float uTheta;
uniform float uTime;
uniform vec2 uRes;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uFluid;
uniform vec3 uLamp;
const vec2 LDIR = vec2(-0.55, 0.835);
float T(sampler2D t, ivec2 i){ return texelFetch(t, clamp(i, ivec2(0), ivec2(N - 1)), 0).r; }
float samp(sampler2D t, vec2 x){
  vec2 g = x - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  return mix(mix(T(t, i), T(t, i + EX), f.x), mix(T(t, i + EY), T(t, i + ivec2(1, 1)), f.x), f.y);
}
float hgt(sampler2D t, vec2 x){ return smoothstep(-0.8, 0.8, samp(t, x)); }

vec3 layer(sampler2D t, vec2 suv, float th, vec3 oil, vec3 carrier){
  vec2 x = suv * FN;
  float phi = samp(t, x);
  float d = 2.2;
  vec2 nw = vec2(hgt(t, x + vec2(d, 0.0)) - hgt(t, x - vec2(d, 0.0)),
                 hgt(t, x + vec2(0.0, d)) - hgt(t, x - vec2(0.0, d))) / (2.0 * d);
  vec2 n = rot(nw, th);
  float thick = 0.2 * (smoothstep(-0.3, 0.3, phi)
    + smoothstep(-0.3, 0.3, samp(t, x + vec2(7.0, 0.0)))
    + smoothstep(-0.3, 0.3, samp(t, x - vec2(7.0, 0.0)))
    + smoothstep(-0.3, 0.3, samp(t, x + vec2(0.0, 7.0)))
    + smoothstep(-0.3, 0.3, samp(t, x - vec2(0.0, 7.0))));
  float cov = smoothstep(-0.3, 0.3, phi);
  vec3 deep = oil * oil;
  vec3 col = mix(carrier, mix(oil, deep, 0.5 * thick), cov);
  float rim = clamp(length(n) * 3.4, 0.0, 1.0);
  float lit = dot(n / (length(n) + 1e-4), LDIR);
  col *= 1.0 - 0.42 * rim;                                    // meniscus darkening
  col *= 1.0 - 0.30 * rim * max(-lit, 0.0);                   // far side of the lens
  col += oil * 0.9 * rim * pow(max(lit, 0.0), 1.4);           // caustic fringe
  col += 0.10 * rim * pow(max(lit, 0.0), 6.0);                // specular glint
  return col;
}

void main(){
  vec2 uvW = gl_FragCoord.xy / uRes;
  vec2 p = (uvW - 0.5) / ${DISK_FRAC.toFixed(2)};
  float r = length(p);
  if (r > 1.03) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 q = rot(p, -uTheta);
  vec2 suv = 0.5 + q * ((0.5 * FN - 2.0) / FN);
  vec3 ta = layer(uPA, suv, uTheta, uColA, uFluid);
  vec3 tb = layer(uPB, suv, uTheta, uColB, vec3(0.97));
  vec3 tc = uThird > 0.5 ? layer(uPC, suv, uTheta, uColC, vec3(0.97)) : vec3(1.0);
  float lamp = 0.42 + 1.1 * exp(-r * r * 2.7);
  vec3 col = uLamp * lamp * ta * tb * tc;
  col *= mix(1.0, 0.25, smoothstep(0.9, 0.99, r));            // glass rim shadow
  col += uLamp * 0.05 * smoothstep(0.975, 0.995, r) * (1.0 - smoothstep(0.995, 1.0, r));
  col *= 1.0 - smoothstep(0.985, 1.0, r);
  col *= 1.0 + 0.05 * (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5);
  o = vec4(col, 1.0);
}`;

const FS_FINAL = `${HEAD}
uniform sampler2D uW;
uniform vec2 uRes;
uniform float uDiskPx;
uniform float uExposure;
uniform float uTime;
uniform vec3 uAmb;
float shoulder(float x){ return x < 0.78 ? x : 0.78 + 0.22 * tanh((x - 0.78) / 0.22); }
void main(){
  vec2 fc = gl_FragCoord.xy;
  float S = uDiskPx / ${DISK_FRAC.toFixed(2)};
  vec2 uv = (fc - 0.5 * uRes) / S + 0.5;
  vec2 d = uv - 0.5;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  vec3 wheel = vec3(0.0);
  if (inside) {
    wheel.r = textureLod(uW, 0.5 + d * 1.0035, 0.8).r;     // slight lens fringing
    wheel.g = textureLod(uW, uv, 0.8).g;
    wheel.b = textureLod(uW, 0.5 + d * 0.9965, 0.8).b;
  }
  vec3 bloom = 0.30 * textureLod(uW, uv, 3.0).rgb + 0.28 * textureLod(uW, uv, 4.0).rgb
             + 0.24 * textureLod(uW, uv, 5.0).rgb + 0.22 * textureLod(uW, uv, 6.0).rgb;
  vec2 sUV = fc / uRes;
  float vig = 1.0 - 0.9 * dot(sUV - 0.5, sUV - 0.5);
  float plaster = 0.5 + 0.5 * hash12(floor(fc * 0.5));
  vec3 wall = uAmb * vig * (0.85 + 0.3 * plaster);
  vec3 col = wall + bloom * 0.62 + wheel;
  col *= uExposure;
  col = vec3(shoulder(col.r), shoulder(col.g), shoulder(col.b));
  col += (hash12(fc + fract(uTime) * 17.0) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- controller

export function startOilWheel(canvas, options = {}) {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return { ok: false, reason: "This browser has no WebGL2, so the oil wheel cannot run." };
  if (!gl.getExtension("EXT_color_buffer_float")) {
    return { ok: false, reason: "This GPU cannot render float textures, so the oil wheel cannot run." };
  }

  const cfg = {
    jacobi: 64,
    damp: 0.9995, // pressure damping per Jacobi iteration (stops the solve drifting)
    // While a letter is up, the second layer moves its oil across the whole wheel. That is a very large-scale
    // flow, so it needs a much stiffer pressure solve (more iterations, almost no damping) to stay
    // incompressible; otherwise the oil is squashed and its volume drains away.
    jacobiLetter: 160,
    dampLetter: 0.99999,
    maxVLetter: 1.4,
    letterVolumeGain: 0.4, // regulator gain and limit while a letter is up
    letterBiasCap: 0.025,
    chSteps: 6,
    eps2: 1.5,
    mobilityCH: 2.0,
    dtCH: 0.0075,
    mob: 8,
    maxV: 0.6,
    buoy: 0.012,
    stir: 0.006,
    volumeGain: 0.03,
    mould: 0.45, // push on oil that is outside the letter mould, per frame at full strength
    gatherBoost: 2.0, // the push is this much stronger while the oil is still gathering into one blob
    pull: 1,
    warp: WARP, // seconds for the single blob to flow into the letter
    fill: 0.12, // how fast gaps inside the unified mass close, per frame
    breakWarp: BREAK_WARP, // seconds for a coarsened layer to flow apart into fresh pieces
    breakPieces: 2, // a layer with this few big pieces or fewer is due a break-up...
    breakMin: 15, // ...after waiting a random time between these many seconds
    breakMax: 40,
    analyseEvery: 8, // frames between looks at the oil (one mass? any gaps?)
    rot: 0.1,
    exposure: 1.0,
    flow: 1,
    ...options.cfg,
  };

  const programs = {};
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  }
  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
    }
    const locs = {};
    return {
      p,
      u(name) {
        if (!(name in locs)) locs[name] = gl.getUniformLocation(p, name);
        return locs[name];
      },
    };
  }

  function makeRT(w, h, ifmt, levels = 1, filter = gl.NEAREST) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Framebuffer is not complete for this GPU.");
    }
    return { tex, fbo, w, h };
  }

  function upload(rt, data, format) {
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rt.w, rt.h, format, gl.FLOAT, data);
  }

  // A letter's fields as a sampled texture (size w x h; a 1x1 zero texture means "no letter").
  function iconTexture(data, size = N) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, size, size, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function bind(P, name, unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.u(name), unit);
  }

  function pass(P, target, setup) {
    gl.useProgram(P.p);
    setup();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const randomSeed = () => Math.floor(Math.random() * 1e9);
  const baseSeed = options.seed ?? randomSeed();

  let sims = [];
  let wheelRT;
  let debugRT;
  try {
    programs.mu = program(FS_MU);
    programs.phi = program(FS_PHI);
    programs.force = program(FS_FORCE);
    programs.div = program(FS_DIV);
    programs.jacobi = program(FS_JACOBI);
    programs.vel = program(FS_VEL);
    programs.advect = program(FS_ADVECT);
    programs.copy = program(FS_COPY);
    programs.wheel = program(FS_WHEEL);
    programs.final = program(FS_FINAL);

    function makeSim(seed, fraction) {
      const sim = {
        phi: [makeRT(N, N, gl.R32F), makeRT(N, N, gl.R32F)],
        mu: makeRT(N, N, gl.R32F),
        f: makeRT(N, N, gl.RG32F),
        pd: [makeRT(N, N, gl.RG32F), makeRT(N, N, gl.RG32F)],
        vel: makeRT(N, N, gl.RG32F),
        home: makeRT(N, N, gl.R32F),
        cur: 0,
        pcur: 0,
        base: fraction,
        bias: 0,
        restore: 0,
        restoring: false,
      };
      const zeros = new Float32Array(N * N * 2);
      upload(sim.pd[0], zeros, gl.RG);
      upload(sim.pd[1], zeros, gl.RG);
      return sim;
    }
    sims = [makeSim(0, 0.27), makeSim(0, 0.2), makeSim(0, 0.15)];
    wheelRT = makeRT(WHEEL_TEX, WHEEL_TEX, gl.RGBA16F, 11, gl.LINEAR);
    debugRT = makeRT(N, N, gl.RGBA32F);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  function pourLayer(i, seed) {
    const sim = sims[i];
    const init = makeInitialPhase(seed + i * 7919, sim.base);
    upload(sim.phi[0], init, gl.RED);
    upload(sim.phi[1], init, gl.RED);
    upload(sim.home, init, gl.RED);
    sim.cur = 0;
    sim.bias = 0;
    sim.restore = 0;
    sim.restoring = false;
  }

  // Fresh, random blobs in every layer (the sandwich starts from a new pour).
  function reseed(seed = randomSeed()) {
    sims.forEach((_, i) => pourLayer(i, seed));
  }
  reseed(baseSeed);

  const state = {
    palette: { ...DEFAULT_PALETTE },
    third: options.third === true, // optional third glass layer; off by default
    letter: null, // { ch, tex, t }: the letter the second layer is forming, t = seconds since the key press
    env: 0, // 0..1 strength of the letter pull on the second layer
    bump: 0, // 0..1..0 during the release, to shake the held letter loose
    theta: 0,
    time: 0,
    frames: 0,
    fps: 0,
    fpsClock: performance.now(),
    fpsFrames: 0,
    rate: 1,
  };

  // Per-layer character: each glass layer's oil floats a little differently, so the layers drift apart.
  const LAYER_BUOYANCY = [1, -0.7, 0.45];
  const LAYER_MOBILITY = [1, 0.85, 0.7];
  const activeSims = () => (state.third ? sims : sims.slice(0, 2));

  // Letters only act on the second layer; the other layers keep drifting untouched.
  const LETTER_LAYER = 1;
  // The mould acts on one layer at a time: the letter layer during a letter, or whichever layer is
  // being broken back up.
  const mouldLayer = () => (state.letter ? state.letter.layer : -1);
  const blankIcon = iconTexture(new Float32Array(4), 1);
  const glyphCache = new Map();
  const cells = wheelCells();
  const mouldData = new Float32Array(N * N * 4); // the current mould, signed distance in .r
  const mouldTex = iconTexture(mouldData);

  const radial = blobDistance(0); // distance of every cell from the centre
  const insideMask = new Uint8Array(N * N);
  for (const i of cells) insideMask[i] = 1;
  const fillRT = makeRT(N, N, gl.R32F); // gaps to close, in the wheel frame
  const fillData = new Float32Array(N * N);
  upload(fillRT, fillData, gl.RED);
  let fillDirty = false;
  const phiScratch = new Float32Array(N * N);

  function setBlobArea(L, area) {
    L.area = area;
    const r = blobRadius(area);
    for (let i = 0; i < radial.length; i += 1) L.dBlob[i] = radial[i] - r;
  }

  function updateMould(morph) {
    const L = state.letter;
    blendMould(L.from, L.to, morph, cells, L.area, mouldData);
    gl.bindTexture(gl.TEXTURE_2D, mouldTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, mouldData);
    L.morph = morph;
  }

  function clearFill() {
    if (!fillDirty) return;
    fillData.fill(0);
    upload(fillRT, fillData, gl.RED);
    fillDirty = false;
  }

  // Index into the view-frame mould of the cell at wheel-frame (x, y), as the shaders do.
  function viewIndex(x, y, c, sn) {
    const dx = x + 0.5 - N / 2;
    const dy = y + 0.5 - N / 2;
    const vx = Math.floor(c * dx - sn * dy + N / 2);
    const vy = Math.floor(sn * dx + c * dy + N / 2);
    return vx >= 0 && vy >= 0 && vx < N && vy < N ? vy * N + vx : -1;
  }

  // Look at the second layer's oil: is it one compact mass, and are there gaps enclosed inside it?
  // This reads the field back, so it only runs every few frames and only while a letter is up.
  function analyseLetter() {
    const L = state.letter;
    const buf = readPhi(sims[LETTER_LAYER]);
    for (let i = 0; i < N * N; i += 1) phiScratch[i] = buf[i * 4];
    const lab = labelOil(phiScratch, insideMask);
    const c = Math.cos(state.theta);
    const sn = Math.sin(state.theta);
    let near = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = y * N + x;
        if (!insideMask[i] || !(phiScratch[i] > 0)) continue;
        const v = viewIndex(x, y, c, sn);
        if (v >= 0 && mouldData[v * 4] < 2) near += 1;
      }
    }
    L.comps = lab.big;
    L.oilCells = lab.total;
    // One mass, sitting in the mould (so it is the round blob, not a stray piece far away).
    L.unified = lab.big === 1 && lab.total > 0 && near / lab.total > 0.9;

    const filling = L.clock.phase === "gather" || L.clock.phase === "warp" || L.clock.phase === "hold";
    if (!filling) return clearFill();
    // Gaps are closed by the main mass growing into them: pockets enclosed by oil, and carrier lying
    // right next to the mass. Only inside the mould, so a letter's real holes (the counter of an R,
    // say) stay open, and only next to the main mass, so no new patch can appear anywhere.
    const holes = findHoles(phiScratch, insideMask);
    const mass = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i += 1) mass[i] = lab.label[i] === lab.largestId && lab.largestId ? 1 : 0;
    const reach = dilate(mass, 3);
    let any = false;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = y * N + x;
        let v = 0;
        if (holes[i] || (reach[i] && insideMask[i])) {
          const m = viewIndex(x, y, c, sn);
          if (m >= 0 && mouldData[m * 4] < -1.5) v = 1;
        }
        fillData[i] = v;
        if (v) any = true;
      }
    }
    if (any || fillDirty) {
      upload(fillRT, fillData, gl.RED);
      fillDirty = any;
    }
  }

  // Each stage hands the mould a new pair of outlines to blend between.
  function enterPhase(L, phase) {
    if (phase === "warp") {
      // The unified mass sets the letter's size, within reason: it may grow or shrink a little to fit.
      const base = sims[LETTER_LAYER].base * cells.length;
      const area = L.oilCells ? Math.max(0.85 * base, Math.min(1.15 * base, L.oilCells)) : base;
      setBlobArea(L, area);
      L.from = L.dBlob;
      L.to = L.sdf;
    } else if (phase === "hold") {
      L.from = L.sdf;
      L.to = L.sdf;
    } else if (phase === "release") {
      const out = releaseField(L.rng, L.area);
      L.blobs = out.count;
      L.from = L.sdf;
      L.to = out.field;
    }
    L.phase = phase;
    L.morph = -1;
  }

  // How many big pieces of oil a layer has right now (specks do not count).
  const BIG_PIECE = 120; // cells
  function countPieces(buf) {
    for (let i = 0; i < N * N; i += 1) phiScratch[i] = buf[i * 4];
    return labelOil(phiScratch, insideMask, BIG_PIECE).big;
  }

  // Break a layer's oil back apart: its current outline flows into a fresh random pattern made the
  // same way as the opening pour, then the pull lets go and the pieces carry on by themselves.
  function startBreakUp(index) {
    if (state.letter || index < 0 || index >= activeSims().length) return false;
    const sim = sims[index];
    const buf = readPhi(sim);
    // The oil as it is now, in the view frame (the frame the mould lives in).
    const c = Math.cos(state.theta);
    const sn = Math.sin(state.theta);
    const nowMask = new Float32Array(N * N);
    let oilCells = 0;
    for (let vy = 0; vy < N; vy += 1) {
      for (let vx = 0; vx < N; vx += 1) {
        const dx = vx + 0.5 - N / 2;
        const dy = vy + 0.5 - N / 2;
        const wx = Math.floor(c * dx + sn * dy + N / 2);
        const wy = Math.floor(-sn * dx + c * dy + N / 2);
        if (wx < 0 || wy < 0 || wx >= N || wy >= N) continue;
        const w = wy * N + wx;
        if (buf[w * 4 + 2] > 0.5 && buf[w * 4] > 0) {
          nowMask[vy * N + vx] = 1;
          oilCells += 1;
        }
      }
    }
    const base = sim.base * cells.length;
    const area = oilCells ? Math.max(0.85 * base, Math.min(1.15 * base, oilCells)) : base;
    const split = splitField(nowMask, Math.random);
    state.letter = {
      kind: "break",
      layer: index,
      from: signedDistance(nowMask),
      to: split.field,
      area,
      clock: newBreakClock(),
      phase: "warp",
      morph: -1,
    };
    sim.restoring = false;
    sim.restore = 0;
    updateMould(0);
    return true;
  }

  // Slowly watch each layer; one that has coarsened to a piece or two for a while is broken back up.
  function watchPieces() {
    const list = activeSims();
    if (state.letter) {
      list.forEach((sim) => (sim.sparseSince = null)); // the wait starts over once the event is done
      return;
    }
    const index = Math.floor(state.frames / 45) % list.length; // one layer per look
    const sim = list[index];
    const pieces = countPieces(readPhi(sim));
    if (pieces > cfg.breakPieces) {
      sim.sparseSince = null;
      return;
    }
    if (sim.sparseSince == null) {
      sim.sparseSince = state.time;
      sim.breakWait = cfg.breakMin + Math.random() * (cfg.breakMax - cfg.breakMin);
    } else if (state.time - sim.sparseSince >= sim.breakWait) {
      sim.sparseSince = null;
      startBreakUp(index);
    }
  }

  function updateLetter(dt) {
    const L = state.letter;
    if (!L) {
      state.env = 0;
      state.bump = 0;
      return;
    }
    if (L.kind === "break") {
      advanceBreak(L.clock, dt, cfg.breakWarp);
      const b = breakView(L.clock, cfg.breakWarp);
      if (b.done) {
        state.letter = null;
        state.env = 0;
        state.bump = 0;
        return;
      }
      if (b.s !== L.morph) updateMould(b.s);
      state.env = b.env;
      state.bump = b.bump;
      return;
    }
    advanceLetter(L.clock, dt, L.unified, cfg.warp);
    const v = letterView(L.clock, cfg.warp);
    if (v.done) {
      state.letter = null;
      state.env = 0;
      state.bump = 0;
      clearFill();
      return;
    }
    if (L.clock.phase !== L.phase) enterPhase(L, L.clock.phase);
    const s = v.phase === "gather" ? 0 : v.phase === "hold" ? 1 : v.s;
    if (s !== L.morph) updateMould(s);
    state.env = v.env;
    state.bump = v.bump;
  }

  function stepLayer(sim, layerIndex) {
    const sign = LAYER_BUOYANCY[layerIndex];
    const mob = cfg.mob * cfg.flow * LAYER_MOBILITY[layerIndex] * state.rate;
    const a = -state.theta;
    const gdown = [Math.sin(a), -Math.cos(a)];
    const mine = layerIndex === mouldLayer(); // the mould is acting on this layer
    const env = mine ? state.env : 0;
    const iconTex = mine ? mouldTex : blankIcon;
    const pull = cfg.pull * Math.min(1, env * 3); // full strength until the release is well under way
    const shake = mine ? 1 + 4 * state.bump : 1; // stir harder as the pull lets go
    const cur = () => sim.phi[sim.cur];
    const muPass = () =>
      pass(programs.mu, sim.mu, () => {
        bind(programs.mu, "uPhi", 0, cur().tex);
        gl.uniform1f(programs.mu.u("uEps2"), cfg.eps2);
      });

    muPass();
    pass(programs.force, sim.f, () => {
      const P = programs.force;
      bind(P, "uPhi", 0, cur().tex);
      bind(P, "uMu", 1, sim.mu.tex);
      bind(P, "uIcon", 2, iconTex);
      gl.uniform2f(P.u("uGdown"), gdown[0], gdown[1]);
      gl.uniform1f(P.u("uBuoy"), cfg.buoy * sign * (1 - 0.85 * env));
      gl.uniform1f(P.u("uTheta"), state.theta);
      // Moving oil a long way (gathering into a blob, or pulling a blob apart) gets the stronger push.
      const gathering = mine && state.letter.clock.phase === (state.letter.kind === "letter" ? "gather" : "warp");
      gl.uniform1f(P.u("uMould"), cfg.mould * pull * state.rate * (gathering ? cfg.gatherBoost : 1));
      gl.uniform1f(P.u("uStir"), cfg.stir * cfg.flow * (1 - env) * shake);
      gl.uniform1f(P.u("uTime"), state.time);
      gl.uniform1f(P.u("uSeed"), layerIndex * 5.3);
    });

    const pdNext = () => 1 - sim.pcur;
    pass(programs.div, sim.pd[pdNext()], () => {
      bind(programs.div, "uF", 0, sim.f.tex);
      bind(programs.div, "uPD", 1, sim.pd[sim.pcur].tex);
    });
    sim.pcur = pdNext();
    const hard = mine; // the mould is moving this layer's oil across the wheel
    for (let i = 0; i < (hard ? cfg.jacobiLetter : cfg.jacobi); i += 1) {
      pass(programs.jacobi, sim.pd[pdNext()], () => {
        bind(programs.jacobi, "uPD", 0, sim.pd[sim.pcur].tex);
        gl.uniform1f(programs.jacobi.u("uDamp"), hard ? cfg.dampLetter : cfg.damp);
      });
      sim.pcur = pdNext();
    }
    pass(programs.vel, sim.vel, () => {
      bind(programs.vel, "uF", 0, sim.f.tex);
      bind(programs.vel, "uPD", 1, sim.pd[sim.pcur].tex);
      gl.uniform1f(programs.vel.u("uMob"), mob);
      gl.uniform1f(programs.vel.u("uMax"), (hard ? cfg.maxVLetter : cfg.maxV) * state.rate);
    });
    pass(programs.advect, sim.phi[1 - sim.cur], () => {
      bind(programs.advect, "uPhi", 0, cur().tex);
      bind(programs.advect, "uVel", 1, sim.vel.tex);
      bind(programs.advect, "uHome", 2, sim.home.tex);
      gl.uniform1f(programs.advect.u("uBias"), sim.bias * state.rate);
      gl.uniform1f(programs.advect.u("uRestore"), sim.restore * state.rate);
      bind(programs.advect, "uFill", 3, fillRT.tex);
      const filling = hard && state.letter.kind === "letter" && ["gather", "warp", "hold"].includes(state.letter.clock.phase);
      gl.uniform1f(programs.advect.u("uFillRate"), filling ? cfg.fill * state.rate : 0);
    });
    sim.cur = 1 - sim.cur;

    for (let k = 0; k < cfg.chSteps; k += 1) {
      muPass();
      pass(programs.phi, sim.phi[1 - sim.cur], () => {
        bind(programs.phi, "uPhi", 0, cur().tex);
        bind(programs.phi, "uMu", 1, sim.mu.tex);
        gl.uniform1f(programs.phi.u("uK"), cfg.dtCH * cfg.mobilityCH);
      });
      sim.cur = 1 - sim.cur;
    }
  }

  function render() {
    const pal = state.palette;
    pass(programs.wheel, wheelRT, () => {
      const P = programs.wheel;
      bind(P, "uPA", 0, sims[0].phi[sims[0].cur].tex);
      bind(P, "uPB", 1, sims[1].phi[sims[1].cur].tex);
      bind(P, "uPC", 2, sims[2].phi[sims[2].cur].tex);
      gl.uniform1f(P.u("uThird"), state.third ? 1 : 0);
      gl.uniform1f(P.u("uTheta"), state.theta);
      gl.uniform1f(P.u("uTime"), state.time);
      gl.uniform2f(P.u("uRes"), WHEEL_TEX, WHEEL_TEX);
      gl.uniform3fv(P.u("uColA"), hexToVec(pal.oilA));
      gl.uniform3fv(P.u("uColB"), hexToVec(pal.oilB));
      gl.uniform3fv(P.u("uColC"), hexToVec(pal.oilC));
      gl.uniform3fv(P.u("uFluid"), hexToVec(pal.fluid));
      gl.uniform3fv(P.u("uLamp"), hexToVec(pal.lamp));
    });
    gl.bindTexture(gl.TEXTURE_2D, wheelRT.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    pass(programs.final, { fbo: null, w: canvas.width, h: canvas.height }, () => {
      const P = programs.final;
      bind(P, "uW", 0, wheelRT.tex);
      gl.uniform2f(P.u("uRes"), canvas.width, canvas.height);
      gl.uniform1f(P.u("uDiskPx"), Math.min(canvas.width, canvas.height) * 0.46);
      gl.uniform1f(P.u("uExposure"), cfg.exposure);
      gl.uniform1f(P.u("uTime"), state.time);
      gl.uniform3fv(P.u("uAmb"), hexToVec(pal.ambient));
    });
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function readPhi(sim) {
    pass(programs.copy, debugRT, () => bind(programs.copy, "uPhi", 0, sim.phi[sim.cur].tex));
    const buf = new Float32Array(N * N * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, debugRT.fbo);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, buf);
    return buf;
  }

  // How well the second layer's oil matches the letter right now (intersection over union).
  // Diagnostic only: it reads the field back, so it is not part of the frame loop.
  function letterOverlap(buf) {
    if (!state.letter) return null;
    const c = Math.cos(state.theta);
    const s = Math.sin(state.theta);
    let both = 0;
    let either = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = y * N + x;
        if (buf[i * 4 + 2] <= 0.5) continue; // outside the glass
        const dx = x + 0.5 - N / 2;
        const dy = y + 0.5 - N / 2;
        const vx = Math.floor(c * dx - s * dy + N / 2); // wheel frame -> view frame, as in the shaders
        const vy = Math.floor(s * dx + c * dy + N / 2);
        const inLetter = vx >= 0 && vy >= 0 && vx < N && vy < N && mouldData[(vy * N + vx) * 4] < 0; // inside the current mould
        const inOil = buf[i * 4] > 0;
        if (inLetter && inOil) both += 1;
        if (inLetter || inOil) either += 1;
      }
    }
    return either ? both / either : 0;
  }

  function measure(sim, buf = readPhi(sim)) {
    let oil = 0;
    let mass = 0;
    let cells = 0;
    let nan = 0;
    for (let i = 0; i < N * N; i += 1) {
      if (buf[i * 4 + 2] > 0.5) {
        cells += 1;
        if (!Number.isFinite(buf[i * 4])) nan += 1;
        else {
          if (buf[i * 4] > 0) oil += 1;
          mass += Math.max(0, Math.min(1, 0.5 * (buf[i * 4] + 1)));
        }
      }
    }
    return { oilFraction: oil / cells, oilMass: mass / cells, nan };
  }

  // Keep each layer's oil volume near its starting share so the wheel never drains.
  // The bias term acts at interfaces; if a layer runs very low there may be no
  // interface left to grow, so it also condenses fresh oil from a new noise pour.
  function regulateVolume() {
    for (const sim of activeSims()) {
      const { oilFraction } = measure(sim);
      const hard = sims.indexOf(sim) === mouldLayer();
      // While a letter is up the layer's target is the size of the letter's mould.
      const deficit = (hard ? state.letter.area / cells.length : sim.base) - oilFraction;
      // While a letter is up the regulator works harder: pushing the oil around the whole wheel leaves
      // small incompressibility errors, and this gently inflates or deflates the oil to cancel them.
      const cap = hard ? cfg.letterBiasCap : 0.006;
      sim.bias = Math.max(-cap, Math.min(cap, deficit * (hard ? cfg.letterVolumeGain : cfg.volumeGain)));
      if (deficit > 0.04 && !sim.restoring && !hard) {
        upload(sim.home, makeInitialPhase(randomSeed(), sim.base), gl.RED);
        sim.restoring = true;
      }
      if (deficit < 0.01) sim.restoring = false;
      sim.restore = sim.restoring ? Math.min(0.006, Math.max(deficit, 0) * 0.08) : 0;
    }
  }

  let last = performance.now();
  let raf = 0;
  let running = true;
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // Per-step strengths are tuned at ~43 fps; scale them so slower frames move the same oil per second.
    state.rate = Math.max(0.5, Math.min(2.2, dt * 43));
    state.time += dt;
    resize();
    updateLetter(dt);
    state.theta += dt * cfg.rot * cfg.flow * (1 - 0.7 * state.env); // the wheel eases off while a letter is held
    stepLayer(sims[0], 0);
    stepLayer(sims[1], 1);
    if (state.third) stepLayer(sims[2], 2); // no GPU cost while the third layer is off
    if (state.frames % 20 === 0) regulateVolume();
    if (state.letter && state.letter.kind === "letter" && state.frames % cfg.analyseEvery === 0) analyseLetter();
    if (state.frames % 45 === 0) watchPieces();
    render();
    state.frames += 1;
    state.fpsFrames += 1;
    if (now - state.fpsClock > 1000) {
      state.fps = (state.fpsFrames * 1000) / (now - state.fpsClock);
      state.fpsFrames = 0;
      state.fpsClock = now;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    ok: true,
    cfg,
    state,
    setPalette(next) {
      state.palette = { ...state.palette, ...next };
    },
    setFlow(v) {
      cfg.flow = v;
    },
    // A new pour: fresh random blobs in every layer. It also cancels any letter in progress.
    reseed(seed) {
      state.letter = null;
      reseed(seed);
    },
    // Switch the optional third glass layer on or off. Each time it is switched on it gets a fresh pour.
    setThird(on) {
      const next = Boolean(on);
      if (next && !state.third) pourLayer(2, randomSeed());
      state.third = next;
    },
    // Break a layer's oil (0, 1 or 2) back up into fresh pieces now, instead of waiting for it to coarsen.
    breakUp(layer = 1) {
      state.letter = null; // like a new letter key, this takes over from whatever the mould was doing
      return startBreakUp(layer);
    },
    // Morph the second layer's oil into a letter, hold it, then let it spread back out.
    // Returns false for anything that is not A-Z.
    formLetter(ch) {
      if (!isLetterKey(ch)) return false;
      const key = ch.toUpperCase();
      let entry = glyphCache.get(key);
      if (!entry) {
        entry = buildGlyphData(key);
        glyphCache.set(key, entry);
      }
      // A new key mid-sequence keeps the pull where it is and re-gathers: the old letter melts back
      // into a blob and flows into the new one.
      const layer = sims[LETTER_LAYER];
      const area = layer.base * cells.length;
      const L = {
        kind: "letter",
        layer: LETTER_LAYER,
        ch: key,
        sdf: entry.sdf,
        dBlob: new Float32Array(N * N),
        from: null,
        to: null,
        area,
        clock: newLetterClock(Math.min(1, state.env)),
        phase: "gather",
        morph: -1,
        unified: false,
        comps: null,
        oilCells: 0,
        blobs: 0,
        rng: mulberry32(randomSeed()),
      };
      setBlobArea(L, area);
      L.from = L.dBlob;
      L.to = L.dBlob;
      state.letter = L;
      updateMould(0);
      // No fresh patches may be spawned while the letter is up: only the one mass may grow or shrink.
      layer.restoring = false;
      layer.restore = 0;
      return true;
    },
    stats() {
      return activeSims().map((sim, i) => {
        const buf = readPhi(sim);
        const out = { ...measure(sim, buf), target: sim.base };
        out.pieces = countPieces(buf);
        if (i === LETTER_LAYER) {
          out.letterOverlap = state.letter && state.letter.kind === "letter" ? letterOverlap(buf) : null;
          out.letter = state.letter && state.letter.layer === i ? { kind: state.letter.kind, phase: state.letter.clock.phase, pieces: state.letter.comps, unified: state.letter.unified, blobs: state.letter.blobs } : null;
        }
        return out;
      });
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}

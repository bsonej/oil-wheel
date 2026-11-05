import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PALETTE, N, hexToVec, makeInitialPhase } from "../src/oilwheel.js";

test("hexToVec parses long and short hex, tolerating junk", () => {
  assert.deepEqual(hexToVec("#ff0000"), [1, 0, 0]);
  assert.deepEqual(hexToVec("0f0"), [0, 1, 0]);
  assert.deepEqual(hexToVec(undefined), [0, 0, 0]);
});

test("default palette has every colour the renderer reads", () => {
  for (const key of ["oilA", "oilB", "fluid", "lamp", "ambient"]) {
    assert.match(DEFAULT_PALETTE[key], /^#[0-9a-f]{6}$/i);
  }
});

test("makeInitialPhase hits the requested oil fraction inside the wheel", () => {
  for (const fraction of [0.2, 0.27]) {
    const phi = makeInitialPhase(1234, fraction);
    let oil = 0;
    let cells = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const dx = x + 0.5 - N / 2;
        const dy = y + 0.5 - N / 2;
        if (dx * dx + dy * dy < (N / 2 - 2) ** 2) {
          cells += 1;
          if (phi[y * N + x] > 0) oil += 1;
        }
      }
    }
    assert.ok(Math.abs(oil / cells - fraction) < 0.01, `fraction ${fraction} got ${oil / cells}`);
  }
});

test("different seeds give different pours; the same seed repeats", () => {
  const a = makeInitialPhase(1, 0.25);
  const b = makeInitialPhase(2, 0.25);
  const a2 = makeInitialPhase(1, 0.25);
  assert.deepEqual(a, a2);
  assert.notDeepEqual(a, b);
});

test("phase values are bounded and the corners (outside the glass) are carrier", () => {
  const phi = makeInitialPhase(99, 0.3);
  assert.equal(phi[0], -1);
  assert.ok(phi.every((v) => v >= -1 && v <= 1));
});

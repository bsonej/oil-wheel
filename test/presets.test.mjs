import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PALETTE } from "../src/oilwheel.js";
import { PRESETS } from "../src/presets.js";

const KEYS = Object.keys(DEFAULT_PALETTE);

test("every preset defines every palette colour as a 6-digit hex", () => {
  for (const preset of PRESETS) {
    for (const key of KEYS) {
      assert.match(preset[key], /^#[0-9a-f]{6}$/i, `${preset.name}.${key} = ${preset[key]}`);
    }
  }
});

test("preset names are unique", () => {
  const names = PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test("the character palettes are present", () => {
  for (const name of ["Mickey", "Donald", "Pluto"]) {
    assert.ok(PRESETS.some((p) => p.name === name), `${name} preset missing`);
  }
});

test("the default palette includes an Oil C colour for the optional third layer", () => {
  assert.match(DEFAULT_PALETTE.oilC, /^#[0-9a-f]{6}$/i);
});

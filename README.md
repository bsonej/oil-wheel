# Oil Wheel

**Try it: https://bsonej.github.io/oil-wheel/**

A digital replica of the classic Mathmos Lava Lamp projector, intended to run on a round 6 inch transparent display. It runs in the browser, with no dependencies and no build step.

It simulates what is inside a real oil-wheel projector: sealed glass layers, each holding a coloured oil and a clear carrier that never mix. The sandwich turns slowly in front of a lamp, so the oil sags, stretches and merges into an ever-changing pattern. Where layers overlap, their dyes multiply into another colour.

Two oil layers are on by default. An optional third layer adds a third oil colour.

## Run it

```sh
npm start        # http://127.0.0.1:4173/   (PORT=4180 npm start to change the port)
npm test         # node's built-in test runner
```

Any static file server works too, because the page is plain ES modules. Open it over `http://`, not `file://`.

Needs a browser with WebGL2 and float render targets (`EXT_color_buffer_float`): current Chrome, Edge, Firefox and Safari on a normal GPU.

## Controls

| | |
|---|---|
| Palette presets | Classic, Ember, Aurora, Lagoon, Violet, plus Mickey, Donald and Pluto character palettes. |
| Swatches | Oil A, Oil B, Oil C, carrier (the base colour of the field), lamp and wall. Saved in `localStorage`. |
| Third oil layer (`3`) | Optional third layer using the Oil C colour. Off by default and costs nothing while off. |
| Flow & rotation | Speed of the wheel and the oil. |
| New pour (`Space`) | Fresh random blobs in every layer. |
| Fullscreen (`Enter`), Hide controls (`Esc`) | For using it as a display. |
| Letters (`A` to `Z`) | The second oil flows together into one blob, the blob flows into that letter, it is held for 3 seconds, then the letter flows apart into a random 1 to 4 blobs that drift off. Pressing another letter mid-way melts the current one back into a blob and flows into the new letter. Keys with Ctrl, Cmd or Alt are ignored. |

From the console, `oilWheel.cfg` holds the simulation constants, `oilWheel.formLetter("R")` triggers a letter, `oilWheel.breakUp(0)` breaks a layer back into lumps, and `oilWheel.stats()` reports each active layer's oil fraction (and, while a letter is up, how much of the letter the oil covers).

## How it works

Everything is in `src/oilwheel.js`, on the GPU, one simulation per layer at 256×256:

- **Phase field.** Oil and carrier are a Cahn-Hilliard phase field. Surface tension rounds the blobs, interfaces stay crisp, and oil volume is conserved.
- **Flow.** The liquids sit in a thin gap, so flow is Hele-Shaw (Darcy): `u = mobility * (force - grad p)`, made incompressible with a Jacobi pressure solve inside a circular glass boundary. Forces are surface tension, buoyancy, and a slow divergence-free stirring field.
- **Rotation.** The wheel turns, so gravity rotates in the wheel frame. That is what keeps the oil moving. Each layer's oil has slightly different buoyancy and mobility, so the layers drift apart.
- **Optics.** Each layer is a translucent dye filter, so the layers multiply. Meniscus lensing darkens and brightens blob edges, and a lamp hotspot, glass rim, bloom, slight chromatic fringe and grain finish it.
- **Volume regulator.** Every 20 frames the oil fraction of each layer is measured. A small interface bias nudges it back toward its starting share. If a layer ever runs very low there may be no interface left to grow, so fresh oil condenses from a new noise pour.
- **Letters.** The oil is never faded in or out. It is pushed around by an invisible *mould*: a signed distance field (negative inside) whose outline the oil outside it is pushed toward, so the flow, merging and splitting are all the real simulation. Four stages:
  1. **Gather.** The mould is one round blob and the push is strong. Every separate piece of oil flows toward it and coalesces. The engine looks at the oil every few frames (connected-component labelling) and the next stage does not start until it is a single compact piece that has stayed that way for a third of a second. Gaps are closed by the main mass growing into them, only inside the mould and only next to the main mass, so no new patch ever appears.
  2. **Warp.** The mould's outline is blended, smoothly, from the blob into the letter (blending two signed distance fields gives a continuous in-between shape). A level offset is recomputed every frame so the mould's area always equals the oil's volume, so the oil fills it exactly. The letter is fixed in the viewer's frame, so it stays upright while the wheel turns.
  3. **Hold** for 3 seconds.
  4. **Release.** The outline is blended from the letter into a random 1 to 4 round blobs holding the same amount of oil, then the push fades and stirring is boosted so they drift apart.

  Only the unified mass may grow or shrink, and only by a little (a volume regulator holds it to the mould's size). Pushing oil across the whole wheel is a very large-scale flow, so while a letter is up that layer gets a stiffer pressure solve (more iterations and almost no damping); with the normal one the flow stays slightly compressible and the oil visibly drains away.
- **Break-ups.** Left alone, oil slowly coarsens until each colour is one piece. Every second or so the engine looks at one layer; if it has had two big pieces or fewer for a random 15 to 40 seconds, it is broken back up with the same mould used for letters. The mould blends from the oil's current outline into 3 to 5 round lumps placed inside it (the mass is split into regions around spread-out points, with clear carrier between lumps), the push stays on a moment while the necks pinch off, then fades with a stir boost so the lumps drift apart. Nothing is created or removed. Tune with `oilWheel.cfg.breakPieces`, `breakMin`, `breakMax`, `breakWarp`, or force one with `oilWheel.breakUp(layer)`. A letter key press overrides a break-up in progress.
- **Frame-rate independence.** Per-step strengths are tuned at about 43 fps and scaled by frame time, so a slow GPU moves the same oil per second.

## Layout

```
index.html        page and controls
src/oilwheel.js   the simulation and renderer (startOilWheel)
src/glyph.js      letter timeline and glyph-to-field conversion
src/grid.js       simulation grid size shared by the two
src/presets.js    palette presets
src/app.js        palette, presets, keys, persistence
src/style.css
server.mjs        zero-dependency static server
test/             node:test tests for the pure helpers and presets
```

## Using the engine elsewhere

```js
import { startOilWheel } from "./src/oilwheel.js";

const wheel = startOilWheel(document.querySelector("canvas"));
if (!wheel.ok) console.warn(wheel.reason);   // no WebGL2 / float targets
wheel.setPalette({ oilA: "#ffb000", oilB: "#00c9a7", fluid: "#d9480f" });
wheel.setThird(true);                         // optional third layer, uses palette.oilC
wheel.setFlow(1.5);
wheel.reseed();
wheel.destroy();
```

The canvas should be sized with CSS. The wheel is drawn centred and fitted to the shorter side. The wall colour is the area outside the wheel, so use black for a transparent display.

# Oil Wheel

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
| Third oil layer (`T`) | Optional third layer using the Oil C colour. Off by default and costs nothing while off. |
| Flow & rotation | Speed of the wheel and the oil. |
| New pour (`N`) | Fresh random blobs in every layer. |
| Fullscreen (`F`), Hide controls (`H`) | For using it as a display. |

From the console, `oilWheel.cfg` holds the simulation constants and `oilWheel.stats()` reports each active layer's oil fraction.

## How it works

Everything is in `src/oilwheel.js`, on the GPU, one simulation per layer at 256×256:

- **Phase field.** Oil and carrier are a Cahn-Hilliard phase field. Surface tension rounds the blobs, interfaces stay crisp, and oil volume is conserved.
- **Flow.** The liquids sit in a thin gap, so flow is Hele-Shaw (Darcy): `u = mobility * (force - grad p)`, made incompressible with a Jacobi pressure solve inside a circular glass boundary. Forces are surface tension, buoyancy, and a slow divergence-free stirring field.
- **Rotation.** The wheel turns, so gravity rotates in the wheel frame. That is what keeps the oil moving. Each layer's oil has slightly different buoyancy and mobility, so the layers drift apart.
- **Optics.** Each layer is a translucent dye filter, so the layers multiply. Meniscus lensing darkens and brightens blob edges, and a lamp hotspot, glass rim, bloom, slight chromatic fringe and grain finish it.
- **Volume regulator.** Every 20 frames the oil fraction of each layer is measured. A small interface bias nudges it back toward its starting share. If a layer ever runs very low there may be no interface left to grow, so fresh oil condenses from a new noise pour.
- **Frame-rate independence.** Per-step strengths are tuned at about 43 fps and scaled by frame time, so a slow GPU moves the same oil per second.

## Layout

```
index.html        page and controls
src/oilwheel.js   the simulation and renderer (startOilWheel)
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

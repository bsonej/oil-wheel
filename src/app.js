import { DEFAULT_PALETTE, startOilWheel } from "./oilwheel.js";
import { PRESETS } from "./presets.js";

const STORE_KEY = "oilwheel.v1";

const $ = (id) => document.getElementById(id);
const inputs = {
  oilA: $("tone-a"),
  oilB: $("tone-b"),
  oilC: $("tone-oil-c"),
  fluid: $("tone-c"),
  lamp: $("tone-lamp"),
  ambient: $("tone-bg"),
};

function loadSaved() {
  try {
    return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

const saved = loadSaved();
const palette = { ...DEFAULT_PALETTE, ...saved.palette };
let flow = Number.isFinite(saved.flow) ? saved.flow : 100;
let third = saved.third === true; // the third layer is an option and starts off

const wheel = startOilWheel($("lava"), { third });
if (!wheel.ok) {
  const note = $("note");
  note.textContent = wheel.reason;
  note.hidden = false;
  $("panel").hidden = true;
} else {
  const presetButtons = [];

  function apply() {
    wheel.setPalette(palette);
    wheel.setFlow(flow / 100);
    wheel.setThird(third);
    for (const [key, input] of Object.entries(inputs)) input.value = palette[key];
    $("speed").value = String(flow);
    $("third").checked = third;
    $("oil-c-swatch").classList.toggle("off", !third);
    document.documentElement.style.setProperty("--tone-a", palette.oilA);
    document.documentElement.style.setProperty("--tone-b", palette.oilB);
    // Oil C only counts toward "which preset is this" while the third layer is on.
    const keys = Object.keys(inputs).filter((k) => third || k !== "oilC");
    presetButtons.forEach(({ button, preset }) => {
      const same = keys.every((k) => preset[k].toLowerCase() === String(palette[k]).toLowerCase());
      button.setAttribute("aria-pressed", String(same));
    });
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ palette, flow, third }));
    } catch {
      /* storage may be unavailable (private mode); the wheel still works */
    }
  }

  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = preset.name;
    button.addEventListener("click", () => {
      for (const key of Object.keys(inputs)) palette[key] = preset[key];
      apply();
    });
    $("presets").append(button);
    presetButtons.push({ button, preset });
  }

  for (const [key, input] of Object.entries(inputs)) {
    input.addEventListener("input", () => {
      palette[key] = input.value;
      apply();
    });
  }
  $("speed").addEventListener("input", (event) => {
    flow = Number(event.target.value);
    apply();
  });
  $("third").addEventListener("change", (event) => {
    third = event.target.checked;
    apply();
  });

  const panel = $("panel");
  const reveal = $("show-panel");
  function setPanel(visible) {
    panel.hidden = !visible;
    reveal.hidden = visible;
  }
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  $("reseed").addEventListener("click", () => wheel.reseed());
  $("fullscreen").addEventListener("click", toggleFullscreen);
  $("hide-panel").addEventListener("click", () => setPanel(false));
  reveal.addEventListener("click", () => setPanel(true));
  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "h") setPanel(panel.hidden);
    else if (key === "f") toggleFullscreen();
    else if (key === "n") wheel.reseed();
    else if (key === "t") {
      third = !third;
      apply();
    }
  });

  apply();
  window.oilWheel = wheel; // handy from the console: oilWheel.stats(), oilWheel.cfg
}

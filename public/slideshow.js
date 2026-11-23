// Pure helpers (unit-tested) and the browser wiring that uses them.

export function nextIndex(current, length) {
  return length === 0 ? 0 : (current + 1) % length;
}

export function applyPending(current, pending, atBoundary) {
  return atBoundary && pending ? pending : current;
}

export function indexOfShown(slides, shownName) {
  return shownName === undefined ? -1 : slides.findIndex((x) => x.name === shownName);
}

function start() {
  const layers = [document.getElementById("layer-a"), document.getElementById("layer-b")];
  const banner = document.getElementById("banner");
  const panel = document.getElementById("panel");
  let front = 0;
  let slides = [];
  let pending = null;
  let index = -1;
  let shownName;
  let rotationMs = 15000;
  let timer;

  const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x.url === b[i].url);

  function show(slide) {
    const back = layers[1 - front];
    back.onload = () => {
      layers[front].classList.remove("visible");
      back.classList.add("visible");
      front = 1 - front;
    };
    back.src = slide.url;
    shownName = slide.name;
  }

  function tick() {
    clearTimeout(timer);
    const swapped = pending !== null;
    slides = applyPending(slides, pending, true);
    pending = null;
    if (swapped) index = indexOfShown(slides, shownName);
    if (slides.length > 0) {
      index = nextIndex(index, slides.length);
      // A single unchanged image needs no reload; only reshow it if it is new.
      if (slides.length > 1 || swapped || shownName === undefined) show(slides[index]);
    }
    timer = setTimeout(tick, rotationMs);
  }

  function render(state) {
    banner.hidden = !state.banner;
    banner.textContent = state.banner ? state.banner.text : "";
    if (state.images.length === 0 && state.message) {
      panel.hidden = false;
      panel.textContent = state.message;
    } else {
      panel.hidden = true;
    }

    if (slides.length === 0) {
      slides = state.images;
      if (slides.length > 0) { index = -1; tick(); }
    } else if (!sameSet(slides, state.images)) {
      pending = state.images;
    } else {
      pending = null;
    }
  }

  fetch("/config.json").then((r) => r.json()).then((c) => { rotationMs = c.rotationSeconds * 1000; });
  new EventSource("/events").onmessage = (e) => render(JSON.parse(e.data));
}

if (typeof document !== "undefined") start();

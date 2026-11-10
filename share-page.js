// /r — draws a shared Lacelap route from the URL fragment. The fragment never reaches a server.
// Decoded text goes into the page with textContent only.

import { decodeShareLink, gpxFilename, pathLength, pointAlong, toGPX } from "/r.js";

const COLORS = { spruceDeep: "#0b3330", cream: "#f6f1e4", coral: "#ff6b3d" };
const FIVE_K = 5000;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const desktop = window.matchMedia("(min-width: 820px)");

const $ = (id) => document.getElementById(id);

let map = null;
let layers = [];
let current = null;

const ERRORS = {
  missing: {
    title: "No route in this link",
    body: "The route lives in the part of the link after the #, and it's missing here. Ask your friend to share it again and open the whole link.",
  },
  unsupportedVersion: {
    title: "Made with a newer Lacelap",
    body: "This route was shared from a newer version of Lacelap than this page understands. Try again in a little while, or ask your friend for the GPX file.",
  },
  garbled: {
    title: "This route didn't make it",
    body: "The link looks cut off or garbled. Some messaging apps chop long links. Ask your friend to share it again, or to send the GPX file.",
  },
};

function showError(kind) {
  const e = ERRORS[kind] ?? ERRORS.garbled;
  $("error-title").textContent = e.title;
  $("error-body").textContent = e.body;
  document.title = "Lacelap";
  document.body.classList.remove("is-route");
  document.body.classList.add("is-error");
  current = null;
}

function formatNumber(x) {
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ensureMap() {
  if (map) return map;
  map = L.map("map", { zoomControl: false, preferCanvas: false, attributionControl: true });
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  // A zoom mid-animation would leave a stale dash length behind; just finish the line.
  map.on("zoomstart", finishDrawing);
  return map;
}

function finishDrawing() {
  for (const el of document.querySelectorAll(".route-line")) {
    el.classList.remove("drawing");
    el.style.strokeDasharray = "";
    el.style.strokeDashoffset = "";
  }
}

/** The line draws itself on from the start dot, about a second, ease-out. */
function drawOn(polylines) {
  if (reduceMotion.matches) return;
  const paths = polylines.map((p) => p.getElement()).filter(Boolean);
  for (const el of paths) {
    const len = el.getTotalLength();
    el.style.strokeDasharray = `${len} ${len}`;
    el.style.strokeDashoffset = `${len}`;
  }
  // Two frames so the starting offset is painted before the transition begins.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const el of paths) {
        el.classList.add("drawing");
        el.style.strokeDashoffset = "0";
        el.addEventListener("transitionend", finishDrawing, { once: true });
      }
    }),
  );
}

function fitRoute(bounds) {
  const opts = desktop.matches
    ? { paddingTopLeft: [400, 32], paddingBottomRight: [32, 32] }
    : { padding: [28, 28] };
  map.fitBounds(bounds, { ...opts, maxZoom: 17, animate: false });
}

function render(route) {
  current = route;
  document.body.classList.remove("is-error");
  document.body.classList.add("is-route");

  const name = route.name.trim() || "A 5K loop";
  $("route-name").textContent = name;
  document.title = `${name} · Lacelap`;

  const length = pathLength(route.coordinates);
  // The sender's engine measured the full-detail route; the link carries a simplified one.
  const meters = route.distance > 0 ? route.distance : length;
  $("km").textContent = formatNumber(meters / 1000);
  $("mi").textContent = formatNumber(meters / 1609.344);

  ensureMap();
  for (const layer of layers) layer.remove();
  layers = [];

  const latlngs = route.coordinates.map((c) => [c.lat, c.lon]);
  const casing = L.polyline(latlngs, {
    color: COLORS.spruceDeep, weight: 11, opacity: 0.9, lineCap: "round", lineJoin: "round",
    className: "route-line", interactive: false,
  }).addTo(map);
  const line = L.polyline(latlngs, {
    color: COLORS.cream, weight: 5.5, opacity: 1, lineCap: "round", lineJoin: "round",
    className: "route-line", interactive: false,
  }).addTo(map);
  layers.push(casing, line);

  // The 5K point, scaled onto the simplified line so it lands where the sender's app put it.
  let flagAt = null;
  if (meters >= FIVE_K && length > 0) flagAt = pointAlong(route.coordinates, (FIVE_K * length) / meters);
  if (flagAt) {
    const flag = L.marker([flagAt.lat, flagAt.lon], {
      icon: L.divIcon({
        className: "flag-icon",
        html: '<span class="flag"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 1h1.5v14H3zM5.5 2h8l-2 3.5 2 3.5h-8z"/></svg>5K</span>',
        iconSize: [48, 22],
        iconAnchor: [24, 26],
      }),
      keyboard: false,
      interactive: false,
      title: "5 kilometers",
    }).addTo(map);
    layers.push(flag);
  }
  $("flag-hint").hidden = !flagAt;

  const start = route.coordinates[0];
  const dot = L.circleMarker([start.lat, start.lon], {
    radius: 9, color: COLORS.cream, weight: 4, fillColor: COLORS.coral, fillOpacity: 1,
    className: "start-dot", interactive: false,
  }).addTo(map);
  layers.push(dot);

  map.invalidateSize();
  fitRoute(casing.getBounds());
  drawOn([casing, line]);
}

function load() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw.trim()) return showError("missing");
  try {
    // Payloads are URL-safe already; some apps percent-encode them anyway.
    render(decodeShareLink(decodeURIComponent(raw).trim()));
  } catch (err) {
    showError(err?.code === "unsupportedVersion" ? "unsupportedVersion" : "garbled");
  }
}

$("gpx").addEventListener("click", () => {
  if (!current) return;
  const name = current.name.trim() || "Lacelap 5K";
  const blob = new Blob([toGPX(name, current.coordinates)], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = gpxFilename(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

window.addEventListener("hashchange", load);
desktop.addEventListener("change", () => {
  if (map && layers.length) {
    map.invalidateSize();
    fitRoute(layers[0].getBounds());
  }
});

// Leaflet loads with `defer`, which runs before module scripts; guard anyway.
if (window.L) load();
else window.addEventListener("DOMContentLoaded", load, { once: true });

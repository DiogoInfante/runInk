import L from 'leaflet';
import * as turf from '@turf/turf';
import { gpx } from 'togeojson';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { inject } from '@vercel/analytics';

inject();

// ─── Constants ────────────────────────────────────────────────────────────────

const CM_PER_INCH = 2.54;
const POINTS_PER_INCH = 72;
const DEFAULT_DPI = 300;
const MAX_GRADIENT_SEGMENTS = 300;
const EXPORT_REFERENCE_WIDTH_PX = 800;

// ─── State ────────────────────────────────────────────────────────────────────

const map = L.map('map', { preferCanvas: false }).setView([0, 0], 2);
let tileLayer = L.tileLayer(document.getElementById('style-select').value, {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

let routeLayer = null; // currently displayed L.polyline or group
let currentGeoJSON = null;
let currentFileName = 'runink-export';
let hasDrawn = false;
let previewBox = null;
let animationRAF = null; // requestAnimationFrame handle for current animation
let routeCoords = []; // flat array of [lat, lng] for the current route
let routeValues = []; // per-coord normalized value (altitude or pace)

// ─── Multi-stop gradient state ────────────────────────────────────────────────
let gradientStops = [
  { color: '#ff4444', pos: 0 },
  { color: '#4488ff', pos: 1 },
];

function getAnimDurationMs() {
  const el = document.getElementById('anim-duration');
  return (parseFloat(el?.value) || 3) * 1000;
}

// Debounce helper for expensive redraws
let _drawDebounce = null;
function debouncedDraw() {
  if (_drawDebounce) cancelAnimationFrame(_drawDebounce);
  _drawDebounce = requestAnimationFrame(() => {
    if (currentGeoJSON && hasDrawn) drawRoute(currentGeoJSON);
  });
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const customizer = document.getElementById('customizer');
const uploadWrapper = document.getElementById('file-upload-wrapper');
const gpxInput = document.getElementById('gpx-input');
const styleSelect = document.getElementById('style-select');
const colorInput = document.getElementById('color-input');
const routeWidthInput = document.getElementById('route-width');
const curvatureInput = document.getElementById('curvature');
const gradientEnabled = document.getElementById('gradient-enabled');
const gradientMode = document.getElementById('gradient-mode');
const gradStopsContainer = document.getElementById('grad-stops');
const gradPreview = document.getElementById('grad-preview');
const gradStopAddBtn = document.getElementById('grad-stop-add');
const glowEnabled = document.getElementById('glow-enabled');
const glowBlurInput = document.getElementById('glow-blur');
const glowSpreadInput = document.getElementById('glow-spread');
const glowOpacityInput = document.getElementById('glow-opacity');
const shadowEnabled = document.getElementById('shadow-enabled');
const shadowDxInput = document.getElementById('shadow-dx');
const shadowDyInput = document.getElementById('shadow-dy');
const shadowBlurInput = document.getElementById('shadow-blur');
const shadowColorInput = document.getElementById('shadow-color');
const shadowOpacityInput = document.getElementById('shadow-opacity');
const animDurationInput = document.getElementById('anim-duration');
const transparentBg = document.getElementById('transparent-bg');
const replayBtn = document.getElementById('replay-btn');
const saveBtn = document.getElementById('save-btn');
const exportVideoBtn = document.getElementById('export-video-btn');
const recIndicator = document.getElementById('recording-indicator');

// ─── Size Presets ─────────────────────────────────────────────────────────────

const PRESETS = {
  'instagram-square': { w: 30, h: 30, unit: 'cm', dpi: DEFAULT_DPI }, // 1:1
  'instagram-portrait': { w: 30, h: 37.5, unit: 'cm', dpi: DEFAULT_DPI }, // 4:5
  tiktok: { w: 30, h: 53.3, unit: 'cm', dpi: DEFAULT_DPI }, // 9:16
  a3: { w: 29.7, h: 42.0, unit: 'cm', dpi: DEFAULT_DPI },
  a2: { w: 42.0, h: 59.4, unit: 'cm', dpi: DEFAULT_DPI },
  a1: { w: 59.4, h: 84.1, unit: 'cm', dpi: DEFAULT_DPI },
};

document.getElementById('preset-pills').addEventListener('click', (e) => {
  const btn = e.target.closest('.preset-pill');
  if (!btn) return;
  const key = btn.dataset.preset;
  const preset = PRESETS[key];
  if (!preset) return;

  // Toggle active state
  document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');

  document.getElementById('width').value = preset.w;
  document.getElementById('height').value = preset.h;
  document.getElementById('unit').value = preset.unit;
  document.getElementById('dpi').value = preset.dpi;

  if (previewBox) {
    previewBox.setAspectRatio(preset.w / preset.h);
  }
  if (previewBox) previewBox._render();
});

// ─── Range value display ──────────────────────────────────────────────────────

function bindRangeVal(inputEl, displayId, suffix = '') {
  const el = document.getElementById(displayId);
  if (!el) return;
  el.textContent = inputEl.value + suffix;
  inputEl.addEventListener('input', () => {
    el.textContent = inputEl.value + suffix;
  });
}
bindRangeVal(routeWidthInput, 'route-width-val');
bindRangeVal(curvatureInput, 'curvature-val');
bindRangeVal(glowBlurInput, 'glow-blur-val');
bindRangeVal(glowSpreadInput, 'glow-spread-val');
bindRangeVal(glowOpacityInput, 'glow-opacity-val');
bindRangeVal(shadowOpacityInput, 'shadow-opacity-val');
bindRangeVal(animDurationInput, 'anim-duration-val', 's');

// ─── Toggle sub-options ───────────────────────────────────────────────────────

function bindToggle(checkboxId, optionsId, onChange) {
  const cb = document.getElementById(checkboxId);
  const opts = document.getElementById(optionsId);
  cb.addEventListener('change', () => {
    opts.classList.toggle('hidden', !cb.checked);
    if (onChange) onChange();
  });
}

bindToggle('gradient-enabled', 'gradient-options', () => {
  const solidRow = document.getElementById('solid-color-row');
  solidRow.style.display = gradientEnabled.checked ? 'none' : '';
  if (currentGeoJSON) drawRoute(currentGeoJSON);
});

bindToggle('glow-enabled', 'glow-options', () => {
  applyEffects();
});
bindToggle('shadow-enabled', 'shadow-options', () => {
  applyEffects();
});

// ─── Live redraw triggers ─────────────────────────────────────────────────────

colorInput.addEventListener('input', debouncedDraw);

[routeWidthInput, curvatureInput].forEach((el) => {
  el.addEventListener('input', debouncedDraw);
});

gradientMode.addEventListener('change', debouncedDraw);

[
  glowBlurInput,
  glowSpreadInput,
  glowOpacityInput,
  shadowDxInput,
  shadowDyInput,
  shadowBlurInput,
  shadowColorInput,
  shadowOpacityInput,
].forEach((el) =>
  el.addEventListener('input', () => {
    applyEffects();
  })
);

['width', 'height'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    if (previewBox) {
      const w = parseFloat(document.getElementById('width').value) || 1;
      const h = parseFloat(document.getElementById('height').value) || 1;
      previewBox.setAspectRatio(w / h);
    }
    // deactivate preset pills since user typed custom values
    document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
  });
});

document.getElementById('unit')?.addEventListener('change', () => {
  if (previewBox) previewBox._render();
});

// ─── Theme ────────────────────────────────────────────────────────────────────

function updateTheme(styleURL) {
  const isDark = styleURL.includes('dark_all');
  document.body.classList.toggle('dark-mode', isDark);

  const currentColor = colorInput.value.toLowerCase();
  if (isDark && currentColor === '#000000') {
    colorInput.value = '#ffffff';
    if (currentGeoJSON && hasDrawn) drawRoute(currentGeoJSON);
  } else if (!isDark && currentColor === '#ffffff') {
    colorInput.value = '#000000';
    if (currentGeoJSON && hasDrawn) drawRoute(currentGeoJSON);
  }
}

updateTheme(styleSelect.value);

styleSelect.addEventListener('change', (e) => {
  const styleURL = e.target.value;
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(styleURL, {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
  updateTheme(styleURL);
});

// ─── Color utilities ──────────────────────────────────────────────────────────

/**
 * Converts a 6-character hex color string (e.g., "#ff4444") to an [R, G, B] tuple.
 * @param {string} hex - Hex color string
 * @returns {number[]} [r, g, b] array with values 0..255
 */
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

/**
 * Linearly interpolates between two hex colors at parametric position t (0..1).
 * @param {string} hexA - Starting hex color
 * @param {string} hexB - Ending hex color
 * @param {number} t - Interpolation factor (0.0 to 1.0)
 * @returns {string} Interpolated color in 'rgb(r,g,b)' format
 */
function lerpColor(hexA, hexB, t) {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${b})`;
}

/**
 * Samples a color along a multi-stop color gradient at parametric position t (0..1).
 * @param {number} t - Position factor along route (0.0 to 1.0)
 * @returns {string} CSS color string (hex or rgb)
 */
function sampleGradient(t) {
  const stops = gradientStops;
  if (stops.length === 0) return '#888888';
  if (stops.length === 1 || t <= stops[0].pos) return stops[0].color;
  if (t >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].pos && t <= stops[i + 1].pos) {
      const segT = (t - stops[i].pos) / (stops[i + 1].pos - stops[i].pos);
      return lerpColor(stops[i].color, stops[i + 1].color, segT);
    }
  }
  return stops[stops.length - 1].color;
}

// ─── Gradient Stops Manager ───────────────────────────────────────────────────

/**
 * Renders the color stop input controls for multi-stop route gradients.
 */
function renderGradientStops() {
  gradStopsContainer.innerHTML = '';
  gradientStops.forEach((stop, idx) => {
    const row = document.createElement('div');
    row.className = 'grad-stop-row';

    const colorIn = document.createElement('input');
    colorIn.type = 'color';
    colorIn.value = stop.color;
    colorIn.addEventListener('input', (e) => {
      gradientStops[idx].color = e.target.value;
      updateGradPreview();
      debouncedDraw();
    });

    const posLabel = document.createElement('span');
    posLabel.className = 'grad-stop-pos';
    posLabel.textContent = `${Math.round(stop.pos * 100)}%`;

    row.appendChild(colorIn);
    row.appendChild(posLabel);

    if (gradientStops.length > 2) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'grad-stop-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        gradientStops.splice(idx, 1);
        redistributeStops();
        renderGradientStops();
        updateGradPreview();
        debouncedDraw();
      });
      row.appendChild(removeBtn);
    }

    gradStopsContainer.appendChild(row);
  });
}

/**
 * Evenly spaces position stops across 0.0 to 1.0.
 */
function redistributeStops() {
  const n = gradientStops.length;
  gradientStops.forEach((s, i) => {
    s.pos = n > 1 ? i / (n - 1) : 0;
  });
}

/**
 * Updates the linear-gradient CSS background preview bar in the customizer panel.
 */
function updateGradPreview() {
  const css = gradientStops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(', ');
  gradPreview.style.background = `linear-gradient(90deg, ${css})`;
}

// Default colors palette for new stops
const STOP_PALETTE = [
  '#ff4444',
  '#ff8844',
  '#ffcc44',
  '#44cc88',
  '#4488ff',
  '#8844ff',
  '#ff44aa',
  '#44ddff',
  '#88ff44',
  '#ff4488',
];

gradStopAddBtn.addEventListener('click', () => {
  if (gradientStops.length >= 10) return;
  // Pick a color not yet used
  const usedColors = new Set(gradientStops.map((s) => s.color.toLowerCase()));
  const newColor = STOP_PALETTE.find((c) => !usedColors.has(c)) || '#888888';
  gradientStops.push({ color: newColor, pos: 1 });
  redistributeStops();
  renderGradientStops();
  updateGradPreview();
  debouncedDraw();
});

// Init
renderGradientStops();
updateGradPreview();

// ─── GPX value extraction ─────────────────────────────────────────────────────

/**
 * Extracts normalized metrics (0..1) per coordinate from a GeoJSON route object.
 * Supports position index, elevation profile, or calculated pace between track points.
 *
 * @param {GeoJSON.FeatureCollection} geojson - Parsed GPX GeoJSON data
 * @param {'position'|'altitude'|'pace'} mode - Metric extraction mode
 * @returns {number[]|null} Array of normalized values (0..1) or null if data unavailable
 */
function extractValuesFromGeoJSON(geojson, mode) {
  // Try to grab altitude / time per coordinate from the first LineString feature
  const feature = geojson.features.find((f) => f.geometry?.type === 'LineString');
  if (!feature) return null;

  const coords = feature.geometry.coordinates; // [lng, lat, ele?]

  if (mode === 'altitude') {
    const alts = coords.map((c) => (c[2] !== undefined && !isNaN(c[2]) ? c[2] : null));
    const valid = alts.filter((v) => v !== null);
    if (valid.length < 2) return null;
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    if (max === min) return null;
    return alts.map((v) => (v !== null ? (v - min) / (max - min) : 0));
  }

  if (mode === 'pace') {
    // togeojson stores timestamps in feature.properties.coordTimes as ISO strings
    const times = feature.properties?.coordTimes;
    if (!times || times.length < 2) return null;
    const ts = times.map((t) => new Date(t).getTime());
    const paces = []; // ms per unit distance
    for (let i = 0; i < coords.length; i++) {
      if (i === 0) {
        paces.push(0);
        continue;
      }
      const dt = ts[i] - ts[i - 1];
      const [lngA, latA] = coords[i - 1];
      const [lngB, latB] = coords[i];
      const dist = turf.distance([lngA, latA], [lngB, latB], { units: 'meters' });
      paces.push(dist > 0 ? dt / dist : 0);
    }
    const p2 = paces.slice(1);
    const min = Math.min(...p2);
    const max = Math.max(...p2);
    if (max === min) return null;
    return paces.map((v) => (v - min) / (max - min));
  }

  // position: 0..1 by index
  return coords.map((_, i) => i / (coords.length - 1));
}

// ─── SVG Effects (glow + shadow via filter) ───────────────────────────────────

const SVG_FILTER_ID = 'runink-combined-fx';

function getOrCreateSvgDefs() {
  // Leaflet's SVG renderer creates an <svg> inside the map pane
  const svg = document.querySelector('#map svg.leaflet-zoom-animated, #map svg');
  if (!svg) return null;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

function applyEffects() {
  const defs = getOrCreateSvgDefs();
  if (!defs) return;

  // Remove old filter
  defs.querySelector(`#${SVG_FILTER_ID}`)?.remove();

  const glowOn = glowEnabled.checked;
  const shadowOn = shadowEnabled.checked;

  if (!glowOn && !shadowOn) {
    // Clear filters from all paths
    document.querySelectorAll('#map svg path').forEach((p) => {
      p.style.filter = '';
    });
    return;
  }

  // Build a single combined filter with all effects
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.id = SVG_FILTER_ID;
  filter.setAttribute('x', '-100%');
  filter.setAttribute('y', '-100%');
  filter.setAttribute('width', '400%');
  filter.setAttribute('height', '400%');

  let filterInner = '';
  let lastResult = 'SourceGraphic';

  if (shadowOn) {
    const dx = parseFloat(shadowDxInput.value);
    const dy = parseFloat(shadowDyInput.value);
    const blur = parseFloat(shadowBlurInput.value);
    const color = shadowColorInput.value;
    const opac = parseFloat(shadowOpacityInput.value);
    filterInner += `<feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur}" flood-color="${color}" flood-opacity="${opac}" result="shadow"/>`;
    lastResult = 'shadow';
  }

  if (glowOn) {
    const blur = parseFloat(glowBlurInput.value);
    const spread = parseFloat(glowSpreadInput.value);
    const opac = parseFloat(glowOpacityInput.value);
    const color = gradientEnabled.checked ? sampleGradient(0) : colorInput.value;
    filterInner += `
      <feFlood flood-color="${color}" flood-opacity="${opac}" result="glowColor"/>
      <feComposite in="glowColor" in2="SourceGraphic" operator="in" result="coloredSrc"/>
      <feMorphology in="coloredSrc" operator="dilate" radius="${spread}" result="dilated"/>
      <feGaussianBlur in="dilated" stdDeviation="${blur}" result="glow"/>
      <feMerge>
        <feMergeNode in="glow"/>
        <feMergeNode in="${lastResult}"/>
      </feMerge>`;
  }

  filter.innerHTML = filterInner;
  defs.appendChild(filter);

  // Apply to ALL path elements inside Leaflet's SVG — this catches both
  // single polylines and gradient segment polylines regardless of className
  document.querySelectorAll('#map svg path').forEach((p) => {
    p.style.filter = `url(#${SVG_FILTER_ID})`;
  });
}

// ─── Draw Route ───────────────────────────────────────────────────────────────

function clearRouteLayer() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
}

function drawRoute(geojson, animate = false) {
  const curvature = parseFloat(curvatureInput.value || 100);
  const maxTolerance = 0.01;
  const tolerance = maxTolerance * (1 - curvature / 100);
  const simplified = turf.simplify(geojson, { tolerance });

  const validFeatures = simplified.features.filter(
    (f) => f.geometry && f.geometry.type === 'LineString'
  );
  if (!validFeatures.length) return;

  const feature = validFeatures[0];
  const coords = feature.geometry.coordinates.map((c) => [c[1], c[0]]); // [lat, lng]
  routeCoords = coords;

  const weight = parseFloat(routeWidthInput.value || 3);
  const useGrad = gradientEnabled.checked;

  clearRouteLayer();

  if (useGrad) {
    // Compute values for gradient coloring
    const mode = gradientMode.value;
    const vals = extractValuesFromGeoJSON(geojson, mode);
    routeValues = vals || coords.map((_, i) => i / (coords.length - 1));

    if (animate) {
      drawGradientAnimated(coords, routeValues, weight);
    } else {
      drawGradientFull(coords, routeValues, weight);
    }
  } else {
    const color = colorInput.value;
    routeLayer = L.polyline(animate ? [] : coords, {
      color,
      weight,
      className: 'runink-route',
    }).addTo(map);

    if (animate) {
      animateDraw(routeLayer, coords, () => {
        applyEffects();
        showCustomizer();
      });
    } else {
      applyEffects();
    }
  }
}

function drawGradientFull(coords, values, weight) {
  const group = L.layerGroup().addTo(map);
  routeLayer = group;

  // Chunk coords into MAX_GRADIENT_SEGMENTS for performance
  const totalPts = coords.length;
  const segCount = Math.min(totalPts - 1, MAX_GRADIENT_SEGMENTS);
  const step = (totalPts - 1) / segCount;

  for (let s = 0; s < segCount; s++) {
    const startIdx = Math.round(s * step);
    const endIdx = Math.round((s + 1) * step);
    const segCoords = coords.slice(startIdx, endIdx + 1);
    const t = values[startIdx] ?? startIdx / (totalPts - 1);
    const color = sampleGradient(t);
    L.polyline(segCoords, { color, weight }).addTo(group);
  }

  requestAnimationFrame(() => applyEffects());
}

function drawGradientAnimated(coords, values, weight) {
  const duration = getAnimDurationMs();

  // Pre-build chunked segments
  const totalPts = coords.length;
  const segCount = Math.min(totalPts - 1, MAX_GRADIENT_SEGMENTS);
  const stp = (totalPts - 1) / segCount;
  const segments = [];
  for (let s = 0; s < segCount; s++) {
    const si = Math.round(s * stp);
    const ei = Math.round((s + 1) * stp);
    const t = values[si] ?? si / (totalPts - 1);
    segments.push({ coords: coords.slice(si, ei + 1), color: sampleGradient(t), endPt: ei });
  }

  const group = L.layerGroup().addTo(map);
  routeLayer = group;
  let drawnSegCount = 0;

  if (animationRAF) cancelAnimationFrame(animationRAF);
  const startTime = performance.now();

  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const endIdx = Math.floor(progress * totalPts);

    while (drawnSegCount < segments.length && segments[drawnSegCount].endPt <= endIdx) {
      const seg = segments[drawnSegCount];
      L.polyline(seg.coords, { color: seg.color, weight }).addTo(group);
      drawnSegCount++;
    }

    if (progress < 1) {
      animationRAF = requestAnimationFrame(step);
    } else {
      while (drawnSegCount < segments.length) {
        const seg = segments[drawnSegCount];
        L.polyline(seg.coords, { color: seg.color, weight }).addTo(group);
        drawnSegCount++;
      }
      requestAnimationFrame(() => applyEffects());
      showCustomizer();
    }
  }

  animationRAF = requestAnimationFrame(step);
  hasDrawn = true;
}

function animateDraw(layer, coords, onComplete) {
  if (animationRAF) cancelAnimationFrame(animationRAF);
  const duration = getAnimDurationMs();
  const startTime = performance.now();

  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const idx = Math.floor(progress * coords.length);
    layer.setLatLngs(coords.slice(0, idx));

    if (progress < 1) {
      animationRAF = requestAnimationFrame(step);
    } else {
      if (onComplete) onComplete();
    }
  }

  animationRAF = requestAnimationFrame(step);
  hasDrawn = true;
}

// ─── Replay Animation ─────────────────────────────────────────────────────────

replayBtn.addEventListener('click', () => {
  if (!currentGeoJSON) return;
  hasDrawn = false;
  const useGrad = gradientEnabled.checked;
  const coords = routeCoords;
  const weight = parseFloat(routeWidthInput.value || 3);

  clearRouteLayer();

  if (useGrad) {
    const mode = gradientMode.value;
    const vals = extractValuesFromGeoJSON(currentGeoJSON, mode);
    routeValues = vals || coords.map((_, i) => i / (coords.length - 1));
    drawGradientAnimated(coords, routeValues, weight);
  } else {
    const color = colorInput.value;
    routeLayer = L.polyline([], {
      color,
      weight,
      className: 'runink-route',
    }).addTo(map);
    animateDraw(routeLayer, coords, () => {
      applyEffects();
    });
  }
});

// ─── PreviewBox ───────────────────────────────────────────────────────────────

/**
 * Interactive preview frame overlaid on the Leaflet map container to allow users
 * to adjust export cropping bounds, scale, aspect ratio, and rule-of-thirds alignment.
 */
class PreviewBox {
  constructor(leafletMap, mapEl) {
    this.leafletMap = leafletMap;
    this.mapEl = mapEl;
    this.x = 0;
    this.y = 0;
    this.w = 300;
    this.h = 300;
    this.aspectRatio = 1;
    this._dragging = false;
    this._resizing = false;
    this._resizeHandle = null;
    this._dragStart = null;
    this._build();
    this._bindEvents();
  }

  _build() {
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '500',
    });

    this.masks = {};
    ['top', 'bottom', 'left', 'right'].forEach((side) => {
      const div = document.createElement('div');
      Object.assign(div.style, {
        position: 'absolute',
        background: 'rgba(0,0,0,0.45)',
        pointerEvents: 'none',
      });
      this.masks[side] = div;
      this.overlay.appendChild(div);
    });

    this.frame = document.createElement('div');
    Object.assign(this.frame.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      cursor: 'move',
      border: '1.5px solid rgba(255,255,255,0.92)',
      outline: '1px solid rgba(0,0,0,0.22)',
      outlineOffset: '-1px',
    });

    // Rule-of-thirds grid
    [1, 2].forEach((i) => {
      const vl = document.createElement('div');
      Object.assign(vl.style, {
        position: 'absolute',
        top: '0',
        bottom: '0',
        left: `${(i / 3) * 100}%`,
        width: '1px',
        background: 'rgba(255,255,255,0.12)',
        pointerEvents: 'none',
      });
      const hl = document.createElement('div');
      Object.assign(hl.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        top: `${(i / 3) * 100}%`,
        height: '1px',
        background: 'rgba(255,255,255,0.12)',
        pointerEvents: 'none',
      });
      this.frame.appendChild(vl);
      this.frame.appendChild(hl);
    });

    const HANDLES = [
      { id: 'nw', top: '0%', left: '0%', cursor: 'nw-resize' },
      { id: 'n', top: '0%', left: '50%', cursor: 'n-resize' },
      { id: 'ne', top: '0%', left: '100%', cursor: 'ne-resize' },
      { id: 'e', top: '50%', left: '100%', cursor: 'e-resize' },
      { id: 'se', top: '100%', left: '100%', cursor: 'se-resize' },
      { id: 's', top: '100%', left: '50%', cursor: 's-resize' },
      { id: 'sw', top: '100%', left: '0%', cursor: 'sw-resize' },
      { id: 'w', top: '50%', left: '0%', cursor: 'w-resize' },
    ];
    this.handleEls = {};
    HANDLES.forEach(({ id, top, left, cursor }) => {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute',
        width: '9px',
        height: '9px',
        background: 'white',
        border: '1.5px solid rgba(0,0,0,0.28)',
        borderRadius: '50%',
        transform: 'translate(-50%,-50%)',
        top,
        left,
        cursor,
        zIndex: '2',
        boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
      });
      el.dataset.handle = id;
      this.frame.appendChild(el);
      this.handleEls[id] = el;
    });

    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute',
      bottom: '-24px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.62)',
      color: 'white',
      fontSize: '10px',
      fontFamily: 'Manrope, sans-serif',
      fontWeight: '600',
      letterSpacing: '0.05em',
      padding: '2px 7px',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    });
    this.frame.appendChild(this.label);
    this.overlay.appendChild(this.frame);
    this.mapEl.appendChild(this.overlay);
  }

  _bindEvents() {
    this.frame.addEventListener('mousedown', (e) => {
      if (e.target.dataset.handle) return;
      e.stopPropagation();
      e.preventDefault();
      this._startDrag(e);
    });
    Object.entries(this.handleEls).forEach(([id, el]) => {
      el.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this._startResize(e, id);
      });
    });
    this._onMove = (e) => this._handleMove(e);
    this._onUp = () => this._handleUp();
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('mouseup', this._onUp);
    this._ro = new ResizeObserver(() => this._render());
    this._ro.observe(this.mapEl);
  }

  _startDrag(e) {
    this._dragging = true;
    this._dragStart = { mx: e.clientX, my: e.clientY, bx: this.x, by: this.y };
    this.leafletMap.dragging.disable();
    document.body.style.userSelect = 'none';
  }

  _startResize(e, id) {
    this._resizing = true;
    this._resizeHandle = id;
    this._dragStart = {
      mx: e.clientX,
      my: e.clientY,
      bx: this.x,
      by: this.y,
      bw: this.w,
      bh: this.h,
    };
    this.leafletMap.dragging.disable();
    document.body.style.userSelect = 'none';
  }

  _handleMove(e) {
    if (this._dragging) {
      const dx = e.clientX - this._dragStart.mx;
      const dy = e.clientY - this._dragStart.my;
      this.x = this._dragStart.bx + dx;
      this.y = this._dragStart.by + dy;
      this._render();
    } else if (this._resizing) {
      this._doResize(e);
    }
  }

  _doResize(e) {
    const { mx, my, bx, by, bw, bh } = this._dragStart;
    const dx = e.clientX - mx,
      dy = e.clientY - my;
    const ar = this.aspectRatio,
      MIN = 60;
    let nx = bx,
      ny = by,
      nw = bw,
      nh = bh;
    switch (this._resizeHandle) {
      case 'se':
        nw = Math.max(MIN, bw + dx);
        nh = nw / ar;
        break;
      case 'sw':
        nw = Math.max(MIN, bw - dx);
        nh = nw / ar;
        nx = bx + bw - nw;
        break;
      case 'ne':
        nw = Math.max(MIN, bw + dx);
        nh = nw / ar;
        ny = by + bh - nh;
        break;
      case 'nw':
        nw = Math.max(MIN, bw - dx);
        nh = nw / ar;
        nx = bx + bw - nw;
        ny = by + bh - nh;
        break;
      case 'e':
        nw = Math.max(MIN, bw + dx);
        nh = nw / ar;
        ny = by + (bh - nh) / 2;
        break;
      case 'w':
        nw = Math.max(MIN, bw - dx);
        nh = nw / ar;
        nx = bx + bw - nw;
        ny = by + (bh - nh) / 2;
        break;
      case 's':
        nh = Math.max(MIN, bh + dy);
        nw = nh * ar;
        nx = bx + (bw - nw) / 2;
        break;
      case 'n':
        nh = Math.max(MIN, bh - dy);
        nw = nh * ar;
        nx = bx + (bw - nw) / 2;
        ny = by + bh - nh;
        break;
    }
    this.x = nx;
    this.y = ny;
    this.w = nw;
    this.h = nh;
    this._render();
  }

  _handleUp() {
    if (this._dragging || this._resizing) {
      this._dragging = false;
      this._resizing = false;
      this._resizeHandle = null;
      this._dragStart = null;
      this.leafletMap.dragging.enable();
      document.body.style.userSelect = '';
    }
  }

  _render() {
    const { x, y, w, h } = this;
    const mw = this.mapEl.offsetWidth,
      mh = this.mapEl.offsetHeight;
    Object.assign(this.frame.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    Object.assign(this.masks.top.style, { left: '0', top: '0', width: '100%', height: `${y}px` });
    Object.assign(this.masks.bottom.style, {
      left: '0',
      top: `${y + h}px`,
      width: '100%',
      height: `${mh - y - h}px`,
    });
    Object.assign(this.masks.left.style, {
      left: '0',
      top: `${y}px`,
      width: `${x}px`,
      height: `${h}px`,
    });
    Object.assign(this.masks.right.style, {
      left: `${x + w}px`,
      top: `${y}px`,
      width: `${mw - x - w}px`,
      height: `${h}px`,
    });

    const wVal = document.getElementById('width')?.value || '';
    const hVal = document.getElementById('height')?.value || '';
    const unit = document.getElementById('unit')?.value || 'cm';
    this.label.textContent = `${wVal} × ${hVal} ${unit}`;
  }

  centerAndFit() {
    const mw = this.mapEl.offsetWidth,
      mh = this.mapEl.offsetHeight;
    const maxSize = Math.min(mw, mh) * 0.65;
    if (this.aspectRatio >= 1) {
      this.w = maxSize;
      this.h = maxSize / this.aspectRatio;
    } else {
      this.h = maxSize;
      this.w = maxSize * this.aspectRatio;
    }
    this.x = (mw - this.w) / 2;
    this.y = (mh - this.h) / 2;
    this._render();
  }

  setAspectRatio(ar) {
    if (!ar || !isFinite(ar) || ar <= 0) return;
    const cx = this.x + this.w / 2,
      cy = this.y + this.h / 2;
    this.aspectRatio = ar;
    this.h = this.w / ar;
    this.x = cx - this.w / 2;
    this.y = cy - this.h / 2;
    this._render();
  }

  getBounds() {
    const tl = this.leafletMap.containerPointToLatLng([this.x, this.y]);
    const br = this.leafletMap.containerPointToLatLng([this.x + this.w, this.y + this.h]);
    return L.latLngBounds(tl, br);
  }

  destroy() {
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mouseup', this._onUp);
    this._ro?.disconnect();
    this.overlay.remove();
  }
}

// ─── GPX Upload ───────────────────────────────────────────────────────────────

gpxInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  currentFileName = file.name.replace(/\.[^/.]+$/, '');

  try {
    const xml = await file.text();
    const gpxDoc = new DOMParser().parseFromString(xml, 'application/xml');

    if (gpxDoc.querySelector('parsererror')) {
      alert('Could not parse GPX file. Please check that the file is valid XML.');
      return;
    }

    const geojson = gpx(gpxDoc);

    if (!geojson || !geojson.features || geojson.features.length === 0) {
      alert('No valid route features found in the GPX file.');
      return;
    }

    const tempCoords = geojson.features
      .filter((f) => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString')
      .flatMap((f) =>
        f.geometry.type === 'LineString'
          ? f.geometry.coordinates.map((c) => [c[1], c[0]])
          : f.geometry.coordinates.flatMap((line) => line.map((c) => [c[1], c[0]]))
      );

    if (!tempCoords.length) {
      alert('The uploaded GPX file does not contain any valid coordinate track points.');
      return;
    }

    currentGeoJSON = geojson;
    hasDrawn = false;
    clearRouteLayer();

    uploadWrapper.classList.remove('fade-in');
    uploadWrapper.classList.add('fade-out');

    const bounds = L.latLngBounds(tempCoords);
    map.flyToBounds(bounds, { padding: [50, 50], duration: 1.2 });

    setTimeout(() => {
      drawRoute(geojson, true);
    }, 1300);
  } catch (err) {
    console.error('Error loading GPX file:', err);
    alert('Failed to read GPX file. Please ensure it is a supported GPX track.');
  }
});

// ─── Show Customizer ──────────────────────────────────────────────────────────

function showCustomizer() {
  customizer.classList.remove('hidden');
  customizer.style.opacity = '0';
  customizer.style.transform = 'translateX(100%)';
  requestAnimationFrame(() => {
    customizer.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    customizer.style.opacity = '1';
    customizer.style.transform = 'translateX(0)';
  });

  setTimeout(() => {
    if (!previewBox) {
      const w = parseFloat(document.getElementById('width').value) || 30;
      const h = parseFloat(document.getElementById('height').value) || 30;
      previewBox = new PreviewBox(map, document.getElementById('map'));
      previewBox.aspectRatio = w / h;
      previewBox.centerAndFit();
    }
  }, 700);
}

// ─── Web Mercator Projection ──────────────────────────────────────────────────

/**
 * Creates a Web Mercator projection transformation mapping geographical latitude/longitude
 * coordinates to target canvas pixel space while preserving correct geographical aspect ratios.
 *
 * @param {L.LatLngBounds} bounds - Geographical bounding box of the route/viewport
 * @param {number} W - Canvas width in pixels
 * @param {number} H - Canvas height in pixels
 * @returns {function(number, number): [number, number]} Projection function (lat, lng) -> [pixelX, pixelY]
 */
function makeMercProjector(bounds, W, H) {
  function latToY(lat) {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  const swX = (bounds.getWest() + 180) / 360;
  const neX = (bounds.getEast() + 180) / 360;
  const swY = latToY(bounds.getSouth());
  const neY = latToY(bounds.getNorth());
  const bw = neX - swX,
    bh = swY - neY;
  // Fit bounds into canvas while maintaining aspect ratio
  const bAR = bw / bh,
    cAR = W / H;
  let sx, sy, ox, oy;
  if (bAR > cAR) {
    sx = W / bw;
    sy = sx;
    ox = 0;
    oy = (H - bh * sy) / 2;
  } else {
    sy = H / bh;
    sx = sy;
    ox = (W - bw * sx) / 2;
    oy = 0;
  }
  return function (lat, lng) {
    const px = ((lng + 180) / 360 - swX) * sx + ox;
    const py = (latToY(lat) - neY) * sy + oy;
    return [px, py];
  };
}

// ─── Canvas Route Renderer (for transparent export + video capture) ───────────

/**
 * Renders the route coordinates onto an offscreen HTML5 Canvas with optional drop shadow,
 * glow effects, and multi-stop gradient styling.
 *
 * @param {number} widthPx - Target canvas width in pixels
 * @param {number} heightPx - Target canvas height in pixels
 * @param {L.LatLngBounds} bounds - Route geographical bounds
 * @returns {HTMLCanvasElement} Prepared canvas with rendered route
 */
function renderRouteToCanvas(widthPx, heightPx, bounds) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');

  const project = makeMercProjector(bounds, widthPx, heightPx);

  const coords = routeCoords;
  if (!coords.length) return canvas;

  const weight = parseFloat(routeWidthInput.value || 3);
  const useGrad = gradientEnabled.checked;
  const glowOn = glowEnabled.checked;
  const shadowOn = shadowEnabled.checked;

  // Shadow pass
  if (shadowOn) {
    const dx = parseFloat(shadowDxInput.value);
    const dy = parseFloat(shadowDyInput.value);
    const blur = parseFloat(shadowBlurInput.value);
    const color = shadowColorInput.value;
    const opac = parseFloat(shadowOpacityInput.value);
    ctx.save();
    ctx.shadowOffsetX = dx * (widthPx / EXPORT_REFERENCE_WIDTH_PX);
    ctx.shadowOffsetY = dy * (widthPx / EXPORT_REFERENCE_WIDTH_PX);
    ctx.shadowBlur = blur * (widthPx / EXPORT_REFERENCE_WIDTH_PX);
    ctx.shadowColor = colorWithOpacity(color, opac);
    drawCanvasRoute(ctx, coords, weight, useGrad);
    ctx.restore();
  }

  // Glow pass
  if (glowOn) {
    const blur = parseFloat(glowBlurInput.value);
    const spread = parseFloat(glowSpreadInput.value);
    const opac = parseFloat(glowOpacityInput.value);
    const color = useGrad ? sampleGradient(0) : colorInput.value;
    ctx.save();
    ctx.shadowBlur = blur * (widthPx / EXPORT_REFERENCE_WIDTH_PX);
    ctx.shadowColor = colorWithOpacity(color, opac);
    ctx.lineWidth = weight * spread;
    ctx.strokeStyle = colorWithOpacity(color, opac * 0.5);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    coords.forEach(([lat, lng], i) => {
      const [px, py] = project(lat, lng);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Main route
  drawCanvasRoute(ctx, coords, weight, useGrad);

  function drawCanvasRoute(ctx, coords, weight, useGrad) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (useGrad && coords.length > 1) {
      const vals = routeValues.length ? routeValues : coords.map((_, i) => i / (coords.length - 1));
      for (let i = 0; i < coords.length - 1; i++) {
        const [lat0, lng0] = coords[i];
        const [lat1, lng1] = coords[i + 1];
        const [px0, py0] = project(lat0, lng0);
        const [px1, py1] = project(lat1, lng1);
        ctx.beginPath();
        ctx.moveTo(px0, py0);
        ctx.lineTo(px1, py1);
        ctx.strokeStyle = sampleGradient(vals[i] ?? 0);
        ctx.lineWidth = weight;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      coords.forEach(([lat, lng], i) => {
        const [px, py] = project(lat, lng);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.strokeStyle = colorInput.value;
      ctx.lineWidth = weight;
      ctx.stroke();
    }
  }

  return canvas;
}

function colorWithOpacity(hex, opacity) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${opacity})`;
}

// ─── Export PNG ───────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  if (!currentGeoJSON) return;

  const widthCm = parseFloat(document.getElementById('width').value || 30);
  const heightCm = parseFloat(document.getElementById('height').value || 30);
  const unit = document.getElementById('unit').value;
  const dpi = parseFloat(document.getElementById('dpi').value || 300);

  const { widthPx, heightPx } = toPixels(widthCm, heightCm, unit, dpi);
  const transparent = transparentBg.checked;

  if (transparent) {
    // Render route directly onto a canvas (no map tiles)
    const fitBounds = previewBox ? previewBox.getBounds() : getRouteBounds();
    const canvas = renderRouteToCanvas(widthPx, heightPx, fitBounds);
    downloadCanvas(canvas, `${currentFileName}.png`);
    return;
  }

  // With map tiles: hidden export map + html2canvas
  const container = document.createElement('div');
  Object.assign(container.style, {
    width: `${widthPx}px`,
    height: `${heightPx}px`,
    position: 'absolute',
    left: '-9999px',
    top: '-9999px',
  });
  document.body.appendChild(container);

  const exportMap = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
  });

  L.tileLayer(styleSelect.value, { maxZoom: 19, crossOrigin: true }).addTo(exportMap);

  const curvature = parseFloat(curvatureInput.value || 100);
  const tolerance = 0.01 * (1 - curvature / 100);
  const simplified = turf.simplify(currentGeoJSON, { tolerance });
  const validFeatures = simplified.features.filter(
    (f) => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')
  );

  const useGrad = gradientEnabled.checked;
  if (useGrad) {
    const weight = parseFloat(routeWidthInput.value || 3);
    const vals = routeValues.length
      ? routeValues
      : routeCoords.map((_, i) => i / (routeCoords.length - 1));
    routeCoords.forEach((_, i) => {
      if (i === 0) return;
      const t = vals[i] ?? 0;
      L.polyline([routeCoords[i - 1], routeCoords[i]], {
        color: sampleGradient(t),
        weight,
      }).addTo(exportMap);
    });
  } else {
    L.geoJSON(
      { type: 'FeatureCollection', features: validFeatures },
      {
        style: { color: colorInput.value, weight: parseFloat(routeWidthInput.value || 3) },
      }
    ).addTo(exportMap);
  }

  const fitBounds = previewBox ? previewBox.getBounds() : getRouteBounds();
  exportMap.fitBounds(fitBounds);
  exportMap.invalidateSize();

  let tilesLoaded = false;

  // Wait for tiles
  exportMap.eachLayer((l) => {
    if (l._url)
      l.on('load', () => {
        tilesLoaded = true;
        checkReady();
      });
  });
  exportMap.whenReady(() => {
    checkReady();
  });

  function checkReady() {
    if (!tilesLoaded) return;
    setTimeout(() => {
      window
        .html2canvas(container, { width: widthPx, height: heightPx, useCORS: true, scale: 1 })
        .then((canvas) => {
          downloadCanvas(canvas, `${currentFileName}.png`);
          exportMap.remove();
          document.body.removeChild(container);
        })
        .catch((err) => {
          console.error('Export failed:', err);
          alert('Export failed. Try "Transparent Background" mode or reduce DPI.');
          exportMap.remove();
          document.body.removeChild(container);
        });
    }, 600);
  }
});

// ─── Export Video ─────────────────────────────────────────────────────────────

exportVideoBtn.addEventListener('click', async () => {
  if (!currentGeoJSON || !routeCoords.length) {
    alert('Upload a GPX file first.');
    return;
  }

  if (!window.MediaRecorder) {
    alert('MediaRecorder is not supported in this browser. Try Chrome or Edge.');
    return;
  }

  const widthCm = parseFloat(document.getElementById('width').value || 30);
  const heightCm = parseFloat(document.getElementById('height').value || 30);
  // Video output at 1080p-ish (cap to avoid memory issues)
  const videoW = Math.min(Math.round((widthCm / heightCm) * 1080), 1920);
  const videoH = Math.min(1080, Math.round((heightCm / widthCm) * videoW));

  const fitBounds = previewBox ? previewBox.getBounds() : getRouteBounds();
  const coords = routeCoords;
  const weight = parseFloat(routeWidthInput.value || 3);
  const useGrad = gradientEnabled.checked;
  const duration = getAnimDurationMs();
  const glowOn = glowEnabled.checked;
  const shadowOn = shadowEnabled.checked;
  const transparent = transparentBg.checked;

  const canvas = document.createElement('canvas');
  canvas.width = videoW;
  canvas.height = videoH;
  const ctx = canvas.getContext('2d');

  // Use proper Web Mercator projection so route aligns with map tiles
  const project = makeMercProjector(fitBounds, videoW, videoH);

  const vals = useGrad
    ? routeValues.length
      ? routeValues
      : coords.map((_, i) => i / (coords.length - 1))
    : null;

  // Record as WebM first, then convert to MP4
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  const stream = canvas.captureStream(60);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const webmBlob = new Blob(chunks, { type: mimeType });
    recIndicator.querySelector('.rec-label') &&
      (recIndicator.querySelector('.rec-label').textContent = 'Converting to MP4...');
    try {
      const mp4Blob = await convertWebmToMp4(webmBlob);
      const url = URL.createObjectURL(mp4Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'runink-animation.mp4';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('MP4 conversion failed, falling back to WebM:', err);
      const url = URL.createObjectURL(webmBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'runink-animation.webm';
      a.click();
      URL.revokeObjectURL(url);
    }
    recIndicator.style.display = 'none';
  };

  // Load background image if not transparent
  let bgImage = null;
  if (!transparent) {
    bgImage = await loadMapSnapshot(fitBounds, videoW, videoH);
  }

  recIndicator.style.display = 'flex';

  recorder.start();
  const startTime = performance.now();

  function renderFrame(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const endIdx = Math.floor(progress * coords.length);

    ctx.clearRect(0, 0, videoW, videoH);

    if (bgImage) {
      ctx.drawImage(bgImage, 0, 0, videoW, videoH);
    }

    // Shadow
    if (shadowOn) {
      const dx = parseFloat(shadowDxInput.value);
      const dy = parseFloat(shadowDyInput.value);
      const blur = parseFloat(shadowBlurInput.value);
      const col = shadowColorInput.value;
      const op = parseFloat(shadowOpacityInput.value);
      ctx.save();
      ctx.shadowOffsetX = dx;
      ctx.shadowOffsetY = dy;
      ctx.shadowBlur = blur;
      ctx.shadowColor = colorWithOpacity(col, op);
      drawSegments(ctx, coords, endIdx, weight, useGrad, vals);
      ctx.restore();
    }

    // Glow
    if (glowOn) {
      const blur = parseFloat(glowBlurInput.value);
      const spread = parseFloat(glowSpreadInput.value);
      const op = parseFloat(glowOpacityInput.value);
      const col = useGrad ? sampleGradient(0) : colorInput.value;
      ctx.save();
      ctx.shadowBlur = blur;
      ctx.shadowColor = colorWithOpacity(col, op);
      ctx.lineWidth = weight * spread;
      ctx.strokeStyle = colorWithOpacity(col, op * 0.4);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      coords.slice(0, endIdx).forEach(([lat, lng], i) => {
        const [px, py] = project(lat, lng);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }

    // Main route
    drawSegments(ctx, coords, endIdx, weight, useGrad, vals);

    if (progress < 1) {
      requestAnimationFrame(renderFrame);
    } else {
      setTimeout(() => recorder.stop(), 500);
    }
  }

  function drawSegments(ctx, coords, endIdx, weight, useGrad, vals) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (useGrad && vals) {
      for (let i = 0; i < endIdx - 1; i++) {
        const [px0, py0] = project(coords[i][0], coords[i][1]);
        const [px1, py1] = project(coords[i + 1][0], coords[i + 1][1]);
        ctx.beginPath();
        ctx.moveTo(px0, py0);
        ctx.lineTo(px1, py1);
        ctx.strokeStyle = sampleGradient(vals[i] ?? 0);
        ctx.lineWidth = weight;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      coords.slice(0, endIdx).forEach(([lat, lng], i) => {
        const [px, py] = project(lat, lng);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.strokeStyle = colorInput.value;
      ctx.lineWidth = weight;
      ctx.stroke();
    }
  }

  requestAnimationFrame(renderFrame);
});

// ─── WebM → MP4 conversion via ffmpeg.wasm ─────────────────────────────────

let _ffmpeg = null;
async function getFFmpeg() {
  if (_ffmpeg) return _ffmpeg;
  _ffmpeg = new FFmpeg();
  await _ffmpeg.load();
  return _ffmpeg;
}

async function convertWebmToMp4(webmBlob) {
  const ff = await getFFmpeg();
  const webmData = await fetchFile(webmBlob);
  await ff.writeFile('input.webm', webmData);
  await ff.exec([
    '-i',
    'input.webm',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    'output.mp4',
  ]);
  const mp4Data = await ff.readFile('output.mp4');
  await ff.deleteFile('input.webm');
  await ff.deleteFile('output.mp4');
  return new Blob([mp4Data.buffer], { type: 'video/mp4' });
}

// Load map tiles as an image for video background
async function loadMapSnapshot(bounds, w, h) {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    Object.assign(container.style, {
      width: `${w}px`,
      height: `${h}px`,
      position: 'absolute',
      left: '-9999px',
      top: '-9999px',
    });
    document.body.appendChild(container);

    const m = L.map(container, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    });
    const tl = L.tileLayer(styleSelect.value, { maxZoom: 19, crossOrigin: true }).addTo(m);
    m.fitBounds(bounds);
    m.invalidateSize();

    tl.on('load', () => {
      setTimeout(() => {
        window
          .html2canvas(container, { width: w, height: h, useCORS: true, scale: 1 })
          .then((c) => {
            m.remove();
            document.body.removeChild(container);
            resolve(c);
          })
          .catch(() => {
            m.remove();
            document.body.removeChild(container);
            resolve(null);
          });
      }, 400);
    });

    // Fallback timeout
    setTimeout(() => resolve(null), 5000);
  });
}

/**
 * Converts dimensions in specified unit (cm, in, pt, px) to target pixel dimensions based on DPI.
 *
 * @param {number} width - Input width in units
 * @param {number} height - Input height in units
 * @param {'cm'|'in'|'pt'|'px'} unit - Measurement unit
 * @param {number} dpi - Dots per inch resolution
 * @returns {{ widthPx: number, heightPx: number }} Calculated dimensions in pixels
 */
function toPixels(width, height, unit, dpi) {
  let widthPx, heightPx;
  switch (unit) {
    case 'cm':
      widthPx = Math.round((width / CM_PER_INCH) * dpi);
      heightPx = Math.round((height / CM_PER_INCH) * dpi);
      break;
    case 'in':
      widthPx = Math.round(width * dpi);
      heightPx = Math.round(height * dpi);
      break;
    case 'pt':
      widthPx = Math.round((width / POINTS_PER_INCH) * dpi);
      heightPx = Math.round((height / POINTS_PER_INCH) * dpi);
      break;
    case 'px':
    default:
      widthPx = Math.round(width);
      heightPx = Math.round(height);
  }
  return { widthPx, heightPx };
}

function getRouteBounds() {
  if (!routeCoords.length)
    return L.latLngBounds([
      [0, 0],
      [1, 1],
    ]);
  return L.latLngBounds(routeCoords);
}

function downloadCanvas(canvas, filename) {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

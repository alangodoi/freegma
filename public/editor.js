// =============================================================
// Freegma — standalone SVG editor (fully client-side, per-drawing size)
// =============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

// --- State ---
// drawings: { name: { svg: string, width: number, height: number } }
let drawings = {};
let currentId = null;
let currentW = 512;
let currentH = 512;
let selection = [];
const undoStack = [];
const redoStack = [];
let drag = null;
let pan = null;
let pendingShape = null; // { tag, button } while a draw-tool is armed
let selectedAnchor = null; // { el, cmdIdx, kind } — one dot on a path (or null)
let vbX = -50, vbY = -50, vbW = 612, vbH = 612;

// --- DOM refs ---
const svgCanvas    = document.getElementById('svgCanvas');
const canvasInner  = document.getElementById('canvasInner');
const iconList     = document.getElementById('iconList');
const elementList  = document.getElementById('elementList');
const propsPanel   = document.getElementById('propsPanel');
const drawColor    = document.getElementById('drawColor');
const drawColorHex = document.getElementById('drawColorHex');
const addShapeRow  = document.getElementById('floatingTools');

// Color applied to newly added shapes. Driven via the sidebar swatch button.
let newFillColor = (drawColor && drawColor.dataset.value) || '#888888';
function setNewFillColor(hex) {
  newFillColor = hex;
  if (drawColor) {
    drawColor.dataset.value = hex;
    drawColor.style.setProperty('--swatch-color', hex);
  }
  if (drawColorHex) drawColorHex.textContent = hex.toUpperCase();
}
setNewFillColor(newFillColor);
if (drawColor) {
  drawColor.addEventListener('click', () => {
    openColorPicker(drawColor, { value: newFillColor, onChange: setNewFillColor });
  });
}
const canvasWInp   = document.getElementById('canvasW');
const canvasHInp   = document.getElementById('canvasH');
const sizePresets  = document.getElementById('sizePresets');
const canvasBg     = document.getElementById('canvasBg');
const canvasBgNone = document.getElementById('canvasBgNone');

// --- Visible bounds rect (icon viewport) ---
const boundsRect = document.createElementNS(SVG_NS, 'rect');
boundsRect.setAttribute('x', '0');
boundsRect.setAttribute('y', '0');
boundsRect.setAttribute('fill', 'none');
boundsRect.setAttribute('stroke', 'rgba(255,120,150,0.35)');
boundsRect.setAttribute('stroke-width', '1');
boundsRect.setAttribute('stroke-dasharray', '8 4');
boundsRect.style.pointerEvents = 'none';
boundsRect.dataset.bounds = '1';

// --- Selection handles group ---
const handlesGroup = document.createElementNS(SVG_NS, 'g');
handlesGroup.dataset.handles = '1';
handlesGroup.style.pointerEvents = 'none';
handlesGroup.style.display = 'none';

const selRect = document.createElementNS(SVG_NS, 'rect');
selRect.setAttribute('fill', 'none');
selRect.setAttribute('stroke', '#ff7898');
selRect.setAttribute('stroke-width', '2');
selRect.setAttribute('stroke-dasharray', '6 3');
handlesGroup.appendChild(selRect);

const HANDLE_SIZE = 8;
const handleIds = ['nw','n','ne','e','se','s','sw','w'];
const handles = {};
for (const id of handleIds) {
  const h = document.createElementNS(SVG_NS, 'rect');
  h.setAttribute('width', HANDLE_SIZE);
  h.setAttribute('height', HANDLE_SIZE);
  h.setAttribute('fill', '#ff7898');
  h.setAttribute('stroke', '#fff');
  h.setAttribute('stroke-width', '1');
  h.style.pointerEvents = 'all';
  h.style.cursor = id === 'n' || id === 's' ? 'ns-resize'
                 : id === 'e' || id === 'w' ? 'ew-resize'
                 : id === 'nw' || id === 'se' ? 'nwse-resize' : 'nesw-resize';
  h.dataset.handle = id;
  handlesGroup.appendChild(h);
  handles[id] = h;
}

const rotLine = document.createElementNS(SVG_NS, 'line');
rotLine.setAttribute('stroke', '#ff7898');
rotLine.setAttribute('stroke-width', '1');
rotLine.setAttribute('stroke-dasharray', '3 2');
handlesGroup.appendChild(rotLine);

const rotHandle = document.createElementNS(SVG_NS, 'circle');
rotHandle.setAttribute('r', '6');
rotHandle.setAttribute('fill', '#44aaff');
rotHandle.setAttribute('stroke', '#fff');
rotHandle.setAttribute('stroke-width', '1');
rotHandle.style.pointerEvents = 'all';
rotHandle.style.cursor = 'grab';
rotHandle.dataset.handle = 'rotate';
handlesGroup.appendChild(rotHandle);

// --- Smart-guide overlay (Figma-style alignment guides during move) ---
const SNAP_THRESHOLD_PX = 6;
const guidesGroup = document.createElementNS(SVG_NS, 'g');
guidesGroup.dataset.guides = '1';
guidesGroup.style.pointerEvents = 'none';
guidesGroup.style.display = 'none';

// --- Marquee (drag-to-select) rectangle ---
const marqueeRect = document.createElementNS(SVG_NS, 'rect');
marqueeRect.dataset.marquee = '1';
marqueeRect.setAttribute('fill', 'rgba(255,120,150,0.12)');
marqueeRect.setAttribute('stroke', '#ff7898');
marqueeRect.setAttribute('stroke-width', '1');
marqueeRect.setAttribute('stroke-dasharray', '4 2');
marqueeRect.setAttribute('vector-effect', 'non-scaling-stroke');
marqueeRect.style.pointerEvents = 'none';
marqueeRect.style.display = 'none';

// --- Path anchor overlay (visual editor for free-form <path> elements) ---
const pathAnchorsGroup = document.createElementNS(SVG_NS, 'g');
pathAnchorsGroup.dataset.pathAnchors = '1';
pathAnchorsGroup.style.display = 'none';

// =============================================================
// SVG parsing helpers
// =============================================================

function extractSize(svgStr) {
  const tmp = document.createElement('div');
  tmp.innerHTML = svgStr;
  const s = tmp.querySelector('svg');
  if (!s) return { width: 512, height: 512 };
  const vb = s.getAttribute('viewBox');
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { width: p[2], height: p[3] };
  }
  const w = parseFloat(s.getAttribute('width')) || 512;
  const h = parseFloat(s.getAttribute('height')) || 512;
  return { width: w, height: h };
}

function sanitizeName(raw) {
  const n = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return n.match(/^[a-z_]/) ? n : '_' + n;
}

// =============================================================
// Rounded-rect path (per-corner radius, Figma-style)
// =============================================================
// A "rect-path" is a <path data-rect="1"> with data-x, data-y, data-w, data-h,
// data-tl, data-tr, data-br, data-bl. Plain <rect> is used when all four
// corners are equal; as soon as they differ, the element is converted to a
// rect-path so each corner can be controlled independently.

function roundedRectD(x, y, w, h, tl, tr, br, bl) {
  const max = Math.min(w, h) / 2;
  const clamp = (v) => Math.max(0, Math.min(v, max));
  tl = clamp(tl); tr = clamp(tr); br = clamp(br); bl = clamp(bl);
  const p = [];
  p.push(`M${x + tl},${y}`);
  p.push(`L${x + w - tr},${y}`);
  if (tr > 0) p.push(`A${tr},${tr} 0 0 1 ${x + w},${y + tr}`);
  p.push(`L${x + w},${y + h - br}`);
  if (br > 0) p.push(`A${br},${br} 0 0 1 ${x + w - br},${y + h}`);
  p.push(`L${x + bl},${y + h}`);
  if (bl > 0) p.push(`A${bl},${bl} 0 0 1 ${x},${y + h - bl}`);
  p.push(`L${x},${y + tl}`);
  if (tl > 0) p.push(`A${tl},${tl} 0 0 1 ${x + tl},${y}`);
  p.push('Z');
  return p.join(' ');
}

function renderRectPath(el) {
  const x = +el.dataset.x || 0;
  const y = +el.dataset.y || 0;
  const w = +el.dataset.w || 0;
  const h = +el.dataset.h || 0;
  const tl = +el.dataset.tl || 0;
  const tr = +el.dataset.tr || 0;
  const br = +el.dataset.br || 0;
  const bl = +el.dataset.bl || 0;
  el.setAttribute('d', roundedRectD(x, y, w, h, tl, tr, br, bl));
}

function isRectLike(el) {
  return el && (el.tagName === 'rect' || (el.tagName === 'path' && el.dataset && el.dataset.rect === '1'));
}

function getRectLike(el) {
  if (el.tagName === 'rect') {
    const r = +el.getAttribute('rx') || 0;
    return {
      x: +el.getAttribute('x') || 0,
      y: +el.getAttribute('y') || 0,
      w: +el.getAttribute('width') || 0,
      h: +el.getAttribute('height') || 0,
      tl: r, tr: r, br: r, bl: r,
    };
  }
  return {
    x: +el.dataset.x || 0,
    y: +el.dataset.y || 0,
    w: +el.dataset.w || 0,
    h: +el.dataset.h || 0,
    tl: +el.dataset.tl || 0,
    tr: +el.dataset.tr || 0,
    br: +el.dataset.br || 0,
    bl: +el.dataset.bl || 0,
  };
}

const RECT_PRESERVED_ATTRS = ['fill', 'stroke', 'stroke-width', 'opacity', 'transform'];

function rectToRectPath(rect, corners) {
  const path = document.createElementNS(SVG_NS, 'path');
  for (const a of RECT_PRESERVED_ATTRS) {
    const v = rect.getAttribute(a);
    if (v !== null) path.setAttribute(a, v);
  }
  path.dataset.rect = '1';
  path.dataset.x = corners.x;
  path.dataset.y = corners.y;
  path.dataset.w = corners.w;
  path.dataset.h = corners.h;
  path.dataset.tl = corners.tl;
  path.dataset.tr = corners.tr;
  path.dataset.br = corners.br;
  path.dataset.bl = corners.bl;
  renderRectPath(path);
  rect.parentNode.insertBefore(path, rect);
  rect.remove();
  return path;
}

function rectPathToRect(path) {
  const rect = document.createElementNS(SVG_NS, 'rect');
  for (const a of RECT_PRESERVED_ATTRS) {
    const v = path.getAttribute(a);
    if (v !== null) rect.setAttribute(a, v);
  }
  rect.setAttribute('x', path.dataset.x);
  rect.setAttribute('y', path.dataset.y);
  rect.setAttribute('width', path.dataset.w);
  rect.setAttribute('height', path.dataset.h);
  path.parentNode.insertBefore(rect, path);
  path.remove();
  return rect;
}

// Update a rect-like element with a patch; may swap the element type.
// Returns the (possibly new) element.
function setRectLike(el, patch) {
  const cur = getRectLike(el);
  const next = { ...cur, ...patch };
  const cornersEqual = next.tl === next.tr && next.tr === next.br && next.br === next.bl;

  if (el.tagName === 'rect') {
    if (cornersEqual) {
      el.setAttribute('x', next.x);
      el.setAttribute('y', next.y);
      el.setAttribute('width', next.w);
      el.setAttribute('height', next.h);
      if (next.tl > 0) el.setAttribute('rx', next.tl);
      else el.removeAttribute('rx');
      return el;
    }
    return rectToRectPath(el, next);
  }

  // rect-path
  el.dataset.x = next.x;
  el.dataset.y = next.y;
  el.dataset.w = next.w;
  el.dataset.h = next.h;
  el.dataset.tl = next.tl;
  el.dataset.tr = next.tr;
  el.dataset.br = next.br;
  el.dataset.bl = next.bl;
  if (cornersEqual && next.tl === 0) return rectPathToRect(el);
  renderRectPath(el);
  return el;
}

// =============================================================
// Arrow — a single <path data-arrow="1"> drawn as a closed polygon.
// Replaces the earlier <line marker-end> approach, which had rendering
// quirks (marker / stroke-cap interactions). Geometry lives in data-*
// attrs; the `d` is re-derived via renderArrowPath on every change.
// =============================================================

function isArrow(el) {
  return el && el.tagName === 'path' && el.dataset && el.dataset.arrow === '1';
}

function getArrow(el) {
  return {
    x1: parseFloat(el.dataset.x1) || 0,
    y1: parseFloat(el.dataset.y1) || 0,
    x2: parseFloat(el.dataset.x2) || 0,
    y2: parseFloat(el.dataset.y2) || 0,
    t:  parseFloat(el.dataset.thickness) || 2,
    hL: parseFloat(el.dataset.headLength) || 0,
    hW: parseFloat(el.dataset.headWidth)  || 0,
  };
}

function setArrow(el, patch) {
  const cur = getArrow(el);
  const next = { ...cur, ...patch };
  el.dataset.x1 = String(next.x1);
  el.dataset.y1 = String(next.y1);
  el.dataset.x2 = String(next.x2);
  el.dataset.y2 = String(next.y2);
  el.dataset.thickness  = String(next.t);
  el.dataset.headLength = String(next.hL);
  el.dataset.headWidth  = String(next.hW);
  renderArrowPath(el);
  return el;
}

function renderArrowPath(el) {
  const { x1, y1, x2, y2, t } = getArrow(el);
  let { hL, hW } = getArrow(el);
  const dx = x2 - x1, dy = y2 - y1;
  const L = Math.hypot(dx, dy) || 1;
  // Clamp head length so the body never inverts when the arrow is short.
  if (hL > L * 0.8) hL = L * 0.8;
  const ux = dx / L, uy = dy / L;
  const lx = -uy,    ly = ux; // perpendicular (counter-clockwise)
  const bx = x2 - ux * hL;
  const by = y2 - uy * hL;
  const t2 = t / 2;
  const h2 = Math.max(hW, t) / 2;
  const pts = [
    [x1 + lx * t2, y1 + ly * t2],
    [bx + lx * t2, by + ly * t2],
    [bx + lx * h2, by + ly * h2],
    [x2, y2],
    [bx - lx * h2, by - ly * h2],
    [bx - lx * t2, by - ly * t2],
    [x1 - lx * t2, y1 - ly * t2],
  ];
  const fmt = (n) => (Math.round(n * 100) / 100).toString();
  const d = 'M ' + pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L ') + ' Z';
  el.setAttribute('d', d);
}

// =============================================================
// Canvas size
// =============================================================

function applyBoundsRect() {
  boundsRect.setAttribute('width', currentW);
  boundsRect.setAttribute('height', currentH);
  const bg = getBgRect();
  if (bg) {
    bg.setAttribute('width',  String(currentW));
    bg.setAttribute('height', String(currentH));
  }
}

function getBgRect() {
  return svgCanvas.querySelector(':scope > [data-bg="1"]');
}

function setCanvasBg(color) {
  let r = getBgRect();
  if (!color && !r) return;
  pushUndo();
  if (!color) {
    r.remove();
    syncCanvasBgSwatch();
    persistCurrent();
    refreshIconList();
    return;
  }
  if (!r) {
    r = document.createElementNS(SVG_NS, 'rect');
    r.dataset.bg = '1';
    r.setAttribute('x', '0');
    r.setAttribute('y', '0');
    r.setAttribute('width',  String(currentW));
    r.setAttribute('height', String(currentH));
    r.style.pointerEvents = 'none';
    svgCanvas.insertBefore(r, svgCanvas.firstChild);
  } else if (svgCanvas.firstChild !== r) {
    svgCanvas.insertBefore(r, svgCanvas.firstChild);
  }
  r.setAttribute('fill', color);
  syncCanvasBgSwatch();
  persistCurrent();
  refreshIconList();
}

function syncCanvasBgSwatch() {
  if (!canvasBg) return;
  const r = getBgRect();
  const fill = r ? r.getAttribute('fill') : null;
  canvasBg.dataset.value = fill || '#ffffff';
  canvasBg.style.setProperty('--swatch-color', fill || 'transparent');
  canvasBg.classList.toggle('is-empty', !fill);
}

if (canvasBg) {
  canvasBg.addEventListener('click', () => {
    openColorPicker(canvasBg, {
      value: canvasBg.dataset.value || '#ffffff',
      onChange: setCanvasBg,
    });
  });
}
if (canvasBgNone) canvasBgNone.addEventListener('click', () => setCanvasBg(null));

function resetViewboxToFit() {
  const pad = Math.max(50, Math.round(Math.max(currentW, currentH) * 0.1));
  vbX = -pad; vbY = -pad;
  vbW = currentW + pad * 2;
  vbH = currentH + pad * 2;
  svgCanvas.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
}

// Parse a path's `d` attribute into a normalized array of absolute-coord
// segments. H/V are promoted to L; S/T are expanded to C/Q with the implicit
// reflected control point made explicit. A-commands are kept as-is (with all
// five numeric args plus the two endpoint coords). This canonical form lets
// the visual anchor editor read/write segments without re-parsing context.
function parsePathD(d) {
  const segs = [];
  if (!d) return segs;
  let cx = 0, cy = 0;
  let sx = 0, sy = 0;
  let prevCubicX2 = null, prevCubicY2 = null;
  let prevQuadX1 = null, prevQuadY1 = null;
  const stride = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const args = m[2];
    if (upper === 'Z') {
      segs.push({ cmd: 'Z' });
      cx = sx; cy = sy;
      prevCubicX2 = prevCubicY2 = null;
      prevQuadX1 = prevQuadY1 = null;
      continue;
    }
    const nums = (args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    const st = stride[upper];
    if (!st) continue;
    for (let i = 0; i < nums.length; i += st) {
      const c = nums.slice(i, i + st);
      // M followed by more coord pairs = implicit L (lineto)
      const eff = (upper === 'M' && i > 0) ? 'L' : upper;
      if (eff === 'M' || eff === 'L') {
        let x = c[0], y = c[1];
        if (rel) { x += cx; y += cy; }
        segs.push({ cmd: eff, x, y });
        if (eff === 'M') { sx = x; sy = y; }
        cx = x; cy = y;
        prevCubicX2 = prevCubicY2 = null;
        prevQuadX1 = prevQuadY1 = null;
      } else if (eff === 'H') {
        let x = c[0];
        if (rel) x += cx;
        segs.push({ cmd: 'L', x, y: cy });
        cx = x;
        prevCubicX2 = prevCubicY2 = null;
        prevQuadX1 = prevQuadY1 = null;
      } else if (eff === 'V') {
        let y = c[0];
        if (rel) y += cy;
        segs.push({ cmd: 'L', x: cx, y });
        cy = y;
        prevCubicX2 = prevCubicY2 = null;
        prevQuadX1 = prevQuadY1 = null;
      } else if (eff === 'C') {
        let [x1, y1, x2, y2, x, y] = c;
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        segs.push({ cmd: 'C', x1, y1, x2, y2, x, y });
        cx = x; cy = y;
        prevCubicX2 = x2; prevCubicY2 = y2;
        prevQuadX1 = prevQuadY1 = null;
      } else if (eff === 'S') {
        let [x2, y2, x, y] = c;
        if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
        const x1 = (prevCubicX2 !== null) ? 2 * cx - prevCubicX2 : cx;
        const y1 = (prevCubicY2 !== null) ? 2 * cy - prevCubicY2 : cy;
        segs.push({ cmd: 'C', x1, y1, x2, y2, x, y });
        cx = x; cy = y;
        prevCubicX2 = x2; prevCubicY2 = y2;
        prevQuadX1 = prevQuadY1 = null;
      } else if (eff === 'Q') {
        let [x1, y1, x, y] = c;
        if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
        segs.push({ cmd: 'Q', x1, y1, x, y });
        cx = x; cy = y;
        prevQuadX1 = x1; prevQuadY1 = y1;
        prevCubicX2 = prevCubicY2 = null;
      } else if (eff === 'T') {
        let [x, y] = c;
        if (rel) { x += cx; y += cy; }
        const x1 = (prevQuadX1 !== null) ? 2 * cx - prevQuadX1 : cx;
        const y1 = (prevQuadY1 !== null) ? 2 * cy - prevQuadY1 : cy;
        segs.push({ cmd: 'Q', x1, y1, x, y });
        cx = x; cy = y;
        prevQuadX1 = x1; prevQuadY1 = y1;
        prevCubicX2 = prevCubicY2 = null;
      } else if (eff === 'A') {
        let [rx, ry, rot, la, sw, x, y] = c;
        if (rel) { x += cx; y += cy; }
        segs.push({ cmd: 'A', rx, ry, rot, la, sw, x, y });
        cx = x; cy = y;
        prevCubicX2 = prevCubicY2 = null;
        prevQuadX1 = prevQuadY1 = null;
      }
    }
  }
  return segs;
}

function serializePathSegments(segs) {
  const fmt = (n) => String(Math.round(n * 1000) / 1000);
  const parts = [];
  for (const s of segs) {
    if (s.cmd === 'M') parts.push(`M${fmt(s.x)},${fmt(s.y)}`);
    else if (s.cmd === 'L') parts.push(`L${fmt(s.x)},${fmt(s.y)}`);
    else if (s.cmd === 'C') parts.push(`C${fmt(s.x1)},${fmt(s.y1)} ${fmt(s.x2)},${fmt(s.y2)} ${fmt(s.x)},${fmt(s.y)}`);
    else if (s.cmd === 'Q') parts.push(`Q${fmt(s.x1)},${fmt(s.y1)} ${fmt(s.x)},${fmt(s.y)}`);
    else if (s.cmd === 'A') parts.push(`A${fmt(s.rx)},${fmt(s.ry)} ${s.rot} ${s.la} ${s.sw} ${fmt(s.x)},${fmt(s.y)}`);
    else if (s.cmd === 'Z') parts.push('Z');
  }
  return parts.join(' ');
}

// --- Geometry helpers used by the path-anchor add/insert feature ---

function lerpPt(p, q, t) {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

function distToLineSeg(P, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: A.x + t * dx, y: A.y + t * dy };
  return { d: Math.hypot(P.x - proj.x, P.y - proj.y), t, point: proj };
}

function evalBezier(pts, t) {
  if (pts.length === 4) {
    const a = lerpPt(pts[0], pts[1], t);
    const b = lerpPt(pts[1], pts[2], t);
    const c = lerpPt(pts[2], pts[3], t);
    const d = lerpPt(a, b, t);
    const e = lerpPt(b, c, t);
    return lerpPt(d, e, t);
  }
  const a = lerpPt(pts[0], pts[1], t);
  const b = lerpPt(pts[1], pts[2], t);
  return lerpPt(a, b, t);
}

function distToBezier(P, pts, N = 30) {
  let best = { d: Infinity, t: 0 };
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const pt = evalBezier(pts, t);
    const d = Math.hypot(P.x - pt.x, P.y - pt.y);
    if (d < best.d) best = { d, t };
  }
  return best;
}

// Split a cubic C (P0, P1, P2, P3) at parameter t via De Casteljau.
// Returns { firstCtrls: [Q0, R0], mid: S, secondCtrls: [R1, Q2] }.
function splitCubic(P0, P1, P2, P3, t) {
  const Q0 = lerpPt(P0, P1, t);
  const Q1 = lerpPt(P1, P2, t);
  const Q2 = lerpPt(P2, P3, t);
  const R0 = lerpPt(Q0, Q1, t);
  const R1 = lerpPt(Q1, Q2, t);
  const S  = lerpPt(R0, R1, t);
  return { firstCtrls: [Q0, R0], mid: S, secondCtrls: [R1, Q2] };
}

// Split a quadratic Q (P0, P1, P2) at parameter t.
// Returns { firstCtrl: Q0, mid: S, secondCtrl: Q1 }.
function splitQuadratic(P0, P1, P2, t) {
  const Q0 = lerpPt(P0, P1, t);
  const Q1 = lerpPt(P1, P2, t);
  const S  = lerpPt(Q0, Q1, t);
  return { firstCtrl: Q0, mid: S, secondCtrl: Q1 };
}

// Insert a new anchor point on the nearest segment of `el`'s path.
// canvasX/canvasY are in SVG user coords (use svgPt for mouse events).
function addAnchorAt(el, canvasX, canvasY) {
  // Project to element-local coords via inverse of any transform.
  let lx = canvasX, ly = canvasY;
  const tl = el.transform.baseVal;
  if (tl && tl.numberOfItems > 0) {
    const c = tl.consolidate();
    if (c) {
      const inv = c.matrix.inverse();
      const pt = svgCanvas.createSVGPoint();
      pt.x = canvasX; pt.y = canvasY;
      const loc = pt.matrixTransform(inv);
      lx = loc.x; ly = loc.y;
    }
  }
  const P = { x: lx, y: ly };
  const segs = parsePathD(el.getAttribute('d') || '');
  if (segs.length === 0) return false;

  // Find nearest segment to P.
  let prev = null, sstart = { x: 0, y: 0 };
  let best = { idx: -1, d: Infinity, t: 0, kind: null };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.cmd === 'M') { sstart = { x: s.x, y: s.y }; prev = sstart; continue; }
    if (s.cmd === 'L' && prev) {
      const r = distToLineSeg(P, prev, { x: s.x, y: s.y });
      if (r.d < best.d) best = { idx: i, d: r.d, t: r.t, kind: 'L' };
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === 'C' && prev) {
      const pts = [prev, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }, { x: s.x, y: s.y }];
      const r = distToBezier(P, pts);
      if (r.d < best.d) best = { idx: i, d: r.d, t: r.t, kind: 'C' };
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === 'Q' && prev) {
      const pts = [prev, { x: s.x1, y: s.y1 }, { x: s.x, y: s.y }];
      const r = distToBezier(P, pts);
      if (r.d < best.d) best = { idx: i, d: r.d, t: r.t, kind: 'Q' };
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === 'Z' && prev) {
      const r = distToLineSeg(P, prev, sstart);
      if (r.d < best.d) best = { idx: i, d: r.d, t: r.t, kind: 'Z' };
      prev = { x: sstart.x, y: sstart.y };
    } else if (s.cmd === 'A' && prev) {
      // Out of scope — skip splitting arcs.
      prev = { x: s.x, y: s.y };
    }
  }

  const rect = svgCanvas.getBoundingClientRect();
  const threshold = rect.width > 0 ? 12 * vbW / rect.width : 12;
  if (best.idx < 0 || best.d > threshold) return false;

  // Build `prev` again up to best.idx so we can split geometry.
  prev = null; sstart = { x: 0, y: 0 };
  for (let i = 0; i < best.idx; i++) {
    const s = segs[i];
    if (s.cmd === 'M') { sstart = { x: s.x, y: s.y }; prev = sstart; }
    else if (s.cmd === 'L' || s.cmd === 'C' || s.cmd === 'Q' || s.cmd === 'A') prev = { x: s.x, y: s.y };
    else if (s.cmd === 'Z') prev = { x: sstart.x, y: sstart.y };
  }
  const seg = segs[best.idx];
  const t = best.t;
  let newCmdIdx = best.idx; // position of the inserted anchor in segs afterwards

  if (best.kind === 'L') {
    const split = lerpPt(prev, { x: seg.x, y: seg.y }, t);
    segs.splice(best.idx, 1,
      { cmd: 'L', x: split.x, y: split.y },
      { cmd: 'L', x: seg.x, y: seg.y }
    );
  } else if (best.kind === 'C') {
    const s = splitCubic(prev, { x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, { x: seg.x, y: seg.y }, t);
    segs.splice(best.idx, 1,
      { cmd: 'C', x1: s.firstCtrls[0].x, y1: s.firstCtrls[0].y, x2: s.firstCtrls[1].x, y2: s.firstCtrls[1].y, x: s.mid.x, y: s.mid.y },
      { cmd: 'C', x1: s.secondCtrls[0].x, y1: s.secondCtrls[0].y, x2: s.secondCtrls[1].x, y2: s.secondCtrls[1].y, x: seg.x, y: seg.y }
    );
  } else if (best.kind === 'Q') {
    const s = splitQuadratic(prev, { x: seg.x1, y: seg.y1 }, { x: seg.x, y: seg.y }, t);
    segs.splice(best.idx, 1,
      { cmd: 'Q', x1: s.firstCtrl.x, y1: s.firstCtrl.y, x: s.mid.x, y: s.mid.y },
      { cmd: 'Q', x1: s.secondCtrl.x, y1: s.secondCtrl.y, x: seg.x, y: seg.y }
    );
  } else if (best.kind === 'Z') {
    const split = lerpPt(prev, sstart, t);
    segs.splice(best.idx, 0, { cmd: 'L', x: split.x, y: split.y });
    // Z stays at best.idx + 1.
  } else {
    return false;
  }

  el.setAttribute('d', serializePathSegments(segs));
  // Select the newly inserted anchor's endpoint so the user can drag/delete immediately.
  selectedAnchor = { el, cmdIdx: newCmdIdx, kind: 'end' };
  return true;
}

// Remove a path anchor. `kind` is 'end' (splice the segment) or
// 'c1'/'c2'/'q1' (collapse the curve to a straight L, preserving the endpoint).
function removeAnchorAt(el, cmdIdx, kind) {
  const segs = parsePathD(el.getAttribute('d') || '');
  if (cmdIdx < 0 || cmdIdx >= segs.length) return false;
  const seg = segs[cmdIdx];

  if (kind === 'end') {
    if (seg.cmd === 'M' && cmdIdx === 0) return false;
    if (seg.cmd === 'Z') return false;
    const nonZ = segs.filter(s => s.cmd !== 'Z').length;
    if (nonZ <= 2) return false;
    segs.splice(cmdIdx, 1);
  } else if (kind === 'c1' || kind === 'c2' || kind === 'q1') {
    if (seg.cmd !== 'C' && seg.cmd !== 'Q') return false;
    segs[cmdIdx] = { cmd: 'L', x: seg.x, y: seg.y };
  } else {
    return false;
  }
  el.setAttribute('d', serializePathSegments(segs));
  return true;
}

// Scale every numeric coordinate in a path's `d` attribute.
function scalePathD(d, sx, sy) {
  return d.replace(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g, (_, cmd, args) => {
    if (cmd === 'Z' || cmd === 'z') return cmd;
    const nums = (args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    const out = [];
    const upper = cmd.toUpperCase();
    const stride = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 }[upper];
    for (let i = 0; i < nums.length; i += stride) {
      const c = nums.slice(i, i + stride);
      if (upper === 'H') out.push(c[0] * sx);
      else if (upper === 'V') out.push(c[0] * sy);
      else if (upper === 'A') out.push(c[0]*sx, c[1]*sy, c[2], c[3], c[4], c[5]*sx, c[6]*sy);
      else if (upper === 'C') out.push(c[0]*sx, c[1]*sy, c[2]*sx, c[3]*sy, c[4]*sx, c[5]*sy);
      else if (upper === 'S' || upper === 'Q') out.push(c[0]*sx, c[1]*sy, c[2]*sx, c[3]*sy);
      else out.push(c[0]*sx, c[1]*sy);
    }
    return cmd + (out.length ? ' ' + out.map(n => +n.toFixed(3)).join(',') : '');
  });
}

function scaleTransformAttr(tr, sx, sy) {
  return tr
    .replace(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g, (_, x, y) => `translate(${+x * sx},${+y * sy})`)
    .replace(/rotate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g, (_, a, cx, cy) => `rotate(${a},${+cx * sx},${+cy * sy})`);
}

function scaleElement(el, sx, sy) {
  const tag = el.tagName;
  const mul = (a, s) => String((parseFloat(el.getAttribute(a)) || 0) * s);
  const minS = Math.min(sx, sy);

  if (tag === 'rect') {
    el.setAttribute('x', mul('x', sx));
    el.setAttribute('y', mul('y', sy));
    el.setAttribute('width', mul('width', sx));
    el.setAttribute('height', mul('height', sy));
    if (el.hasAttribute('rx')) el.setAttribute('rx', mul('rx', minS));
  } else if (tag === 'circle') {
    el.setAttribute('cx', mul('cx', sx));
    el.setAttribute('cy', mul('cy', sy));
    el.setAttribute('r', mul('r', minS));
  } else if (tag === 'ellipse') {
    el.setAttribute('cx', mul('cx', sx));
    el.setAttribute('cy', mul('cy', sy));
    el.setAttribute('rx', mul('rx', sx));
    el.setAttribute('ry', mul('ry', sy));
  } else if (tag === 'line') {
    el.setAttribute('x1', mul('x1', sx));
    el.setAttribute('y1', mul('y1', sy));
    el.setAttribute('x2', mul('x2', sx));
    el.setAttribute('y2', mul('y2', sy));
  } else if (tag === 'image') {
    el.setAttribute('x', mul('x', sx));
    el.setAttribute('y', mul('y', sy));
    el.setAttribute('width',  mul('width',  sx));
    el.setAttribute('height', mul('height', sy));
  } else if (tag === 'text') {
    const newX = mul('x', sx);
    el.setAttribute('x', newX);
    el.setAttribute('y', mul('y', sy));
    for (const t of el.querySelectorAll(':scope > tspan')) t.setAttribute('x', newX);
    const fs = parseFloat(el.getAttribute('font-size'));
    if (fs && isFinite(fs)) el.setAttribute('font-size', String(fs * minS));
  } else if (tag === 'path') {
    if (el.dataset.rect === '1') {
      el.dataset.x = (+el.dataset.x || 0) * sx;
      el.dataset.y = (+el.dataset.y || 0) * sy;
      el.dataset.w = (+el.dataset.w || 0) * sx;
      el.dataset.h = (+el.dataset.h || 0) * sy;
      el.dataset.tl = (+el.dataset.tl || 0) * minS;
      el.dataset.tr = (+el.dataset.tr || 0) * minS;
      el.dataset.br = (+el.dataset.br || 0) * minS;
      el.dataset.bl = (+el.dataset.bl || 0) * minS;
      renderRectPath(el);
    } else {
      const d = el.getAttribute('d');
      if (d) el.setAttribute('d', scalePathD(d, sx, sy));
    }
  }

  const tr = el.getAttribute('transform');
  if (tr) el.setAttribute('transform', scaleTransformAttr(tr, sx, sy));

  const sw = parseFloat(el.getAttribute('stroke-width'));
  if (sw && isFinite(sw)) el.setAttribute('stroke-width', String(sw * minS));
}

// Scale the entire current drawing to fit new dimensions.
function scaleDrawing(newW, newH) {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  if (newW === currentW && newH === currentH) return;
  const sx = newW / currentW;
  const sy = newH / currentH;
  pushUndo();
  for (const el of Array.from(svgCanvas.children)) {
    if (el === boundsRect || el === handlesGroup) continue;
    scaleElement(el, sx, sy);
  }
  setCanvasSize(newW, newH);
  if (selection.length) { updateHandles(); refreshElementList(); if (selection.length === 1) populateProps(selection[0]); }
}

function setCanvasSize(w, h, { persist = true } = {}) {
  w = Math.max(1, Math.round(w || 1));
  h = Math.max(1, Math.round(h || 1));
  currentW = w; currentH = h;
  applyBoundsRect();
  canvasWInp.value = String(w);
  canvasHInp.value = String(h);
  if (persist && currentId && drawings[currentId]) {
    drawings[currentId].width = w;
    drawings[currentId].height = h;
    // Re-cache the svg markup so the sidebar preview updates with new viewBox
    drawings[currentId].svg = cleanClone().outerHTML;
    refreshIconList();
  }
}

// =============================================================
// Loading / Downloading
// =============================================================

async function loadAll() {
  if (loadFromLocalStorage()) {
    // Restore the saved session: load the last-open drawing, or the first
    // if the saved currentId is gone.
    const target = (currentId && drawings[currentId]) ? currentId : Object.keys(drawings).sort()[0];
    // loadDrawing short-circuits if id === currentId, so temporarily null the
    // module variable to force a full re-render.
    currentId = null;
    loadDrawing(target);
    refreshIconList();
    return;
  }
  try {
    const def = await fetch('/api/defaults').then(r => r.json());
    for (const [name, svg] of Object.entries(def)) {
      const { width, height } = extractSize(svg);
      drawings[name] = { svg, width, height };
    }
  } catch {}
  newDrawing();
  refreshIconList();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Google Fonts loaded by index.html. We embed an @import for the ones
// actually used in the drawing so exported SVGs render with the right
// font when opened in a browser — matching the "editable text + external
// font" pattern used by Figma / Adobe XD SVG exports.
const GOOGLE_FONTS = {
  'Inter':            [300, 400, 500, 600, 700, 900],
  'Roboto':           [300, 400, 500, 700, 900],
  'Poppins':          [300, 400, 500, 600, 700, 900],
  'Montserrat':       [300, 400, 500, 600, 700, 900],
  'DM Sans':          [400, 500, 700],
  'Oswald':           [300, 400, 500, 600, 700],
  'Playfair Display': [400, 500, 700, 900],
  'Lora':             [400, 500, 700],
  'Fira Code':        [400, 600],
  'Space Mono':       [400, 700],
};

function extractFirstFamily(family) {
  if (!family) return null;
  const m = family.match(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z][\w\s-]*?))(?:\s*,|\s*$)/);
  if (!m) return null;
  return (m[1] || m[2] || m[3]).trim();
}

function collectFontUsage(clone) {
  const usage = new Map();
  const texts = clone.querySelectorAll('text');
  for (const t of texts) {
    const family = extractFirstFamily(t.getAttribute('font-family'));
    if (!family || !GOOGLE_FONTS[family]) continue;
    const weightAttr = parseInt(t.getAttribute('font-weight'), 10);
    const w = GOOGLE_FONTS[family].includes(weightAttr) ? weightAttr : 400;
    if (!usage.has(family)) usage.set(family, new Set());
    usage.get(family).add(w);
  }
  return usage;
}

function buildGoogleFontsCssUrl(usage) {
  const families = [...usage.entries()]
    .map(([name, set]) => `family=${encodeURIComponent(name).replace(/%20/g, '+')}:wght@${[...set].sort((a,b)=>a-b).join(';')}`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

// Inline actual woff2 bytes as @font-face data URLs. Used for raster export,
// where SVG-in-img is sandboxed and can't fetch external resources.
async function buildInlineFontCss(usage) {
  if (usage.size === 0) return null;
  const cssUrl = buildGoogleFontsCssUrl(usage);
  let css;
  try {
    const resp = await fetch(cssUrl);
    if (!resp.ok) return null;
    css = await resp.text();
  } catch { return null; }
  const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/['"]/g, '')))]
    .filter(u => u.startsWith('https://fonts.gstatic.com'));
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const dataUrl = `data:font/woff2;base64,${btoa(bin)}`;
      css = css.split(u).join(dataUrl);
    } catch {}
  }
  return css;
}

async function embedInlineFontsInSvg(clone) {
  const usage = collectFontUsage(clone);
  const css = await buildInlineFontCss(usage);
  if (!css) return;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const style = document.createElementNS(SVG_NS, 'style');
  style.setAttribute('type', 'text/css');
  style.textContent = css;
  defs.appendChild(style);
  clone.insertBefore(defs, clone.firstChild);
}

function embedGoogleFontsInSvg(clone) {
  const usage = collectFontUsage(clone);
  if (usage.size === 0) return;
  const importUrl = buildGoogleFontsCssUrl(usage);
  const defs = document.createElementNS(SVG_NS, 'defs');
  const style = document.createElementNS(SVG_NS, 'style');
  style.setAttribute('type', 'text/css');
  style.textContent = `@import url('${importUrl}');`;
  defs.appendChild(style);
  clone.insertBefore(defs, clone.firstChild);
}

function exportSvg() {
  let name = currentId;
  if (!name) {
    name = sanitizeName(prompt('Filename (lowercase, letters/digits/_/-):', 'untitled') || '');
    if (!name) return;
  }
  const clone = cleanClone();
  embedGoogleFontsInSvg(clone);
  const svg = clone.outerHTML;
  drawings[name] = { svg, width: currentW, height: currentH };
  currentId = name;
  triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
  refreshIconList();
  flashButton('btnExport', 'SAVED!');
}

async function exportRaster(mime) {
  const name = currentId || sanitizeName(prompt('Filename (lowercase, letters/digits/_/-):', 'untitled') || '');
  if (!name) return;
  const clone = cleanClone();
  // SVG-in-img can't pull @import over the network, so inline each used
  // Google Font's woff2 as base64 @font-face data URLs. Falls back silently
  // if fetch fails (offline) — text then renders in the system fallback.
  await embedInlineFontsInSvg(clone);
  const svg = clone.outerHTML;
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('Failed to load SVG for rasterization'));
      img.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, currentW);
    canvas.height = Math.max(1, currentH);
    const ctx = canvas.getContext('2d');
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    await new Promise((res) => {
      const quality = mime === 'image/jpeg' ? 0.92
                    : mime === 'image/webp' ? 0.95
                    : undefined;
      canvas.toBlob((outBlob) => {
        if (!outBlob) { alert('Export failed — browser returned no image data.'); res(); return; }
        const ext = mime === 'image/png'  ? 'png'
                  : mime === 'image/webp' ? 'webp'
                  : 'jpg';
        triggerDownload(outBlob, `${name}.${ext}`);
        res();
      }, mime, quality);
    });
    flashButton('btnExport', 'SAVED!');
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

async function removeDrawing(name) {
  if (!drawings[name]) return;
  const ok = await showConfirm({
    title: 'Remove drawing',
    message: `Remove "${name}" from this session? This can't be undone.`,
    confirmText: 'Remove',
  });
  if (!ok) return;
  const wasCurrent = (currentId === name);
  delete drawings[name];
  if (wasCurrent) {
    currentId = null;
    const keys = Object.keys(drawings).sort();
    if (keys.length > 0) loadDrawing(keys[0]);
    else newDrawing();
  } else {
    refreshIconList();
  }
  scheduleSave();
}

function openRenameDialog(name) {
  if (!name || !drawings[name]) return;
  renameTargetName = name;
  renameCurrentNameEl.textContent = name;
  renameInput.value = name;
  renameError.style.display = 'none';
  renameError.textContent = '';
  renameDialog.classList.remove('hidden');
  // Defer focus until after the dialog is visible so selection sticks.
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 0);
}

function closeRenameDialog() {
  renameDialog.classList.add('hidden');
  renameTargetName = null;
}

function commitRename() {
  if (!renameTargetName || !drawings[renameTargetName]) { closeRenameDialog(); return; }
  const raw = renameInput.value;
  const n = sanitizeName(raw || '');
  if (!n) {
    renameError.textContent = 'Please enter a name.';
    renameError.style.display = '';
    return;
  }
  if (n === renameTargetName) { closeRenameDialog(); return; }
  if (drawings[n]) {
    renameError.textContent = `"${n}" is already taken.`;
    renameError.style.display = '';
    return;
  }
  drawings[n] = drawings[renameTargetName];
  delete drawings[renameTargetName];
  if (currentId === renameTargetName) currentId = n;
  scheduleSave();
  closeRenameDialog();
  refreshIconList();
}

function uniqueUntitledName() {
  for (let i = 1; ; i++) {
    const n = `untitled-${i}`;
    if (!drawings[n]) return n;
  }
}

function persistCurrent() {
  if (!currentId || !drawings[currentId]) return;
  drawings[currentId].svg = cleanClone().outerHTML;
  drawings[currentId].width = currentW;
  drawings[currentId].height = currentH;
  scheduleSave();
}

// --- Auto-save to localStorage ------------------------------------------
// All drawings and the current-active id are serialised to LS with a short
// debounce so edits survive a reload / tab-close. On boot, loadAll()
// restores from LS before falling back to the server icons.
const LS_KEY = 'freegma:workspace:v1';
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToLocalStorage, 400);
}
function saveToLocalStorage() {
  saveTimer = null;
  try {
    // Mirror the live canvas into drawings[currentId] before writing.
    if (currentId && drawings[currentId]) {
      drawings[currentId].svg = cleanClone().outerHTML;
      drawings[currentId].width = currentW;
      drawings[currentId].height = currentH;
    }
    const payload = { version: 1, currentId, drawings, savedAt: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch (e) {
    // Quota exceeded / private mode — warn once but keep the in-memory session alive.
    console.warn('[Freegma] auto-save failed:', e && e.message || e);
  }
}
// Flush any pending debounced save immediately so rapid tab-closes don't
// drop the latest edit.
window.addEventListener('beforeunload', () => {
  if (saveTimer) { clearTimeout(saveTimer); saveToLocalStorage(); }
});

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !data.drawings || typeof data.drawings !== 'object') return false;
    const keys = Object.keys(data.drawings);
    if (keys.length === 0) return false;
    drawings = {};
    for (const [name, d] of Object.entries(data.drawings)) {
      if (d && typeof d.svg === 'string') {
        drawings[name] = {
          svg: d.svg,
          width: Number(d.width) || 512,
          height: Number(d.height) || 512,
        };
      }
    }
    if (data.currentId && drawings[data.currentId]) currentId = data.currentId;
    return Object.keys(drawings).length > 0;
  } catch (e) {
    console.warn('[Freegma] auto-save restore failed:', e && e.message || e);
    return false;
  }
}

function newDrawing(width = 512, height = 512, name = null) {
  persistCurrent();
  selection = [];
  currentW = width;
  currentH = height;
  canvasWInp.value = String(width);
  canvasHInp.value = String(height);
  while (svgCanvas.firstChild) svgCanvas.removeChild(svgCanvas.firstChild);
  applyBoundsRect();
  svgCanvas.appendChild(boundsRect);
  svgCanvas.appendChild(guidesGroup);
  svgCanvas.appendChild(pathAnchorsGroup);
  svgCanvas.appendChild(marqueeRect);
  svgCanvas.appendChild(handlesGroup);
  handlesGroup.style.display = 'none';
  clearGuides();
  clearPathAnchors();
  resetViewboxToFit();
  currentId = name && !drawings[name] ? name : uniqueUntitledName();
  drawings[currentId] = { svg: cleanClone().outerHTML, width, height };
  refreshIconList();
  refreshElementList();
  propsPanel.innerHTML = '<div class="empty">Empty canvas — add shapes from the left</div>';
  scheduleSave();
}

function loadDrawing(id) {
  const d = drawings[id];
  if (!d) return;
  if (id === currentId) return;
  persistCurrent();
  currentId = id;
  selection = [];
  currentW = d.width || 512;
  currentH = d.height || 512;
  canvasWInp.value = String(currentW);
  canvasHInp.value = String(currentH);
  while (svgCanvas.firstChild) svgCanvas.removeChild(svgCanvas.firstChild);
  applyBoundsRect();
  const tmp = document.createElement('div');
  tmp.innerHTML = d.svg || '';
  const srcSvg = tmp.querySelector('svg');
  if (srcSvg) {
    for (const child of Array.from(srcSvg.children)) {
      svgCanvas.appendChild(child.cloneNode(true));
    }
  }
  svgCanvas.appendChild(boundsRect);
  svgCanvas.appendChild(guidesGroup);
  svgCanvas.appendChild(pathAnchorsGroup);
  svgCanvas.appendChild(marqueeRect);
  svgCanvas.appendChild(handlesGroup);
  handlesGroup.style.display = 'none';
  const bgOnLoad = getBgRect();
  if (bgOnLoad) bgOnLoad.style.pointerEvents = 'none';
  syncCanvasBgSwatch();
  clearGuides();
  clearPathAnchors();
  resetViewboxToFit();
  refreshIconList();
  refreshElementList();
  propsPanel.innerHTML = '<div class="empty">Select an element</div>';
  scheduleSave();
}

function cleanClone() {
  const clone = svgCanvas.cloneNode(true);
  clone.querySelectorAll('[data-bounds], [data-handles], [data-guides], [data-path-anchors], [data-marquee], [data-hidden]').forEach(e => e.remove());
  // data-locked is editor-only state; remove it without removing the element.
  clone.querySelectorAll('[data-locked]').forEach(e => e.removeAttribute('data-locked'));
  clone.setAttribute('viewBox', `0 0 ${currentW} ${currentH}`);
  clone.setAttribute('width', String(currentW));
  clone.setAttribute('height', String(currentH));
  clone.setAttribute('xmlns', SVG_NS);
  clone.removeAttribute('style');
  return clone;
}

function flashButton(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1200);
}

// =============================================================
// Icon list / Element list
// =============================================================

function refreshIconList() {
  iconList.innerHTML = '';
  const keys = Object.keys(drawings).sort();
  if (keys.length === 0) {
    iconList.innerHTML = '<div class="empty">No drawings — click “+ New”</div>';
    return;
  }
  for (const name of keys) {
    const d = drawings[name];
    const row = document.createElement('div');
    row.className = 'icon-item' + (name === currentId ? ' active' : '');
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.innerHTML = d.svg;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
    const dim = document.createElement('span'); dim.className = 'd'; dim.textContent = `${d.width}×${d.height}`;
    meta.appendChild(n); meta.appendChild(dim);
    row.appendChild(preview);
    row.appendChild(meta);
    row.tabIndex = 0;
    row.dataset.drawing = name;
    row.addEventListener('click', () => {
      loadDrawing(name);
      // loadDrawing may rebuild the list, leaving `row` detached — refocus the
      // fresh row so Delete has a live target.
      const live = iconList.querySelector(`.icon-item[data-drawing="${CSS.escape(name)}"]`);
      (live || row).focus();
    });
    row.addEventListener('dblclick', (e) => { e.preventDefault(); openRenameDialog(name); });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDrawingContextMenu(e, name);
    });
    iconList.appendChild(row);
  }
}

const expandedGroups = new WeakSet();
let draggedLayerEl = null;

function isAncestorOf(ancestor, node) {
  let n = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parentNode;
  }
  return false;
}

const LAYER_ICONS = {
  eyeOn:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><path d="M2 2l12 12"/></svg>',
  lockOn:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V4.5a3 3 0 0 1 6 0V7"/></svg>',
  lockOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V4.5a3 3 0 0 1 5.7-1.3"/></svg>',
  caretRight: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3.5 l5 4.5 l-5 4.5 z"/></svg>',
  caretDown:  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 6 l4.5 5 l4.5 -5 z"/></svg>',
};

function layerChildrenOf(parent) {
  const all = Array.from(parent.children);
  if (parent === svgCanvas) {
    return all.filter(c => {
      if (c === handlesGroup || c === boundsRect || c === marqueeRect) return false;
      if (c.dataset && (c.dataset.bg || c.dataset.guides || c.dataset.pathAnchors || c.dataset.marquee || c.dataset.freegmaGradients)) return false;
      if (c.tagName === 'defs') return false;
      return true;
    });
  }
  return all;
}

function buildLayerRow(el, depth, index, siblings, parent) {
  const fill = getPaint(el, 'fill') || getPaint(el, 'stroke') || '#888';
  const isSel = selection.includes(el);
  const isLocked = !!el.dataset.locked;
  const isHidden = !!el.dataset.hidden;
  const isGroup = el.tagName === 'g';
  const expanded = isGroup && expandedGroups.has(el);

  const row = document.createElement('div');
  row.className = 'elem-item' + (isSel ? ' active' : '') +
    (isLocked ? ' is-locked' : '') +
    (isHidden ? ' is-hidden' : '');
  row.draggable = true;
  row.style.paddingLeft = (4 + depth * 12) + 'px';

  // Disclosure triangle (groups only)
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'layer-caret' + (isGroup ? '' : ' is-leaf');
  if (isGroup) {
    caret.innerHTML = expanded ? LAYER_ICONS.caretDown : LAYER_ICONS.caretRight;
    caret.dataset.hint = expanded ? 'Collapse' : 'Expand';
    caret.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (expandedGroups.has(el)) expandedGroups.delete(el);
      else expandedGroups.add(el);
      refreshElementList();
    });
  }
  row.appendChild(caret);

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = fill === 'none' ? 'transparent' : fill;
  row.appendChild(dot);

  const lbl = document.createElement('span');
  lbl.className = 'elem-label';
  const label = isGroup ? `group · ${el.children.length}` : el.tagName;
  lbl.textContent = label;
  row.appendChild(lbl);

  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'layer-icon layer-eye' + (isHidden ? ' is-off' : '');
  eye.dataset.hint = isHidden ? 'Show' : 'Hide';
  eye.innerHTML = isHidden ? LAYER_ICONS.eyeOff : LAYER_ICONS.eyeOn;
  eye.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pushUndo();
    setElHidden(el, !isHidden);
    updateHandles();
    refreshElementList();
  });
  row.appendChild(eye);

  const lock = document.createElement('button');
  lock.type = 'button';
  lock.className = 'layer-icon layer-lock' + (isLocked ? ' is-on' : '');
  lock.dataset.hint = isLocked ? 'Unlock' : 'Lock';
  lock.innerHTML = isLocked ? LAYER_ICONS.lockOn : LAYER_ICONS.lockOff;
  lock.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pushUndo();
    setElLocked(el, !isLocked);
    refreshElementList();
  });
  row.appendChild(lock);

  row.addEventListener('click', (e) => {
    selectElement(el, e.ctrlKey || e.metaKey);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!selection.includes(el)) selectElement(el);
    openContextMenu(e, el);
  });

  // Drag-reorder across any depth. Drop zones on each row:
  //   - top third (or top half of leaf rows)       → before target (same parent)
  //   - middle third of a group row                → into target as last child
  //   - bottom third (or bottom half of leaf rows) → after target (same parent)
  row.addEventListener('dragstart', (ev) => {
    draggedLayerEl = el;
    ev.dataTransfer.effectAllowed = 'move';
    // Needed for the drop event to fire in Firefox.
    ev.dataTransfer.setData('text/plain', 'layer');
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => {
    draggedLayerEl = null;
    row.classList.remove('is-dragging', 'drop-before', 'drop-after', 'drop-into');
  });
  row.addEventListener('dragover', (ev) => {
    if (!draggedLayerEl) return;
    // Can't drop an element into itself or a descendant.
    if (draggedLayerEl === el || isAncestorOf(draggedLayerEl, el)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const box = row.getBoundingClientRect();
    const y = ev.clientY - box.top;
    const third = box.height / 3;
    let zone;
    if (isGroup) {
      if (y < third) zone = 'before';
      else if (y > box.height - third) zone = 'after';
      else zone = 'into';
    } else {
      zone = y < box.height / 2 ? 'before' : 'after';
    }
    row.classList.toggle('drop-before', zone === 'before');
    row.classList.toggle('drop-after',  zone === 'after');
    row.classList.toggle('drop-into',   zone === 'into');
  });
  row.addEventListener('dragleave', (ev) => {
    if (!row.contains(ev.relatedTarget)) row.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const zone = row.classList.contains('drop-into') ? 'into'
               : row.classList.contains('drop-before') ? 'before'
               : 'after';
    row.classList.remove('drop-before', 'drop-after', 'drop-into');
    if (!draggedLayerEl || draggedLayerEl === el || isAncestorOf(draggedLayerEl, el)) return;
    pushUndo();
    if (zone === 'into' && isGroup) {
      el.appendChild(draggedLayerEl);
    } else if (zone === 'before') {
      el.parentNode.insertBefore(draggedLayerEl, el);
    } else {
      el.parentNode.insertBefore(draggedLayerEl, el.nextSibling);
    }
    // After reshuffling, children that moved under a group can leave the group
    // empty; collapse such empties aren't auto-removed to keep scope small.
    refreshElementList();
    updateHandles();
  });

  elementList.appendChild(row);

  // Recurse into expanded groups.
  if (isGroup && expanded) {
    const childList = layerChildrenOf(el);
    childList.forEach((child, ci) => {
      buildLayerRow(child, depth + 1, ci, childList, el);
    });
  }
}

function refreshElementList() {
  elementList.innerHTML = '';
  const els = layerChildrenOf(svgCanvas);
  if (els.length === 0) {
    elementList.innerHTML = '<div class="empty">No shapes yet</div>';
    return;
  }
  els.forEach((el, i) => {
    buildLayerRow(el, 0, i, els, svgCanvas);
  });
}

// =============================================================
// Selection + handles
// =============================================================

function selectElement(el, addToSelection = false) {
  if (addToSelection) {
    const idx = selection.indexOf(el);
    if (idx >= 0) selection.splice(idx, 1);
    else selection.push(el);
  } else {
    selection = [el];
  }
  if (selectedAnchor && !selection.includes(selectedAnchor.el)) selectedAnchor = null;
  updateHandles();
  handlesGroup.style.display = selection.length ? '' : 'none';
  refreshElementList();
  if (selection.length === 1) populateProps(selection[0]);
  else if (selection.length > 1) {
    renderMultiSelectProps(selection.length);
  } else {
    propsPanel.innerHTML = '<div class="empty">Select an element</div>';
  }
  renderPathAnchors(selection.length === 1 ? selection[0] : null);
}

function alignSelection(kind) {
  if (selection.length < 2) return;
  const boxes = selection.map(el => ({ el, bb: bboxInCanvas(el) }));
  const minX = Math.min(...boxes.map(b => b.bb.x));
  const maxX = Math.max(...boxes.map(b => b.bb.x + b.bb.width));
  const minY = Math.min(...boxes.map(b => b.bb.y));
  const maxY = Math.max(...boxes.map(b => b.bb.y + b.bb.height));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  pushUndo();
  for (const { el, bb } of boxes) {
    let dx = 0, dy = 0;
    if (kind === 'left')    dx = minX - bb.x;
    if (kind === 'right')   dx = maxX - (bb.x + bb.width);
    if (kind === 'hcenter') dx = cx - (bb.x + bb.width / 2);
    if (kind === 'top')     dy = minY - bb.y;
    if (kind === 'bottom')  dy = maxY - (bb.y + bb.height);
    if (kind === 'vmiddle') dy = cy - (bb.y + bb.height / 2);
    if (dx || dy) moveElement(el, dx, dy);
  }
  updateHandles();
  refreshElementList();
}

function distributeSelection(axis) {
  if (selection.length < 3) return;
  const boxes = selection.map(el => ({ el, bb: bboxInCanvas(el) }));
  if (axis === 'h') boxes.sort((a, b) => a.bb.x - b.bb.x);
  else              boxes.sort((a, b) => a.bb.y - b.bb.y);
  const first = boxes[0], last = boxes[boxes.length - 1];
  let totalSize, span;
  if (axis === 'h') {
    totalSize = boxes.reduce((s, b) => s + b.bb.width, 0);
    span = (last.bb.x + last.bb.width) - first.bb.x;
  } else {
    totalSize = boxes.reduce((s, b) => s + b.bb.height, 0);
    span = (last.bb.y + last.bb.height) - first.bb.y;
  }
  if (span <= totalSize) return; // overlapping — nothing to distribute
  const gap = (span - totalSize) / (boxes.length - 1);
  pushUndo();
  let cursor = axis === 'h'
    ? first.bb.x + first.bb.width + gap
    : first.bb.y + first.bb.height + gap;
  for (let i = 1; i < boxes.length - 1; i++) {
    const b = boxes[i];
    if (axis === 'h') {
      const dx = cursor - b.bb.x;
      if (dx) moveElement(b.el, dx, 0);
      cursor += b.bb.width + gap;
    } else {
      const dy = cursor - b.bb.y;
      if (dy) moveElement(b.el, 0, dy);
      cursor += b.bb.height + gap;
    }
  }
  updateHandles();
  refreshElementList();
}

function renderMultiSelectProps(count) {
  propsPanel.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'empty';
  header.textContent = `${count} elements selected`;
  propsPanel.appendChild(header);
  const grid = document.createElement('div');
  grid.className = 'align-grid';
  const btn = (hint, icon, onClick, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'align-btn';
    b.dataset.hint = hint;
    b.innerHTML = icon;
    if (disabled) { b.disabled = true; b.classList.add('is-disabled'); }
    else b.addEventListener('click', onClick);
    grid.appendChild(b);
    return b;
  };
  // 16x16 icons — currentColor lines + thin rects representing shapes
  const ICONS = {
    left:    '<svg viewBox="0 0 16 16"><line x1="1.5" y1="2" x2="1.5" y2="14" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3.5" width="10" height="2.5" fill="currentColor"/><rect x="3" y="9" width="7" height="2.5" fill="currentColor"/></svg>',
    hcenter: '<svg viewBox="0 0 16 16"><line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3.5" width="10" height="2.5" fill="currentColor"/><rect x="4.5" y="9" width="7" height="2.5" fill="currentColor"/></svg>',
    right:   '<svg viewBox="0 0 16 16"><line x1="14.5" y1="2" x2="14.5" y2="14" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3.5" width="10" height="2.5" fill="currentColor"/><rect x="6" y="9" width="7" height="2.5" fill="currentColor"/></svg>',
    top:     '<svg viewBox="0 0 16 16"><line x1="2" y1="1.5" x2="14" y2="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="3" width="2.5" height="10" fill="currentColor"/><rect x="9" y="3" width="2.5" height="7" fill="currentColor"/></svg>',
    vmiddle: '<svg viewBox="0 0 16 16"><line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="3" width="2.5" height="10" fill="currentColor"/><rect x="9" y="4.5" width="2.5" height="7" fill="currentColor"/></svg>',
    bottom:  '<svg viewBox="0 0 16 16"><line x1="2" y1="14.5" x2="14" y2="14.5" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="3" width="2.5" height="10" fill="currentColor"/><rect x="9" y="6" width="2.5" height="7" fill="currentColor"/></svg>',
    distH:   '<svg viewBox="0 0 16 16"><rect x="1" y="3.5" width="3" height="9" fill="currentColor"/><rect x="6.5" y="3.5" width="3" height="9" fill="currentColor"/><rect x="12" y="3.5" width="3" height="9" fill="currentColor"/></svg>',
    distV:   '<svg viewBox="0 0 16 16"><rect x="3.5" y="1" width="9" height="3" fill="currentColor"/><rect x="3.5" y="6.5" width="9" height="3" fill="currentColor"/><rect x="3.5" y="12" width="9" height="3" fill="currentColor"/></svg>',
  };
  btn('Align left edges',           ICONS.left,    () => alignSelection('left'));
  btn('Align horizontal centers',    ICONS.hcenter, () => alignSelection('hcenter'));
  btn('Align right edges',          ICONS.right,   () => alignSelection('right'));
  btn('Distribute horizontally (equal gaps)', ICONS.distH, () => distributeSelection('h'), count < 3);
  btn('Align top edges',            ICONS.top,     () => alignSelection('top'));
  btn('Align vertical centers',      ICONS.vmiddle, () => alignSelection('vmiddle'));
  btn('Align bottom edges',         ICONS.bottom,  () => alignSelection('bottom'));
  btn('Distribute vertically (equal gaps)',   ICONS.distV, () => distributeSelection('v'), count < 3);
  propsPanel.appendChild(grid);
}

function clearSelection() {
  selection = [];
  selectedAnchor = null;
  handlesGroup.style.display = 'none';
  refreshElementList();
  propsPanel.innerHTML = '<div class="empty">Select an element</div>';
  clearPathAnchors();
}

// Replace an element in the selection array after it's been swapped in the DOM.
function swapSelected(oldEl, newEl) {
  const idx = selection.indexOf(oldEl);
  if (idx >= 0) selection[idx] = newEl;
  updateHandles();
  refreshElementList();
}

// BBox of an element in svgCanvas user-space. getBBox() returns the local,
// pre-transform bbox; if the element has its own `transform` attribute we push
// the 4 corners through that transform's consolidated matrix. Shapes are
// direct children of svgCanvas so no ancestor transforms apply. We avoid
// getCTM() because browsers disagree on whether it folds in the outer SVG's
// viewBox transformation.
function bboxInCanvas(el) {
  const bb = el.getBBox();
  if (!el.getAttribute('transform')) return bb;
  let m;
  try {
    const consolidated = el.transform.baseVal.consolidate();
    if (!consolidated) return bb;
    m = consolidated.matrix;
  } catch { return bb; }
  const pt = svgCanvas.createSVGPoint();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const corners = [
    [bb.x,            bb.y],
    [bb.x + bb.width, bb.y],
    [bb.x + bb.width, bb.y + bb.height],
    [bb.x,            bb.y + bb.height],
  ];
  for (const [x, y] of corners) {
    pt.x = x; pt.y = y;
    const t = pt.matrixTransform(m);
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function updateHandles() {
  if (selection.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of selection) {
    const b = bboxInCanvas(s);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  const pad = 6;
  const bx = minX - pad, by = minY - pad;
  const bw = (maxX - minX) + pad * 2, bh = (maxY - minY) + pad * 2;
  selRect.setAttribute('x', bx);
  selRect.setAttribute('y', by);
  selRect.setAttribute('width', bw);
  selRect.setAttribute('height', bh);
  const hs = HANDLE_SIZE;
  const pos = {
    nw: [bx - hs/2, by - hs/2],
    n:  [bx + bw/2 - hs/2, by - hs/2],
    ne: [bx + bw - hs/2, by - hs/2],
    e:  [bx + bw - hs/2, by + bh/2 - hs/2],
    se: [bx + bw - hs/2, by + bh - hs/2],
    s:  [bx + bw/2 - hs/2, by + bh - hs/2],
    sw: [bx - hs/2, by + bh - hs/2],
    w:  [bx - hs/2, by + bh/2 - hs/2],
  };
  for (const [id, [hx, hy]] of Object.entries(pos)) {
    handles[id].setAttribute('x', hx);
    handles[id].setAttribute('y', hy);
  }
  const rcx = bx + bw / 2, rcy = by - 30;
  rotHandle.setAttribute('cx', rcx);
  rotHandle.setAttribute('cy', rcy);
  rotLine.setAttribute('x1', rcx);
  rotLine.setAttribute('y1', by);
  rotLine.setAttribute('x2', rcx);
  rotLine.setAttribute('y2', rcy);
}

// =============================================================
// Smart alignment guides (only active during move-drag)
// =============================================================

function toBoxKeys(b) {
  return {
    left: b.x, right: b.x + b.width, cx: b.x + b.width / 2,
    top: b.y, bottom: b.y + b.height, cy: b.y + b.height / 2,
  };
}

function unionSelectionBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of selection) {
    const b = bboxInCanvas(s);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return toBoxKeys({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

function collectGuideRefs() {
  const refs = [Object.assign(
    { left: 0, right: currentW, cx: currentW / 2, top: 0, bottom: currentH, cy: currentH / 2 },
    { id: 'canvas' },
  )];
  const selSet = new Set(selection);
  let i = 0;
  for (const child of svgCanvas.children) {
    if (child.dataset && (child.dataset.bounds || child.dataset.handles || child.dataset.guides || child.dataset.marquee || child.dataset.pathAnchors || child.dataset.bg || child.dataset.hidden)) continue;
    if (selSet.has(child)) continue;
    const b = bboxInCanvas(child);
    if (!isFinite(b.width) || !isFinite(b.height)) continue;
    refs.push(Object.assign(toBoxKeys(b), { id: `child-${i++}` }));
  }
  return refs;
}

function computeSnap(hypo) {
  const refs = collectGuideRefs();
  const rect = svgCanvas.getBoundingClientRect();
  const threshold = rect.width > 0 ? SNAP_THRESHOLD_PX * vbW / rect.width : SNAP_THRESHOLD_PX;
  const xKeys = ['left', 'cx', 'right'];
  const yKeys = ['top', 'cy', 'bottom'];
  let snapDx = 0, snapDy = 0, bestX = Infinity, bestY = Infinity;
  for (const ref of refs) {
    for (const sk of xKeys) for (const rk of xKeys) {
      const d = ref[rk] - hypo[sk];
      const ad = Math.abs(d);
      if (ad < threshold && ad < bestX) { bestX = ad; snapDx = d; }
    }
    for (const sk of yKeys) for (const rk of yKeys) {
      const d = ref[rk] - hypo[sk];
      const ad = Math.abs(d);
      if (ad < threshold && ad < bestY) { bestY = ad; snapDy = d; }
    }
  }
  const snapped = {
    left: hypo.left + snapDx, right: hypo.right + snapDx, cx: hypo.cx + snapDx,
    top: hypo.top + snapDy, bottom: hypo.bottom + snapDy, cy: hypo.cy + snapDy,
  };
  const eps = Math.max(0.01, threshold * 0.01);
  const vGuides = [], hGuides = [];
  for (const ref of refs) {
    for (const sk of xKeys) for (const rk of xKeys) {
      if (Math.abs(snapped[sk] - ref[rk]) < eps) vGuides.push(buildVGuide(ref[rk], snapped, ref));
    }
    for (const sk of yKeys) for (const rk of yKeys) {
      if (Math.abs(snapped[sk] - ref[rk]) < eps) hGuides.push(buildHGuide(ref[rk], snapped, ref));
    }
  }
  const filteredV = keepNearestPerSide(vGuides, 'x');
  const filteredH = keepNearestPerSide(hGuides, 'y');
  const chainedV = collectChainedEqualGuides(filteredV, refs, 'v');
  const chainedH = collectChainedEqualGuides(filteredH, refs, 'h');
  return {
    snapDx, snapDy,
    vGuides: [...filteredV, ...chainedV],
    hGuides: [...filteredH, ...chainedH],
  };
}

// Build a vertical-line guide from a shared X between two boxes. Also
// compute the perpendicular (Y-axis) edge-to-edge gap between the boxes
// and the position for a distance label — null when they overlap vertically.
function buildVGuide(x, snapped, ref) {
  const y1 = Math.min(snapped.top, ref.top);
  const y2 = Math.max(snapped.bottom, ref.bottom);
  let distance = null, labelY = null, direction = null;
  if (snapped.bottom < ref.top) {
    distance = ref.top - snapped.bottom;
    labelY = (snapped.bottom + ref.top) / 2;
    direction = 'after';  // ref is below snapped
  } else if (ref.bottom < snapped.top) {
    distance = snapped.top - ref.bottom;
    labelY = (ref.bottom + snapped.top) / 2;
    direction = 'before'; // ref is above snapped
  }
  return { x, y1, y2, labelX: x, labelY, distance, direction, refId: ref.id };
}

// Drop hGuides whose gap spans over a nearer aligned ref on the same side.
// E.g., when dragging the rightmost of three shapes, we keep the gap to the
// middle shape and drop the "through-the-middle" gap to the leftmost one.
// Chain guides (ref↔ref) are left alone.
function keepNearestPerSide(guides, perpKey) {
  const nearest = new Map();
  const other = [];
  const chainOrNull = [];
  for (const g of guides) {
    if (g.distance == null || !g.direction) { chainOrNull.push(g); continue; }
    if (g.refId && String(g.refId).startsWith('chain-')) { other.push(g); continue; }
    const k = `${Math.round(g[perpKey] * 100)}|${g.direction}`;
    const prev = nearest.get(k);
    if (!prev || g.distance < prev.distance) nearest.set(k, g);
  }
  return [...chainOrNull, ...other, ...nearest.values()];
}

// When the dragging shape's gap to one ref matches the gap between two OTHER
// refs on the same alignment line, emit extra guide entries for those ref-ref
// gaps. markEqualSpacing later tags them (and the original) as equal so they
// all render in the equal-distance style.
function collectChainedEqualGuides(existing, refs, kind) {
  const extras = [];
  const ALIGN_EPS = 1;   // how close "aligned on the same line" means
  const MATCH_EPS = 0.5; // how close two gaps must be to count as the same
  for (const g of existing) {
    if (g.distance == null) continue;
    if (kind === 'h') {
      const sharedY = g.y;
      const aligned = refs.filter(r =>
        Math.abs(r.top - sharedY) < ALIGN_EPS ||
        Math.abs(r.cy  - sharedY) < ALIGN_EPS ||
        Math.abs(r.bottom - sharedY) < ALIGN_EPS,
      );
      aligned.sort((a, b) => a.left - b.left);
      for (let i = 0; i < aligned.length - 1; i++) {
        const a = aligned[i], b = aligned[i + 1];
        const gap = b.left - a.right;
        if (gap > 0.5 && Math.abs(gap - g.distance) < MATCH_EPS) {
          extras.push({
            y: sharedY,
            x1: a.right, x2: b.left,
            labelX: (a.right + b.left) / 2,
            labelY: sharedY,
            distance: gap,
            refId: `chain-${a.id}|${b.id}`,
            equal: true,
          });
          g.equal = true;
        }
      }
    } else {
      const sharedX = g.x;
      const aligned = refs.filter(r =>
        Math.abs(r.left - sharedX) < ALIGN_EPS ||
        Math.abs(r.cx   - sharedX) < ALIGN_EPS ||
        Math.abs(r.right - sharedX) < ALIGN_EPS,
      );
      aligned.sort((a, b) => a.top - b.top);
      for (let i = 0; i < aligned.length - 1; i++) {
        const a = aligned[i], b = aligned[i + 1];
        const gap = b.top - a.bottom;
        if (gap > 0.5 && Math.abs(gap - g.distance) < MATCH_EPS) {
          extras.push({
            x: sharedX,
            y1: a.bottom, y2: b.top,
            labelX: sharedX,
            labelY: (a.bottom + b.top) / 2,
            distance: gap,
            refId: `chain-${a.id}|${b.id}`,
            equal: true,
          });
          g.equal = true;
        }
      }
    }
  }
  return extras;
}

function buildHGuide(y, snapped, ref) {
  const x1 = Math.min(snapped.left, ref.left);
  const x2 = Math.max(snapped.right, ref.right);
  let distance = null, labelX = null, direction = null;
  if (snapped.right < ref.left) {
    distance = ref.left - snapped.right;
    labelX = (snapped.right + ref.left) / 2;
    direction = 'after';  // ref is to the right of snapped
  } else if (ref.right < snapped.left) {
    distance = snapped.left - ref.right;
    labelX = (ref.right + snapped.left) / 2;
    direction = 'before'; // ref is to the left of snapped
  }
  return { y, x1, x2, labelX, labelY: y, distance, direction, refId: ref.id };
}

// Resize-time alignment snap. Only the edges implied by the handle move,
// so we snap just those to ref boxes and build matching guide lines.
// Supports primitive rect/ellipse + rect-like paths (path[data-rect="1"]);
// skips tags whose resize semantics don't map cleanly to per-edge deltas
// (circle's radius-based resize, transform-based generic fallback).
function computeResizeSnap(el, handle) {
  const tag = el.tagName;
  const isRectPath = tag === 'path' && el.dataset.rect === '1';
  if (!isRectPath && tag !== 'rect' && tag !== 'ellipse') {
    return { snapDx: 0, snapDy: 0, vGuides: [], hGuides: [] };
  }
  const bb = bboxInCanvas(el);
  const keys = toBoxKeys(bb);
  const movingX = handle.includes('e') ? 'right' : handle.includes('w') ? 'left' : null;
  const movingY = handle.includes('s') ? 'bottom' : handle.includes('n') ? 'top'  : null;
  const refs = collectGuideRefs();
  const rect = svgCanvas.getBoundingClientRect();
  const threshold = rect.width > 0 ? SNAP_THRESHOLD_PX * vbW / rect.width : SNAP_THRESHOLD_PX;
  const xKeys = ['left', 'cx', 'right'];
  const yKeys = ['top', 'cy', 'bottom'];
  let snapDx = 0, snapDy = 0, bestX = Infinity, bestY = Infinity;
  if (movingX) {
    for (const ref of refs) for (const rk of xKeys) {
      const d = ref[rk] - keys[movingX];
      const ad = Math.abs(d);
      if (ad < threshold && ad < bestX) { bestX = ad; snapDx = d; }
    }
  }
  if (movingY) {
    for (const ref of refs) for (const rk of yKeys) {
      const d = ref[rk] - keys[movingY];
      const ad = Math.abs(d);
      if (ad < threshold && ad < bestY) { bestY = ad; snapDy = d; }
    }
  }
  const snappedLeft   = movingX === 'left'   ? keys.left   + snapDx : keys.left;
  const snappedRight  = movingX === 'right'  ? keys.right  + snapDx : keys.right;
  const snappedTop    = movingY === 'top'    ? keys.top    + snapDy : keys.top;
  const snappedBottom = movingY === 'bottom' ? keys.bottom + snapDy : keys.bottom;
  const snapped = {
    left: snappedLeft, right: snappedRight, cx: (snappedLeft + snappedRight) / 2,
    top:  snappedTop,  bottom: snappedBottom, cy: (snappedTop + snappedBottom) / 2,
  };
  const eps = Math.max(0.01, threshold * 0.01);
  const vGuides = [], hGuides = [];
  for (const ref of refs) {
    if (movingX) {
      for (const rk of xKeys) if (Math.abs(snapped[movingX] - ref[rk]) < eps) {
        vGuides.push(buildVGuide(ref[rk], snapped, ref));
      }
    }
    if (movingY) {
      for (const rk of yKeys) if (Math.abs(snapped[movingY] - ref[rk]) < eps) {
        hGuides.push(buildHGuide(ref[rk], snapped, ref));
      }
    }
  }
  const filteredV = keepNearestPerSide(vGuides, 'x');
  const filteredH = keepNearestPerSide(hGuides, 'y');
  const chainedV = collectChainedEqualGuides(filteredV, refs, 'v');
  const chainedH = collectChainedEqualGuides(filteredH, refs, 'h');
  return {
    snapDx, snapDy,
    vGuides: [...filteredV, ...chainedV],
    hGuides: [...filteredH, ...chainedH],
  };
}

// When the dragged shape aligns with a ref along several edges (e.g. same
// width -> left, center, and right all match), we end up with parallel
// labels all showing the same gap. Keep just the middle one so the user
// sees one clear distance per ref pair per perpendicular gap.
function collapseSiblingLabels(guides, perpKey) {
  const groups = new Map();
  for (const g of guides) {
    if (g.distance == null || g.refId == null) continue;
    const key = `${g.refId}|${Math.round(g[perpKey] * 100)}|${Math.round(g.distance * 100)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const hideLabel = new Set();
  const otherKey = perpKey === 'labelY' ? 'labelX' : 'labelY';
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a[otherKey] - b[otherKey]);
    const keep = group[Math.floor(group.length / 2)];
    for (const g of group) if (g !== keep) hideLabel.add(g);
  }
  return hideLabel;
}

// Tag guides whose gap distance is equal across refs on the same axis so
// renderGuides can draw them in a distinct "equal-spacing" style.
function markEqualSpacing(guides) {
  const byDist = new Map();
  for (const g of guides) {
    if (g.distance == null) continue;
    // Match the 1-decimal precision that the pills actually display — that
    // way every pair tagged "equal" literally shows the same number.
    const key = (Math.round(g.distance * 10) / 10).toString();
    if (!byDist.has(key)) byDist.set(key, []);
    byDist.get(key).push(g);
  }
  for (const group of byDist.values()) {
    if (group.length < 2) continue;
    const refIds = new Set(group.map(g => g.refId));
    if (refIds.size < 2) continue; // only count across distinct ref shapes
    for (const g of group) g.equal = true;
  }
}

function renderGuides(vGuides, hGuides) {
  while (guidesGroup.firstChild) guidesGroup.removeChild(guidesGroup.firstChild);
  if (!vGuides.length && !hGuides.length) {
    guidesGroup.style.display = 'none';
    return;
  }
  guidesGroup.style.display = '';
  const make = (x1, y1, x2, y2) => {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', '#ff2d92');
    l.setAttribute('stroke-width', '1');
    l.setAttribute('vector-effect', 'non-scaling-stroke');
    guidesGroup.appendChild(l);
  };
  for (const g of vGuides) make(g.x, g.y1, g.x, g.y2);
  for (const g of hGuides) make(g.x1, g.y, g.x2, g.y);

  // Collapse "same ref + same gap" sibling labels down to the middle one;
  // flag gap distances that repeat across refs on the same axis.
  const hideV = collapseSiblingLabels(vGuides, 'labelY');
  const hideH = collapseSiblingLabels(hGuides, 'labelX');
  markEqualSpacing(vGuides);
  markEqualSpacing(hGuides);

  // Distance labels — sized in user-units but scaled from target screen px,
  // so the badges stay readable (and compact) at any zoom level.
  const screenW = canvasInner.clientWidth || 1;
  const pxToUser = vbW / screenW;
  const fontSize = 16 * pxToUser;
  const padX = 9 * pxToUser;
  const padY = 5 * pxToUser;
  const charW = fontSize * 0.62;
  const seen = new Set();
  const makeLabel = (x, y, text, equal) => {
    const key = `${Math.round(x * 100)}:${Math.round(y * 100)}:${text}:${equal ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    const label = equal ? `= ${text}` : text;
    const tw = label.length * charW;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', x - tw / 2 - padX);
    rect.setAttribute('y', y - fontSize / 2 - padY);
    rect.setAttribute('width',  tw + padX * 2);
    rect.setAttribute('height', fontSize + padY * 2);
    rect.setAttribute('rx', 3 * pxToUser);
    rect.setAttribute('fill', equal ? '#ff7898' : '#ff2d92');
    guidesGroup.appendChild(rect);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.setAttribute('fill', equal ? '#1a0010' : '#fff');
    t.setAttribute('font-size', fontSize);
    t.setAttribute('font-family', 'JetBrains Mono, SF Mono, Consolas, monospace');
    t.setAttribute('font-weight', '700');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.textContent = label;
    guidesGroup.appendChild(t);
  };
  const fmt = (d) => {
    const abs = Math.abs(d);
    if (abs < 0.5) return '0';
    return (Math.round(abs * 10) / 10).toString().replace(/\.0$/, '');
  };
  for (const g of vGuides) {
    if (g.distance == null || g.labelY == null) continue;
    if (hideV.has(g)) continue;
    makeLabel(g.labelX, g.labelY, fmt(g.distance), !!g.equal);
  }
  for (const g of hGuides) {
    if (g.distance == null || g.labelX == null) continue;
    if (hideH.has(g)) continue;
    makeLabel(g.labelX, g.labelY, fmt(g.distance), !!g.equal);
  }
}

function clearGuides() {
  while (guidesGroup.firstChild) guidesGroup.removeChild(guidesGroup.firstChild);
  guidesGroup.style.display = 'none';
}

// =============================================================
// Path anchor editor (visual handles for free-form <path>)
// =============================================================

function clearPathAnchors() {
  while (pathAnchorsGroup.firstChild) pathAnchorsGroup.removeChild(pathAnchorsGroup.firstChild);
  pathAnchorsGroup.style.display = 'none';
}

function renderPathAnchors(el) {
  clearPathAnchors();
  if (!el || el.tagName !== 'path' || isRectLike(el) || isArrow(el)) return;
  const d = el.getAttribute('d') || '';
  const segs = parsePathD(d);
  if (segs.length === 0) return;

  let m = null;
  const tl = el.transform.baseVal;
  if (tl && tl.numberOfItems > 0) {
    const c = tl.consolidate();
    if (c) m = c.matrix;
  }
  const proj = (x, y) => {
    if (!m) return { x, y };
    const p = svgCanvas.createSVGPoint();
    p.x = x; p.y = y;
    const r = p.matrixTransform(m);
    return { x: r.x, y: r.y };
  };

  const makeLine = (p1, p2) => {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', p1.x); l.setAttribute('y1', p1.y);
    l.setAttribute('x2', p2.x); l.setAttribute('y2', p2.y);
    l.setAttribute('stroke', '#44aaff');
    l.setAttribute('stroke-width', '1');
    l.setAttribute('stroke-dasharray', '3 2');
    l.setAttribute('vector-effect', 'non-scaling-stroke');
    l.style.pointerEvents = 'none';
    pathAnchorsGroup.appendChild(l);
  };
  const makeDot = (p, kind, idx) => {
    const isSel = selectedAnchor && selectedAnchor.el === el
      && selectedAnchor.cmdIdx === idx && selectedAnchor.kind === kind;
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
    c.setAttribute('r', isSel ? (kind === 'end' ? 5 : 4) : (kind === 'end' ? 4 : 3));
    c.setAttribute('fill', kind === 'end' ? '#ff7898' : '#44aaff');
    c.setAttribute('stroke', isSel ? '#ff2d92' : '#fff');
    c.setAttribute('stroke-width', isSel ? '2' : '1');
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    c.dataset.paCmd = String(idx);
    c.dataset.paKind = kind;
    c.style.cursor = 'grab';
    c.style.pointerEvents = 'all';
    pathAnchorsGroup.appendChild(c);
  };

  let prev = null;
  let sx = 0, sy = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.cmd === 'Z') { prev = { x: sx, y: sy }; continue; }
    if (s.cmd === 'M') { sx = s.x; sy = s.y; }
    if (s.cmd === 'C') {
      const pPrev = prev ? proj(prev.x, prev.y) : null;
      const p1 = proj(s.x1, s.y1);
      const p2 = proj(s.x2, s.y2);
      const pEnd = proj(s.x, s.y);
      if (pPrev) makeLine(pPrev, p1);
      makeLine(pEnd, p2);
      makeDot(p1, 'c1', i);
      makeDot(p2, 'c2', i);
    } else if (s.cmd === 'Q') {
      const pPrev = prev ? proj(prev.x, prev.y) : null;
      const p1 = proj(s.x1, s.y1);
      const pEnd = proj(s.x, s.y);
      if (pPrev) makeLine(pPrev, p1);
      makeLine(pEnd, p1);
      makeDot(p1, 'q1', i);
    }
    makeDot(proj(s.x, s.y), 'end', i);
    prev = { x: s.x, y: s.y };
  }
  pathAnchorsGroup.style.display = '';
}

// =============================================================
// Properties panel
// =============================================================

// Read fill/stroke preferring inline style (which overrides SVG attributes)
// so the UI reflects what's actually rendered for imported markup.
function getPaint(el, kind) {
  const s = el.style && el.style[kind];
  if (s) return s;
  return el.getAttribute(kind);
}

// Set fill/stroke authoritatively: clear any inline style for the property,
// then write the attribute. Pass null to remove it.
function setPaint(el, kind, value) {
  if (el.style && el.style[kind]) el.style[kind] = '';
  if (value === null || value === undefined) el.removeAttribute(kind);
  else el.setAttribute(kind, value);
}

function hexColor(c) {
  if (!c || c === 'none') return '#000000';
  if (c.startsWith('#') && c.length === 7) return c;
  if (c.startsWith('#') && c.length === 4) return '#' + c[1]+c[1]+c[2]+c[2]+c[3]+c[3];
  if (c.startsWith('rgb')) {
    const m = c.match(/-?\d+(\.\d+)?/g);
    if (m && m.length >= 3) {
      const r = +m[0], g = +m[1], b = +m[2];
      return '#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
    }
  }
  return '#888888';
}

// =============================================================
// Color picker popover (shared by sidebar + properties swatches)
// =============================================================

const colorPopover = document.createElement('div');
colorPopover.id = 'colorPopover';
colorPopover.className = 'hidden';
colorPopover.innerHTML = `
  <div class="cp-tabs">
    <button type="button" class="cp-tab is-active" data-ft="solid">Solid</button>
    <button type="button" class="cp-tab" data-ft="linear">Linear</button>
    <button type="button" class="cp-tab" data-ft="radial">Radial</button>
  </div>
  <div class="cp-gradient hidden">
    <div class="cp-grad-bar">
      <div class="cp-grad-preview"></div>
      <div class="cp-grad-stops"></div>
    </div>
    <div class="cp-grad-angle-row">
      <span class="cp-grad-angle-label">Angle</span>
      <input class="cp-grad-angle" type="range" min="0" max="359" step="1" value="90">
      <span class="cp-grad-angle-value">90°</span>
    </div>
  </div>
  <div class="cp-sv">
    <div class="cp-sv-sat"></div>
    <div class="cp-sv-val"></div>
    <div class="cp-sv-thumb"></div>
  </div>
  <div class="cp-hue">
    <div class="cp-hue-thumb"></div>
  </div>
  <div class="cp-row">
    <input class="cp-hex" type="text" maxlength="7" spellcheck="false" autocomplete="off">
    <button type="button" class="cp-pick" data-hint="Pick a color from anywhere on screen">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.5 2 L14 5.5 L12 7.5 L8.5 4 Z"/>
        <path d="M12 7.5 L6 13.5 L3 14.5 L2 13.5 L3 10.5 L9 4.5"/>
      </svg>
    </button>
  </div>
  <div class="cp-palette-label">In this drawing</div>
  <div class="cp-palette"></div>
`;
document.body.appendChild(colorPopover);

const cpSV        = colorPopover.querySelector('.cp-sv');
const cpSat       = colorPopover.querySelector('.cp-sv-sat');
const cpSVThumb   = colorPopover.querySelector('.cp-sv-thumb');
const cpHue       = colorPopover.querySelector('.cp-hue');
const cpHueThumb  = colorPopover.querySelector('.cp-hue-thumb');
const cpHex       = colorPopover.querySelector('.cp-hex');
const cpPick      = colorPopover.querySelector('.cp-pick');
const cpPalette   = colorPopover.querySelector('.cp-palette');
const cpTabs      = colorPopover.querySelectorAll('.cp-tab');
const cpGradient  = colorPopover.querySelector('.cp-gradient');
const cpGradBar   = colorPopover.querySelector('.cp-grad-bar');
const cpGradPrev  = colorPopover.querySelector('.cp-grad-preview');
const cpGradStops = colorPopover.querySelector('.cp-grad-stops');
const cpGradAngleRow   = colorPopover.querySelector('.cp-grad-angle-row');
const cpGradAngle      = colorPopover.querySelector('.cp-grad-angle');
const cpGradAngleValue = colorPopover.querySelector('.cp-grad-angle-value');

const cpState = {
  h: 0, s: 0, v: 0.5,
  onChange: null,
  anchor: null,
  // Fill-mode state
  fillType: 'solid', // 'solid' | 'linear' | 'radial'
  stops: null,       // [{ offset, color, opacity }]
  angle: 90,         // degrees (linear only)
  activeStop: 0,
  gradientId: null,
};

function cpHsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function cpRgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function cpHexToRgb(hex) {
  if (!hex) return null;
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0,2), 16), parseInt(h.slice(2,4), 16), parseInt(h.slice(4,6), 16)];
}

function cpRgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}

// --- Gradient helpers ---
let gradientIdCounter = 0;
function nextGradientId() {
  return 'freegmaGrad-' + (++gradientIdCounter);
}
function getGradientDefs() {
  let defs = svgCanvas.querySelector(':scope > defs[data-freegma-gradients]');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    defs.setAttribute('data-freegma-gradients', '1');
    svgCanvas.insertBefore(defs, svgCanvas.firstChild);
  }
  return defs;
}
function gradientUrl(id) { return `url(#${id})`; }
function parseGradientUrl(paint) {
  if (!paint || typeof paint !== 'string') return null;
  const m = paint.match(/^url\(#([^)]+)\)$/);
  return m ? m[1] : null;
}
function findGradientDef(id) {
  return svgCanvas.querySelector(`:scope > defs[data-freegma-gradients] > #${CSS.escape(id)}`);
}
function buildGradient(id, type, stops, angle) {
  const defs = getGradientDefs();
  let grad = findGradientDef(id);
  const desiredTag = type === 'radial' ? 'radialGradient' : 'linearGradient';
  if (grad && grad.tagName !== desiredTag) { grad.remove(); grad = null; }
  if (!grad) {
    grad = document.createElementNS(SVG_NS, desiredTag);
    grad.setAttribute('id', id);
    defs.appendChild(grad);
  }
  if (type === 'linear') {
    // Angle: 0° = left-to-right; 90° = top-to-bottom (common UX convention).
    const a = angle * Math.PI / 180;
    const cx = 0.5, cy = 0.5;
    const r = Math.SQRT1_2; // so the gradient axis spans the bounding box diagonally at 45°
    const x1 = cx - Math.cos(a) * r;
    const y1 = cy - Math.sin(a) * r;
    const x2 = cx + Math.cos(a) * r;
    const y2 = cy + Math.sin(a) * r;
    grad.setAttribute('x1', x1.toFixed(4));
    grad.setAttribute('y1', y1.toFixed(4));
    grad.setAttribute('x2', x2.toFixed(4));
    grad.setAttribute('y2', y2.toFixed(4));
    grad.removeAttribute('cx'); grad.removeAttribute('cy'); grad.removeAttribute('r');
  } else {
    grad.setAttribute('cx', '0.5');
    grad.setAttribute('cy', '0.5');
    grad.setAttribute('r',  '0.5');
    grad.removeAttribute('x1'); grad.removeAttribute('y1');
    grad.removeAttribute('x2'); grad.removeAttribute('y2');
  }
  while (grad.firstChild) grad.removeChild(grad.firstChild);
  for (const s of stops) {
    const st = document.createElementNS(SVG_NS, 'stop');
    st.setAttribute('offset', (Math.max(0, Math.min(1, s.offset)) * 100).toFixed(2) + '%');
    st.setAttribute('stop-color', s.color);
    if (s.opacity != null && s.opacity < 1) st.setAttribute('stop-opacity', String(s.opacity));
    grad.appendChild(st);
  }
  return grad;
}
// --- Effects (drop shadow + gaussian blur) ---
let effectIdCounter = 0;
function nextEffectId() { return 'freegmaFx-' + (++effectIdCounter); }
function getEffectsDefs() {
  let defs = svgCanvas.querySelector(':scope > defs[data-freegma-effects]');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    defs.setAttribute('data-freegma-effects', '1');
    svgCanvas.insertBefore(defs, svgCanvas.firstChild);
  }
  return defs;
}
function getEffectFilterDef(el) {
  const m = (el.getAttribute('filter') || '').match(/^url\(#([^)]+)\)$/);
  if (!m) return null;
  return getEffectsDefs().querySelector('#' + CSS.escape(m[1]));
}
function parseEffectsFromElement(el) {
  const f = getEffectFilterDef(el);
  if (!f) return { shadow: null, blur: null };
  const shadow = f.dataset.shadowX != null ? {
    x: +f.dataset.shadowX || 0,
    y: +f.dataset.shadowY || 0,
    blur: +f.dataset.shadowBlur || 0,
    color: f.dataset.shadowColor || '#000000',
    opacity: f.dataset.shadowOpacity != null ? +f.dataset.shadowOpacity : 0.5,
  } : null;
  const blur = f.dataset.blurRadius != null ? { radius: +f.dataset.blurRadius } : null;
  return { shadow, blur };
}
function setElementEffects(el, { shadow, blur }) {
  if (!shadow && !blur) {
    const f = getEffectFilterDef(el);
    if (f) f.remove();
    el.removeAttribute('filter');
    return;
  }
  let f = getEffectFilterDef(el);
  let id;
  if (f) {
    id = f.getAttribute('id');
  } else {
    id = nextEffectId();
    f = document.createElementNS(SVG_NS, 'filter');
    f.setAttribute('id', id);
    getEffectsDefs().appendChild(f);
  }
  // Expand the filter region so shadow/blur spill doesn't clip.
  f.setAttribute('x', '-50%');
  f.setAttribute('y', '-50%');
  f.setAttribute('width',  '200%');
  f.setAttribute('height', '200%');
  // Clear previous state.
  while (f.firstChild) f.removeChild(f.firstChild);
  delete f.dataset.shadowX; delete f.dataset.shadowY; delete f.dataset.shadowBlur;
  delete f.dataset.shadowColor; delete f.dataset.shadowOpacity;
  delete f.dataset.blurRadius;

  const ns = SVG_NS;
  const mk = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  // Source (possibly blurred) used as the non-shadow pass.
  let sourceRef = 'SourceGraphic';
  if (blur && blur.radius > 0) {
    f.appendChild(mk('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: blur.radius, result: 'blurred' }));
    sourceRef = 'blurred';
    f.dataset.blurRadius = String(blur.radius);
  }
  if (shadow) {
    f.appendChild(mk('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: Math.max(0, shadow.blur), result: 'sb1' }));
    f.appendChild(mk('feOffset', { in: 'sb1', dx: shadow.x, dy: shadow.y, result: 'sb2' }));
    f.appendChild(mk('feFlood', { 'flood-color': shadow.color, 'flood-opacity': shadow.opacity, result: 'sc' }));
    f.appendChild(mk('feComposite', { in: 'sc', in2: 'sb2', operator: 'in', result: 'shadow' }));
    const merge = mk('feMerge', {});
    merge.appendChild(mk('feMergeNode', { in: 'shadow' }));
    merge.appendChild(mk('feMergeNode', { in: sourceRef }));
    f.appendChild(merge);
    f.dataset.shadowX = String(shadow.x);
    f.dataset.shadowY = String(shadow.y);
    f.dataset.shadowBlur = String(shadow.blur);
    f.dataset.shadowColor = shadow.color;
    f.dataset.shadowOpacity = String(shadow.opacity);
  }
  el.setAttribute('filter', `url(#${id})`);
}

function parseGradientDef(grad) {
  if (!grad) return null;
  const isLinear = grad.tagName === 'linearGradient';
  let angle = 90;
  if (isLinear) {
    const x1 = parseFloat(grad.getAttribute('x1')) || 0;
    const y1 = parseFloat(grad.getAttribute('y1')) || 0;
    const x2 = parseFloat(grad.getAttribute('x2')) || 1;
    const y2 = parseFloat(grad.getAttribute('y2')) || 0;
    angle = Math.round(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);
    if (angle < 0) angle += 360;
  }
  const stops = [];
  for (const st of grad.querySelectorAll(':scope > stop')) {
    const offRaw = st.getAttribute('offset') || '0';
    let offset = offRaw.endsWith('%') ? parseFloat(offRaw) / 100 : parseFloat(offRaw);
    if (!Number.isFinite(offset)) offset = 0;
    const color = st.getAttribute('stop-color') || '#000000';
    const opacity = parseFloat(st.getAttribute('stop-opacity'));
    stops.push({ offset, color, opacity: Number.isFinite(opacity) ? opacity : 1 });
  }
  if (stops.length === 0) {
    stops.push({ offset: 0, color: '#ffffff', opacity: 1 });
    stops.push({ offset: 1, color: '#000000', opacity: 1 });
  }
  return { type: isLinear ? 'linear' : 'radial', angle, stops };
}

function cpRender({ syncHex = true } = {}) {
  const { h, s, v } = cpState;
  cpSat.style.background = `linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`;
  cpSVThumb.style.left = (s * 100) + '%';
  cpSVThumb.style.top  = ((1 - v) * 100) + '%';
  cpHueThumb.style.left = ((h / 360) * 100) + '%';
  const [r, g, b] = cpHsvToRgb(h, s, v);
  const hex = cpRgbToHex(r, g, b);
  cpSVThumb.style.background = hex;
  if (syncHex) cpHex.value = hex.toUpperCase();
  return hex;
}

function cpEmit() {
  const hex = cpRender();
  if (cpState.fillType === 'solid') {
    if (cpState.onChange) cpState.onChange(hex);
    return;
  }
  // Gradient mode — update the active stop's color, rebuild the def, emit url.
  if (cpState.stops && cpState.stops[cpState.activeStop]) {
    cpState.stops[cpState.activeStop].color = hex;
  }
  cpApplyGradient();
  if (cpState.onChange && cpState.gradientId) {
    cpState.onChange(gradientUrl(cpState.gradientId));
  }
}

function cpSetFromHex(hex, { syncHex = true } = {}) {
  const rgb = cpHexToRgb(hex);
  if (!rgb) return null;
  const [h, s, v] = cpRgbToHsv(...rgb);
  // Preserve hue when the input is achromatic so the hue slider doesn't jump to 0.
  if (s > 0) cpState.h = h;
  cpState.s = s; cpState.v = v;
  cpRender({ syncHex });
  return cpRgbToHex(...rgb);
}

// Rebuild the gradient definition and refresh the popover preview + stops.
function cpApplyGradient() {
  if (!cpState.gradientId) cpState.gradientId = nextGradientId();
  buildGradient(cpState.gradientId, cpState.fillType, cpState.stops, cpState.angle);
  cpRenderGradientPreview();
  cpRenderStopHandles();
}

function cpRenderGradientPreview() {
  if (!cpState.stops) return;
  const parts = cpState.stops
    .slice().sort((a, b) => a.offset - b.offset)
    .map(s => `${s.color} ${(s.offset * 100).toFixed(2)}%`)
    .join(', ');
  if (cpState.fillType === 'linear') {
    cpGradPrev.style.background = `linear-gradient(90deg, ${parts})`;
  } else {
    cpGradPrev.style.background = `radial-gradient(circle at 50% 50%, ${parts})`;
  }
}

function cpRenderStopHandles() {
  cpGradStops.innerHTML = '';
  if (!cpState.stops) return;
  cpState.stops.forEach((s, i) => {
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'cp-grad-stop' + (i === cpState.activeStop ? ' is-active' : '');
    h.style.left = (s.offset * 100) + '%';
    h.style.background = s.color;
    h.dataset.stopIndex = String(i);
    h.title = `Stop ${i + 1}: ${s.color} (${Math.round(s.offset * 100)}%) — drag to move, Del to remove`;
    cpGradStops.appendChild(h);
  });
}

function cpSelectStop(i) {
  if (i < 0 || i >= cpState.stops.length) return;
  cpState.activeStop = i;
  const stop = cpState.stops[i];
  cpSetFromHex(stop.color);
  cpRenderStopHandles();
}

function cpAddStop(offset, color) {
  cpState.stops.push({ offset: Math.max(0, Math.min(1, offset)), color, opacity: 1 });
  cpState.stops.sort((a, b) => a.offset - b.offset);
  const newIdx = cpState.stops.findIndex(s => s.offset === Math.max(0, Math.min(1, offset)) && s.color === color);
  cpState.activeStop = newIdx >= 0 ? newIdx : cpState.stops.length - 1;
  cpApplyGradient();
  if (cpState.onChange && cpState.gradientId) cpState.onChange(gradientUrl(cpState.gradientId));
}

function cpRemoveActiveStop() {
  if (!cpState.stops || cpState.stops.length <= 2) return; // keep at least 2
  cpState.stops.splice(cpState.activeStop, 1);
  cpState.activeStop = Math.max(0, cpState.activeStop - 1);
  cpSelectStop(cpState.activeStop);
  cpApplyGradient();
  if (cpState.onChange && cpState.gradientId) cpState.onChange(gradientUrl(cpState.gradientId));
}

function cpSetFillType(type) {
  if (cpState.fillType === type) return;
  cpState.fillType = type;
  cpTabs.forEach(t => t.classList.toggle('is-active', t.dataset.ft === type));
  if (type === 'solid') {
    cpGradient.classList.add('hidden');
    // Emit the currently-edited color as the new solid fill.
    if (cpState.onChange) cpState.onChange(cpRender());
    return;
  }
  // Entering gradient mode — seed stops from the current color if we don't
  // already have them.
  if (!cpState.stops) {
    const startHex = cpRender();
    cpState.stops = [
      { offset: 0, color: startHex, opacity: 1 },
      { offset: 1, color: '#000000', opacity: 1 },
    ];
    cpState.activeStop = 0;
  }
  cpGradient.classList.remove('hidden');
  cpGradAngleRow.classList.toggle('hidden', type !== 'linear');
  cpState.gradientId = cpState.gradientId || nextGradientId();
  cpApplyGradient();
  // Bring the editor into sync with the active stop.
  const active = cpState.stops[cpState.activeStop];
  if (active) cpSetFromHex(active.color);
  if (cpState.onChange) cpState.onChange(gradientUrl(cpState.gradientId));
}

function cpDrag(el, handler) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const apply = (ev) => {
      const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / rect.height));
      handler(x, y);
    };
    apply(e);
    const up = () => {
      window.removeEventListener('mousemove', apply);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', apply);
    window.addEventListener('mouseup', up);
  });
}

cpDrag(cpSV,  (x, y) => { cpState.s = x; cpState.v = 1 - y; cpEmit(); });
cpDrag(cpHue, (x)    => { cpState.h = x * 360;              cpEmit(); });

// Tabs — switch between solid / linear / radial.
cpTabs.forEach(t => t.addEventListener('click', () => cpSetFillType(t.dataset.ft)));

// Angle slider for linear gradients.
cpGradAngle.addEventListener('input', () => {
  cpState.angle = parseFloat(cpGradAngle.value) || 0;
  cpGradAngleValue.textContent = cpState.angle + '°';
  if (cpState.fillType === 'linear') {
    cpApplyGradient();
    if (cpState.onChange && cpState.gradientId) cpState.onChange(gradientUrl(cpState.gradientId));
  }
});

// Gradient bar: click a stop to select, drag to reposition, click empty
// area to add a new stop at that offset. Delete/Backspace removes the
// active stop (min 2 preserved).
cpGradStops.addEventListener('mousedown', (e) => {
  if (cpState.fillType === 'solid') return;
  const stopBtn = e.target.closest('.cp-grad-stop');
  if (stopBtn) {
    e.preventDefault();
    const idx = parseInt(stopBtn.dataset.stopIndex, 10);
    cpSelectStop(idx);
    // Begin drag
    const rect = cpGradBar.getBoundingClientRect();
    const move = (ev) => {
      const offset = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      cpState.stops[cpState.activeStop].offset = offset;
      cpApplyGradient();
      if (cpState.onChange && cpState.gradientId) cpState.onChange(gradientUrl(cpState.gradientId));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
});
cpGradBar.addEventListener('click', (e) => {
  if (cpState.fillType === 'solid') return;
  if (e.target.closest('.cp-grad-stop')) return;
  const rect = cpGradBar.getBoundingClientRect();
  const offset = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  // Interpolate color at that offset between the two nearest existing stops.
  const sorted = cpState.stops.slice().sort((a, b) => a.offset - b.offset);
  let color = sorted[0].color;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].offset >= offset) {
      const prev = sorted[i - 1], next = sorted[i];
      const t = (offset - prev.offset) / Math.max(0.001, next.offset - prev.offset);
      const a = cpHexToRgb(prev.color) || [0,0,0];
      const b = cpHexToRgb(next.color) || [0,0,0];
      color = cpRgbToHex(a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t);
      break;
    }
  }
  cpAddStop(offset, color);
  // Bring the editor to the newly-added stop.
  const active = cpState.stops[cpState.activeStop];
  if (active) cpSetFromHex(active.color);
});
document.addEventListener('keydown', (e) => {
  if (colorPopover.classList.contains('hidden')) return;
  if (cpState.fillType === 'solid') return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    cpRemoveActiveStop();
  }
});

cpHex.addEventListener('input', () => {
  const normalized = cpSetFromHex(cpHex.value, { syncHex: false });
  if (!normalized) return;
  if (cpState.fillType === 'solid') {
    if (cpState.onChange) cpState.onChange(normalized);
  } else {
    cpState.stops[cpState.activeStop].color = normalized;
    cpApplyGradient();
    if (cpState.onChange && cpState.gradientId) cpState.onChange(gradientUrl(cpState.gradientId));
  }
});

// Element-based eyedropper: click any shape on the canvas to grab its paint.
// Works across browsers (doesn't rely on the window.EyeDropper API) and picks
// the SVG element's actual fill/stroke rather than a blended rendered pixel.
cpPick.dataset.hint = 'Pick a color from a shape on the canvas (Esc to cancel)';
cpPick.addEventListener('click', () => startCanvasPick());

function startCanvasPick() {
  const anchor = cpState.anchor;
  const onChange = cpState.onChange;
  const originalHex = cpRender();
  // Capture the gradient context so we can re-open the picker with the
  // stop-updated gradient instead of defaulting back to solid.
  const wasGradient = cpState.fillType !== 'solid';
  const gradSnapshot = wasGradient ? {
    type: cpState.fillType,
    stops: cpState.stops.map(s => ({ ...s })),
    angle: cpState.angle,
    activeStop: cpState.activeStop,
    gradientId: cpState.gradientId,
  } : null;
  closeColorPicker();
  document.body.classList.add('cp-picking');

  const reopen = (hex) => {
    if (!anchor) return;
    if (wasGradient && hex && hex !== originalHex) {
      // Restore gradient mode with the picked color in the active stop.
      gradSnapshot.stops[gradSnapshot.activeStop].color = hex;
      Object.assign(cpState, {
        fillType: gradSnapshot.type,
        stops: gradSnapshot.stops,
        angle: gradSnapshot.angle,
        activeStop: gradSnapshot.activeStop,
        gradientId: gradSnapshot.gradientId,
      });
      cpApplyGradient();
      openColorPicker(anchor, { value: gradientUrl(gradSnapshot.gradientId), onChange });
    } else {
      openColorPicker(anchor, { value: hex, onChange });
    }
  };
  const cleanup = () => {
    document.body.classList.remove('cp-picking');
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    let picked = null;
    if (canvasInner.contains(e.target)) {
      let t = e.target;
      while (t && t !== svgCanvas) {
        if (t.dataset && (t.dataset.bounds || t.dataset.handles || t.dataset.pathAnchors)) { t = null; break; }
        if (t.tagName && t.tagName.toLowerCase() === 'image') {
          const fromImg = cpSamplePixelFromImage(t, e.clientX, e.clientY);
          if (fromImg) { picked = fromImg; break; }
        }
        const raw = getPaint(t, 'fill') || getPaint(t, 'stroke');
        if (raw && raw !== 'none') { picked = hexColor(raw); break; }
        t = t.parentElement;
      }
    }
    if (picked && onChange) {
      if (wasGradient) {
        // Apply picked to active stop, emit the gradient url.
        gradSnapshot.stops[gradSnapshot.activeStop].color = picked;
        buildGradient(gradSnapshot.gradientId, gradSnapshot.type, gradSnapshot.stops, gradSnapshot.angle);
        onChange(gradientUrl(gradSnapshot.gradientId));
      } else {
        onChange(picked);
      }
    }
    reopen(picked || originalHex);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); reopen(originalHex); }
  };
  // Defer one tick so the button's own mousedown/click doesn't trigger us.
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function cpCollectCanvasColors() {
  const set = new Set();
  const walk = (el) => {
    if (!el) return;
    const d = el.dataset;
    if (d && (d.bounds || d.handles || d.pathAnchors || d.guides || d.bg || d.marquee || d.hidden)) return;
    for (const attr of ['fill', 'stroke']) {
      const v = getPaint(el, attr);
      if (v && v !== 'none') {
        const rgb = cpHexToRgb(hexColor(v));
        if (rgb) set.add(cpRgbToHex(...rgb).toUpperCase());
      }
    }
    for (const child of el.children || []) walk(child);
  };
  for (const child of svgCanvas.children) walk(child);
  return Array.from(set);
}

// Cache of raster <img> by href + extracted colors. Lets the eyedropper
// sample pixels from SVG <image> elements and seeds the palette with
// dominant image colors.
const cpImageCache = new Map();

function cpLoadImage(href, onReady) {
  if (!href) return null;
  let entry = cpImageCache.get(href);
  if (!entry) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    entry = { img, colors: null };
    cpImageCache.set(href, entry);
    if (onReady) img.addEventListener('load', () => onReady(entry), { once: true });
    img.addEventListener('error', () => {}, { once: true });
    img.src = href;
  } else if (onReady && (!entry.img.complete || !entry.img.naturalWidth)) {
    // Still loading — queue the callback. Never call it synchronously, so
    // callers that re-enter cpRenderPalette can't produce infinite recursion.
    entry.img.addEventListener('load', () => onReady(entry), { once: true });
  }
  return entry;
}

function cpSamplePixelFromImage(imgEl, clientX, clientY) {
  const href = imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href');
  if (!href) return null;
  const entry = cpLoadImage(href);
  if (!entry || !entry.img.complete || !entry.img.naturalWidth) return null;
  // Map client coords into the image's local user-space (handles rotation/scale).
  const ctm = imgEl.getScreenCTM();
  if (!ctm) return null;
  const pt = svgCanvas.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  const rx = parseFloat(imgEl.getAttribute('x') || 0);
  const ry = parseFloat(imgEl.getAttribute('y') || 0);
  const rw = parseFloat(imgEl.getAttribute('width')  || 0);
  const rh = parseFloat(imgEl.getAttribute('height') || 0);
  if (!rw || !rh) return null;
  // Respect preserveAspectRatio="xMidYMid meet" (our default for pasted images).
  const iw = entry.img.naturalWidth;
  const ih = entry.img.naturalHeight;
  const par = (imgEl.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
  let renderedX = rx, renderedY = ry, renderedW = rw, renderedH = rh;
  if (par !== 'none') {
    const sc = Math.min(rw / iw, rh / ih);
    renderedW = iw * sc;
    renderedH = ih * sc;
    renderedX = rx + (rw - renderedW) / 2;
    renderedY = ry + (rh - renderedH) / 2;
  }
  const sx = Math.floor((local.x - renderedX) / renderedW * iw);
  const sy = Math.floor((local.y - renderedY) / renderedH * ih);
  if (sx < 0 || sx >= iw || sy < 0 || sy >= ih) return null;
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  const ctx = c.getContext('2d');
  try {
    ctx.drawImage(entry.img, sx, sy, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] < 8) return null;
    return cpRgbToHex(d[0], d[1], d[2]);
  } catch { return null; }
}

function cpExtractImageColors(img) {
  const maxDim = 64;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) return [];
  const scale = Math.min(maxDim / iw, maxDim / ih, 1);
  const w = Math.max(1, Math.floor(iw * scale));
  const h = Math.max(1, Math.floor(ih * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  try { ctx.drawImage(img, 0, 0, w, h); } catch { return []; }
  let pixels;
  try { pixels = ctx.getImageData(0, 0, w, h).data; } catch { return []; }
  const buckets = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i+3] < 128) continue;
    const key = (pixels[i] & 0xE0) << 16 | (pixels[i+1] & 0xE0) << 8 | (pixels[i+2] & 0xE0);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  // Keep the top N quantized colors, but skip candidates that are too close
  // to one we already picked — otherwise anti-aliased halos of a big region
  // (e.g. the red background with white logo edges) can eat all the slots.
  const ordered = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const picked = [];
  const minDistSq = 60 * 60; // perceptual-ish threshold in unquantized RGB
  for (const [key] of ordered) {
    const r = (key >> 16) & 0xFF;
    const g = (key >> 8)  & 0xFF;
    const b = key & 0xFF;
    let tooClose = false;
    for (const p of picked) {
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      if (dr * dr + dg * dg + db * db < minDistSq) { tooClose = true; break; }
    }
    if (tooClose) continue;
    picked.push([r, g, b]);
    if (picked.length >= 8) break;
  }
  return picked.map(([r, g, b]) => cpRgbToHex(r, g, b).toUpperCase());
}

function cpCollectImageColors(onLate) {
  const out = [];
  const imgs = svgCanvas.querySelectorAll('image');
  for (const el of imgs) {
    if (el.closest('[data-handles], [data-bounds], [data-path-anchors], [data-guides]')) continue;
    const href = el.getAttribute('href') || el.getAttribute('xlink:href');
    if (!href) continue;
    const entry = cpLoadImage(href, (e) => {
      if (!e.colors) e.colors = cpExtractImageColors(e.img);
      onLate && onLate();
    });
    if (entry && entry.img.complete && entry.img.naturalWidth > 0) {
      if (!entry.colors) entry.colors = cpExtractImageColors(entry.img);
      for (const c of entry.colors) out.push(c);
    }
  }
  return out;
}

function cpRenderPalette() {
  cpPalette.innerHTML = '';
  const reRender = () => {
    if (!colorPopover.classList.contains('hidden')) cpRenderPalette();
  };
  const merged = [...cpCollectCanvasColors(), ...cpCollectImageColors(reRender)];
  const seen = new Set();
  const uniq = [];
  for (const c of merged) { if (!seen.has(c)) { seen.add(c); uniq.push(c); } }
  if (!uniq.length) {
    const empty = document.createElement('span');
    empty.className = 'cp-palette-empty';
    empty.textContent = 'No colors yet';
    cpPalette.appendChild(empty);
    return;
  }
  for (const c of uniq) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'cp-swatch';
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('click', () => {
      const hex = cpSetFromHex(c);
      if (!hex) return;
      if (cpState.fillType === 'solid') {
        if (cpState.onChange) cpState.onChange(hex);
      } else {
        cpState.stops[cpState.activeStop].color = hex;
        cpApplyGradient();
        if (cpState.onChange && cpState.gradientId) cpState.onChange(gradientUrl(cpState.gradientId));
      }
    });
    cpPalette.appendChild(sw);
  }
}

function openColorPicker(anchorEl, { value, onChange }) {
  cpState.anchor = anchorEl;
  cpState.onChange = onChange;
  // Detect if the incoming fill is a gradient (url(#id)) and set the
  // popover into gradient mode; otherwise fall back to solid.
  const gradId = parseGradientUrl(value);
  const grad = gradId ? findGradientDef(gradId) : null;
  if (grad) {
    const parsed = parseGradientDef(grad);
    cpState.fillType = parsed.type;
    cpState.stops = parsed.stops.map(s => ({ ...s }));
    cpState.angle = parsed.angle;
    cpState.activeStop = 0;
    cpState.gradientId = gradId;
    cpTabs.forEach(t => t.classList.toggle('is-active', t.dataset.ft === parsed.type));
    cpGradient.classList.remove('hidden');
    cpGradAngleRow.classList.toggle('hidden', parsed.type !== 'linear');
    cpGradAngle.value = String(parsed.angle);
    cpGradAngleValue.textContent = parsed.angle + '°';
    cpSetFromHex(parsed.stops[0].color);
    cpRenderGradientPreview();
    cpRenderStopHandles();
  } else {
    cpState.fillType = 'solid';
    cpState.stops = null;
    cpState.gradientId = null;
    cpTabs.forEach(t => t.classList.toggle('is-active', t.dataset.ft === 'solid'));
    cpGradient.classList.add('hidden');
    cpSetFromHex(value || '#888888');
  }
  cpRenderPalette();
  colorPopover.classList.remove('hidden');
  // Measure after reveal so offsetHeight is accurate.
  const anchorRect = anchorEl.getBoundingClientRect();
  const pw = colorPopover.offsetWidth  || 228;
  const ph = colorPopover.offsetHeight || 300;
  const margin = 6;
  let left = anchorRect.left - pw - margin;
  if (left < 4) left = anchorRect.right + margin;
  if (left + pw > window.innerWidth - 4) left = window.innerWidth - pw - 4;
  if (left < 4) left = 4;
  let top = anchorRect.top;
  if (top + ph > window.innerHeight - 4) top = window.innerHeight - ph - 4;
  if (top < 4) top = 4;
  colorPopover.style.left = left + 'px';
  colorPopover.style.top  = top  + 'px';
}

function closeColorPicker() {
  colorPopover.classList.add('hidden');
  cpState.onChange = null;
  cpState.anchor = null;
}

document.addEventListener('mousedown', (e) => {
  if (colorPopover.classList.contains('hidden')) return;
  if (colorPopover.contains(e.target)) return;
  if (cpState.anchor && cpState.anchor.contains(e.target)) return;
  closeColorPicker();
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !colorPopover.classList.contains('hidden')) closeColorPicker();
});

function makeSwatchButton({ value, hint, onChange }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'swatch-btn';
  if (hint) btn.dataset.hint = hint;
  btn.dataset.value = value;
  btn.style.setProperty('--swatch-color', value);
  btn.innerHTML = '<span class="swatch-fill"></span>';
  btn.addEventListener('click', () => {
    openColorPicker(btn, {
      value: btn.dataset.value,
      onChange: (hex) => {
        btn.dataset.value = hex;
        btn.style.setProperty('--swatch-color', hex);
        onChange(hex);
      }
    });
  });
  return btn;
}

// ---- Prop panel builders --------------------------------------------------

function field(labelText) {
  const row = document.createElement('div');
  row.className = 'field';
  const lb = document.createElement('span');
  lb.className = 'field-label';
  lb.textContent = labelText;
  const ctrl = document.createElement('div');
  ctrl.className = 'field-ctrl';
  row.appendChild(lb);
  row.appendChild(ctrl);
  return { row, ctrl };
}

function miniInput(label, value, { onInput, hint, min, step = 1, labelHtml, field } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'mini';
  if (hint) wrap.dataset.hint = hint;
  if (field) wrap.dataset.field = field;
  const lb = document.createElement('span');
  if (labelHtml) lb.innerHTML = labelHtml;
  else lb.textContent = label;
  wrap.appendChild(lb);
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = step;
  if (min !== undefined) inp.min = min;
  if (field) inp.dataset.field = field;
  inp.value = value;
  if (onInput) inp.addEventListener('input', onInput);
  wrap.appendChild(inp);
  return { wrap, inp };
}

// After populateProps() replaces the input the user was typing in (because a
// rect-path ↔ rect swap forced a rebuild), refocus the equivalent field and
// restore the caret so keystrokes keep landing on the input — otherwise the
// next Backspace hits <body> and the global delete-shape handler fires.
function restorePropsFocus(fieldKey, caret, caretEnd) {
  const fresh = propsPanel.querySelector(`input[data-field="${fieldKey}"]`);
  if (!fresh) return;
  fresh.focus();
  try { fresh.setSelectionRange(caret ?? 0, caretEnd ?? fresh.value.length); } catch {}
}

function populateProps(el) {
  propsPanel.innerHTML = '';
  const tag = el.tagName;

  // ---- Fill ----
  {
    const { row, ctrl } = field('Fill');
    const swatch = makeSwatchButton({
      value: hexColor(getPaint(el, 'fill')),
      hint: 'Fill color',
      onChange: (hex) => { setPaint(el, 'fill', hex); refreshElementList(); },
    });
    ctrl.appendChild(swatch);
    const none = document.createElement('button');
    none.textContent = 'None';
    none.dataset.hint = 'Set fill to transparent';
    none.addEventListener('click', () => { setPaint(el, 'fill', 'none'); refreshElementList(); });
    ctrl.appendChild(none);
    propsPanel.appendChild(row);
  }

  // ---- Border ----
  let borderWInp;
  {
    const { row, ctrl } = field('Border');
    const swatch = makeSwatchButton({
      value: hexColor(getPaint(el, 'stroke')),
      hint: 'Border color',
      onChange: (hex) => {
        setPaint(el, 'stroke', hex);
        if (!parseFloat(el.getAttribute('stroke-width'))) {
          el.setAttribute('stroke-width', '1');
          if (borderWInp) borderWInp.value = '1';
        }
      },
    });
    ctrl.appendChild(swatch);
    const wMini = miniInput('W', el.getAttribute('stroke-width') || '0', {
      min: 0,
      hint: 'Border width (0 hides it)',
      onInput: () => el.setAttribute('stroke-width', wMini.inp.value),
    });
    borderWInp = wMini.inp;
    ctrl.appendChild(wMini.wrap);
    const none = document.createElement('button');
    none.textContent = 'None';
    none.dataset.hint = 'Remove border';
    none.addEventListener('click', () => {
      setPaint(el, 'stroke', null);
      el.setAttribute('stroke-width', '0');
      borderWInp.value = '0';
    });
    ctrl.appendChild(none);
    propsPanel.appendChild(row);
  }

  // ---- Opacity ----
  {
    const { row, ctrl } = field('Opacity');
    const r = document.createElement('input');
    r.type = 'range'; r.min = 0; r.max = 1; r.step = 0.05;
    r.value = el.getAttribute('opacity') || '1';
    const v = document.createElement('span');
    v.className = 'muted';
    v.style.cssText = 'min-width:28px;text-align:right;font-family:var(--mono)';
    v.textContent = (+r.value).toFixed(2);
    r.addEventListener('input', () => {
      el.setAttribute('opacity', r.value);
      v.textContent = (+r.value).toFixed(2);
    });
    ctrl.appendChild(r);
    ctrl.appendChild(v);
    propsPanel.appendChild(row);
  }

  // ---- Effects (drop shadow + gaussian blur) ----
  {
    const section = document.createElement('div');
    section.className = 'fx-section';
    const heading = document.createElement('div');
    heading.className = 'fx-heading';
    heading.textContent = 'Effects';
    section.appendChild(heading);
    const ctrl = document.createElement('div');
    ctrl.className = 'fx-body';
    section.appendChild(ctrl);
    const current = parseEffectsFromElement(el);
    let shadow = current.shadow;
    let blur   = current.blur;
    const apply = () => { setElementEffects(el, { shadow, blur }); updateHandles(); };

    // --- Shadow block ---
    const shadowWrap = document.createElement('div');
    shadowWrap.className = 'fx-row';
    const shadowBtn = document.createElement('button');
    shadowBtn.type = 'button';
    shadowBtn.className = 'fx-toggle' + (shadow ? ' is-on' : '');
    shadowBtn.textContent = 'Shadow';
    shadowBtn.dataset.hint = 'Toggle drop shadow';
    const shadowDetails = document.createElement('div');
    shadowDetails.className = 'fx-details' + (shadow ? '' : ' hidden');
    const renderShadowUI = () => {
      shadowDetails.innerHTML = '';
      if (!shadow) return;
      const r1 = document.createElement('div');
      r1.className = 'fx-row-inner';
      for (const [lbl, key, min] of [['X', 'x', -200], ['Y', 'y', -200], ['Blur', 'blur', 0]]) {
        const mini = miniInput(lbl, shadow[key], {
          min, step: 'any',
          hint: `Shadow ${lbl.toLowerCase()}`,
          onInput: (ev) => { shadow[key] = parseFloat(ev.target.value) || 0; apply(); },
        });
        r1.appendChild(mini.wrap);
      }
      shadowDetails.appendChild(r1);
      const r2 = document.createElement('div');
      r2.className = 'fx-row-inner';
      const sw = makeSwatchButton({
        value: shadow.color,
        hint: 'Shadow color',
        onChange: (hex) => { shadow.color = hex; apply(); },
      });
      r2.appendChild(sw);
      const rng = document.createElement('input');
      rng.type = 'range'; rng.min = 0; rng.max = 1; rng.step = 0.05;
      rng.value = String(shadow.opacity);
      rng.style.flex = '1';
      rng.dataset.hint = 'Shadow opacity';
      const val = document.createElement('span');
      val.className = 'muted';
      val.style.cssText = 'min-width:28px;text-align:right;font-family:var(--mono)';
      val.textContent = (+rng.value).toFixed(2);
      rng.addEventListener('input', () => {
        shadow.opacity = parseFloat(rng.value);
        val.textContent = shadow.opacity.toFixed(2);
        apply();
      });
      r2.appendChild(rng);
      r2.appendChild(val);
      shadowDetails.appendChild(r2);
    };
    shadowBtn.addEventListener('click', () => {
      shadow = shadow ? null : { x: 2, y: 4, blur: 6, color: '#000000', opacity: 0.5 };
      shadowBtn.classList.toggle('is-on', !!shadow);
      shadowDetails.classList.toggle('hidden', !shadow);
      renderShadowUI();
      apply();
    });
    shadowWrap.appendChild(shadowBtn);
    shadowWrap.appendChild(shadowDetails);
    ctrl.appendChild(shadowWrap);

    // --- Blur block ---
    const blurWrap = document.createElement('div');
    blurWrap.className = 'fx-row';
    const blurBtn = document.createElement('button');
    blurBtn.type = 'button';
    blurBtn.className = 'fx-toggle' + (blur ? ' is-on' : '');
    blurBtn.textContent = 'Blur';
    blurBtn.dataset.hint = 'Toggle gaussian blur';
    const blurDetails = document.createElement('div');
    blurDetails.className = 'fx-details' + (blur ? '' : ' hidden');
    const renderBlurUI = () => {
      blurDetails.innerHTML = '';
      if (!blur) return;
      const r = document.createElement('div');
      r.className = 'fx-row-inner';
      const rng = document.createElement('input');
      rng.type = 'range'; rng.min = 0; rng.max = 30; rng.step = 0.5;
      rng.value = String(blur.radius);
      rng.style.flex = '1';
      rng.dataset.hint = 'Blur radius';
      const val = document.createElement('span');
      val.className = 'muted';
      val.style.cssText = 'min-width:34px;text-align:right;font-family:var(--mono)';
      val.textContent = (+rng.value).toFixed(1) + 'px';
      rng.addEventListener('input', () => {
        blur.radius = parseFloat(rng.value);
        val.textContent = blur.radius.toFixed(1) + 'px';
        apply();
      });
      r.appendChild(rng);
      r.appendChild(val);
      blurDetails.appendChild(r);
    };
    blurBtn.addEventListener('click', () => {
      blur = blur ? null : { radius: 3 };
      blurBtn.classList.toggle('is-on', !!blur);
      blurDetails.classList.toggle('hidden', !blur);
      renderBlurUI();
      apply();
    });
    blurWrap.appendChild(blurBtn);
    blurWrap.appendChild(blurDetails);
    ctrl.appendChild(blurWrap);

    renderShadowUI();
    renderBlurUI();
    propsPanel.appendChild(section);
  }

  // ---- Geometry ----
  if (isRectLike(el)) {
    const cur = getRectLike(el);
    const onRect = (key) => (ev) => {
      const input = ev.target;
      const caret = input.selectionStart, caretEnd = input.selectionEnd;
      const v = parseFloat(input.value) || 0;
      const patch = (ev.shiftKey && (key === 'tl' || key === 'tr' || key === 'br' || key === 'bl'))
        ? { tl: v, tr: v, br: v, bl: v } : { [key]: v };
      const newEl = setRectLike(el, patch);
      if (newEl !== el) {
        swapSelected(el, newEl);
        populateProps(newEl);
        restorePropsFocus(key, caret, caretEnd);
        return;
      }
      updateHandles();
    };

    {
      const { row, ctrl } = field('Position');
      ctrl.appendChild(miniInput('X', cur.x, { onInput: onRect('x'), field: 'x', step: 'any' }).wrap);
      ctrl.appendChild(miniInput('Y', cur.y, { onInput: onRect('y'), field: 'y', step: 'any' }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('Size');
      ctrl.appendChild(miniInput('W', cur.w, { min: 1, onInput: onRect('w'), field: 'w', step: 'any' }).wrap);
      ctrl.appendChild(miniInput('H', cur.h, { min: 1, onInput: onRect('h'), field: 'h', step: 'any' }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('Corners');
      ctrl.style.flexWrap = 'wrap';
      let individual = !(cur.tl === cur.tr && cur.tr === cur.br && cur.br === cur.bl);
      const applyUniform = (ev) => {
        const input = ev.target;
        const caret = input.selectionStart, caretEnd = input.selectionEnd;
        const v = parseFloat(input.value) || 0;
        const newEl = setRectLike(el, { tl: v, tr: v, br: v, bl: v });
        if (newEl !== el) {
          swapSelected(el, newEl);
          populateProps(newEl);
          restorePropsFocus('corners-uniform', caret, caretEnd);
          return;
        }
        updateHandles();
      };
      const renderCorners = () => {
        ctrl.innerHTML = '';
        const c = getRectLike(el);
        if (individual) {
          ctrl.dataset.hint = 'Per-corner radius';
          ctrl.appendChild(miniInput('TL', c.tl, { min: 0, onInput: onRect('tl'), field: 'tl', step: 'any' }).wrap);
          ctrl.appendChild(miniInput('TR', c.tr, { min: 0, onInput: onRect('tr'), field: 'tr', step: 'any' }).wrap);
          ctrl.appendChild(miniInput('BL', c.bl, { min: 0, onInput: onRect('bl'), field: 'bl', step: 'any' }).wrap);
          ctrl.appendChild(miniInput('BR', c.br, { min: 0, onInput: onRect('br'), field: 'br', step: 'any' }).wrap);
        } else {
          ctrl.dataset.hint = 'Uniform corner radius';
          ctrl.appendChild(miniInput('', c.tl, {
            min: 0,
            step: 'any',
            onInput: applyUniform,
            field: 'corners-uniform',
            labelHtml: '<svg class="corner-ico" viewBox="0 0 11 11" aria-hidden="true"><path d="M1 10 V4 Q1 1 4 1 H10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
          }).wrap);
        }
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'corner-toggle' + (individual ? ' active' : '');
        toggle.textContent = individual ? '◼' : '◻';
        toggle.dataset.hint = individual
          ? 'Link corners (one radius for all four)'
          : 'Unlink corners (edit each corner independently)';
        toggle.addEventListener('click', () => {
          if (individual) {
            const cc = getRectLike(el);
            const v = Math.max(cc.tl, cc.tr, cc.br, cc.bl);
            if (!(cc.tl === v && cc.tr === v && cc.br === v && cc.bl === v)) {
              const newEl = setRectLike(el, { tl: v, tr: v, br: v, bl: v });
              if (newEl !== el) { swapSelected(el, newEl); populateProps(newEl); return; }
              updateHandles();
            }
          }
          individual = !individual;
          renderCorners();
        });
        ctrl.appendChild(toggle);
      };
      renderCorners();
      propsPanel.appendChild(row);
    }
  } else if (tag === 'circle') {
    const { row, ctrl } = field('Geometry');
    const onAttr = (a) => (ev) => { el.setAttribute(a, ev.target.value); updateHandles(); };
    ctrl.style.flexWrap = 'wrap';
    ctrl.appendChild(miniInput('CX', el.getAttribute('cx') || 0, { onInput: onAttr('cx') }).wrap);
    ctrl.appendChild(miniInput('CY', el.getAttribute('cy') || 0, { onInput: onAttr('cy') }).wrap);
    ctrl.appendChild(miniInput('R',  el.getAttribute('r')  || 0, { min: 0, onInput: onAttr('r') }).wrap);
    propsPanel.appendChild(row);
  } else if (tag === 'ellipse') {
    const onAttr = (a) => (ev) => { el.setAttribute(a, ev.target.value); updateHandles(); };
    {
      const { row, ctrl } = field('Center');
      ctrl.appendChild(miniInput('CX', el.getAttribute('cx') || 0, { onInput: onAttr('cx') }).wrap);
      ctrl.appendChild(miniInput('CY', el.getAttribute('cy') || 0, { onInput: onAttr('cy') }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('Radii');
      ctrl.appendChild(miniInput('RX', el.getAttribute('rx') || 0, { min: 0, onInput: onAttr('rx') }).wrap);
      ctrl.appendChild(miniInput('RY', el.getAttribute('ry') || 0, { min: 0, onInput: onAttr('ry') }).wrap);
      propsPanel.appendChild(row);
    }
  } else if (tag === 'line') {
    const onAttr = (a) => (ev) => { el.setAttribute(a, ev.target.value); updateHandles(); };
    {
      const { row, ctrl } = field('Start');
      ctrl.appendChild(miniInput('X1', el.getAttribute('x1') || 0, { onInput: onAttr('x1') }).wrap);
      ctrl.appendChild(miniInput('Y1', el.getAttribute('y1') || 0, { onInput: onAttr('y1') }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('End');
      ctrl.appendChild(miniInput('X2', el.getAttribute('x2') || 0, { onInput: onAttr('x2') }).wrap);
      ctrl.appendChild(miniInput('Y2', el.getAttribute('y2') || 0, { onInput: onAttr('y2') }).wrap);
      propsPanel.appendChild(row);
    }
  } else if (isArrow(el)) {
    const a = getArrow(el);
    const onA = (key) => (ev) => {
      const v = parseFloat(ev.target.value) || 0;
      setArrow(el, { [key]: v });
      updateHandles();
      refreshElementList();
    };
    {
      const { row, ctrl } = field('Start');
      ctrl.appendChild(miniInput('X1', a.x1, { onInput: onA('x1'), step: 'any', field: 'x1' }).wrap);
      ctrl.appendChild(miniInput('Y1', a.y1, { onInput: onA('y1'), step: 'any', field: 'y1' }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('End');
      ctrl.appendChild(miniInput('X2', a.x2, { onInput: onA('x2'), step: 'any', field: 'x2' }).wrap);
      ctrl.appendChild(miniInput('Y2', a.y2, { onInput: onA('y2'), step: 'any', field: 'y2' }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('Body');
      ctrl.appendChild(miniInput('T', a.t, { min: 0.5, step: 'any', onInput: onA('t'), field: 't',
        hint: 'Body thickness' }).wrap);
      propsPanel.appendChild(row);
    }
    {
      const { row, ctrl } = field('Head');
      ctrl.appendChild(miniInput('L', a.hL, { min: 0, step: 'any', onInput: onA('hL'), field: 'hL',
        hint: 'Arrowhead length along the line' }).wrap);
      ctrl.appendChild(miniInput('W', a.hW, { min: 0, step: 'any', onInput: onA('hW'), field: 'hW',
        hint: 'Arrowhead width perpendicular to the line' }).wrap);
      propsPanel.appendChild(row);
    }
  } else if (tag === 'path') {
    // Free-form path: anchors on the canvas + raw `d` textarea as advanced view.
    const hint = document.createElement('div');
    hint.className = 'path-hint';
    hint.textContent = 'Drag the pink dots on the canvas to move anchor points, cyan dots for curve handles.';
    propsPanel.appendChild(hint);
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = 'Raw d (advanced)';
    lbl.style.marginTop = '4px';
    propsPanel.appendChild(lbl);
    const ta = document.createElement('textarea');
    ta.value = el.getAttribute('d') || '';
    ta.style.height = '80px';
    ta.addEventListener('input', () => {
      el.setAttribute('d', ta.value);
      updateHandles();
      renderPathAnchors(el);
    });
    propsPanel.appendChild(ta);
    const ref = document.createElement('div');
    ref.className = 'path-ref';
    ref.innerHTML = `<b>M</b> x,y move &nbsp; <b>L</b> x,y line<br>
      <b>C</b> x1,y1 x2,y2 x,y cubic curve<br>
      <b>Q</b> x1,y1 x,y quadratic curve<br>
      <b>A</b> rx,ry rot la sw x,y arc<br>
      <b>Z</b> close &nbsp; <i>lowercase = relative</i>`;
    propsPanel.appendChild(ref);
  } else if (tag === 'text') {
    // ---- Content ----
    {
      const { row, ctrl } = field('Text');
      const ta = document.createElement('textarea');
      ta.value = getMultilineText(el);
      ta.style.height = '54px';
      ta.style.flex = '1';
      ta.dataset.hint = 'Text content — Enter inserts a line break (rendered as <tspan>s)';
      ta.addEventListener('input', () => {
        setMultilineText(el, ta.value);
        updateHandles();
        refreshElementList();
      });
      ctrl.appendChild(ta);
      propsPanel.appendChild(row);
    }
    // ---- Font size ----
    {
      const { row, ctrl } = field('Font');
      const curSize = parseFloat(el.getAttribute('font-size')) || 16;
      ctrl.appendChild(miniInput('Size', curSize, {
        min: 1,
        step: 'any',
        field: 'font-size',
        hint: 'Font size in canvas units',
        onInput: (ev) => { el.setAttribute('font-size', ev.target.value || 0); updateHandles(); },
      }).wrap);
      propsPanel.appendChild(row);
    }
    // ---- Font family ----
    {
      const { row, ctrl } = field('Family');
      const sel = document.createElement('select');
      sel.dataset.hint = 'Font family — Google-hosted web fonts or system fallbacks';
      sel.style.flex = '1';
      const families = [
        { label: 'System',           value: 'system-ui, -apple-system, sans-serif' },
        { label: 'Sans-serif',       value: 'sans-serif' },
        { label: 'Serif',            value: 'serif' },
        { label: 'Monospace',        value: 'monospace' },
        // Google Fonts (linked in index.html)
        { label: 'Inter',            value: '"Inter", system-ui, sans-serif' },
        { label: 'Roboto',           value: '"Roboto", system-ui, sans-serif' },
        { label: 'Poppins',          value: '"Poppins", system-ui, sans-serif' },
        { label: 'Montserrat',       value: '"Montserrat", system-ui, sans-serif' },
        { label: 'DM Sans',          value: '"DM Sans", system-ui, sans-serif' },
        { label: 'Oswald',           value: '"Oswald", system-ui, sans-serif' },
        { label: 'Playfair Display', value: '"Playfair Display", Georgia, serif' },
        { label: 'Lora',             value: '"Lora", Georgia, serif' },
        { label: 'Fira Code',        value: '"Fira Code", ui-monospace, monospace' },
        { label: 'Space Mono',       value: '"Space Mono", ui-monospace, monospace' },
        // System-installed serif/mono classics
        { label: 'Courier New',      value: '"Courier New", Courier, monospace' },
        { label: 'Georgia',          value: 'Georgia, serif' },
      ];
      const cur = el.getAttribute('font-family') || families[0].value;
      let matched = false;
      for (const f of families) {
        const o = document.createElement('option');
        o.value = f.value; o.textContent = f.label;
        if (f.value === cur) { o.selected = true; matched = true; }
        sel.appendChild(o);
      }
      // If the element has an unrecognized font-family (e.g., from an
      // imported SVG), show it as a disabled-looking entry so the current
      // value is preserved rather than silently overwritten.
      if (!matched) {
        const o = document.createElement('option');
        o.value = cur; o.textContent = cur;
        o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        el.setAttribute('font-family', sel.value);
        updateHandles();
      });
      ctrl.appendChild(sel);
      propsPanel.appendChild(row);
    }
    // ---- Font weight ----
    {
      const { row, ctrl } = field('Weight');
      const sel = document.createElement('select');
      sel.dataset.hint = 'Font weight';
      sel.style.flex = '1';
      const weights = [
        { label: 'Light (300)',  value: '300' },
        { label: 'Normal (400)', value: '400' },
        { label: 'Medium (500)', value: '500' },
        { label: 'Semibold (600)', value: '600' },
        { label: 'Bold (700)',   value: '700' },
        { label: 'Black (900)',  value: '900' },
      ];
      const curW = el.getAttribute('font-weight') || '400';
      for (const w of weights) {
        const o = document.createElement('option');
        o.value = w.value; o.textContent = w.label;
        if (w.value === String(curW)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { el.setAttribute('font-weight', sel.value); updateHandles(); });
      ctrl.appendChild(sel);
      propsPanel.appendChild(row);
    }
    // ---- Alignment (text-anchor) ----
    {
      const { row, ctrl } = field('Align');
      const current = el.getAttribute('text-anchor') || 'start';
      const anchors = [
        { value: 'start',  label: '⟸', hint: 'Left (anchor=start)' },
        { value: 'middle', label: '⇔', hint: 'Center (anchor=middle)' },
        { value: 'end',    label: '⟹', hint: 'Right (anchor=end)' },
      ];
      for (const a of anchors) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'corner-toggle' + (a.value === current ? ' active' : '');
        b.textContent = a.label;
        b.dataset.hint = a.hint;
        b.addEventListener('click', () => {
          // Changing text-anchor shifts the text relative to x. Capture the
          // current visual bbox, update the anchor, then move x so the text
          // stays visually in place (start=left edge, middle=center, end=right).
          const bb = bboxInCanvas(el);
          el.setAttribute('text-anchor', a.value);
          let newX = bb.x;
          if (a.value === 'middle') newX = bb.x + bb.width / 2;
          else if (a.value === 'end') newX = bb.x + bb.width;
          el.setAttribute('x', newX);
          for (const t of el.querySelectorAll(':scope > tspan')) t.setAttribute('x', newX);
          populateProps(el);
          updateHandles();
        });
        ctrl.appendChild(b);
      }
      propsPanel.appendChild(row);
    }
    // ---- Position ----
    {
      const { row, ctrl } = field('Position');
      const onXY = (key) => (ev) => {
        const v = ev.target.value || 0;
        el.setAttribute(key, v);
        if (key === 'x') {
          for (const t of el.querySelectorAll(':scope > tspan')) t.setAttribute('x', v);
        }
        updateHandles();
      };
      ctrl.appendChild(miniInput('X', el.getAttribute('x') || 0, { onInput: onXY('x'), field: 'x', step: 'any' }).wrap);
      ctrl.appendChild(miniInput('Y', el.getAttribute('y') || 0, { onInput: onXY('y'), field: 'y', step: 'any' }).wrap);
      propsPanel.appendChild(row);
    }
  }

  // ---- Actions ----
  const actRow = document.createElement('div');
  actRow.className = 'act-row';
  const mkAct = (label, hint, handler, cls) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.hint = hint;
    if (cls) b.className = cls;
    b.addEventListener('click', handler);
    actRow.appendChild(b);
  };
  mkAct('↑', 'Move up (draws above siblings)', () => {
    pushUndo();
    const p = el.previousElementSibling;
    if (p) { svgCanvas.insertBefore(el, p); refreshElementList(); }
  });
  mkAct('↓', 'Move down (draws below siblings)', () => {
    pushUndo();
    const n = el.nextElementSibling;
    if (n && n !== boundsRect && n !== handlesGroup) { svgCanvas.insertBefore(n, el); refreshElementList(); }
  });
  mkAct('Dup', 'Duplicate (Ctrl+D)', () => {
    pushUndo();
    const c = el.cloneNode(true);
    svgCanvas.insertBefore(c, handlesGroup);
    refreshElementList();
    selectElement(c);
  });
  mkAct('Delete', 'Delete (Del)', () => {
    pushUndo();
    svgCanvas.removeChild(el);
    clearSelection();
  }, 'danger');
  propsPanel.appendChild(actRow);
}

// =============================================================
// Undo
// =============================================================

function snapshotCanvas() {
  const clone = svgCanvas.cloneNode(true);
  clone.querySelectorAll('[data-handles], [data-bounds], [data-guides], [data-path-anchors], [data-marquee]').forEach(e => e.remove());
  return clone.innerHTML;
}

function restoreCanvas(html) {
  while (svgCanvas.firstChild) svgCanvas.removeChild(svgCanvas.firstChild);
  const tmp = document.createElementNS(SVG_NS, 'svg');
  tmp.innerHTML = html;
  for (const child of Array.from(tmp.children)) svgCanvas.appendChild(child);
  svgCanvas.appendChild(boundsRect);
  svgCanvas.appendChild(guidesGroup);
  svgCanvas.appendChild(pathAnchorsGroup);
  svgCanvas.appendChild(marqueeRect);
  svgCanvas.appendChild(handlesGroup);
  handlesGroup.style.display = 'none';
  clearGuides();
  clearPathAnchors();
  selection = [];
  refreshElementList();
  propsPanel.innerHTML = '<div class="empty">Select an element</div>';
}

function pushUndo() {
  undoStack.push(snapshotCanvas());
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
  scheduleSave();
}

function popUndo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshotCanvas());
  if (redoStack.length > 50) redoStack.shift();
  restoreCanvas(undoStack.pop());
  scheduleSave();
}

function popRedo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshotCanvas());
  if (undoStack.length > 50) undoStack.shift();
  restoreCanvas(redoStack.pop());
  scheduleSave();
}

// =============================================================
// Move + Resize + Rotate
// =============================================================

function moveElement(el, dx, dy) {
  const tag = el.tagName;
  const cur = el.getAttribute('transform') || '';
  const hasRotate = cur.includes('rotate(');
  if (!hasRotate && tag === 'path' && el.dataset.rect === '1') {
    el.dataset.x = (+el.dataset.x || 0) + dx;
    el.dataset.y = (+el.dataset.y || 0) + dy;
    renderRectPath(el);
  } else if (!hasRotate && isArrow(el)) {
    setArrow(el, {
      x1: (+el.dataset.x1 || 0) + dx, y1: (+el.dataset.y1 || 0) + dy,
      x2: (+el.dataset.x2 || 0) + dx, y2: (+el.dataset.y2 || 0) + dy,
    });
  } else if (!hasRotate && (tag === 'rect' || tag === 'image')) {
    el.setAttribute('x', parseFloat(el.getAttribute('x')||0) + dx);
    el.setAttribute('y', parseFloat(el.getAttribute('y')||0) + dy);
  } else if (!hasRotate && tag === 'text') {
    const newX = parseFloat(el.getAttribute('x')||0) + dx;
    const newY = parseFloat(el.getAttribute('y')||0) + dy;
    el.setAttribute('x', newX);
    el.setAttribute('y', newY);
    for (const t of el.querySelectorAll(':scope > tspan')) t.setAttribute('x', newX);
  } else if (!hasRotate && (tag === 'circle' || tag === 'ellipse')) {
    el.setAttribute('cx', parseFloat(el.getAttribute('cx')||0) + dx);
    el.setAttribute('cy', parseFloat(el.getAttribute('cy')||0) + dy);
  } else if (!hasRotate && tag === 'line') {
    for (const a of ['x1','y1','x2','y2']) el.setAttribute(a, parseFloat(el.getAttribute(a)||0) + (a.includes('y') ? dy : dx));
  } else {
    const tm = cur.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
    const tx = tm ? parseFloat(tm[1]) + dx : dx;
    const ty = tm ? parseFloat(tm[2]) + dy : dy;
    const other = cur.replace(/translate\([^)]*\)\s*/g, '').trim();
    el.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)})` + (other ? ' ' + other : ''));
  }
}

function rotateElement(el, cx, cy, deltaDeg) {
  const existing = el.getAttribute('transform') || '';
  const cleaned = existing.replace(/\s*rotate\([^)]*\)/g, '').trim();
  const rm = existing.match(/rotate\(([-\d.]+)/);
  const curRot = rm ? parseFloat(rm[1]) : 0;
  const newRot = curRot + deltaDeg;
  const rot = `rotate(${newRot.toFixed(1)},${cx.toFixed(1)},${cy.toFixed(1)})`;
  el.setAttribute('transform', cleaned ? cleaned + ' ' + rot : rot);
}

// Snapshot the element's current transform as a plain matrix {a,b,c,d,e,f}.
// Used at the start of a rotate-drag so further rotations can be expressed
// as `rotate(δ, W) matrix(M_start)` — which guarantees rotation around the
// world point W regardless of what the existing transform looked like.
function snapshotMatrix(el) {
  const list = el.transform.baseVal;
  if (!list || list.numberOfItems === 0) return null;
  const consolidated = list.consolidate();
  if (!consolidated) return null;
  const m = consolidated.matrix;
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

function formatMatrix(m) {
  return `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
}

function resizeElement(el, dx, dy, h, bb) {
  const tag = el.tagName;
  if (tag === 'path' && el.dataset.rect === '1') {
    let x = +el.dataset.x || 0, y = +el.dataset.y || 0;
    let w = +el.dataset.w || 0, ht = +el.dataset.h || 0;
    if (h.includes('e')) w += dx; if (h.includes('w')) { w -= dx; x += dx; }
    if (h.includes('s')) ht += dy; if (h.includes('n')) { ht -= dy; y += dy; }
    if (w > 2) { el.dataset.x = x; el.dataset.w = w; }
    if (ht > 2) { el.dataset.y = y; el.dataset.h = ht; }
    renderRectPath(el);
  } else if (tag === 'rect' || tag === 'image') {
    let x = parseFloat(el.getAttribute('x')||0), y = parseFloat(el.getAttribute('y')||0);
    let w = parseFloat(el.getAttribute('width')||0), ht = parseFloat(el.getAttribute('height')||0);
    if (h.includes('e')) w += dx; if (h.includes('w')) { w -= dx; x += dx; }
    if (h.includes('s')) ht += dy; if (h.includes('n')) { ht -= dy; y += dy; }
    if (w > 2) { el.setAttribute('x', x); el.setAttribute('width', w); }
    if (ht > 2) { el.setAttribute('y', y); el.setAttribute('height', ht); }
  } else if (tag === 'circle') {
    // Grow-direction sign per axis, based on which handle is being dragged.
    // "e"/"s" => +, "w"/"n" => -, side-only handles have the other axis = 0.
    const signX = h.includes('e') ? 1 : h.includes('w') ? -1 : 0;
    const signY = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
    const drX = dx * signX;
    const drY = dy * signY;
    const dr = Math.abs(drX) > Math.abs(drY) ? drX : drY;
    const r = parseFloat(el.getAttribute('r')||0);
    el.setAttribute('r', Math.max(2, r + dr));
  } else if (tag === 'ellipse') {
    let rx = parseFloat(el.getAttribute('rx')||0), ry = parseFloat(el.getAttribute('ry')||0);
    if (h.includes('e') || h.includes('w')) rx += (h.includes('w') ? -dx : dx);
    if (h.includes('s') || h.includes('n')) ry += (h.includes('n') ? -dy : dy);
    el.setAttribute('rx', Math.max(2, rx));
    el.setAttribute('ry', Math.max(2, ry));
  } else {
    const scaleX = bb.width > 0 ? (bb.width + (h.includes('e') ? dx : h.includes('w') ? -dx : 0)) / bb.width : 1;
    const scaleY = bb.height > 0 ? (bb.height + (h.includes('s') ? dy : h.includes('n') ? -dy : 0)) / bb.height : 1;
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    el.setAttribute('transform', `translate(${cx.toFixed(1)},${cy.toFixed(1)}) scale(${Math.max(0.1,scaleX).toFixed(3)},${Math.max(0.1,scaleY).toFixed(3)}) translate(${(-cx).toFixed(1)},${(-cy).toFixed(1)})`);
  }
}

// =============================================================
// Mouse interaction
// =============================================================

function svgPt(e) {
  const pt = svgCanvas.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svgCanvas.getScreenCTM().inverse());
}

// Last known cursor position in SVG coordinates, used by paste to drop
// shapes at the cursor instead of a fixed offset from the originals.
let lastCursorSvgPt = null;
canvasInner.addEventListener('mousemove', (e) => {
  lastCursorSvgPt = svgPt(e);
});

svgCanvas.addEventListener('mousedown', (e) => {
  // Only left-click drives select / draw / marquee / resize.
  // Middle button is pan (handled on canvasInner); right button opens the
  // context menu.
  if (e.button !== 0) return;
  const tgt = e.target;

  // Handle-corner drags and path-anchor drags take precedence over an armed
  // draw tool — otherwise grabbing a resize handle with e.g. the rect tool
  // armed would start drawing a tiny rect instead of resizing.
  const isHandleHit = tgt.dataset && (tgt.dataset.handle || tgt.dataset.paCmd !== undefined);

  if (pendingShape && e.button === 0 && !isHandleHit) {
    e.preventDefault(); e.stopPropagation();
    const sp = svgPt(e);
    pushUndo();
    const tag = pendingShape.tag;
    const el = document.createElementNS(SVG_NS, tag);
    const c = newFillColor;
    if (tag === 'line') {
      el.setAttribute('stroke', c);
      el.setAttribute('stroke-width', Math.max(2, Math.min(currentW, currentH) * 0.012));
    } else if (pendingShape.marker === 'arrow' && tag === 'path') {
      // Arrow = closed polygon path. Fill with current color, initialise
      // with sensible defaults scaled to the canvas size.
      el.setAttribute('fill', c);
      el.setAttribute('stroke', 'none');
      el.dataset.arrow = '1';
      const t  = Math.max(2, Math.min(currentW, currentH) * 0.008);
      el.dataset.thickness  = String(t);
      el.dataset.headLength = String(t * 3.5);
      el.dataset.headWidth  = String(t * 2.5);
      setArrow(el, { x1: sp.x, y1: sp.y, x2: sp.x, y2: sp.y });
    } else if (tag === 'text') {
      el.setAttribute('fill', c);
      el.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      el.setAttribute('font-size', '14');
      el.setAttribute('dominant-baseline', 'hanging');
      el.setAttribute('text-anchor', 'start');
      setMultilineText(el, 'Text');
    } else {
      el.setAttribute('fill', c);
    }
    setDrawGeometry(el, tag, sp.x, sp.y, sp.x, sp.y);
    svgCanvas.insertBefore(el, handlesGroup);
    drag = { mode: 'draw', tag, startX: sp.x, startY: sp.y, el };
    return;
  }

  if (tgt.dataset && tgt.dataset.paCmd !== undefined && selection.length === 1) {
    const el = selection[0];
    const cmdIdx = +tgt.dataset.paCmd;
    const kind = tgt.dataset.paKind;
    selectedAnchor = { el, cmdIdx, kind };
    pushUndo();
    let inv = null;
    const tl = el.transform.baseVal;
    if (tl && tl.numberOfItems > 0) {
      const c = tl.consolidate();
      if (c) inv = c.matrix.inverse();
    }
    drag = { mode: 'path-anchor', el, cmdIdx, kind, inv };
    renderPathAnchors(el);
    e.preventDefault(); e.stopPropagation();
    return;
  }

  if (tgt.dataset && tgt.dataset.handle && selection.length) {
    const sp = svgPt(e);
    pushUndo();
    if (tgt.dataset.handle === 'rotate') {
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for (const s of selection) { const b = bboxInCanvas(s); minX=Math.min(minX,b.x); minY=Math.min(minY,b.y); maxX=Math.max(maxX,b.x+b.width); maxY=Math.max(maxY,b.y+b.height); }
      const cx = (minX+maxX)/2, cy = (minY+maxY)/2;
      const startMatrices = selection.map(snapshotMatrix);
      drag = { mode: 'rotate', cx, cy, startAngle: Math.atan2(sp.y - cy, sp.x - cx), startMatrices, x: sp.x, y: sp.y };
    } else if (selection.length === 1) {
      const startFontSize = selection[0].tagName === 'text'
        ? (parseFloat(selection[0].getAttribute('font-size')) || 16) : null;
      const startTransform = selection[0].getAttribute('transform') || '';
      drag = { mode: 'resize', handle: tgt.dataset.handle, startBBox: selection[0].getBBox(), startX: sp.x, startY: sp.y, startFontSize, startTransform, x: sp.x, y: sp.y };
    }
    e.preventDefault(); e.stopPropagation();
    return;
  }

  if (tgt === svgCanvas || tgt === boundsRect || handlesGroup.contains(tgt)) {
    if (tgt === svgCanvas || tgt === boundsRect) {
      // Start marquee drag. Selection is only cleared on mouseup if the
      // marquee ended empty (so a bare click on empty canvas still clears).
      const sp = svgPt(e);
      drag = {
        mode: 'marquee',
        startX: sp.x, startY: sp.y,
        x: sp.x, y: sp.y,
        additive: e.ctrlKey || e.metaKey,
        prevSelection: selection.slice(),
      };
      marqueeRect.setAttribute('x', sp.x);
      marqueeRect.setAttribute('y', sp.y);
      marqueeRect.setAttribute('width', 0);
      marqueeRect.setAttribute('height', 0);
      e.preventDefault();
    }
    return;
  }

  if (e.altKey && e.button === 0 && selection.length === 1) {
    const sel = selection[0];
    if (sel === tgt && sel.tagName === 'path' && !isRectLike(sel) && !isArrow(sel)) {
      const sp = svgPt(e);
      pushUndo();
      if (addAnchorAt(sel, sp.x, sp.y)) {
        renderPathAnchors(sel);
        updateHandles();
      }
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // When clicking inside a multi-line <text> (each line is a <tspan>),
  // promote the hit to the parent <text> so we select the whole element,
  // not just the clicked line.
  let pickTgt = tgt;
  if (pickTgt && pickTgt.parentNode && pickTgt.parentNode.tagName === 'text') {
    pickTgt = pickTgt.parentNode;
  }
  // Promote clicks inside a group to the outermost <g> that's a direct child
  // of svgCanvas, so the whole group selects/drags as a unit.
  while (pickTgt && pickTgt.parentNode && pickTgt.parentNode !== svgCanvas) {
    pickTgt = pickTgt.parentNode;
  }
  if (!pickTgt || pickTgt === svgCanvas) return;
  // Locked elements ignore left-click — click behaves like clicking empty canvas.
  if (pickTgt.dataset && pickTgt.dataset.locked) return;
  const addToSel = e.ctrlKey || e.metaKey;
  if (addToSel) selectElement(pickTgt, true);
  else if (!selection.includes(pickTgt)) selectElement(pickTgt);
  // Alt+drag on a selection = duplicate and drag the clones (Figma-style).
  // duplicateSelection pushes its own undo; skip the outer pushUndo in that case.
  if (e.altKey && !addToSel && selection.length) {
    duplicateSelection();
  } else {
    pushUndo();
  }
  const sp = svgPt(e);
  drag = { mode: 'move', startX: sp.x, startY: sp.y, appliedX: 0, appliedY: 0, x: sp.x, y: sp.y };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const sp = svgPt(e);

  if (drag.mode === 'draw') {
    let endX = sp.x, endY = sp.y;
    if (e.shiftKey) {
      // Shift on line/arrow — constrain to 0°/45°/90°/135°.
      if (drag.tag === 'line' || isArrow(drag.el)) {
        const dx = sp.x - drag.startX;
        const dy = sp.y - drag.startY;
        const len = Math.hypot(dx, dy);
        if (len > 0.01) {
          const step = Math.PI / 4;
          const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
          endX = drag.startX + Math.cos(snapped) * len;
          endY = drag.startY + Math.sin(snapped) * len;
        }
      // Shift on rect/ellipse — constrain to a square / circle along the
      // longer axis of the drag so the cursor stays on the corner.
      } else if (drag.tag === 'rect' || drag.tag === 'ellipse') {
        const dx = sp.x - drag.startX;
        const dy = sp.y - drag.startY;
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        endX = drag.startX + (dx >= 0 ? side : -side);
        endY = drag.startY + (dy >= 0 ? side : -side);
      }
    }
    setDrawGeometry(drag.el, drag.tag, drag.startX, drag.startY, endX, endY);
    return;
  }

  if (drag.mode === 'path-anchor') {
    let lx = sp.x, ly = sp.y;
    if (drag.inv) {
      const pt = svgCanvas.createSVGPoint();
      pt.x = sp.x; pt.y = sp.y;
      const local = pt.matrixTransform(drag.inv);
      lx = local.x; ly = local.y;
    }
    const segs = parsePathD(drag.el.getAttribute('d'));
    const seg = segs[drag.cmdIdx];
    if (!seg) return;
    if (drag.kind === 'end') { seg.x = lx; seg.y = ly; }
    else if (drag.kind === 'c1') { seg.x1 = lx; seg.y1 = ly; }
    else if (drag.kind === 'c2') { seg.x2 = lx; seg.y2 = ly; }
    else if (drag.kind === 'q1') { seg.x1 = lx; seg.y1 = ly; }
    drag.el.setAttribute('d', serializePathSegments(segs));
    renderPathAnchors(drag.el);
    updateHandles();
    const ta = propsPanel.querySelector('textarea');
    if (ta) ta.value = drag.el.getAttribute('d');
    return;
  }

  if (drag.mode === 'marquee') {
    const x1 = Math.min(drag.startX, sp.x);
    const y1 = Math.min(drag.startY, sp.y);
    const w  = Math.abs(sp.x - drag.startX);
    const h  = Math.abs(sp.y - drag.startY);
    marqueeRect.setAttribute('x', x1);
    marqueeRect.setAttribute('y', y1);
    marqueeRect.setAttribute('width',  w);
    marqueeRect.setAttribute('height', h);
    marqueeRect.style.display = '';
    drag.x = sp.x; drag.y = sp.y;
    return;
  }

  if (selection.length === 0) return;

  if (drag.mode === 'move') {
    const desiredX = sp.x - drag.startX;
    const desiredY = sp.y - drag.startY;
    const selBox = unionSelectionBox();
    const deltaHypoX = desiredX - drag.appliedX;
    const deltaHypoY = desiredY - drag.appliedY;
    const hypo = {
      left: selBox.left + deltaHypoX, right: selBox.right + deltaHypoX, cx: selBox.cx + deltaHypoX,
      top: selBox.top + deltaHypoY, bottom: selBox.bottom + deltaHypoY, cy: selBox.cy + deltaHypoY,
    };
    const { snapDx, snapDy, vGuides, hGuides } = computeSnap(hypo);
    const finalX = desiredX + snapDx;
    const finalY = desiredY + snapDy;
    const applyX = finalX - drag.appliedX;
    const applyY = finalY - drag.appliedY;
    if (applyX || applyY) {
      for (const el of selection) moveElement(el, applyX, applyY);
    }
    drag.appliedX = finalX;
    drag.appliedY = finalY;
    renderGuides(vGuides, hGuides);
  } else if (drag.mode === 'resize' && selection.length === 1) {
    const el0 = selection[0];
    if (el0.tagName === 'text' && drag.startFontSize) {
      // Text: scale font-size from cumulative handle drag against the start
      // bbox. The generic transform-based fallback doesn't accumulate (each
      // mousemove overwrites with a near-identity scale) — this path
      // produces a real font-size change the user can see and export.
      const cumDx = sp.x - drag.startX;
      const cumDy = sp.y - drag.startY;
      const signX = drag.handle.includes('e') ? 1 : drag.handle.includes('w') ? -1 : 0;
      const signY = drag.handle.includes('s') ? 1 : drag.handle.includes('n') ? -1 : 0;
      const bbw = drag.startBBox.width  || 1;
      const bbh = drag.startBBox.height || 1;
      let scale = 1;
      if (signX !== 0 && signY !== 0) {
        const sx = (bbw + cumDx * signX) / bbw;
        const sy = (bbh + cumDy * signY) / bbh;
        scale = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      } else if (signX !== 0) {
        scale = (bbw + cumDx * signX) / bbw;
      } else if (signY !== 0) {
        scale = (bbh + cumDy * signY) / bbh;
      }
      scale = Math.max(0.1, scale);
      el0.setAttribute('font-size', (drag.startFontSize * scale).toFixed(2));
    } else if (el0.tagName === 'g') {
      // Groups resize via a fresh transform built from the frozen startBBox
      // + cumulative drag, then re-composed with the group's startTransform.
      // Falling through to the generic transform-scale branch would fail
      // because it treats the incremental dx/dy as cumulative.
      const cumDx = sp.x - drag.startX;
      const cumDy = sp.y - drag.startY;
      const h = drag.handle;
      const bb = drag.startBBox;
      const scaleX = bb.width  > 0 ? (bb.width  + (h.includes('e') ? cumDx : h.includes('w') ? -cumDx : 0)) / bb.width  : 1;
      const scaleY = bb.height > 0 ? (bb.height + (h.includes('s') ? cumDy : h.includes('n') ? -cumDy : 0)) / bb.height : 1;
      const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
      const scaleStr = `translate(${cx.toFixed(3)},${cy.toFixed(3)}) scale(${Math.max(0.1,scaleX).toFixed(3)},${Math.max(0.1,scaleY).toFixed(3)}) translate(${(-cx).toFixed(3)},${(-cy).toFixed(3)})`;
      el0.setAttribute('transform', drag.startTransform ? `${scaleStr} ${drag.startTransform}` : scaleStr);
    } else {
      const dx = sp.x - drag.x, dy = sp.y - drag.y;
      resizeElement(el0, dx, dy, drag.handle, drag.startBBox);
      const snap = computeResizeSnap(el0, drag.handle);
      if (snap.snapDx || snap.snapDy) {
        resizeElement(el0, snap.snapDx, snap.snapDy, drag.handle, drag.startBBox);
      }
      renderGuides(snap.vGuides, snap.hGuides);
    }
    populateProps(selection[0]);
    drag.x = sp.x; drag.y = sp.y;
  } else if (drag.mode === 'rotate') {
    const angle = Math.atan2(sp.y - drag.cy, sp.x - drag.cx);
    const totalDeltaDeg = (angle - drag.startAngle) * (180 / Math.PI);
    const rotStr = `rotate(${totalDeltaDeg.toFixed(3)},${drag.cx.toFixed(3)},${drag.cy.toFixed(3)})`;
    for (let i = 0; i < selection.length; i++) {
      const el = selection[i];
      const m = drag.startMatrices[i];
      el.setAttribute('transform', m ? `${rotStr} ${formatMatrix(m)}` : rotStr);
    }
    drag.x = sp.x; drag.y = sp.y;
  }

  updateHandles();
  if (drag.mode !== 'path-anchor' && selection.length === 1) {
    renderPathAnchors(selection[0]);
  }
});

window.addEventListener('mouseup', () => {
  if (drag && drag.mode === 'draw') {
    const { el, tag, startX, startY } = drag;
    const bb = el.getBBox();
    if (Math.max(bb.width, bb.height) < 2) {
      for (const [k, v] of Object.entries(shapeDefaults(tag, startX, startY))) el.setAttribute(k, String(v));
    }
    refreshElementList();
    selectElement(el);
    exitDrawMode();
    drag = null;
    return;
  }
  if (drag && drag.mode === 'marquee') {
    marqueeRect.style.display = 'none';
    const x1 = Math.min(drag.startX, drag.x);
    const y1 = Math.min(drag.startY, drag.y);
    const x2 = Math.max(drag.startX, drag.x);
    const y2 = Math.max(drag.startY, drag.y);
    const hits = [];
    for (const child of svgCanvas.children) {
      if (child === handlesGroup || child === boundsRect || child === marqueeRect) continue;
      if (child.dataset && (child.dataset.bg || child.dataset.guides || child.dataset.pathAnchors || child.dataset.marquee || child.dataset.locked || child.dataset.hidden)) continue;
      const bb = bboxInCanvas(child);
      if (!isFinite(bb.width) || !isFinite(bb.height)) continue;
      const intersects = !(bb.x + bb.width < x1 || bb.x > x2 || bb.y + bb.height < y1 || bb.y > y2);
      if (intersects) hits.push(child);
    }
    if (drag.additive) {
      selection = drag.prevSelection.slice();
      for (const el of hits) if (!selection.includes(el)) selection.push(el);
    } else {
      selection = hits;
    }
    updateHandles();
    handlesGroup.style.display = selection.length ? '' : 'none';
    refreshElementList();
    if (selection.length === 1) populateProps(selection[0]);
    else if (selection.length > 1) renderMultiSelectProps(selection.length);
    else propsPanel.innerHTML = '<div class="empty">Select an element</div>';
    drag = null;
    return;
  }
  if (drag && drag.mode === 'resize' && selection.length === 1) {
    drag.startBBox = selection[0].getBBox();
  }
  if (drag && (drag.mode === 'move' || drag.mode === 'resize')) clearGuides();
  drag = null;
});

// Zoom with scroll
canvasInner.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
  const pt = svgCanvas.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const sp = pt.matrixTransform(svgCanvas.getScreenCTM().inverse());
  const newW = vbW * zoomFactor;
  const maxDim = Math.max(currentW, currentH);
  if (newW < maxDim * 0.05 || newW > maxDim * 20) return;
  vbX = sp.x - (sp.x - vbX) * zoomFactor;
  vbY = sp.y - (sp.y - vbY) * zoomFactor;
  vbW = newW;
  vbH = vbH * zoomFactor;
  svgCanvas.setAttribute('viewBox', `${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`);
}, { passive: false });

canvasInner.addEventListener('contextmenu', (e) => e.preventDefault());

// Suppress the browser's native right-click menu everywhere in the app so
// right-click only opens our own menus (canvas, drawings list, layers).
// Keep the native menu inside real text editors (input / textarea /
// contenteditable) so users still get Paste / Undo / spell-check there.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
});
canvasInner.addEventListener('mousedown', (e) => {
  if (e.button !== 1) return; // middle mouse button
  e.preventDefault();
  pan = { x: e.clientX, y: e.clientY };
  canvasInner.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!pan) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  const rect = svgCanvas.getBoundingClientRect();
  vbX -= dx * (vbW / rect.width);
  vbY -= dy * (vbH / rect.height);
  svgCanvas.setAttribute('viewBox', `${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`);
  pan.x = e.clientX; pan.y = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 1 && pan) { pan = null; canvasInner.style.cursor = ''; }
});

// =============================================================
// Keyboard shortcuts
// =============================================================

// Track the last time the user typed into any form input. If a destructive
// key (Delete/Backspace) fires within a short window of that, skip canvas
// deletion — the user was almost certainly continuing to edit a field whose
// input got replaced mid-keystroke (e.g., Corners swapping rect↔path).
let lastFormInputAt = 0;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) lastFormInputAt = Date.now();
}, true);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && Date.now() - lastFormInputAt < 250) return;

  // `?` — open the keyboard shortcut overlay.
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }

  // Figma-style tool shortcuts: V select, R rect, O ellipse, C circle,
  // L line, A arrow, P path, T text. No modifier keys.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') { e.preventDefault(); exitDrawMode(); return; }
    const toolMap = { r: 'Rect', o: 'Ellipse', c: 'Circle', l: 'Line', a: 'Arrow', p: 'Path', t: 'Text' };
    const label = toolMap[k];
    if (label) {
      const idx = shapes.findIndex(s => s.label === label);
      const btn = shapeButtons[idx];
      if (btn) { e.preventDefault(); enterDrawMode(shapes[idx].tag, btn, { marker: shapes[idx].marker }); return; }
    }
  }

  if (e.key === 'Escape') {
    if (pendingShape) { e.preventDefault(); exitDrawMode(); return; }
    if (selectedAnchor) {
      e.preventDefault();
      selectedAnchor = null;
      if (selection.length === 1) renderPathAnchors(selection[0]);
      return;
    }
  }

  if (selection.length && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
    const dy = e.key === 'ArrowDown'  ? step : e.key === 'ArrowUp'   ? -step : 0;
    pushUndo();
    for (const el of selection) if (!el.dataset.locked) moveElement(el, dx, dy);
    updateHandles();
    if (selection.length === 1) renderPathAnchors(selection[0]);
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    // If a drawing row in the sidebar has focus, delete that drawing instead
    // of any canvas selection. (Rows get focus when clicked.)
    const focusedRow = e.target && e.target.classList && e.target.classList.contains('icon-item')
      ? e.target
      : null;
    if (focusedRow && focusedRow.dataset.drawing) {
      e.preventDefault();
      removeDrawing(focusedRow.dataset.drawing);
      return;
    }
    if (selectedAnchor && selection.includes(selectedAnchor.el)) {
      e.preventDefault();
      pushUndo();
      const ok = removeAnchorAt(selectedAnchor.el, selectedAnchor.cmdIdx, selectedAnchor.kind);
      if (ok) {
        const host = selectedAnchor.el;
        selectedAnchor = null;
        renderPathAnchors(host);
        updateHandles();
      }
      return;
    }
    if (selection.length) {
      const targets = selection.filter(el => !el.dataset.locked);
      if (!targets.length) return;
      e.preventDefault();
      pushUndo();
      for (const el of targets) svgCanvas.removeChild(el);
      selection = selection.filter(el => el.dataset.locked);
      if (!selection.length) clearSelection();
      else { updateHandles(); refreshElementList(); }
    }
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) popRedo();
    else popUndo();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    popRedo();
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'd' && selection.length) {
    e.preventDefault();
    pushUndo();
    const clones = [];
    for (const el of selection) {
      const c = el.cloneNode(true);
      svgCanvas.insertBefore(c, handlesGroup);
      clones.push(c);
    }
    selection = clones;
    updateHandles();
    refreshElementList();
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && selection.length) {
    e.preventDefault();
    copySelectionToClipboard();
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else            groupSelection();
  }
});

// Selection transforms — flip around the union bbox center so a single
// shape flips in place and a multi-selection mirrors as a group.
function flipSelection(axis) {
  const targets = selection.filter(el => !el.dataset.locked);
  if (!targets.length) return;
  pushUndo();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of targets) {
    const b = bboxInCanvas(el);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width  > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = axis === 'h' ? -1 : 1;
  const sy = axis === 'v' ? -1 : 1;
  const flip = `translate(${cx.toFixed(3)},${cy.toFixed(3)}) scale(${sx},${sy}) translate(${(-cx).toFixed(3)},${(-cy).toFixed(3)})`;
  for (const el of targets) {
    const cur = el.getAttribute('transform') || '';
    el.setAttribute('transform', cur ? `${flip} ${cur}` : flip);
  }
  updateHandles();
  refreshElementList();
}

function duplicateSelection() {
  const src = selection.filter(el => !el.dataset.locked);
  if (!src.length) return;
  pushUndo();
  const clones = [];
  for (const el of src) {
    const c = el.cloneNode(true);
    svgCanvas.insertBefore(c, handlesGroup);
    clones.push(c);
  }
  selection = clones;
  updateHandles();
  refreshElementList();
}

function deleteSelection() {
  const targets = selection.filter(el => !el.dataset.locked);
  if (!targets.length) return;
  pushUndo();
  for (const el of targets) svgCanvas.removeChild(el);
  selection = selection.filter(el => el.dataset.locked); // keep locked ones in selection
  if (!selection.length) clearSelection();
  else { updateHandles(); refreshElementList(); populateProps(selection[0] || null); }
}

function bringSelectionToFront() {
  const targets = selection.filter(el => !el.dataset.locked);
  if (!targets.length) return;
  pushUndo();
  for (const el of targets) svgCanvas.insertBefore(el, handlesGroup);
  refreshElementList();
  updateHandles();
}

function sendSelectionToBack() {
  const targets = selection.filter(el => !el.dataset.locked);
  if (!targets.length) return;
  pushUndo();
  const bg = svgCanvas.querySelector(':scope > [data-bg="1"]');
  const insertPoint = bg ? bg.nextSibling : svgCanvas.firstChild;
  for (let i = 0; i < targets.length; i++) {
    svgCanvas.insertBefore(targets[i], insertPoint);
  }
  refreshElementList();
  updateHandles();
}

// =============================================================
// Organisation — Group / Ungroup, Lock, Hide
// =============================================================

function groupSelection() {
  const ordered = Array.from(svgCanvas.children).filter(c => selection.includes(c));
  if (ordered.length < 2) return;
  pushUndo();
  const g = document.createElementNS(SVG_NS, 'g');
  const topmost = ordered[ordered.length - 1];
  svgCanvas.insertBefore(g, topmost.nextSibling);
  for (const child of ordered) g.appendChild(child);
  selection = [g];
  updateHandles();
  refreshElementList();
  populateProps(g);
}

function ungroupSelection() {
  const groups = selection.filter(el => el.tagName === 'g' && !el.dataset.locked);
  if (!groups.length) return;
  pushUndo();
  const freed = [];
  for (const g of groups) {
    const cons = g.transform.baseVal.consolidate();
    const gm = cons ? cons.matrix : null;
    const parent = g.parentNode;
    for (const child of Array.from(g.children)) {
      if (gm) {
        // Bake the group's matrix into each child so its visual position survives.
        const ccons = child.transform.baseVal.consolidate();
        const cm = ccons ? ccons.matrix : svgCanvas.createSVGMatrix();
        const composed = gm.multiply(cm);
        child.setAttribute('transform',
          `matrix(${composed.a},${composed.b},${composed.c},${composed.d},${composed.e},${composed.f})`);
      }
      parent.insertBefore(child, g);
      freed.push(child);
    }
    g.remove();
  }
  selection = freed;
  updateHandles();
  handlesGroup.style.display = selection.length ? '' : 'none';
  refreshElementList();
  if (selection.length === 1) populateProps(selection[0]);
  else if (selection.length > 1) renderMultiSelectProps(selection.length);
}

function setElLocked(el, locked) {
  if (locked) el.dataset.locked = '1';
  else delete el.dataset.locked;
}

function setElHidden(el, hidden) {
  if (hidden) {
    el.dataset.hidden = '1';
    el.style.display = 'none';
  } else {
    delete el.dataset.hidden;
    el.style.display = '';
  }
}

function toggleSelectionLock() {
  if (!selection.length) return;
  pushUndo();
  const allLocked = selection.every(el => el.dataset.locked);
  for (const el of selection) setElLocked(el, !allLocked);
  refreshElementList();
}

function toggleSelectionHidden() {
  if (!selection.length) return;
  pushUndo();
  const allHidden = selection.every(el => el.dataset.hidden);
  for (const el of selection) setElHidden(el, !allHidden);
  updateHandles();
  refreshElementList();
}

// Right-click context menu
const ctxMenu = document.getElementById('ctxMenu');
function buildCtxMenu(hasSelection) {
  ctxMenu.innerHTML = '';
  const mk = (label, shortcut, handler, opts = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    const left = document.createElement('span'); left.textContent = label;
    const right = document.createElement('span'); right.className = 'shortcut'; right.textContent = shortcut || '';
    b.appendChild(left); b.appendChild(right);
    if (opts.danger) b.classList.add('danger');
    if (opts.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeContextMenu(); handler(); });
    ctxMenu.appendChild(b);
  };
  const sep = () => {
    const d = document.createElement('div');
    d.className = 'sep';
    ctxMenu.appendChild(d);
  };
  const hasClip = !!localClipboardMarkup;
  const canGroup = selection.length >= 2;
  const canUngroup = selection.some(el => el.tagName === 'g');
  const allLocked = hasSelection && selection.every(el => el.dataset.locked);
  const allHidden = hasSelection && selection.every(el => el.dataset.hidden);
  mk('Group',    'Ctrl+G',       () => groupSelection(),   { disabled: !canGroup });
  mk('Ungroup',  'Ctrl+Shift+G', () => ungroupSelection(), { disabled: !canUngroup });
  sep();
  mk(allLocked ? 'Unlock' : 'Lock', '',  () => toggleSelectionLock(),   { disabled: !hasSelection });
  mk(allHidden ? 'Show'   : 'Hide', '',  () => toggleSelectionHidden(), { disabled: !hasSelection });
  sep();
  mk('Flip horizontally', '', () => flipSelection('h'), { disabled: !hasSelection });
  mk('Flip vertically',   '', () => flipSelection('v'), { disabled: !hasSelection });
  sep();
  mk('Duplicate', 'Ctrl+D', () => duplicateSelection(),          { disabled: !hasSelection });
  mk('Copy',      'Ctrl+C', () => copySelectionToClipboard(),    { disabled: !hasSelection });
  mk('Paste',     'Ctrl+V', () => pasteClipboardMarkup(localClipboardMarkup), { disabled: !hasClip });
  mk('Delete',    'Del',    () => deleteSelection(),             { disabled: !hasSelection, danger: true });
  sep();
  mk('Bring to front', '', () => bringSelectionToFront(), { disabled: !hasSelection });
  mk('Send to back',   '', () => sendSelectionToBack(),   { disabled: !hasSelection });
}

function openContextMenu(e, hitEl) {
  if (hitEl && !selection.includes(hitEl)) selectElement(hitEl);
  buildCtxMenu(selection.length > 0);
  ctxMenu.classList.remove('hidden');
  const w = ctxMenu.offsetWidth || 200;
  const h = ctxMenu.offsetHeight || 240;
  const left = Math.min(e.clientX, window.innerWidth - w - 8);
  const top  = Math.min(e.clientY, window.innerHeight - h - 8);
  ctxMenu.style.left = Math.max(4, left) + 'px';
  ctxMenu.style.top  = Math.max(4, top) + 'px';
}
function closeContextMenu() { ctxMenu.classList.add('hidden'); }

// Sidebar drawings-list context menu — reuses the same #ctxMenu element with
// custom actions (Rename, Remove).
function openDrawingContextMenu(e, name) {
  ctxMenu.innerHTML = '';
  const mk = (label, shortcut, handler, opts = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    const left = document.createElement('span'); left.textContent = label;
    const right = document.createElement('span'); right.className = 'shortcut'; right.textContent = shortcut || '';
    b.appendChild(left); b.appendChild(right);
    if (opts.danger) b.classList.add('danger');
    b.addEventListener('click', () => { closeContextMenu(); handler(); });
    ctxMenu.appendChild(b);
  };
  mk('Open',    '', () => loadDrawing(name));
  mk('Rename',  '', () => openRenameDialog(name));
  mk('Remove',  'Del', () => removeDrawing(name), { danger: true });
  ctxMenu.classList.remove('hidden');
  const w = ctxMenu.offsetWidth || 180;
  const h = ctxMenu.offsetHeight || 120;
  const left = Math.min(e.clientX, window.innerWidth - w - 8);
  const top  = Math.min(e.clientY, window.innerHeight - h - 8);
  ctxMenu.style.left = Math.max(4, left) + 'px';
  ctxMenu.style.top  = Math.max(4, top) + 'px';
}
document.addEventListener('mousedown', (e) => {
  if (ctxMenu.classList.contains('hidden')) return;
  if (!ctxMenu.contains(e.target)) closeContextMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ctxMenu.classList.contains('hidden')) closeContextMenu();
});
svgCanvas.addEventListener('contextmenu', (e) => {
  let tgt = e.target;
  if (tgt.parentNode && tgt.parentNode.tagName === 'text') tgt = tgt.parentNode;
  // Mirror the left-click promotion: walk up to the outermost element that
  // is a direct child of svgCanvas so right-clicking inside a <g> selects
  // the whole group, not an individual child.
  while (tgt && tgt.parentNode && tgt.parentNode !== svgCanvas) {
    tgt = tgt.parentNode;
  }
  const isEmpty = !tgt || tgt === svgCanvas || tgt === boundsRect ||
                  (tgt.dataset && (tgt.dataset.bounds || tgt.dataset.bg || tgt.dataset.marquee));
  e.preventDefault();
  openContextMenu(e, isEmpty ? null : tgt);
});

// Internal copy/paste. Ctrl+V uses the existing window paste handler below;
// this path wraps the selection in a marker <svg data-freegma-clip> so we
// can recognise our own payload and ignore arbitrary clipboard text.
let localClipboardMarkup = null;

function copySelectionToClipboard() {
  if (!selection.length) return;
  const wrapper = document.createElementNS(SVG_NS, 'svg');
  wrapper.setAttribute('xmlns', SVG_NS);
  wrapper.setAttribute('data-freegma-clip', '1');
  for (const el of selection) wrapper.appendChild(el.cloneNode(true));
  const markup = wrapper.outerHTML;
  localClipboardMarkup = markup;
  // Best-effort system clipboard write so cross-tab / cross-drawing paste
  // works. writeText can fail on older browsers / insecure contexts — the
  // in-memory fallback covers us in that case.
  try { navigator.clipboard.writeText(markup); } catch {}
}

function pasteClipboardMarkup(markup) {
  if (!markup) return 0;
  const tmp = document.createElement('div');
  tmp.innerHTML = markup;
  const root = tmp.querySelector('svg[data-freegma-clip]') || tmp.querySelector('svg');
  if (!root) return 0;
  pushUndo();
  const pasted = [];
  for (const child of Array.from(root.children)) {
    if (['defs', 'title', 'desc', 'style'].includes(child.tagName)) continue;
    const node = child.cloneNode(true);
    svgCanvas.insertBefore(node, handlesGroup);
    pasted.push(node);
  }
  // Position pasted shapes at the cursor when possible — measure the union
  // bbox of the paste and translate so its centre lands on the last known
  // cursor position. Falls back to a small diagonal nudge so the paste
  // never lands exactly on top of the originals.
  let dx, dy;
  if (lastCursorSvgPt) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of pasted) {
      const bb = bboxInCanvas(el);
      if (!isFinite(bb.width) || !isFinite(bb.height)) continue;
      if (bb.x < minX) minX = bb.x;
      if (bb.y < minY) minY = bb.y;
      if (bb.x + bb.width  > maxX) maxX = bb.x + bb.width;
      if (bb.y + bb.height > maxY) maxY = bb.y + bb.height;
    }
    if (isFinite(minX)) {
      dx = lastCursorSvgPt.x - (minX + maxX) / 2;
      dy = lastCursorSvgPt.y - (minY + maxY) / 2;
    }
  }
  if (dx == null) {
    const step = Math.max(6, Math.min(currentW, currentH) * 0.02);
    dx = step; dy = step;
  }
  for (const el of pasted) moveElement(el, dx, dy);
  persistCurrent();
  refreshElementList();
  selection = pasted;
  updateHandles();
  handlesGroup.style.display = selection.length ? '' : 'none';
  if (selection.length === 1) populateProps(selection[0]);
  else if (selection.length > 1) renderMultiSelectProps(selection.length);
  return pasted.length;
}

// =============================================================
// Add shape buttons (positions scale with canvas size)
// =============================================================

// Multi-line <text> support. SVG <text> ignores newlines, so we store each
// line as a child <tspan>. Subsequent tspans use x=[parent's x] to reset
// horizontal position and dy=1.2em to shift to the next line. Empty lines
// still advance position and render as blank rows.
function setMultilineText(el, text) {
  const parentX = el.getAttribute('x') || 0;
  while (el.firstChild) el.removeChild(el.firstChild);
  const lines = String(text).split('\n');
  if (lines.length === 1) {
    el.textContent = lines[0];
    return;
  }
  for (let i = 0; i < lines.length; i++) {
    const t = document.createElementNS(SVG_NS, 'tspan');
    t.setAttribute('x', parentX);
    t.setAttribute('dy', i === 0 ? '0' : '1.2em');
    if (lines[i]) t.textContent = lines[i];
    el.appendChild(t);
  }
}

function getMultilineText(el) {
  const tspans = el.querySelectorAll(':scope > tspan');
  if (tspans.length === 0) return el.textContent || '';
  return Array.from(tspans).map(t => t.textContent || '').join('\n');
}

// =============================================================
// Inline text editor — double-click a <text> to type directly on canvas.
// An HTML <textarea> overlay is positioned/styled to match the rendered
// text; the underlying SVG text is hidden during editing and kept in sync
// with every keystroke so changes commit live.
// =============================================================

let textEditOverlay = null;

function openTextInlineEditor(textEl) {
  closeTextInlineEditor();
  const rect = textEl.getBoundingClientRect();
  const canvasRect = canvasInner.getBoundingClientRect();
  // Use the real screen CTM rather than a simple width ratio — it accounts
  // for preserveAspectRatio and whatever zoom/pan the viewBox has. ctm.a
  // equals ctm.d for uniform aspect scaling.
  const ctm = svgCanvas.getScreenCTM();
  const pxPerUnit = ctm ? Math.abs(ctm.a) : (canvasInner.clientWidth / (vbW || 1));
  const fontSizeUser = parseFloat(textEl.getAttribute('font-size')) || 16;
  const fontSizePx = fontSizeUser * pxPerUnit;

  const ta = document.createElement('textarea');
  ta.className = 'inline-text-edit';
  ta.setAttribute('wrap', 'off');
  ta.value = getMultilineText(textEl);

  // Position exactly over the text. Match per-line height to rect.height /
  // lineCount so the textarea's line-boxes coincide with the SVG glyphs.
  const lineCount = Math.max(1, (getMultilineText(textEl) || '').split('\n').length);
  const perLine = rect.height / lineCount;
  ta.style.left   = (rect.left - canvasRect.left) + 'px';
  ta.style.top    = (rect.top  - canvasRect.top ) + 'px';
  ta.style.width  = rect.width + 'px';
  ta.style.height = rect.height + 'px';
  ta.style.lineHeight = perLine + 'px';
  ta.style.fontSize = fontSizePx + 'px';
  ta.style.lineHeight = '1.2';
  ta.style.fontFamily = textEl.getAttribute('font-family') || 'system-ui, sans-serif';
  ta.style.fontWeight = textEl.getAttribute('font-weight') || '400';
  const fillPaint = getPaint(textEl, 'fill');
  ta.style.color = fillPaint && fillPaint !== 'none' ? fillPaint : 'var(--tx)';
  ta.style.textAlign = ({ start: 'left', middle: 'center', end: 'right' })[textEl.getAttribute('text-anchor') || 'start'];

  // Hide the underlying text during editing so the glyphs don't show through.
  const prevVisibility = textEl.style.visibility;
  textEl.style.visibility = 'hidden';

  canvasInner.appendChild(ta);
  const outsideDown = (ev) => {
    if (!textEditOverlay || ev.target === textEditOverlay.ta) return;
    closeTextInlineEditor();
  };
  document.addEventListener('mousedown', outsideDown, true);
  textEditOverlay = { ta, textEl, prevVisibility, outsideDown };
  setTimeout(() => { ta.focus(); ta.select(); }, 0);

  const autosize = () => {
    // Reset both dimensions so scrollWidth/scrollHeight reflect the content,
    // not the previously-applied size.
    ta.style.width  = '10px';
    ta.style.height = 'auto';
    ta.style.width  = (ta.scrollWidth + 6) + 'px';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', () => {
    setMultilineText(textEl, ta.value);
    updateHandles();
    autosize();
  });
  setTimeout(autosize, 0);
  ta.addEventListener('blur', () => closeTextInlineEditor());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeTextInlineEditor(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeTextInlineEditor();
    }
  });
}

function closeTextInlineEditor() {
  if (!textEditOverlay) return;
  const { ta, textEl, prevVisibility, outsideDown } = textEditOverlay;
  textEl.style.visibility = prevVisibility || '';
  ta.remove();
  if (outsideDown) document.removeEventListener('mousedown', outsideDown, true);
  textEditOverlay = null;
  if (selection.includes(textEl)) populateProps(textEl);
}

svgCanvas.addEventListener('dblclick', (e) => {
  let t = e.target;
  if (t && t.parentNode && t.parentNode.tagName === 'text') t = t.parentNode;
  if (t && t.tagName === 'text') {
    e.preventDefault();
    openTextInlineEditor(t);
  }
});

function shapeDefaults(tag, px, py) {
  const cx = px != null ? px : currentW / 2;
  const cy = py != null ? py : currentH / 2;
  const s = Math.min(currentW, currentH);
  switch (tag) {
    case 'rect':    return { x: cx - s*0.1, y: cy - s*0.08, width: s*0.2, height: s*0.16 };
    case 'circle':  return { cx, cy, r: s * 0.1 };
    case 'ellipse': return { cx, cy, rx: s*0.12, ry: s*0.08 };
    case 'line':    return { x1: cx - s*0.1, y1: cy - s*0.1, x2: cx + s*0.1, y2: cy + s*0.1, 'stroke-width': Math.max(2, s*0.012) };
    case 'path':    return { d: `M${(cx-s*0.11).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy-s*0.11).toFixed(1)} L${(cx+s*0.11).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy+s*0.11).toFixed(1)} Z` };
    case 'text':    return { x: cx, y: cy, 'font-size': 14, 'font-family': 'system-ui, -apple-system, sans-serif' };
  }
  return {};
}

// Update geometry of an in-progress shape as the user drags from (x1,y1) to (x2,y2).
function setDrawGeometry(el, tag, x1, y1, x2, y2) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  if (tag === 'rect') {
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('width', Math.max(0, w)); el.setAttribute('height', Math.max(0, h));
  } else if (tag === 'circle') {
    const r = Math.min(w, h) / 2;
    el.setAttribute('cx', x + w / 2); el.setAttribute('cy', y + h / 2);
    el.setAttribute('r', Math.max(0, r));
  } else if (tag === 'ellipse') {
    el.setAttribute('cx', x + w / 2); el.setAttribute('cy', y + h / 2);
    el.setAttribute('rx', Math.max(0, w / 2)); el.setAttribute('ry', Math.max(0, h / 2));
  } else if (tag === 'line') {
    el.setAttribute('x1', x1); el.setAttribute('y1', y1);
    el.setAttribute('x2', x2); el.setAttribute('y2', y2);
  } else if (tag === 'path' && isArrow(el)) {
    // Arrow tool: keep the start at the click, end follows the drag.
    setArrow(el, { x1, y1, x2, y2 });
  } else if (tag === 'path') {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    el.setAttribute('d', `M${(cx-rx).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy-ry).toFixed(1)} L${(cx+rx).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy+ry).toFixed(1)} Z`);
  } else if (tag === 'text') {
    // Text has no drag-to-size — keep it anchored at the click point.
    el.setAttribute('x', x1);
    el.setAttribute('y', y1);
  }
}

const shapes = [
  { label: 'Rect',    tag: 'rect',    icon: '▭', hint: 'Click a point or drag to size a rectangle' },
  { label: 'Circle',  tag: 'circle',  icon: '◯', hint: 'Click a point or drag to size a circle' },
  { label: 'Ellipse', tag: 'ellipse', icon: '⬭', hint: 'Click a point or drag to size an ellipse' },
  { label: 'Line',    tag: 'line',    icon: '╱', hint: 'Click a point or drag from one end to the other (hold Shift for 0°/45°/90°)' },
  { label: 'Arrow',   tag: 'path',    icon: '→', hint: 'Drag to draw an arrow (hold Shift for 0°/45°/90°)', marker: 'arrow' },
  { label: 'Path',    tag: 'path',    icon: '✎', hint: 'Click a point or drag to size a diamond path (editable after)' },
  { label: 'Text',    tag: 'text',    icon: 'T', hint: 'Click the canvas to place text; edit content and font in the properties panel' },
];
const shapeButtons = [];
function enterDrawMode(tag, button, opts = {}) {
  if (pendingShape && pendingShape.button === button) { exitDrawMode(); return; }
  exitDrawMode();
  clearSelection();
  pendingShape = { tag, button, marker: opts.marker || null };
  button.classList.add('active');
  if (typeof selectBtn !== 'undefined') selectBtn.classList.remove('active');
  canvasInner.style.cursor = 'crosshair';
}
function exitDrawMode() {
  if (pendingShape) {
    pendingShape.button.classList.remove('active');
    pendingShape = null;
  }
  if (typeof selectBtn !== 'undefined') selectBtn.classList.add('active');
  if (!pan) canvasInner.style.cursor = '';
}
// Select tool — first button in the floating toolbar. Highlights when no
// shape tool is armed; clicking it also cancels draw mode.
const selectBtn = document.createElement('button');
selectBtn.type = 'button';
selectBtn.innerHTML = '↖';
selectBtn.dataset.hint = 'Select (cancel any armed tool)';
selectBtn.classList.add('active');
selectBtn.addEventListener('click', () => exitDrawMode());
addShapeRow.appendChild(selectBtn);

for (const s of shapes) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = s.icon;
  btn.dataset.hint = `${s.label} — ${s.hint}`;
  btn.dataset.tag = s.tag;
  btn.addEventListener('click', () => enterDrawMode(s.tag, btn, { marker: s.marker }));
  addShapeRow.appendChild(btn);
  shapeButtons.push(btn);
}

// =============================================================
// Size presets
// =============================================================

const PRESETS = [
  { label: '16', w: 16, h: 16 },
  { label: '24', w: 24, h: 24 },
  { label: '48', w: 48, h: 48 },
  { label: '512', w: 512, h: 512 },
  { label: '1024', w: 1024, h: 1024 },
  { label: '16:9', w: 1920, h: 1080 },
];
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.dataset.hint = `Resize canvas to ${p.w}×${p.h} px`;
  b.addEventListener('click', () => setCanvasSize(p.w, p.h));
  sizePresets.appendChild(b);
}

canvasWInp.addEventListener('change', () => setCanvasSize(parseFloat(canvasWInp.value), currentH));
canvasHInp.addEventListener('change', () => setCanvasSize(currentW, parseFloat(canvasHInp.value)));

// =============================================================
// Top bar buttons
// =============================================================

document.getElementById('btnNew').addEventListener('click', openNewDialog);

// New drawing dialog
const newDialog      = document.getElementById('newDialog');
const newW           = document.getElementById('newW');
const newH           = document.getElementById('newH');
const newName        = document.getElementById('newName');
const newError       = document.getElementById('newError');
const newPresetGrid  = document.getElementById('newPresetGrid');

const NEW_PRESETS = [
  { label: 'Icon 16',    w: 16,   h: 16   },
  { label: 'Icon 24',    w: 24,   h: 24   },
  { label: 'Icon 48',    w: 48,   h: 48   },
  { label: 'Square',     w: 512,  h: 512  },
  { label: 'Square 2×',  w: 1024, h: 1024 },
  { label: 'Widescreen', w: 1920, h: 1080 },
  { label: 'IG Feed 4:5',w: 1080, h: 1350 },
  { label: 'IG Story 9:16', w: 1080, h: 1920 },
  { label: 'X Banner',   w: 1500, h: 500  },
  { label: 'YT Thumb',   w: 1280, h: 720  },
  { label: 'YT Banner',  w: 2560, h: 1440 },
  { label: 'Discord Banner', w: 680, h: 240 },
  { label: 'A4 @300dpi', w: 2480, h: 3508 },
];

function renderNewPresets() {
  newPresetGrid.innerHTML = '';
  const selW = +newW.value, selH = +newH.value;
  for (const p of NEW_PRESETS) {
    const t = document.createElement('button');
    t.type = 'button';
    const active = p.w === selW && p.h === selH;
    t.className = 'new-size-tile' + (active ? ' active' : '');
    const shape = document.createElement('div'); shape.className = 'tile-shape';
    const aspect = document.createElement('div'); aspect.className = 'tile-aspect';
    const maxD = 28;
    const ratio = p.w / p.h;
    const aw = ratio >= 1 ? maxD : Math.round(maxD * ratio);
    const ah = ratio >= 1 ? Math.round(maxD / ratio) : maxD;
    aspect.style.width  = Math.max(6, aw) + 'px';
    aspect.style.height = Math.max(6, ah) + 'px';
    shape.appendChild(aspect);
    const lbl = document.createElement('div'); lbl.className = 'tile-label'; lbl.textContent = p.label;
    const dim = document.createElement('div'); dim.className = 'tile-dim';   dim.textContent = `${p.w}×${p.h}`;
    t.appendChild(shape); t.appendChild(lbl); t.appendChild(dim);
    t.addEventListener('click', () => {
      newW.value = String(p.w);
      newH.value = String(p.h);
      renderNewPresets();
    });
    newPresetGrid.appendChild(t);
  }
}

function openNewDialog() {
  newW.value = String(currentW || 512);
  newH.value = String(currentH || 512);
  newName.value = '';
  newError.style.display = 'none';
  newError.textContent = '';
  renderNewPresets();
  newDialog.classList.remove('hidden');
  setTimeout(() => { newW.focus(); newW.select(); }, 0);
}
function closeNewDialog() { newDialog.classList.add('hidden'); }
function commitNewDialog() {
  const w = parseInt(newW.value, 10);
  const h = parseInt(newH.value, 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 100000 || h > 100000) {
    newError.textContent = 'Width and height must be whole numbers between 1 and 100000.';
    newError.style.display = '';
    return;
  }
  const raw = (newName.value || '').trim();
  const name = raw ? sanitizeName(raw) : null;
  if (name && drawings[name]) {
    newError.textContent = `"${name}" is already taken.`;
    newError.style.display = '';
    return;
  }
  closeNewDialog();
  newDrawing(w, h, name);
}

newW.addEventListener('input', renderNewPresets);
newH.addEventListener('input', renderNewPresets);
document.getElementById('newCancel').addEventListener('click', closeNewDialog);
document.getElementById('newOk').addEventListener('click', commitNewDialog);
newDialog.addEventListener('click', (e) => { if (e.target === newDialog) closeNewDialog(); });
for (const inp of [newW, newH, newName]) {
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitNewDialog(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNewDialog(); }
  });
}
const exportMenu = document.getElementById('exportMenu');
document.getElementById('btnExport').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle('hidden');
});
exportMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.menu-item');
  if (!btn) return;
  exportMenu.classList.add('hidden');
  const fmt = btn.dataset.format;
  if (fmt === 'svg') exportSvg();
  else if (fmt === 'png') exportRaster('image/png');
  else if (fmt === 'webp') exportRaster('image/webp');
  else if (fmt === 'jpeg') exportRaster('image/jpeg');
});
window.addEventListener('click', () => exportMenu.classList.add('hidden'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !exportMenu.classList.contains('hidden')) exportMenu.classList.add('hidden');
});

// Rename dialog refs + wiring. Rows in the drawings list open this via dblclick.
const renameDialog        = document.getElementById('renameDialog');
const renameInput         = document.getElementById('renameInput');
const renameCurrentNameEl = document.getElementById('renameCurrentName');
const renameError         = document.getElementById('renameError');
let renameTargetName = null;
document.getElementById('renameCancel').addEventListener('click', closeRenameDialog);
document.getElementById('renameOk').addEventListener('click', commitRename);
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
  if (e.key === 'Escape') { e.preventDefault(); closeRenameDialog(); }
});
renameDialog.addEventListener('click', (e) => {
  if (e.target === renameDialog) closeRenameDialog();
});

// Changelog dialog — opened from the top bar button, dismissed via Esc,
// backdrop, or the Close button.
const CHANGELOG = [
  { date: '2026-04-22', items: [
    'Fixed image resize: pasted / imported raster images now resize by updating x/y/width/height directly (like rects) instead of stacking a transform, so a move after a resize no longer snaps the image back.',
  ]},
  { date: '2026-04-21', items: [
    'Auto-save to localStorage — drawings and the last-open tab survive reload / tab close. Boot restores from storage before falling back to the built-in starter icons; a beforeunload flush keeps rapid tab-closes from dropping the latest edit.',
    'Keyboard shortcut overlay (press "?" or click the keyboard icon in the top bar) with Figma-style tool shortcuts: V select, R rect, O ellipse, C circle, L line, A arrow, P path, T text.',
  ]},
  { date: '2026-04-20', items: [
    'Effects section in the properties panel: toggle a drop shadow (X / Y offset, blur, color, opacity) and gaussian blur (radius) per shape. Rendered via SVG <filter>, so exports carry the effect faithfully.',
    'Gradient fills in the color picker: Solid / Linear / Radial tabs, checker-backed preview bar with draggable stops (click to add, Del to remove), angle slider for linear, and the SV/hue/hex editor + palette + eyedropper all route to the active stop.',
    'Hold Shift while drawing a rect or ellipse to constrain to a square / circle (line and arrow already snapped to 0°/45°/90°).',
  ]},
  { date: '2026-04-19', items: [
    'Double-click any text on the canvas to edit it in place — font, size, color, and alignment all preserved. Type to update live; newlines become <tspan>s automatically. Esc / click outside / Ctrl-Cmd+Enter to commit.',
    'Paste (Ctrl+V) now drops shapes and clipboard images at the cursor rather than a fixed offset.',
  ]},
  { date: '2026-04-18', items: [
    'Arrow tool rebuilt as a single filled polygon <path> — no more marker quirks, tight selection bbox, properties for start / end / body thickness / head size.',
    'Group / Ungroup (Ctrl+G / Ctrl+Shift+G). Groups move, resize, and rotate as one unit.',
    'Layers panel: per-row show/hide (eye) and lock (padlock) toggles; expandable group rows with indented children; drag-and-drop across groups (before / after / into).',
    'Right-click context menu with Group / Ungroup / Lock / Hide / Flip / Duplicate / Copy / Paste / Bring-to-front / Send-to-back; also available on drawing rows (Open / Rename / Remove) and layer rows.',
    'Alt+drag on a selection duplicates it (Figma-style) while dragging; right-click no longer shows the browser menu in app chrome (kept in text inputs).',
    'Pan now uses the middle mouse button so right-click is free for the context menu.',
    'Shape tools moved into a Figma-style floating pill toolbar at the bottom of the canvas.',
    'Curated Google Fonts (Inter, Roboto, Poppins, Montserrat, Oswald, Playfair Display, Lora, DM Sans, Space Mono, Fira Code). SVG export embeds @import for fonts in use; PNG / WebP / JPEG inlines each woff2 as base64 so rasters carry the typeface.',
    'Shape copy/paste across drawings with Ctrl+C / Ctrl+V; marker <svg data-freegma-clip> wrapper on the system clipboard so we only react to our own payload.',
    'Anti-aliasing seam between abutting rects removed (shape-rendering: crispEdges).',
    'Changelog dialog (you\'re looking at it), Discord Banner 680×240 preset.',
    'Disabled browser/CDN caching on the static assets so new builds land on first reload.',
  ]},
  { date: '2026-04-17', items: [
    'Text tool with multi-line (Enter inserts line breaks via <tspan>), font family / size / weight / alignment, corner-drag resizes the font-size.',
    'Align & distribute toolbar appears when 2+ shapes selected: align L/C/R/T/M/B and distribute equal H / V gaps.',
    'Drag-and-drop file import — drop .svg / .png / .jpg / .webp onto the canvas.',
    'Distance pills on alignment guides; equal-spacing detection highlights matching gaps; resize-time guides; marquee selection on empty canvas (Ctrl-drag to add).',
    'Styled "new drawing" preset dialog with aspect-ratio tiles (Icons, Squares, Widescreen, IG Feed / Story, X banner, YT Thumb / Banner, A4).',
    'Double-click a drawing in the sidebar to rename; select + Del to remove (styled confirm dialog).',
    'Freegma "F" logo in the header and favicon; repositioned as a browser graphics tool.',
    'Bug fixes: circle resize on mixed-quadrant handles; Backspace on empty rect-like inputs no longer deletes the shape.',
  ]},
  { date: '2026-04-16', items: [
    'Initial release: vector canvas with rect / circle / ellipse / line / path tools, per-corner rounded rects, undo/redo, pan/zoom, multi-drawing sidebar, Import / Export SVG.',
    'Custom color picker popover with SV square, hue bar, hex input, eyedropper (samples pixels from pasted <image> elements via offscreen canvas), and an "In this drawing" palette that includes dominant colors from images.',
    'Canvas Fill swatch paints the drawing background.',
    'Paste raster images with Ctrl+V anywhere on the canvas.',
    'Export to PNG (lossless), WebP (smaller, near-lossless), JPEG.',
    'GitHub link in the top bar with live star count.',
    'Social preview meta tags (Open Graph + Twitter Card) with og-image at 1200×630.',
    'Renamed to Freegma, MIT license.',
  ]},
];

// Keyboard shortcuts dialog, opened with `?` or from the top bar.
const SHORTCUTS = [
  { group: 'Tools', items: [
    { keys: ['V'],  label: 'Select (cancel tool)' },
    { keys: ['R'],  label: 'Rectangle' },
    { keys: ['O'],  label: 'Ellipse' },
    { keys: ['C'],  label: 'Circle' },
    { keys: ['L'],  label: 'Line' },
    { keys: ['A'],  label: 'Arrow' },
    { keys: ['P'],  label: 'Pen / Path' },
    { keys: ['T'],  label: 'Text' },
  ]},
  { group: 'View', items: [
    { keys: ['Scroll'],         label: 'Zoom at cursor' },
    { keys: ['Middle-drag'],    label: 'Pan the canvas' },
  ]},
  { group: 'Edit', items: [
    { keys: ['⌘', 'Z'],         label: 'Undo' },
    { keys: ['⌘', 'Shift', 'Z'],label: 'Redo' },
    { keys: ['⌘', 'D'],         label: 'Duplicate in place' },
    { keys: ['Alt-drag'],       label: 'Duplicate and drag' },
    { keys: ['⌘', 'C'],         label: 'Copy' },
    { keys: ['⌘', 'V'],         label: 'Paste at cursor' },
    { keys: ['Del'],            label: 'Delete selection' },
  ]},
  { group: 'Selection', items: [
    { keys: ['Click'],          label: 'Select shape' },
    { keys: ['⌘', 'Click'],     label: 'Add / remove from selection' },
    { keys: ['Drag'],           label: 'Marquee (empty canvas)' },
    { keys: ['Esc'],            label: 'Deselect / cancel' },
    { keys: ['Dbl-click'],      label: 'Edit text / rename' },
  ]},
  { group: 'Arrange', items: [
    { keys: ['⌘', 'G'],         label: 'Group' },
    { keys: ['⌘', 'Shift', 'G'],label: 'Ungroup' },
    { keys: ['Arrows'],         label: 'Nudge 1 px' },
    { keys: ['Shift', 'Arrows'],label: 'Nudge 10 px' },
  ]},
  { group: 'Drawing', items: [
    { keys: ['Shift-drag'],     label: '45° line / square / circle' },
    { keys: ['Alt-click'],      label: 'Add path anchor' },
    { keys: ['Del'],            label: 'Remove path anchor' },
  ]},
  { group: 'General', items: [
    { keys: ['?'],              label: 'Show this overlay' },
    { keys: ['Right-click'],    label: 'Context menu' },
  ]},
];

const shortcutsDialog = document.getElementById('shortcutsDialog');
const shortcutsBody   = document.getElementById('shortcutsBody');
function openShortcuts() {
  if (!shortcutsBody) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  shortcutsBody.innerHTML = '';
  for (const group of SHORTCUTS) {
    const col = document.createElement('div');
    col.className = 'shortcuts-group';
    const h = document.createElement('div');
    h.className = 'shortcuts-title';
    h.textContent = group.group;
    col.appendChild(h);
    for (const row of group.items) {
      const r = document.createElement('div');
      r.className = 'shortcut-row';
      const lbl = document.createElement('span');
      lbl.className = 'label';
      lbl.textContent = row.label;
      const keys = document.createElement('span');
      keys.className = 'keys';
      row.keys.forEach((k, i) => {
        if (i > 0) {
          const plus = document.createElement('span');
          plus.className = 'plus';
          plus.textContent = '+';
          keys.appendChild(plus);
        }
        const kbd = document.createElement('kbd');
        // Render the Cmd/Ctrl glyph per-platform.
        kbd.textContent = k === '⌘' ? (isMac ? '⌘' : 'Ctrl') : k;
        keys.appendChild(kbd);
      });
      r.appendChild(lbl);
      r.appendChild(keys);
      col.appendChild(r);
    }
    shortcutsBody.appendChild(col);
  }
  shortcutsDialog.classList.remove('hidden');
}
function closeShortcuts() { shortcutsDialog.classList.add('hidden'); }
document.getElementById('shortcutsClose').addEventListener('click', closeShortcuts);
document.getElementById('btnShortcuts').addEventListener('click', openShortcuts);
shortcutsDialog.addEventListener('click', (e) => { if (e.target === shortcutsDialog) closeShortcuts(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !shortcutsDialog.classList.contains('hidden')) closeShortcuts();
});

const changelogDialog = document.getElementById('changelogDialog');
const changelogBody   = document.getElementById('changelogBody');
function openChangelog() {
  changelogBody.innerHTML = '';
  for (const entry of CHANGELOG) {
    const section = document.createElement('section');
    section.className = 'changelog-entry';
    const head = document.createElement('header');
    head.className = 'changelog-entry-head';
    const date = document.createElement('span');
    date.className = 'changelog-date';
    date.textContent = entry.date;
    head.appendChild(date);
    if (entry.title) {
      const title = document.createElement('span');
      title.className = 'changelog-title';
      title.textContent = entry.title;
      head.appendChild(title);
    }
    section.appendChild(head);
    const list = document.createElement('ul');
    for (const item of entry.items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    section.appendChild(list);
    changelogBody.appendChild(section);
  }
  changelogDialog.classList.remove('hidden');
}
function closeChangelog() { changelogDialog.classList.add('hidden'); }
document.getElementById('btnChangelog').addEventListener('click', openChangelog);
document.getElementById('changelogClose').addEventListener('click', closeChangelog);
changelogDialog.addEventListener('click', (e) => { if (e.target === changelogDialog) closeChangelog(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !changelogDialog.classList.contains('hidden')) closeChangelog();
});

// Confirm dialog (Promise-based replacement for window.confirm)
const confirmDialog  = document.getElementById('confirmDialog');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const confirmOk      = document.getElementById('confirmOk');
const confirmCancel  = document.getElementById('confirmCancel');
let confirmResolve = null;
function showConfirm({ title = 'Confirm', message = '', confirmText = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    confirmTitle.textContent   = title;
    confirmMessage.textContent = message;
    confirmOk.textContent      = confirmText;
    confirmDialog.classList.remove('hidden');
    confirmResolve = resolve;
    setTimeout(() => confirmOk.focus(), 0);
  });
}
function closeConfirm(value) {
  confirmDialog.classList.add('hidden');
  const r = confirmResolve; confirmResolve = null;
  if (r) r(value);
}
confirmOk.addEventListener('click',     () => closeConfirm(true));
confirmCancel.addEventListener('click', () => closeConfirm(false));
confirmDialog.addEventListener('click', (e) => { if (e.target === confirmDialog) closeConfirm(false); });
document.addEventListener('keydown', (e) => {
  if (confirmDialog.classList.contains('hidden')) return;
  if (e.key === 'Enter')  { e.preventDefault(); closeConfirm(true); }
  if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
}, true);
document.getElementById('btnScale').addEventListener('click', () => {
  const raw = prompt(`Scale drawing — new size (WxH or single factor like "2x"):`, `${currentW}x${currentH}`);
  if (raw === null) return;
  const t = String(raw).trim();
  let newW, newH;
  const mx = t.match(/^([\d.]+)\s*x$/i);              // "2x"
  const mm = t.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);     // "1024x1024"
  if (mx) { const f = parseFloat(mx[1]); newW = currentW * f; newH = currentH * f; }
  else if (mm) { newW = +mm[1]; newH = +mm[2]; }
  else { alert(`Use "1024x1024" or "2x"`); return; }
  scaleDrawing(newW, newH);
});

// =============================================================
// Import dialog
// =============================================================

function addDrawingFromSvg(name, svg) {
  name = sanitizeName(name);
  if (!name) return null;
  const { width, height } = extractSize(svg);
  drawings[name] = { svg, width, height };
  return name;
}

const importDialog  = document.getElementById('importDialog');
const importFileInp = document.getElementById('importFile');
const importTextTA  = document.getElementById('importText');
const importNameInp = document.getElementById('importName');

document.getElementById('btnImport').addEventListener('click', () => {
  importFileInp.value = '';
  importTextTA.value = '';
  importNameInp.value = '';
  const newRadio = document.querySelector('input[name="importMode"][value="new"]');
  if (newRadio) newRadio.checked = true;
  importDialog.classList.remove('hidden');
});
document.getElementById('importCancel').addEventListener('click', () => importDialog.classList.add('hidden'));

function appendSvgIntoCurrent(svgText) {
  const tmp = document.createElement('div');
  tmp.innerHTML = svgText;
  const srcSvg = tmp.querySelector('svg');
  if (!srcSvg) return 0;
  let count = 0;
  for (const child of Array.from(srcSvg.children)) {
    if (child.tagName === 'defs' || child.tagName === 'title' || child.tagName === 'desc') continue;
    svgCanvas.insertBefore(child.cloneNode(true), handlesGroup);
    count++;
  }
  return count;
}

document.getElementById('importOk').addEventListener('click', async () => {
  const files = Array.from(importFileInp.files || []);
  const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'new';

  if (mode === 'current') {
    let added = 0;
    pushUndo();
    if (files.length > 0) {
      for (const f of files) {
        const text = await f.text();
        if (!text.includes('<svg')) continue;
        added += appendSvgIntoCurrent(text);
      }
    } else {
      const svg = importTextTA.value.trim();
      if (!svg.includes('<svg')) { alert('Invalid SVG markup'); return; }
      added += appendSvgIntoCurrent(svg);
    }
    importDialog.classList.add('hidden');
    if (added > 0) { persistCurrent(); refreshElementList(); refreshIconList(); }
    return;
  }

  let lastLoaded = null;
  if (files.length > 0) {
    for (const f of files) {
      const text = await f.text();
      if (!text.includes('<svg')) continue;
      const base = f.name.replace(/\.svg$/i, '');
      const n = addDrawingFromSvg(base, text);
      if (n) lastLoaded = n;
    }
  } else {
    const svg = importTextTA.value.trim();
    const nameRaw = importNameInp.value.trim();
    if (!svg.includes('<svg')) { alert('Invalid SVG markup'); return; }
    if (!nameRaw) { alert('Name is required when pasting markup'); return; }
    const n = addDrawingFromSvg(nameRaw, svg);
    if (n) lastLoaded = n;
  }

  importDialog.classList.add('hidden');
  if (lastLoaded) loadDrawing(lastLoaded);
  else refreshIconList();
});

// =============================================================
// Floating hover hint (appended to <body>, positioned with viewport clamp)
// =============================================================

const hintTip = document.createElement('div');
hintTip.id = 'hintTip';
document.body.appendChild(hintTip);

function showHint(target) {
  hintTip.textContent = target.dataset.hint;
  hintTip.style.display = 'block';
  const r = target.getBoundingClientRect();
  const tr = hintTip.getBoundingClientRect();
  const margin = 6;
  let left = r.left + r.width / 2 - tr.width / 2;
  let top  = r.bottom + margin;
  left = Math.max(margin, Math.min(left, window.innerWidth - tr.width - margin));
  if (top + tr.height > window.innerHeight - margin) top = r.top - tr.height - margin;
  hintTip.style.left = `${left}px`;
  hintTip.style.top  = `${top}px`;
}
function hideHint() { hintTip.style.display = 'none'; }

document.addEventListener('mouseover', (e) => {
  const t = e.target.closest && e.target.closest('[data-hint]');
  if (t) showHint(t);
});
document.addEventListener('mouseout', (e) => {
  const t = e.target.closest && e.target.closest('[data-hint]');
  if (t) hideHint();
});
window.addEventListener('blur', hideHint);
window.addEventListener('scroll', hideHint, true);

// =============================================================
// Paste images from clipboard
// =============================================================

window.addEventListener('paste', (e) => {
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => addImageToCanvas(
        String(reader.result),
        lastCursorSvgPt ? lastCursorSvgPt.x : undefined,
        lastCursorSvgPt ? lastCursorSvgPt.y : undefined,
      );
      reader.readAsDataURL(file);
      return;
    }
  }
  // Internal shape paste — accept clipboard text with our marker, or fall
  // back to the in-memory copy when the system clipboard text came from us
  // earlier but is now empty (e.g. user copied without granting perms).
  const text = e.clipboardData.getData('text/plain');
  if (text && /data-freegma-clip/.test(text)) {
    e.preventDefault();
    pasteClipboardMarkup(text);
  } else if (!text && localClipboardMarkup) {
    e.preventDefault();
    pasteClipboardMarkup(localClipboardMarkup);
  }
});

function addImageToCanvas(dataUrl, centerX, centerY) {
  const img = new Image();
  img.onload = () => {
    pushUndo();
    const nw = img.naturalWidth  || 100;
    const nh = img.naturalHeight || 100;
    const ratio = Math.min(currentW * 0.8 / nw, currentH * 0.8 / nh, 1);
    const w = nw * ratio;
    const h = nh * ratio;
    const cx = Number.isFinite(centerX) ? centerX : currentW / 2;
    const cy = Number.isFinite(centerY) ? centerY : currentH / 2;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const el = document.createElementNS(SVG_NS, 'image');
    el.setAttribute('x', x.toFixed(1));
    el.setAttribute('y', y.toFixed(1));
    el.setAttribute('width',  w.toFixed(1));
    el.setAttribute('height', h.toFixed(1));
    el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    el.setAttribute('href', dataUrl);
    svgCanvas.insertBefore(el, handlesGroup);
    persistCurrent();
    selectElement(el);
  };
  img.onerror = () => alert('Could not load pasted image.');
  img.src = dataUrl;
}

// =============================================================
// Drag & drop file import
// =============================================================

canvasInner.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  canvasInner.classList.add('drop-hover');
});
canvasInner.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  canvasInner.classList.add('drop-hover');
});
canvasInner.addEventListener('dragleave', (e) => {
  if (e.target === canvasInner) canvasInner.classList.remove('drop-hover');
});
canvasInner.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  canvasInner.classList.remove('drop-hover');
  const files = Array.from(e.dataTransfer.files);
  const sp = svgPt(e);
  const isSvg   = (f) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);
  const isImage = (f) => f.type.startsWith('image/') && !isSvg(f);
  const svgFiles = files.filter(isSvg);
  const imgFiles = files.filter(isImage);

  if (svgFiles.length) {
    pushUndo();
    let added = 0;
    for (const f of svgFiles) {
      try {
        const text = await f.text();
        added += appendSvgIntoCurrent(text);
      } catch {}
    }
    if (added > 0) {
      persistCurrent();
      refreshElementList();
      refreshIconList();
    }
  }
  for (let i = 0; i < imgFiles.length; i++) {
    const f = imgFiles[i];
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      addImageToCanvas(dataUrl, sp.x + i * 10, sp.y + i * 10);
    } catch {}
  }
});

// Prevent the browser from navigating to the file when a drop lands outside
// the canvas (e.g. on the sidebar or top bar).
['dragover', 'drop'].forEach(t => {
  window.addEventListener(t, (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    if (!canvasInner.contains(e.target)) e.preventDefault();
  });
});

// =============================================================
// GitHub star count badge
// =============================================================

(async function loadGithubStars() {
  const badge = document.getElementById('ghStars');
  const link  = document.querySelector('.gh-link');
  if (!badge || !link) return;
  const repo = link.dataset.repo;
  if (!repo) return;
  const countEl = badge.querySelector('.gh-stars-count');
  const cacheKey = `ghStars:${repo}`;
  const ttl = 10 * 60 * 1000; // 10 min

  const format = (n) => n >= 1000 ? (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k' : String(n);
  const show = (n) => {
    countEl.textContent = format(n);
    badge.classList.remove('hidden');
  };

  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const { count, ts } = JSON.parse(raw);
      if (typeof count === 'number') {
        show(count);
        if (Date.now() - ts < ttl) return; // fresh — skip network
      }
    }
  } catch {}

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const count = data.stargazers_count;
    if (typeof count !== 'number') return;
    show(count);
    try { localStorage.setItem(cacheKey, JSON.stringify({ count, ts: Date.now() })); } catch {}
  } catch {
    // offline or rate-limited — leave badge as-is (hidden or showing cached value)
  }
})();

// =============================================================
// Boot
// =============================================================

loadAll();

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
const addShapeRow  = document.getElementById('addShapeRow');

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

function exportSvg() {
  let name = currentId;
  if (!name) {
    name = sanitizeName(prompt('Filename (lowercase, letters/digits/_/-):', 'untitled') || '');
    if (!name) return;
  }
  const svg = cleanClone().outerHTML;
  drawings[name] = { svg, width: currentW, height: currentH };
  currentId = name;
  triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
  refreshIconList();
  flashButton('btnExport', 'SAVED!');
}

async function exportRaster(mime) {
  const name = currentId || sanitizeName(prompt('Filename (lowercase, letters/digits/_/-):', 'untitled') || '');
  if (!name) return;
  const svg = cleanClone().outerHTML;
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
}

function cleanClone() {
  const clone = svgCanvas.cloneNode(true);
  clone.querySelectorAll('[data-bounds], [data-handles], [data-guides], [data-path-anchors], [data-marquee]').forEach(e => e.remove());
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
    iconList.appendChild(row);
  }
}

function refreshElementList() {
  elementList.innerHTML = '';
  const els = Array.from(svgCanvas.children).filter(c => {
    if (c === handlesGroup || c === boundsRect || c === marqueeRect) return false;
    if (c.dataset && (c.dataset.bg || c.dataset.guides || c.dataset.pathAnchors || c.dataset.marquee)) return false;
    return true;
  });
  if (els.length === 0) {
    elementList.innerHTML = '<div class="empty">No shapes yet</div>';
    return;
  }
  els.forEach((el, i) => {
    const fill = getPaint(el, 'fill') || getPaint(el, 'stroke') || '#888';
    const isSel = selection.includes(el);
    const row = document.createElement('div');
    row.className = 'elem-item' + (isSel ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = fill === 'none' ? 'transparent' : fill;
    row.appendChild(dot);
    const lbl = document.createElement('span');
    lbl.textContent = `${i + 1}  ${el.tagName}`;
    row.appendChild(lbl);
    row.addEventListener('click', (e) => {
      selectElement(el, e.ctrlKey || e.metaKey);
    });
    elementList.appendChild(row);
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
    if (child.dataset && (child.dataset.bounds || child.dataset.handles || child.dataset.guides || child.dataset.marquee || child.dataset.pathAnchors || child.dataset.bg)) continue;
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
  if (!el || el.tagName !== 'path' || isRectLike(el)) return;
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

const cpSV      = colorPopover.querySelector('.cp-sv');
const cpSat     = colorPopover.querySelector('.cp-sv-sat');
const cpSVThumb = colorPopover.querySelector('.cp-sv-thumb');
const cpHue     = colorPopover.querySelector('.cp-hue');
const cpHueThumb= colorPopover.querySelector('.cp-hue-thumb');
const cpHex     = colorPopover.querySelector('.cp-hex');
const cpPick    = colorPopover.querySelector('.cp-pick');
const cpPalette = colorPopover.querySelector('.cp-palette');

const cpState = { h: 0, s: 0, v: 0.5, onChange: null, anchor: null };

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
  if (cpState.onChange) cpState.onChange(hex);
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

cpHex.addEventListener('input', () => {
  const normalized = cpSetFromHex(cpHex.value, { syncHex: false });
  if (normalized && cpState.onChange) cpState.onChange(normalized);
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
  closeColorPicker();
  document.body.classList.add('cp-picking');

  const reopen = (hex) => {
    if (anchor) openColorPicker(anchor, { value: hex, onChange });
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
    if (picked && onChange) onChange(picked);
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
    if (d && (d.bounds || d.handles || d.pathAnchors || d.guides || d.bg || d.marquee)) return;
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
      if (hex && cpState.onChange) cpState.onChange(hex);
    });
    cpPalette.appendChild(sw);
  }
}

function openColorPicker(anchorEl, { value, onChange }) {
  cpState.anchor = anchorEl;
  cpState.onChange = onChange;
  cpSetFromHex(value || '#888888');
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
}

function popUndo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshotCanvas());
  if (redoStack.length > 50) redoStack.shift();
  restoreCanvas(undoStack.pop());
}

function popRedo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshotCanvas());
  if (undoStack.length > 50) undoStack.shift();
  restoreCanvas(redoStack.pop());
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
  } else if (!hasRotate && (tag === 'rect' || tag === 'image')) {
    el.setAttribute('x', parseFloat(el.getAttribute('x')||0) + dx);
    el.setAttribute('y', parseFloat(el.getAttribute('y')||0) + dy);
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
  } else if (tag === 'rect') {
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

svgCanvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return;
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
    if (tag === 'line') { el.setAttribute('stroke', c); el.setAttribute('stroke-width', Math.max(2, Math.min(currentW, currentH) * 0.012)); }
    else el.setAttribute('fill', c);
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
      drag = { mode: 'resize', handle: tgt.dataset.handle, startBBox: selection[0].getBBox(), x: sp.x, y: sp.y };
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
    if (sel === tgt && sel.tagName === 'path' && !isRectLike(sel)) {
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

  const addToSel = e.ctrlKey || e.metaKey;
  if (addToSel) selectElement(tgt, true);
  else if (!selection.includes(tgt)) selectElement(tgt);
  pushUndo();
  const sp = svgPt(e);
  drag = { mode: 'move', startX: sp.x, startY: sp.y, appliedX: 0, appliedY: 0, x: sp.x, y: sp.y };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const sp = svgPt(e);

  if (drag.mode === 'draw') {
    setDrawGeometry(drag.el, drag.tag, drag.startX, drag.startY, sp.x, sp.y);
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
    // Hold Alt to bypass smart-snap for precise placement (e.g. 50.1px gaps).
    const { snapDx, snapDy, vGuides, hGuides } = e.altKey
      ? { snapDx: 0, snapDy: 0, vGuides: [], hGuides: [] }
      : computeSnap(hypo);
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
    const dx = sp.x - drag.x, dy = sp.y - drag.y;
    resizeElement(selection[0], dx, dy, drag.handle, drag.startBBox);
    const snap = e.altKey
      ? { snapDx: 0, snapDy: 0, vGuides: [], hGuides: [] }
      : computeResizeSnap(selection[0], drag.handle);
    if (snap.snapDx || snap.snapDy) {
      resizeElement(selection[0], snap.snapDx, snap.snapDy, drag.handle, drag.startBBox);
    }
    renderGuides(snap.vGuides, snap.hGuides);
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
      if (child.dataset && (child.dataset.bg || child.dataset.guides || child.dataset.pathAnchors || child.dataset.marquee)) continue;
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
canvasInner.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;
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
  if (e.button === 2 && pan) { pan = null; canvasInner.style.cursor = ''; }
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
    for (const el of selection) moveElement(el, dx, dy);
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
      e.preventDefault();
      pushUndo();
      for (const el of selection) svgCanvas.removeChild(el);
      clearSelection();
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
});

// =============================================================
// Add shape buttons (positions scale with canvas size)
// =============================================================

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
  } else if (tag === 'path') {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    el.setAttribute('d', `M${(cx-rx).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy-ry).toFixed(1)} L${(cx+rx).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy+ry).toFixed(1)} Z`);
  }
}

const shapes = [
  { label: 'Rect',    tag: 'rect',    icon: '▭', hint: 'Click a point or drag to size a rectangle' },
  { label: 'Circle',  tag: 'circle',  icon: '◯', hint: 'Click a point or drag to size a circle' },
  { label: 'Ellipse', tag: 'ellipse', icon: '⬭', hint: 'Click a point or drag to size an ellipse' },
  { label: 'Line',    tag: 'line',    icon: '╱', hint: 'Click a point or drag from one end to the other' },
  { label: 'Path',    tag: 'path',    icon: '✎', hint: 'Click a point or drag to size a diamond path (editable after)' },
];
const shapeButtons = [];
function enterDrawMode(tag, button) {
  if (pendingShape && pendingShape.button === button) { exitDrawMode(); return; }
  exitDrawMode();
  clearSelection();
  pendingShape = { tag, button };
  button.classList.add('active');
  canvasInner.style.cursor = 'crosshair';
}
function exitDrawMode() {
  if (!pendingShape) return;
  pendingShape.button.classList.remove('active');
  pendingShape = null;
  if (!pan) canvasInner.style.cursor = '';
}
for (const s of shapes) {
  const btn = document.createElement('button');
  btn.innerHTML = `<span class="ti">${s.icon}</span><span class="tl">${s.label}</span>`;
  btn.dataset.hint = s.hint;
  btn.dataset.tag = s.tag;
  btn.addEventListener('click', () => enterDrawMode(s.tag, btn));
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
      reader.onload = () => addImageToCanvas(String(reader.result));
      reader.readAsDataURL(file);
      return;
    }
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

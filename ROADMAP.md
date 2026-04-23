# Freegma roadmap

A rolling list of ideas for the editor, grouped by rough effort. Nothing here is
promised — just a parking lot for what might be worth building next. Cross
items off as they land; reshuffle freely.

## Small / quick wins

- [x] Alignment guides that **snap**, not just hint (shape-to-shape +
      shape-to-frame, with Shift to disable). *Snap was already implemented
      for moves & resizes; Shift-to-disable shipped 2026-04-23.*
- [ ] Keyboard shortcuts to flip selection (H = horizontal, V conflicts with
      select — maybe Shift+H / Shift+V).
- [ ] Export at 2× / 3× scale for PNG / WebP (retina assets).
- [ ] "Copy as PNG" / "Copy as SVG" to clipboard (no download step).
- [ ] Rulers along the canvas edges + a toggleable grid overlay.
- [ ] Remember per-shape "last paint" (stroke width, dash, opacity) so newly
      drawn shapes adopt the last-used values.
- [ ] Recent-colors swatch row in the color picker (last N picked colors).
- [ ] Search / filter box above the Drawings sidebar.
- [ ] Numeric inputs: drag on the label to scrub, Alt=×0.1, Shift=×10.

## Medium

- [ ] Boolean operations on paths (union / subtract / intersect / exclude),
      producing a new editable path.
- [ ] Per-shape opacity + blend modes (normal, multiply, screen, overlay…).
- [ ] Multi-page / artboards within one drawing (Figma-style frames).
- [ ] Components panel — reusable symbols with instance overrides.
- [ ] Drawing-to-drawing linking (open a drawing inside another via `<use>`).
- [ ] Pen-tool bezier handles with smooth / corner conversion.
- [ ] SVG `<mask>` and `<clipPath>` UI (drag a shape onto another to clip).

## Ambitious

- [ ] Collaborative editing (CRDT / WebSocket, presence cursors).
- [ ] Plugin API so third-party extensions can add tools / properties panels.
- [ ] AI "describe → vector" (generate an SVG path from a prompt, editable
      after).
- [ ] Timeline / animation (CSS keyframes exported as part of the SVG).

## Polish / infra

- [ ] Unit tests for `scalePathD`, `setRectLike`, and the clipboard round-trip.
- [ ] Replace `tmp.innerHTML = …` fragment parsing with `DOMParser` where it
      matters for namespaces.
- [ ] Cursor hints that automatically describe the next click action based on
      `pendingShape`.
- [ ] Preview thumbnails in the sidebar re-rendered off the main thread.

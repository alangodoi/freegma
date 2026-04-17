# Freegma

Open-source browser graphics tool. Design with vectors, drop photos on the canvas, and export to SVG, PNG, WebP, or JPEG — no account, no uploads. Fully client-side; the server is a thin static host and each user works locally in their own browser.

## Quick Start

```bash
bun install
bun start
```

## Features

- **Per-drawing canvas size** — each drawing stores its own `width`×`height`; change it anytime via the W/H inputs or size presets (16, 24, 48, 512, 1024, 16:9)
- **Visual canvas** — interactive selection box with 8 resize handles + rotation handle
- **Multi-select** — Ctrl+Click (Cmd+Click on Mac) to add/remove from selection
- **Move** — drag selected elements (preserves rotation)
- **Resize** — drag corner/edge handles
- **Rotate** — drag the blue circle above the selection
- **Add shapes** — rect, circle, ellipse, line, path (shape defaults scale to the canvas)
- **Path editing** — manual `d` attribute textarea with command reference
- **Undo** — Ctrl+Z (50 step history)
- **Duplicate** — Ctrl+D
- **Delete** — Delete or Backspace
- **Zoom** — mouse scroll (centered on cursor)
- **Pan** — right-click and drag
- **Per-element attributes** — fill, stroke, stroke-width, opacity, x/y/cx/cy/r/rx/ry/…
- **Reorder** — ↑↓ buttons in properties panel
- **Download** — saves current drawing as an `.svg` file via the browser
- **Import** — file picker (multi-select supported) or paste markup
- **Rename / Remove** — manage session drawings

## Notes

- The expanded editor view is 10% padding around each drawing. Scroll to zoom, right-drag to pan. Starting a new drawing or switching drawings refits the view.
- The checkerboard background plus the dashed pink rectangle show the drawing bounds.

## License

MIT License

Copyright (c) 2026 Alan Godoi da Silveira

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

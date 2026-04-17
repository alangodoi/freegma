# Freegma

Standalone SVG editor. Build, edit, and save vector drawings with a visual interface. Fully client-side — the server is a thin static host. Each user works locally in their own browser, and each drawing has its own canvas size (like Figma frames).

## Quick Start

```bash
bun install
bun start
```

Open <http://localhost:3001>

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
- **Copy SVG** — clipboard with cleaned markup (`viewBox="0 0 W H"`, proper `width`/`height`)

## Persistence model

There is no server-side persistence. Drawings live in the current browser session. Use **DOWNLOAD** to save to disk and **IMPORT** to load back. Reloading the page resets to the starter templates from `./icons`.

## Starter templates

Drop `.svg` files into the `icons/` folder. They appear as starter drawings on each page load. The editor reads their `viewBox` (or `width`/`height`) to determine the canvas size per file.

## Notes

- The expanded editor view is 10% padding around each drawing. Scroll to zoom, right-drag to pan. Starting a new drawing or switching drawings refits the view.
- The checkerboard background plus the dashed pink rectangle show the drawing bounds.

## License

MIT — see [LICENSE](./LICENSE).

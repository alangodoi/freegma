import { readdir, readFile } from "node:fs/promises";

const PORT = 3001;

// ---- Default icons (starter templates from ./icons) ----
async function loadDefaults(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const files = await readdir("./icons");
    for (const f of files) {
      if (!f.endsWith(".svg")) continue;
      const name = f.replace(/\.svg$/, "");
      out[name] = await readFile(`./icons/${f}`, "utf8");
    }
  } catch {}
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".json": "application/json",
};

// ---- Server ----
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/defaults" && req.method === "GET") {
      return Response.json(await loadDefaults());
    }

    let filePath = path;
    if (filePath === "/") filePath = "/index.html";
    const file = Bun.file(`./public${filePath}`);
    if (await file.exists()) {
      const ext = filePath.substring(filePath.lastIndexOf("."));
      return new Response(file, {
        headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`SVG Editor running at http://localhost:${PORT}`);

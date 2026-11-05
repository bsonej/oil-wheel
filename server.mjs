// Tiny zero-dependency static server: `npm start` then open http://127.0.0.1:4173/
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const publicFiles = new Set(["index.html"]);

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^([/\\])+/, "");
  const rel = clean === "" ? "index.html" : clean;
  const allowed = publicFiles.has(rel) || rel.startsWith("src/");
  const file = join(root, rel);
  return allowed && file.startsWith(root) ? file : null;
}

createServer(async (req, res) => {
  const file = resolvePath(req.url || "/");
  if (!file) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Oil Wheel on http://127.0.0.1:${port}/`);
});

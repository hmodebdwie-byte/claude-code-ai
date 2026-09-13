"use strict";
/**
 * Minimal static server for the built Vite apps (SPA fallback, no caching).
 * Usage: node static-server.cjs <distDir> <port>
 * Serves a network-only service worker at /sw.js so the workbench preview never
 * gets stuck on a stale Workbox precache after a rebuild (production PWA behaviour
 * is unchanged in the source repos).
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[2] || "dist");
const port = Number(process.argv[3] || process.env.PORT || 5001);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".txt": "text/plain" };
const NETWORK_ONLY_WORKER = `'use strict';
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil((async()=>{const n=await caches.keys();await Promise.all(n.filter(x=>x.startsWith('workbox-precache-')).map(x=>caches.delete(x)));await self.clients.claim();})()));
self.addEventListener('fetch',e=>e.respondWith(fetch(e.request,{cache:'no-store'})));`;

http.createServer((req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://local").pathname); } catch { res.writeHead(400); return res.end(); }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (pathname === "/sw.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Service-Worker-Allowed", "/");
    return res.end(req.method === "HEAD" ? undefined : NETWORK_ONLY_WORKER);
  }
  if (pathname === "/__wb/health") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ok: true, root, port })); }
  let file = path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); return res.end(); }
  try { if (!fs.statSync(file).isFile()) file = path.join(root, "index.html"); } catch { file = path.join(root, "index.html"); }
  res.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream");
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => { res.statusCode = 500; res.end(); }).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`[static] ${root} on http://127.0.0.1:${port}`));

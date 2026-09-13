#!/usr/bin/env node
/**
 * Split wb/snapshots/latest.json into the documents the Live Monitor reads:
 *   db/monitor-latest.json   -> doc monitor/latest   (snapshot without screenshots, trimmed)
 *   db/shots-<label>.json    -> doc shots/<label>    (one screenshot each, <256 KiB)
 *   db/history-<id>.json     -> doc history/<id>     (verdict only)
 *   db/changes-<id>.json     -> doc changes/<id>     (from wb/changes.json, only entries newer than last push)
 * Prints the list of {collection, doc_id, file} to feed into the Artifact write_db batch.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
const WB = process.env.WB_ROOT || "/home/claude/wb";
const OUT = path.join(WB, "snapshots", "db");
mkdirSync(OUT, { recursive: true });
const snap = JSON.parse(readFileSync(path.join(WB, "snapshots", "latest.json"), "utf8"));
const writes = [];
const put = (collection, doc_id, data) => {
  const file = path.join(OUT, `${collection}-${doc_id}.json`);
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > 250 * 1024) throw new Error(`${collection}/${doc_id} is ${Buffer.byteLength(json)} bytes (>250 KiB)`);
  writeFileSync(file, json);
  writes.push({ op: "set", collection, doc_id, file_path: file, bytes: Buffer.byteLength(json) });
};

// screenshots -> their own docs
const pages = (snap.browser && snap.browser.pages) || [];
for (const p of pages) {
  if (p.screenshot) put("shots", p.label, { label: p.label, url: p.url, takenAt: snap.takenAt, status: p.status, dataUrl: p.screenshot });
  delete p.screenshot;
}
// trim bulky fields
for (const s of snap.services || []) { s.lastLines = (s.lastLines || []).slice(-4); s.recentErrors = (s.recentErrors || []).slice(-4); }
if (snap.redis) snap.redis.samples = (snap.redis.samples || []).slice(0, 8);
delete snap.changes; // the page reads the changes collection instead
put("monitor", "latest", snap);
put("history", snap.id, { takenAt: snap.takenAt, verdict: snap.verdict });

// changes: push entries from wb/changes.json (idempotent: same id -> same doc)
const cf = path.join(WB, "changes.json");
if (existsSync(cf)) for (const c of JSON.parse(readFileSync(cf, "utf8"))) put("changes", c.id, c);

console.log(JSON.stringify(writes, null, 1));

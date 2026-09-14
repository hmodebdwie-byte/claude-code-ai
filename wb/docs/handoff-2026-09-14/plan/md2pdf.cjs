const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { chromium } = require(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright"));
const [,, src, out] = process.argv;
const md = fs.readFileSync(src, "utf8");
// minimal markdown → html (headings, paragraphs, lists, tables, code, bold/inline code)
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
const lines = md.split("\n"); let html = ""; let i = 0;
while (i < lines.length) {
  const l = lines[i];
  if (l.startsWith("```")) { let j = i + 1, buf = []; while (j < lines.length && !lines[j].startsWith("```")) buf.push(lines[j++]); html += `<pre>${esc(buf.join("\n"))}</pre>`; i = j + 1; continue; }
  if (/^#{1,3} /.test(l)) { const lvl = l.match(/^#+/)[0].length; html += `<h${lvl}>${inline(l.replace(/^#+ /, ""))}</h${lvl}>`; i++; continue; }
  if (l.startsWith("|")) { let rows = []; while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]); rows = rows.filter((r) => !/^\|\s*-/.test(r)); html += "<table>" + rows.map((r, k) => "<tr>" + r.split("|").slice(1, -1).map((c) => `<${k === 0 ? "th" : "td"}>${inline(c.trim())}</${k === 0 ? "th" : "td"}>`).join("") + "</tr>").join("") + "</table>"; continue; }
  if (/^\d+\. /.test(l) || l.startsWith("* ")) { const ordered = /^\d+\. /.test(l); let items = []; while (i < lines.length && (/^\d+\. /.test(lines[i]) || lines[i].startsWith("* "))) items.push(lines[i++].replace(/^(\d+\. |\* )/, "")); html += `<${ordered ? "ol" : "ul"}>` + items.map((x) => `<li>${inline(x)}</li>`).join("") + `</${ordered ? "ol" : "ul"}>`; continue; }
  if (l.trim() === "") { i++; continue; }
  let buf = [l]; i++; while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||```|\* |\d+\. )/.test(lines[i])) buf.push(lines[i++]);
  html += `<p>${inline(buf.join(" "))}</p>`;
}
const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Helvetica,Arial,sans-serif;font-size:11.5pt;line-height:1.45;color:#111;margin:36px 44px}
h1{font-size:20pt;margin:0 0 6px}h2{font-size:15pt;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}h3{font-size:12.5pt;margin:16px 0 4px}
table{border-collapse:collapse;margin:8px 0;font-size:10.5pt}th,td{border:1px solid #bbb;padding:4px 8px;text-align:left}th{background:#f0f0f0}
code{font-family:Menlo,Consolas,monospace;font-size:10pt;background:#f3f3f3;padding:1px 3px}pre{font-family:Menlo,Consolas,monospace;font-size:9.5pt;background:#f3f3f3;padding:8px;white-space:pre-wrap}
li{margin:3px 0}</style></head><body>${html}</body></html>`;
(async () => { const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }); const p = await b.newPage(); await p.setContent(doc, { waitUntil: "load" }); await p.pdf({ path: out, format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } }); if (process.env.PNG) { await p.setViewportSize({ width: 900, height: 1400 }); await p.screenshot({ path: process.env.PNG, fullPage: false }); } await b.close(); console.log("pdf written", out); })();

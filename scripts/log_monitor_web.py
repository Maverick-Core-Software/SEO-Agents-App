#!/usr/bin/env python3
"""Tiny web log monitor for a JSONL log file.

Usage: python scripts/log_monitor_web.py [path/to/log.jsonl] [port]
Serves a dashboard at http://localhost:<port>/ and a JSON API at /api/logs
that returns parsed log entries (newest first) plus summary counts.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = sys.argv[1] if len(sys.argv) > 1 else "outputs/monitor-2026-09-25.jsonl"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8899

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SEO Run Monitor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Segoe UI", system-ui, sans-serif; background:#0f1117; color:#d7dae0; }
  header { position:sticky; top:0; z-index:2; background:#161a23; padding:10px 16px; display:flex;
           flex-wrap:wrap; gap:12px; align-items:center; border-bottom:1px solid #262b36; }
  header h1 { font-size:15px; margin:0; font-weight:600; color:#e8ebf0; }
  #stats { display:flex; gap:8px; flex-wrap:wrap; }
  .pill { padding:3px 10px; border-radius:12px; font-size:12px; font-weight:600; background:#232836; }
  .pill.info  { color:#6cb2ff; }
  .pill.warn  { color:#ffcc66; background:#3a3220; }
  .pill.error { color:#ff7d7d; background:#3a2020; }
  .pill.total { color:#a9b1c1; }
  #live { font-size:12px; color:#7ee2a8; margin-left:auto; }
  #live.stale { color:#ffcc66; }
  #controls { padding:8px 16px; display:flex; gap:8px; flex-wrap:wrap; background:#12151d; border-bottom:1px solid #262b36; }
  button, select, input { background:#232836; color:#d7dae0; border:1px solid #333a4a; border-radius:6px;
          padding:4px 10px; font-size:12px; cursor:pointer; }
  input { cursor:text; width:260px; }
  button.active { background:#31405e; border-color:#4a6ba3; }
  #log { padding:10px 16px 40px; font-family: "Cascadia Code", Consolas, monospace; font-size:12.5px; }
  .row { display:flex; gap:10px; padding:3px 6px; border-radius:4px; align-items:baseline; }
  .row:hover { background:#1a1f2b; }
  .row .ts { color:#6b7385; white-space:nowrap; flex:0 0 auto; }
  .row .lvl { flex:0 0 52px; text-align:center; border-radius:3px; font-weight:700; font-size:11px; padding:1px 0; }
  .lvl.info  { color:#6cb2ff; background:#1b2b44; }
  .lvl.warn  { color:#ffcc66; background:#3a3220; }
  .lvl.error { color:#ff7d7d; background:#3a2020; }
  .row .msg { white-space:pre-wrap; word-break:break-word; }
  .msg .k { color:#8b93a7; }
  #empty { padding:30px; text-align:center; color:#6b7385; }
</style>
</head>
<body>
<header>
  <h1>SEO Run Monitor &mdash; __LOGFILE__</h1>
  <div id="stats"></div>
  <div id="live">&#9679; live</div>
</header>
<div id="controls">
  <button data-f="all" class="active">All</button>
  <button data-f="info">Info</button>
  <button data-f="warn">Warn</button>
  <button data-f="error">Error</button>
  <button id="tail" class="active">Follow tail</button>
  <select id="limit">
    <option value="100">Last 100</option>
    <option value="500" selected>Last 500</option>
    <option value="2000">Last 2000</option>
    <option value="0">Everything</option>
  </select>
  <input id="q" type="text" placeholder="Filter messages..."/>
</div>
<div id="log"></div>
<div id="empty" hidden>No matching entries.</div>
<script>
let entries = [], filter = 'all', follow = true;
const $ = id => document.getElementById(id);

async function refresh() {
  try {
    const r = await fetch('/api/logs?limit=2000');
    const d = await r.json();
    entries = d.entries;
    renderStats(d);
    render();
    $('live').textContent = '\\u25CF live ' + new Date().toLocaleTimeString();
    $('live').classList.remove('stale');
  } catch (e) {
    $('live').textContent = '\\u25CF connection lost';
    $('live').classList.add('stale');
  }
}

function renderStats(d) {
  $('stats').innerHTML =
    `<span class="pill total">${d.total} events</span>` +
    `<span class="pill info">info ${d.counts.info||0}</span>` +
    `<span class="pill warn">warn ${d.counts.warn||0}</span>` +
    `<span class="pill error">error ${d.counts.error||0}</span>` +
    `<span class="pill total">last ${d.last_ts ? d.last_ts.substr(11,8) : '—'}</span>`;
}

function render() {
  const q = $('q').value.toLowerCase();
  const limit = parseInt($('limit').value, 10);
  let rows = entries;
  if (filter !== 'all') rows = rows.filter(e => e.level === filter);
  if (q) rows = rows.filter(e => (e.message || '').toLowerCase().includes(q));
  if (limit > 0) rows = rows.slice(0, limit);
  $('empty').hidden = rows.length > 0;
  $('log').innerHTML = rows.map(e => {
    let extra = '';
    for (const k of ['subject','to','error','alert_key','status']) {
      if (e[k] !== undefined) extra += ` <span class="k">${k}=</span>${esc(String(e[k]))}`;
    }
    return `<div class="row"><span class="ts">${(e.ts||'').replace('T',' ').substr(0,19)}</span>` +
      `<span class="lvl ${esc(e.level||'info')}">${esc(e.level||'info').toUpperCase()}</span>` +
      `<span class="msg">${esc(e.message||'')}${extra}</span></div>`;
  }).join('');
}

function esc(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

document.querySelectorAll('button[data-f]').forEach(b => b.onclick = () => {
  document.querySelectorAll('button[data-f]').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); filter = b.dataset.f; render();
});
$('tail').onclick = () => { follow = !follow; $('tail').classList.toggle('active', follow); };
$('q').oninput = render; $('limit').onchange = render;
setInterval(refresh, 3000);
refresh();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/logs"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            counts = {"info": 0, "warn": 0, "error": 0}
            entries, last_ts = [], None
            try:
                with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            e = json.loads(line)
                        except json.JSONDecodeError:
                            e = {"ts": "", "level": "warn", "message": line[:500]}
                        lvl = e.get("level", "info")
                        counts[lvl] = counts.get(lvl, 0) + 1
                        last_ts = e.get("ts", last_ts)
                        entries.append(e)
            except FileNotFoundError:
                pass
            entries.reverse()  # newest first
            self.wfile.write(json.dumps({
                "total": len(entries), "counts": counts, "last_ts": last_ts,
                "log_path": LOG_PATH, "entries": entries,
            }).encode())
        elif self.path == "/":
            body = PAGE.replace("__LOGFILE__", os.path.basename(LOG_PATH)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass  # keep console quiet


if __name__ == "__main__":
    print(f"Serving monitor for {os.path.abspath(LOG_PATH)} on http://0.0.0.0:{PORT}/")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

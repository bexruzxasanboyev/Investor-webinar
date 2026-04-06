const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

// SQLite — tez, fayl-based, server kerak emas
const db = new Database(path.join(__dirname, "metrikca.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// Jadval yaratish
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    referrer TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_event ON events(event)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_created ON events(created_at)`);

app.use(cors());
app.use(express.json());

// Statik fayllar (frontend — bir daraja yuqorida)
app.use(express.static(path.join(__dirname, "..")));

// ---- TRACKING ENDPOINT ----
const insertStmt = db.prepare(
  "INSERT INTO events (event, ip, user_agent, referrer) VALUES (?, ?, ?, ?)"
);

app.post("/metrikca/track", (req, res) => {
  const { event } = req.body;
  if (!event || !["PageView", "Lead"].includes(event)) {
    return res.status(400).json({ error: "Invalid event" });
  }
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const ua = req.headers["user-agent"] || "";
  const referrer = req.headers["referer"] || "";
  insertStmt.run(event, ip, ua, referrer);
  res.json({ ok: true });
});

// ---- DASHBOARD API ----

// Umumiy statistika
app.get("/metrikca/stats", (req, res) => {
  const total = db.prepare(`
    SELECT
      SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END) as pageviews,
      SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END) as leads
    FROM events
  `).get();

  const rate = total.pageviews > 0
    ? ((total.leads / total.pageviews) * 100).toFixed(2)
    : "0.00";

  res.json({ ...total, lead_rate: rate + "%" });
});

// Bugungi statistika
app.get("/metrikca/stats/today", (req, res) => {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END) as pageviews,
      SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END) as leads
    FROM events
    WHERE date(created_at) = date('now')
  `).get();

  const rate = row.pageviews > 0
    ? ((row.leads / row.pageviews) * 100).toFixed(2)
    : "0.00";

  res.json({ ...row, lead_rate: rate + "%" });
});

// Soatlik breakdown (bugun)
app.get("/metrikca/stats/hourly", (req, res) => {
  const rows = db.prepare(`
    SELECT
      strftime('%H:00', created_at) as hour,
      SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END) as pageviews,
      SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END) as leads
    FROM events
    WHERE date(created_at) = date('now')
    GROUP BY hour
    ORDER BY hour
  `).all();

  rows.forEach(r => {
    r.lead_rate = r.pageviews > 0
      ? ((r.leads / r.pageviews) * 100).toFixed(2) + "%"
      : "0.00%";
  });

  res.json(rows);
});

// Kunlik breakdown (oxirgi 30 kun)
app.get("/metrikca/stats/daily", (req, res) => {
  const rows = db.prepare(`
    SELECT
      date(created_at) as day,
      SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END) as pageviews,
      SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END) as leads
    FROM events
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY day
    ORDER BY day DESC
  `).all();

  rows.forEach(r => {
    r.lead_rate = r.pageviews > 0
      ? ((r.leads / r.pageviews) * 100).toFixed(2) + "%"
      : "0.00%";
  });

  res.json(rows);
});

// Oxirgi eventlar (real-time monitoring)
app.get("/metrikca/stats/recent", (req, res) => {
  const rows = db.prepare(`
    SELECT event, ip, created_at
    FROM events
    ORDER BY id DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

// ---- DASHBOARD UI ----
app.get("/metrikca", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Metrikca Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;padding:20px}
  h1{color:#D4AF37;margin-bottom:20px;font-size:24px}
  h2{color:#F5E6B8;margin:20px 0 10px;font-size:18px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:30px}
  .card{background:#1a1a1a;border:1px solid rgba(212,175,55,0.3);border-radius:12px;padding:20px;text-align:center}
  .card .value{font-size:32px;font-weight:700;color:#D4AF37}
  .card .label{font-size:13px;color:#888;margin-top:5px}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #222}
  th{color:#D4AF37;font-size:13px;text-transform:uppercase}
  td{font-size:14px;color:#ccc}
  .rate{color:#4ade80;font-weight:600}
  .refresh{color:#888;font-size:12px;margin-top:10px}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
  .badge-pv{background:#1e3a5f;color:#60a5fa}
  .badge-lead{background:#14532d;color:#4ade80}
</style>
</head>
<body>
<h1>Metrikca Dashboard</h1>

<div class="cards" id="cards"></div>

<h2>Soatlik (bugun)</h2>
<table><thead><tr><th>Soat</th><th>PageView</th><th>Lead</th><th>Lead Rate</th></tr></thead><tbody id="hourly"></tbody></table>

<h2>Kunlik (30 kun)</h2>
<table><thead><tr><th>Kun</th><th>PageView</th><th>Lead</th><th>Lead Rate</th></tr></thead><tbody id="daily"></tbody></table>

<h2>Oxirgi eventlar</h2>
<table><thead><tr><th>Event</th><th>IP</th><th>Vaqt</th></tr></thead><tbody id="recent"></tbody></table>

<p class="refresh">Har 5 soniyada yangilanadi</p>

<script>
async function load(){
  const [stats,today,hourly,daily,recent] = await Promise.all([
    fetch("/metrikca/stats").then(r=>r.json()),
    fetch("/metrikca/stats/today").then(r=>r.json()),
    fetch("/metrikca/stats/hourly").then(r=>r.json()),
    fetch("/metrikca/stats/daily").then(r=>r.json()),
    fetch("/metrikca/stats/recent").then(r=>r.json())
  ]);

  document.getElementById("cards").innerHTML=
    card("Jami PageView",stats.pageviews)+
    card("Jami Lead",stats.leads)+
    card("Jami Lead Rate",stats.lead_rate)+
    card("Bugun PageView",today.pageviews)+
    card("Bugun Lead",today.leads)+
    card("Bugun Lead Rate",today.lead_rate);

  document.getElementById("hourly").innerHTML=hourly.map(r=>
    \`<tr><td>\${r.hour}</td><td>\${r.pageviews}</td><td>\${r.leads}</td><td class="rate">\${r.lead_rate}</td></tr>\`
  ).join("")||"<tr><td colspan=4>Ma'lumot yo'q</td></tr>";

  document.getElementById("daily").innerHTML=daily.map(r=>
    \`<tr><td>\${r.day}</td><td>\${r.pageviews}</td><td>\${r.leads}</td><td class="rate">\${r.lead_rate}</td></tr>\`
  ).join("")||"<tr><td colspan=4>Ma'lumot yo'q</td></tr>";

  document.getElementById("recent").innerHTML=recent.map(r=>
    \`<tr><td><span class="badge \${r.event==='Lead'?'badge-lead':'badge-pv'}">\${r.event}</span></td><td>\${r.ip}</td><td>\${r.created_at}</td></tr>\`
  ).join("")||"<tr><td colspan=3>Ma'lumot yo'q</td></tr>";
}

function card(label,value){
  return \`<div class="card"><div class="value">\${value||0}</div><div class="label">\${label}</div></div>\`;
}

load();
setInterval(load,5000);
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Metrikca ishlayapti: http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/metrikca`);
});

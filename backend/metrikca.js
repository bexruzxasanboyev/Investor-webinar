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

app.use(cors({
  origin: [
    "https://metrikainvestor.vercel.app",
    "https://investor-webiner.vercel.app",
    "http://localhost:3000",
    "https://metrikainvestor.asosit.uz"
  ]
}));
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
// Sana + soat filtri: ?from=2026-04-01&to=2026-04-06&timeFrom=09:00&timeTo=18:00

function dateFilter(req) {
  const { from, to, timeFrom, timeTo } = req.query;
  let where = "";
  const params = [];
  if (from && timeFrom) { where += " AND datetime(created_at) >= datetime(? || ' ' || ?)"; params.push(from, timeFrom + ":00"); }
  else if (from) { where += " AND date(created_at) >= ?"; params.push(from); }
  if (to && timeTo) { where += " AND datetime(created_at) <= datetime(? || ' ' || ?)"; params.push(to, timeTo + ":00"); }
  else if (to) { where += " AND date(created_at) <= ?"; params.push(to); }
  return { where, params };
}

function calcRate(pv, ld) {
  return pv > 0 ? ((ld / pv) * 100).toFixed(2) + "%" : "0.00%";
}

// Umumiy statistika (sana filtri bilan)
app.get("/metrikca/stats", (req, res) => {
  const { where, params } = dateFilter(req);
  const total = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END),0) as pageviews,
      COALESCE(SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END),0) as leads,
      COALESCE(COUNT(DISTINCT CASE WHEN event='PageView' THEN ip END),0) as unique_pageviews,
      COALESCE(COUNT(DISTINCT CASE WHEN event='Lead' THEN ip END),0) as unique_leads
    FROM events
    WHERE 1=1 ${where}
  `).get(...params);

  res.json({
    ...total,
    lead_rate: calcRate(total.pageviews, total.leads),
    unique_lead_rate: calcRate(total.unique_pageviews, total.unique_leads)
  });
});

// Bugungi statistika
app.get("/metrikca/stats/today", (req, res) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END),0) as pageviews,
      COALESCE(SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END),0) as leads,
      COALESCE(COUNT(DISTINCT CASE WHEN event='PageView' THEN ip END),0) as unique_pageviews,
      COALESCE(COUNT(DISTINCT CASE WHEN event='Lead' THEN ip END),0) as unique_leads
    FROM events
    WHERE date(created_at) = date('now')
  `).get();

  res.json({
    ...row,
    lead_rate: calcRate(row.pageviews, row.leads),
    unique_lead_rate: calcRate(row.unique_pageviews, row.unique_leads)
  });
});

// Soatlik breakdown (sana + soat filtri bilan)
app.get("/metrikca/stats/hourly", (req, res) => {
  const { from, to, timeFrom, timeTo } = req.query;
  let dateWhere = "";
  const params = [];

  if (from && timeFrom) { dateWhere += " AND datetime(created_at) >= datetime(? || ' ' || ?)"; params.push(from, timeFrom + ":00"); }
  else if (from && !to) { dateWhere += " AND date(created_at) = ?"; params.push(from); }
  else if (from) { dateWhere += " AND date(created_at) >= ?"; params.push(from); }

  if (to && timeTo) { dateWhere += " AND datetime(created_at) <= datetime(? || ' ' || ?)"; params.push(to, timeTo + ":00"); }
  else if (to) { dateWhere += " AND date(created_at) <= ?"; params.push(to); }

  if (!from && !to) { dateWhere = " AND date(created_at) = date('now')"; }

  const rows = db.prepare(`
    SELECT
      strftime('%H:00', created_at) as hour,
      SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END) as pageviews,
      SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END) as leads
    FROM events
    WHERE 1=1 ${dateWhere}
    GROUP BY hour
    ORDER BY hour
  `).all(...params);

  rows.forEach(r => { r.lead_rate = calcRate(r.pageviews, r.leads); });
  res.json(rows);
});

// Kunlik breakdown (sana filtri bilan)
app.get("/metrikca/stats/daily", (req, res) => {
  const { where, params } = dateFilter(req);
  const defaultWhere = where || " AND created_at >= datetime('now', '-30 days')";
  const rows = db.prepare(`
    SELECT
      date(created_at) as day,
      SUM(CASE WHEN event='PageView' THEN 1 ELSE 0 END) as pageviews,
      SUM(CASE WHEN event='Lead' THEN 1 ELSE 0 END) as leads
    FROM events
    WHERE 1=1 ${defaultWhere}
    GROUP BY day
    ORDER BY day DESC
  `).all(...params);

  rows.forEach(r => { r.lead_rate = calcRate(r.pageviews, r.leads); });
  res.json(rows);
});

// Oxirgi eventlar (sana filtri bilan)
app.get("/metrikca/stats/recent", (req, res) => {
  const { where, params } = dateFilter(req);
  const rows = db.prepare(`
    SELECT event, ip, created_at
    FROM events
    WHERE 1=1 ${where}
    ORDER BY id DESC
    LIMIT 50
  `).all(...params);
  res.json(rows);
});

// ---- DASHBOARD REDIRECT ----
app.get("/metrikca", (req, res) => {
  res.redirect("https://metrikainvestor.vercel.app");
});

app.listen(PORT, () => {
  console.log(`Metrikca ishlayapti: http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/metrikca`);
});

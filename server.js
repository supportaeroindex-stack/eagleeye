// EagleEye backend — real HTTP server, real SQLite database, real auth.
// Zero npm dependencies: everything is a Node built-in. Run:  node server.js
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
// DB_PATH env lets a host point the database at a persistent disk (e.g. /data/eagleeye.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "eagleeye.db");
// CORS_ORIGIN env restricts which site can call the API (default "*"; set to your Netlify URL in production)
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/* ---------------------------------------------------------------- database */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS parents (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
    pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, parent_id TEXT NOT NULL, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, parent_id TEXT NOT NULL,
    name TEXT NOT NULL, platform TEXT NOT NULL,
    pairing_token TEXT UNIQUE NOT NULL,
    limit_min INTEGER DEFAULT 120, used_min INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0, online INTEGER DEFAULT 0,
    current_app TEXT DEFAULT '', place TEXT DEFAULT '',
    last_seen INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    ts INTEGER, kind TEXT, title TEXT, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    type TEXT NOT NULL, status TEXT DEFAULT 'pending',
    created_at INTEGER, delivered_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
    ts INTEGER, url TEXT, title TEXT, browser TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_dev ON history(device_id, ts);
`);

/* ---------------------------------------------------------------- helpers */
const now = () => Date.now();
const uid = () => crypto.randomBytes(9).toString("base64url");
const token = () => crypto.randomBytes(32).toString("hex");

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPw(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parentFromAuth(req) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return null;
  const s = db.prepare("SELECT parent_id FROM sessions WHERE token=?").get(t);
  if (!s) return null;
  return db.prepare("SELECT id,email,name FROM parents WHERE id=?").get(s.parent_id) || null;
}

function deviceView(d) {
  return {
    id: d.id, name: d.name, platform: d.platform,
    pairingToken: d.pairing_token,
    limitMin: d.limit_min, usedMin: d.used_min,
    locked: !!d.locked,
    online: d.online && now() - d.last_seen < 90_000 ? true : false,
    currentApp: d.current_app, place: d.place, lastSeen: d.last_seen
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type,Authorization", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" });
  res.end(body);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".zip": "application/zip", ".apk": "application/vnd.android.package-archive" };
const DOWNLOAD_EXT = new Set([".zip", ".apk"]);
function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(__dirname, "public", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(file);
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (DOWNLOAD_EXT.has(ext)) headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

/* ---------------------------------------------------------------- routes */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const seg = url.pathname.split("/").filter(Boolean); // e.g. ["api","devices","abc","command"]
  const method = req.method;

  if (method === "OPTIONS") { send(res, 204, {}); return; }

  // health check for the host (Render/Railway/Fly ping this)
  if (url.pathname === "/healthz" || url.pathname === "/api/health") return send(res, 200, { ok: true, ts: now() });

  // ---- static site ----
  if (seg[0] !== "api") return serveStatic(res, url.pathname);

  const body = (method === "POST" || method === "PATCH") ? await readBody(req) : {};

  try {
    /* ---------- auth ---------- */
    if (seg[1] === "register" && method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const pw = String(body.password || "");
      const name = String(body.name || "").trim() || "Parent";
      if (!/.+@.+\..+/.test(email)) return send(res, 400, { error: "Enter a valid email address." });
      if (pw.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
      if (db.prepare("SELECT 1 FROM parents WHERE email=?").get(email))
        return send(res, 409, { error: "An account with that email already exists." });
      const id = uid(); const { salt, hash } = hashPw(pw);
      db.prepare("INSERT INTO parents(id,email,name,pw_hash,pw_salt,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, email, name, hash, salt, now());
      const t = token();
      db.prepare("INSERT INTO sessions(token,parent_id,created_at) VALUES(?,?,?)").run(t, id, now());
      return send(res, 201, { token: t, parent: { id, email, name } });
    }

    if (seg[1] === "login" && method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const pw = String(body.password || "");
      const p = db.prepare("SELECT * FROM parents WHERE email=?").get(email);
      if (!p || !verifyPw(pw, p.pw_salt, p.pw_hash)) return send(res, 401, { error: "Wrong email or password." });
      const t = token();
      db.prepare("INSERT INTO sessions(token,parent_id,created_at) VALUES(?,?,?)").run(t, p.id, now());
      return send(res, 200, { token: t, parent: { id: p.id, email: p.email, name: p.name } });
    }

    /* ---------- agent (device) endpoints — keyed by pairing token ---------- */
    if (seg[1] === "agent") {
      const tk = String(body.token || req.headers["x-device-token"] || "");
      const dev = db.prepare("SELECT * FROM devices WHERE pairing_token=?").get(tk);
      if (!dev) return send(res, 401, { error: "Unknown device token." });

      if (seg[2] === "heartbeat" && method === "POST") {
        db.prepare("UPDATE devices SET online=1,last_seen=?,current_app=?,used_min=?,place=? WHERE id=?")
          .run(now(), String(body.currentApp ?? dev.current_app), Number.isFinite(body.usedMin) ? body.usedMin : dev.used_min,
               String(body.place ?? dev.place), dev.id);
        const cmds = db.prepare("SELECT id,type FROM commands WHERE device_id=? AND status='pending' ORDER BY id").all(dev.id);
        for (const c of cmds) db.prepare("UPDATE commands SET status='delivered',delivered_at=? WHERE id=?").run(now(), c.id);
        const fresh = db.prepare("SELECT * FROM devices WHERE id=?").get(dev.id);
        return send(res, 200, { commands: cmds, limitMin: fresh.limit_min, locked: !!fresh.locked });
      }
      if (seg[2] === "event" && method === "POST") {
        db.prepare("INSERT INTO events(device_id,ts,kind,title,detail) VALUES(?,?,?,?,?)")
          .run(dev.id, now(), String(body.kind || "info"), String(body.title || ""), String(body.detail || ""));
        return send(res, 201, { ok: true });
      }
      if (seg[2] === "history" && method === "POST") {
        const visits = Array.isArray(body.visits) ? body.visits.slice(0, 200) : [];
        const ins = db.prepare("INSERT INTO history(device_id,ts,url,title,browser) VALUES(?,?,?,?,?)");
        let n = 0;
        for (const v of visits) {
          const url = String(v.url || "").slice(0, 2048);
          if (!url) continue;
          ins.run(dev.id, Number(v.ts) || now(), url, String(v.title || "").slice(0, 512), String(v.browser || "").slice(0, 32));
          n++;
        }
        return send(res, 201, { ok: true, stored: n });
      }
      return send(res, 404, { error: "No such agent route." });
    }

    /* ---------- everything below needs a signed-in parent ---------- */
    const parent = parentFromAuth(req);
    if (!parent) return send(res, 401, { error: "Not signed in." });

    if (seg[1] === "logout" && method === "POST") {
      const h = req.headers.authorization || "";
      db.prepare("DELETE FROM sessions WHERE token=?").run(h.slice(7));
      return send(res, 200, { ok: true });
    }
    if (seg[1] === "me" && method === "GET") return send(res, 200, { parent });

    if (seg[1] === "devices" && seg.length === 2) {
      if (method === "GET") {
        const rows = db.prepare("SELECT * FROM devices WHERE parent_id=? ORDER BY created_at").all(parent.id);
        return send(res, 200, { devices: rows.map(deviceView) });
      }
      if (method === "POST") {
        const name = String(body.name || "").trim();
        const platform = String(body.platform || "").trim();
        if (!name) return send(res, 400, { error: "Give the device a name (e.g. the child's name)." });
        const id = uid(); const pt = token();
        db.prepare("INSERT INTO devices(id,parent_id,name,platform,pairing_token,limit_min,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, parent.id, name, platform || "Unknown", pt, 120, now());
        return send(res, 201, { device: deviceView(db.prepare("SELECT * FROM devices WHERE id=?").get(id)) });
      }
    }

    // /api/devices/:id ...
    if (seg[1] === "devices" && seg[2]) {
      const dev = db.prepare("SELECT * FROM devices WHERE id=? AND parent_id=?").get(seg[2], parent.id);
      if (!dev) return send(res, 404, { error: "Device not found." });

      if (seg.length === 3 && method === "PATCH") {
        const lim = parseInt(body.limitMin, 10);
        if (Number.isFinite(lim)) db.prepare("UPDATE devices SET limit_min=? WHERE id=?").run(Math.max(0, lim), dev.id);
        return send(res, 200, { device: deviceView(db.prepare("SELECT * FROM devices WHERE id=?").get(dev.id)) });
      }
      if (seg.length === 3 && method === "DELETE") {
        db.prepare("DELETE FROM devices WHERE id=?").run(dev.id);
        db.prepare("DELETE FROM events WHERE device_id=?").run(dev.id);
        db.prepare("DELETE FROM commands WHERE device_id=?").run(dev.id);
        return send(res, 200, { ok: true });
      }
      if (seg[3] === "events" && method === "GET") {
        const rows = db.prepare("SELECT ts,kind,title,detail FROM events WHERE device_id=? ORDER BY id DESC LIMIT 50").all(dev.id);
        return send(res, 200, { events: rows });
      }
      if (seg[3] === "history" && method === "GET") {
        const rows = db.prepare("SELECT ts,url,title,browser FROM history WHERE device_id=? ORDER BY ts DESC LIMIT 100").all(dev.id);
        return send(res, 200, { history: rows });
      }
      if (seg[3] === "command" && method === "POST") {
        const type = String(body.type || "");
        const allowed = ["lock", "unlock", "shutdown", "pause", "bedtime"];
        if (!allowed.includes(type)) return send(res, 400, { error: "Unknown command." });
        db.prepare("INSERT INTO commands(device_id,type,created_at) VALUES(?,?,?)").run(dev.id, type, now());
        // reflect intended state so the parent sees it immediately; the agent confirms on next heartbeat
        if (type === "lock" || type === "pause" || type === "bedtime") db.prepare("UPDATE devices SET locked=1 WHERE id=?").run(dev.id);
        if (type === "unlock") db.prepare("UPDATE devices SET locked=0 WHERE id=?").run(dev.id);
        if (type === "shutdown") db.prepare("UPDATE devices SET locked=1,online=0 WHERE id=?").run(dev.id);
        const label = { lock: "Lock", unlock: "Unlock", shutdown: "Shut down", pause: "Pause 30 min", bedtime: "Bedtime lock" }[type];
        db.prepare("INSERT INTO events(device_id,ts,kind,title,detail) VALUES(?,?,?,?,?)")
          .run(dev.id, now(), "command", label + " requested", "Queued for the device — applies on next check-in");
        return send(res, 201, { ok: true, device: deviceView(db.prepare("SELECT * FROM devices WHERE id=?").get(dev.id)) });
      }
    }

    return send(res, 404, { error: "No such route." });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "Server error." });
  }
});

server.listen(PORT, () => {
  console.log(`\n  EagleEye backend running — open  http://localhost:${PORT}\n  Database file: ${DB_PATH}\n`);
});

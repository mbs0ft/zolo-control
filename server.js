#!/usr/bin/env node
/**
 * Zolo Control — zero-dependency Node server
 * Serves the web UI and proxies/controls a LinkPlay "wiimu" speaker
 * (Anker Zolo Halo / A31 chipset) over its local HTTP API + UPnP SOAP.
 *
 * Why a proxy? The speaker's GoAhead web server sends no CORS headers,
 * so a browser page can't talk to it directly.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");
const net = require("net");
const os = require("os");

const ROOT = __dirname;
const CFG_PATH = path.join(ROOT, "config.json");
const UPLOAD_DIR = path.join(ROOT, "uploads");
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
const DEFAULTS = {
  deviceIp: "",          // discovered or set via UI; empty = not configured
  httpApiPort: 80,
  upnpPort: 49152,
  webPort: 3000,
  autoFixVolume: true,   // wiimu bumps volume to ~48 on Play; snap back after
  discoveryTimeoutMs: 4000,
};

/* ------------------------------- config ---------------------------------- */
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) };
  } catch {
    const cfg = { ...DEFAULTS };
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}
let config = loadConfig();
function saveConfig() {
  fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2));
}

/* --------------------------- low-level helpers ---------------------------- */
function requestHttp({ host, port = 80, method = "GET", p = "/", headers = {}, body = null, timeout = 6000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: p, headers }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function xmlVal(s, tag) {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

/** Decode wiimu hex-encoded strings ("556E6B6E6F776E" -> "Unknown"). */
function hexDecode(s) {
  if (typeof s !== "string" || !s || s.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(s)) return s;
  try {
    const out = Buffer.from(s, "hex").toString("utf8");
    return /^[\x20-\x7e\n\r\t]*$/.test(out) ? out : s; // keep original if not printable
  } catch { return s; }
}

/* ------------------------------ LinkPlay API ------------------------------ */
function getStatusEx(ip, timeout = 3500) {
  return requestHttp({ host: ip, port: config.httpApiPort, p: "/httpapi.asp?command=getStatusEx", timeout })
    .then((r) => JSON.parse(r.body));
}
function getPlayerStatus(ip, timeout = 3500) {
  return requestHttp({ host: ip, port: config.httpApiPort, p: "/httpapi.asp?command=getPlayerStatus", timeout })
    .then((r) => JSON.parse(r.body));
}
function getDebugInfo(ip, timeout = 5000) {
  return requestHttp({ host: ip, port: config.httpApiPort, p: "/httpapi.asp?command=getDebugInfo", timeout })
    .then((r) => JSON.parse(r.body));
}

/* --------------------------------- SOAP ----------------------------------- */
const SVC_AVT = "urn:schemas-upnp-org:service:AVTransport:1";
const SVC_RC = "urn:schemas-upnp-org:service:RenderingControl:1";
const AVT_CONTROL = "/upnp/control/rendertransport1";
const RC_CONTROL = "/upnp/control/rendercontrol1";

function soap(ip, service, controlPath, action, argsXml, timeout = 7000) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">${argsXml}</u:${action}></s:Body></s:Envelope>`;
  // NB: SOAPACTION must be QUOTED, or the speaker replies "Invalid Action".
  return requestHttp({
    host: ip, port: config.upnpPort, method: "POST", p: controlPath, body, timeout,
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPACTION: `"${service}#${action}"` },
  }).then((r) => {
    if (r.body.includes("<UPnPError") || /Fault/.test(r.body)) {
      throw new Error(`SOAP ${action} failed: ` + xmlVal(r.body, "errorDescription") || r.body.slice(0, 200));
    }
    return r.body;
  });
}

/* ------------------------------ device actions ---------------------------- */
async function setVolume(ip, value) {
  await soap(ip, SVC_RC, RC_CONTROL, "SetVolume",
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${value}</DesiredVolume>`);
  return getMergedState(ip);
}
async function setMute(ip, value) {
  await soap(ip, SVC_RC, RC_CONTROL, "SetMute",
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${value ? 1 : 0}</DesiredMute>`);
  return getMergedState(ip);
}
async function setEq(ip, value) {
  await soap(ip, SVC_RC, RC_CONTROL, "SetEqualizer",
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredEqualizer>${value}</DesiredEqualizer>`);
  return getMergedState(ip);
}
async function playUrl(ip, url, restoreVolume) {
  // remember volume BEFORE starting media (wiimu auto-raises "media volume")
  let prevVol = null;
  try { prevVol = parseInt((await getPlayerStatus(ip)).vol, 10); } catch {}
  const target = restoreVolume ?? prevVol;
  await soap(ip, SVC_AVT, AVT_CONTROL, "SetAVTransportURI",
    `<InstanceID>0</InstanceID><CurrentURI>${escXml(url)}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
  await soap(ip, SVC_AVT, AVT_CONTROL, "Play", `<InstanceID>0</InstanceID><Speed>1</Speed>`);
  if (config.autoFixVolume && target !== null && !isNaN(target)) {
    setTimeout(() => {
      soap(ip, SVC_RC, RC_CONTROL, "SetVolume",
        `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${target}</DesiredVolume>`)
        .catch(() => {});
    }, 3200);
  }
  return { started: true, restoredVolume: target };
}
function escXml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** Player state + transport state in one payload (frontend polls this). */
async function getMergedState(ip) {
  const player = await getPlayerStatus(ip);
  let state = null;
  try {
    const r = await soap(ip, SVC_AVT, AVT_CONTROL, "GetTransportInfo", `<InstanceID>0</InstanceID>`);
    state = xmlVal(r, "CurrentTransportState");
  } catch { /* fall back below */ }
  const st = (player.status || "").toLowerCase();
  const mapped = state === "PAUSED_PLAYBACK" ? "pause"
    : state === "PLAYING" ? "play"
    : state === "STOPPED" ? "stop"
    : st; // fallback: device's own string
  // wiimu quirk: curpos/totlen are milliseconds on this build (321000 = 5:21)
  let position = (parseInt(player.curpos, 10) || 0) / 1000;
  let duration = (parseInt(player.totlen, 10) || 0) / 1000;
  if (duration > 86400) duration = 0; // stale garbage when idle
  if (duration && position > duration) position = 0;
  if (mapped === "stop") position = 0; // device reports leftover position when stopped
  return {
    state: mapped,
    status: player.status,
    title: hexDecode(player.Title),
    artist: hexDecode(player.Artist),
    album: hexDecode(player.Album),
    position,
    duration,
    vol: parseInt(player.vol, 10) || 0,
    mute: player.mute === "1" || player.mute === 1,
    eq: parseInt(player.eq, 10) || 0,
    loop: player.loop,
  };
}

/* ------------------------------- discovery -------------------------------- */
function localIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list) if (it.family === "IPv4" && !it.internal) return it.address;
  }
  return null;
}

/** SSDP M-SEARCH (UPnP discovery, UDP 239.255.255.250:1900). */
function ssdpSearch(ms = 3000) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", () => { try { sock.close(); } catch {} resolve(found); });
    sock.on("message", (_buf, rinfo) => { if (rinfo && rinfo.address) found.add(rinfo.address); });
    sock.bind(() => {
      const sts = ["ssdp:all", "upnp:rootdevice", "urn:schemas-upnp-org:device:MediaRenderer:1"];
      const send = (st) => {
        const q = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`;
        sock.send(Buffer.from(q), 1900, "239.255.255.250");
      };
      for (const st of sts) { send(st); }
      setTimeout(() => { for (const st of sts) send(st); }, 900);
      setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, ms);
    });
  });
}

/** TCP connect sweep of the /24 we live on (speaker only opens port 80). */
function sweepSubnet(ip, usableMs = 2000) {
  const base = ip.split(".").slice(0, 3).join(".");
  const alive = [];
  let running = 0, idx = 1, done = false;
  return new Promise((resolve) => {
    const t = setTimeout(() => { done = true; resolve(alive); }, usableMs);
    const next = () => {
      if (done || idx > 254) return;
      const host = `${base}.${idx++}`;
      running++;
      const s = net.connect({ host, port: 80, timeout: 350 });
      s.on("connect", () => { alive.push(host); s.destroy(); next(); });
      s.on("timeout", () => { s.destroy(); next(); });
      s.on("error", () => next());
      s.on("close", () => { running--; if (!done && running < 128) next(); });
    };
    for (let i = 0; i < 128; i++) next();
    // keep timer accurate
    void t;
  });
}

/** A candidate counts as a LinkPlay/wiimu speaker only if getStatusEx identifies it. */
async function probeLinkplay(ip) {
  try {
    const s = await getStatusEx(ip, 2200);
    if (s && (s.hardware || s.project)) {
      return {
        ip,
        name: s.DeviceName || s.ssid || `Speaker ${ip}`,
        hardware: s.hardware || "",
        project: s.project || "",
        firmware: s.firmware || "",
        mac: s.MAC || "",
      };
    }
  } catch { /* not a LinkPlay device */ }
  return null;
}

async function discover() {
  const ssdp = await ssdpSearch(Math.min(config.discoveryTimeoutMs, 4000));
  const candidates = new Set([...ssdp]);
  if (config.deviceIp) candidates.add(config.deviceIp);
  const results = [];
  await Promise.all([...candidates].map(async (ip) => {
    const d = await probeLinkplay(ip);
    if (d) results.push(d);
  }));
  if (results.length === 0) {
    const me = localIPv4();
    if (me) {
      const alive = await sweepSubnet(me, 2600);
      await Promise.all(alive.map(async (ip) => {
        const d = await probeLinkplay(ip);
        if (d) results.push(d);
      }));
    }
  }
  // never return the IP running frontend? fine, node's own IP won't be LinkPlay
  return results;
}

/* --------------------------------- server --------------------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

const AUDIO_MIME = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".opus": "audio/ogg", ".ape": "audio/x-ape", ".wma": "audio/x-ms-wma",
};

function sanitizeName(raw) {
  const base = path.basename(raw || "").slice(0, 120);
  const safe = base.replace(/[^\w(). \-[\]]+|[\x00-\x20]/g, "_").replace(/_{2,}/g, "_");
  return safe && safe !== "." ? safe : "track_" + Date.now();
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function readJsonBody(req) {
  let raw = "";
  await new Promise((resolve, reject) => {
    req.on("data", (c) => (raw += c));
    req.on("end", resolve);
    req.on("error", reject);
  });
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function needDevice() {
  if (!config.deviceIp) return null;
  return config.deviceIp;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  let p = u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Filename",
    });
    return res.end();
  }

  try {
    /* -------- API -------- */
    if (p.startsWith("/api/")) {
      const ip = needDevice();

      if (p === "/api/discover" && req.method === "GET") {
        return json(res, 200, { devices: await discover() });
      }

      if (p === "/api/device") {
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const newIp = String(body.ip || "").trim();
          if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(newIp)) return json(res, 400, { error: "invalid IP" });
          const probe = await probeLinkplay(newIp).catch(() => null);
          if (!probe) return json(res, 400, { error: `no LinkPlay device responded at ${newIp}` });
          config.deviceIp = newIp; saveConfig();
          return json(res, 200, { device: probe });
        }
        if (req.method === "GET") {
          if (!ip) return json(res, 200, { device: null });
          const d = await probeLinkplay(ip).catch(() => null);
          return json(res, 200, { device: d });
        }
      }

      if (!ip) return json(res, 400, { error: "No device configured. Discover or set an IP first." });

      if (p === "/api/upload" && req.method === "POST") {
        try {
          const safe = sanitizeName(decodeURIComponent(String(req.headers["x-filename"] || "audio")));
          let target = path.join(UPLOAD_DIR, safe);
          if (fs.existsSync(target)) target = path.join(UPLOAD_DIR, `${Date.now()}_${safe}`);
          const limit = 200 * 1024 * 1024; // 200 MB
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(target);
            let aborted = false;
            req.on("data", (c) => {
              if (!aborted && ws.bytesWritten + c.length > limit) {
                aborted = true;
                req.unpipe(ws); req.destroy();
                ws.end(() => { try { fs.unlinkSync(target); } catch {} });
                reject(new Error("upload too large (max 200 MB)"));
              }
            });
            req.pipe(ws);
            ws.on("finish", resolve);
            ws.on("error", reject);
            req.on("error", () => { if (!aborted) reject(new Error("upload aborted")); });
          });
          const rel = path.basename(target);
          const lanIp = localIPv4();
          const host = lanIp || (req.socket.localAddress || "").replace(/^::ffff:/, "") || "localhost";
          return json(res, 200, {
            name: rel,
            size: (fs.statSync(target)).size,
            url: `http://${host}:${config.webPort}/uploads/${encodeURIComponent(rel)}`,
          });
        } catch (e) {
          return json(res, 400, { error: e.message || "upload failed" });
        }
      }

      if (p === "/api/state" && req.method === "GET") return json(res, 200, await getMergedState(ip));
      if (p === "/api/status" && req.method === "GET") return json(res, 200, await getStatusEx(ip));
      if (p === "/api/debug" && req.method === "GET") return json(res, 200, await getDebugInfo(ip));

      if (p === "/api/volume" && req.method === "POST") {
        const { value } = await readJsonBody(req);
        const v = Math.max(0, Math.min(100, parseInt(value, 10)));
        if (isNaN(v)) return json(res, 400, { error: "value 0-100 required" });
        return json(res, 200, await setVolume(ip, v));
      }
      if (p === "/api/mute" && req.method === "POST") {
        const { value } = await readJsonBody(req);
        return json(res, 200, await setMute(ip, !!value));
      }
      if (p === "/api/eq" && req.method === "POST") {
        const { value } = await readJsonBody(req);
        const v = parseInt(value, 10);
        if (isNaN(v) || v < 0 || v > 9) return json(res, 400, { error: "eq value 0-9 required" });
        return json(res, 200, await setEq(ip, v));
      }
      if (p === "/api/play" && req.method === "POST") {
        const { url, restoreVolume } = await readJsonBody(req);
        if (!/^https?:\/\//i.test(String(url))) return json(res, 400, { error: "url must start with http(s)://" });
        return json(res, 200, await playUrl(ip, String(url), restoreVolume ?? null));
      }
      if (p === "/api/pause" && req.method === "POST") {
        await soap(ip, SVC_AVT, AVT_CONTROL, "Pause", `<InstanceID>0</InstanceID>`);
        return json(res, 200, await getMergedState(ip));
      }

      if (p === "/api/resume" && req.method === "POST") {
        await soap(ip, SVC_AVT, AVT_CONTROL, "Play", `<InstanceID>0</InstanceID><Speed>1</Speed>`);
        return json(res, 200, await getMergedState(ip));
      }
      if (p === "/api/stop" && req.method === "POST") {
        await soap(ip, SVC_AVT, AVT_CONTROL, "Stop", `<InstanceID>0</InstanceID>`);
        return json(res, 200, await getMergedState(ip));
      }
      if (p === "/api/next" && req.method === "POST") {
        await soap(ip, SVC_AVT, AVT_CONTROL, "Next", `<InstanceID>0</InstanceID>`);
        return json(res, 200, await getMergedState(ip));
      }
      if (p === "/api/prev" && req.method === "POST") {
        await soap(ip, SVC_AVT, AVT_CONTROL, "Previous", `<InstanceID>0</InstanceID>`);
        return json(res, 200, await getMergedState(ip));
      }
      if (p === "/api/seek" && req.method === "POST") {
        const { seconds } = await readJsonBody(req);
        const s = Math.max(0, parseInt(seconds, 10) || 0);
        const hh = String(Math.floor(s / 3600)).padStart(2, "0");
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        await soap(ip, SVC_AVT, AVT_CONTROL, "Seek",
          `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${hh}:${mm}:${ss}</Target>`);
        return json(res, 200, { seeked: true });
      }

      return json(res, 404, { error: "unknown api route" });
    }

    /* -------- uploaded audio (served to the speaker, Range-capable) -------- */
    if (p.startsWith("/uploads/") && req.method === "GET") {
      const fp2 = path.join(UPLOAD_DIR, sanitizeName(decodeURIComponent(p.slice("/uploads/".length))));
      fs.stat(fp2, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
        const type = AUDIO_MIME[path.extname(fp2).toLowerCase()] || "audio/mpeg";
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
        const common = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
        if (range) {
          let start, end;
          if (range[1] === "") { // suffix range "bytes=-N"
            const n = Math.min(parseInt(range[2], 10) || 262144, st.size);
            start = st.size - n; end = st.size - 1;
          } else {
            start = parseInt(range[1], 10);
            end = range[2] === "" ? st.size - 1 : Math.min(parseInt(range[2], 10), st.size - 1);
          }
          if (start > end || start >= st.size) {
            res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
            return res.end();
          }
          res.writeHead(206, {
            ...common,
            "Content-Range": `bytes ${start}-${end}/${st.size}`,
            "Content-Length": end - start + 1,
          });
          return fs.createReadStream(fp2, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...common, "Content-Length": st.size });
        fs.createReadStream(fp2).pipe(res);
      });
      return;
    }

    /* -------- static -------- */
    if (p === "/") p = "/index.html";
    let fp = path.join(ROOT, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!fp.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end("forbidden"); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  } catch (e) {
    console.error("handler error:", e && e.stack || e);
    json(res, 502, { error: e.message || String(e) });
  }
});

server.listen(config.webPort, "0.0.0.0", () => {
  console.log(`Zolo Control running → http://localhost:${config.webPort}`);
  console.log(`Device: ${config.deviceIp || "(not configured — use Discover in the UI)"}`);
});

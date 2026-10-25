# Zolo Control

A zero-dependency web UI for the **Anker Zolo Halo** speaker (LinkPlay A31 "wiimu" platform,
Alexa built-in, discontinued) — resurrected as a LAN-controllable streamer.

Also likely works as-is with other LinkPlay-based speakers (just discover them).

![status](https://img.shields.io/badge/platform-LinkPlay%20A31-7c5cff)
![deps](https://img.shields.io/badge/dependencies-0-00d4a2)

## What it does

| Feature | How |
|---|---|
| **Device discovery** | SSDP (UPnP M-SEARCH) + automatic LAN port-80 scan fallback; falls back to manual IP entry |
| **Local file playback** | Pick files from your PC → they upload to the proxy (with progress) → the speaker streams them back over HTTP. Queue with auto-advance. Range requests supported (seek works) |
| **Device info panel** | Chipset, firmware/build, Alexa/DSP/MCU versions, MAC, Wi-Fi SSID/channel/RSSI quality, internet state |
| **Now playing** | Track/artist/album, live position with click/drag-to-seek progress bar |
| **Material 3 UI** | Full Material You theming: light/dark schemes with toggle, state-layer buttons, segmented EQ control, FAB, dialogs, snackbars, Roboto + Material Symbols |
| **Plays from anywhere** | Frontend is origin-agnostic — deploy the static UI to Cloudflare Pages and point it at a "bridge" (see below) |
| **Transport** | Play (any HTTP(S) audio URL), Pause, Stop, Prev, Next |
| **Volume & mute** | Real UPnP RenderingControl Set/Get |
| **EQ presets** | `SetEqualizer` 0–5 (device uses numeric presets) |
| **Auto volume fix** | The speaker silently jumps to "media volume" (~48) when a stream starts — the proxy snaps it back to your level |
| **Zero dependencies** | Plain Node.js (built-ins only) + one HTML file. Nothing to `npm install`. |

## Quick start

```sh
node server.js
# → Zolo Control running → http://localhost:3000
```

Open **http://localhost:3000**, press **⚙︎ → Discover**, pick your speaker. Done.
(First run has no `config.json` — it's created automatically and git-ignored; `config.example.json` is the committable template.)

Control it from your phone too — the server listens on `0.0.0.0`, so open
`http://<your-computer-ip>:3000` from any device on the same Wi-Fi.

> Playing local files? Run a quick static server in the folder:
> `python3 -m http.server 8888` then use `http://<your-computer-ip>:8888/song.mp3`.

## Config (`config.json`, auto-created)

| Field | Default | Meaning |
|---|---|---|
| `deviceIp` | `""` | speaker IP; set automatically when you pick a discovered device |
| `webPort` | `3000` | local UI server port |
| `upnpPort` | `49152` | speaker's UPnP control port |
| `autoFixVolume` | `true` | restore pre-play volume after each `play` (wiimu volume jump quirk) |

## HTTP API exposed by the proxy

Same-origin JSON (the UI uses these too):

```
GET  /api/status      rich device info (firmware, hw, wifi, capabilities)
GET  /api/state       merged player state: title/artist/album (utf-8), position, duration, vol, mute, eq, state
GET  /api/debug       diagnostics (ASR state, crash counters, OTA)
GET  /api/discover    SSDP + subnet scan → [{ip,name,hardware,project,firmware,mac}]
GET  /api/device      current device (+live verify)
POST /api/device      {ip}  — validate & save
POST /api/upload      file upload (binary body + X-Filename header) → {url} hosted at /uploads/<name>
GET  /uploads/<name>  audio served with Range support (speaker fetches this URL)
POST /api/volume      {value 0-100}
POST /api/mute        {bool}
POST /api/eq          {0-9}  (0-5 typical on this build)
POST /api/play        {url, restoreVolume?} — SetAVTransportURI + Play (+ auto volume fix)
POST /api/pause | /api/resume | /api/stop
POST /api/seek        {seconds}   (REL_TIME — untested on this build, SCPD-listed)
POST /api/next | /api/prev        (SCPD-listed, untested)
```

## Device quirks we had to engineer around

- **SOAPACTION must be quoted** (`"urn:…#SetVolume"`) or the speaker returns `Invalid Action` even for valid actions.
- **wiimu raises volume to ~48 when media starts** — separate "media volume" from the indicator volume. Handled with a delayed re-apply (`autoFixVolume`).
- **HTTP API is case-sensitive** (`getPlayerStatus`, not `getplayerstatus`) and the `set*` verbs are stripped from this Alexa build — writes go via UPnP SOAP.
- Metadata (`Title/Artist/Album`) arrives **hex-encoded** — decoded server-side.
- `curpos`/`totlen` come in **milliseconds** here (e.g. `321000` = 5:21) — converted to seconds by the proxy; stale idle values are zeroed.
- `Title` may be the last fetched URL rather than a song name (device firmware behavior).
- When idle/stream stopped, the device reports stale position/duration.
- Upstreams that send audio must be reachable from the speaker (LAN or internet).

## Deep dive docs

- [`zolo-halo-api.md`](zolo-halo-api.md) — full API reference of the speaker itself (HTTP API + UPnP SOAP, quirks, curl/JS snippets)
- [`zolo-halo-notes.md`](zolo-halo-notes.md) — device discovery story, open ports, hardware details, test log

## Notes

- The proxy has **no authentication** — LAN-tecrow tools only. Don't expose it to the internet.
- Avoid OTA/Wi-Fi/UART debug features of the underlying firmware unless you're researching (see notes doc) — a bricked discontinued speaker has no factory OS to re-flash.
- Tested against: Zolo Halo, fw `4.2.331854` (`a31ankera1alexa`, Oct 2021), hardware A31.

## Notes

- The proxy has **no authentication** — LAN tools only. Don't expose it to the internet.
- Upstream audio URLs must be reachable from the speaker (LAN or internet).

# Hosting the UI on Cloudflare Pages

The UI is static — one HTML file — so Pages works out of the box:

```sh
npx wrangler pages deploy public --project-name zolo-control
```

The Node proxy (`server.js`) **cannot** run on Pages (it needs LAN access to the speaker),
so the hosted UI talks to a **bridge** — the Node server running on your machine/NAS.

Two ways to run it:

| Setup | How | Notes |
|---|---|---|
| **Fully local** (simplest) | `node server.js`, open `http://localhost:3000` | UI + bridge on one origin, zero config |
| **UI on Pages + local bridge** | Deploy UI to Pages, then expose a HTTPS bridge and set its URL in ⚙︎ → Bridge | Browsers block plain `http` calls from an `https` page (mixed content), so the bridge needs TLS, e.g. a free quick tunnel: `cloudflared tunnel --url http://localhost:3000` → paste the `https://…trycloudflare.com` URL into Settings → Bridge |

The bridge already serves permissive CORS (`*`), including `OPTIONS` preflights and the
`X-Filename` custom header used by uploads.

## Roadmap ideas

- Multi-room grouping (PlayQueue/slave-mask SOAP APIs already mapped in the docs)
- Alarm management (`Get/SetAlarmQueue`)
- WebSocket push instead of polling


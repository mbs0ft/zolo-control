# Zolo Halo (LinkPlay A31 "wiimu") — API Reference for a Browser Frontend

Device: `192.168.31.239` — Anker Zolo Halo, firmware 4.2.331854 (`a31ankera1alexa`)
Everything below is **no-auth local HTTP**. Verified live on 2026-10-25 unless marked untested.

---

## 0. Architecture at a glance

| Layer | Where | Best for |
|---|---|---|
| HTTP JSON API | `http://192.168.31.239/httpapi.asp?command=<cmd>` (port 80) | **Status/monitoring** (device info, player state, debug) |
| UPnP SOAP AVTransport | `http://192.168.31.239:49152/upnp/control/rendertransport1` | **Playback control** (play URL, stop, pause, seek, next/prev, loop mode) |
| UPnP SOAP RenderingControl | `http://192.168.31.239:49152/upnp/control/rendercontrol1` | **Volume, mute, EQ, device name, alarms** |
| UPnP SOAP PlayQueue (wiimu custom) | `http://192.168.31.239:49152/upnp/control/PlayQueue1` | Untested — likely media presets & queue |

### Browser/CORS reality check (important for a frontend!)
The GoAhead server sends **no CORS headers**. A web page on another origin cannot read these responses directly from JS. Options:
1. **Serve the frontend from a tiny local proxy** (Node/Express, Go, or even a Bash+netcat dev proxy) — recommended; also gives you HTTPS->HTTP relay for your Navidrome URLs.
2. Browser extension disabling web security (dev only).
3. Tauri/Electron/desktop app shell — no CORS restrictions.

All SOAP must be sent as `POST` with `Content-Type: text/xml; charset=utf-8`.

### Two showstoppers you WILL hit (encode them in your frontend helpers)
1. **SOAPACTION must be quoted** or you get `UPnPError -111 Invalid Action` even for valid actions:
   ```js
   headers = { SOAPACTION: `"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"` }
   ```
2. **wiimu auto-raises volume to ~48 when a media stream starts** (media volume ≠ Alexa indicator volume). Snap it back after `Play` if you want consistent UX.

---

## 1. HTTP JSON API (port 80) — monitoring

All are GET; responses are compact JSON. Unknown commands → plain-text `unknown command`.
**Verified working:**

| Command | Purpose | Key fields |
|---|---|---|
| `getStatusEx` | Full device info (best for the "About/Settings" page) | `DeviceName`, `GroupName`, `firmware`, `hardware`, `project`, `build`, `Release`, `alexa_ver`, `dsp_ver`, `mcu_ver`, `vol`-independent info like `upnp_uuid`, `MAC`, `essid` (hex SSID), `RSSI`, `WifiChannel`, `battery_percent`, `spotify_active`, `preset_key` (count = 6), hidden-AP flags |
| `getStatus` | Same core as getStatusEx (slightly smaller) | same subset |
| `getPlayerStatus` | **Player state for the Now-Playing screen** | `status` (`stop`/`play`/…), `vol` (0–100), `mute` (0/1), `loop` mode, `eq` (numeric preset), `curpos` (sec), `totlen` (sec), `plicount`/`plicurr`, `Title`/`Artist`/`Album` (**hex-encoded UTF-8** — decode before display, e.g. `556E6B6E6F776E` = `Unknown`) |
| `getDebugInfo` | Health/diagnostics page | `asr_ongoing`, `asr_ready`, `alexa_response_status`, crash counters (`asr_tts_crash`, `process_deadlock`, …), `power_ticks`, `RA0_clients`/`APP_clients`, OTA flags |
| `getNetworkList` | Security mode | `securemode` |

## 2. UPnP SOAP — CONTROL (the real write channel)

Base: `http://192.168.31.239:49152` · Service URNs:
- AVTransport: `urn:schemas-upnp-org:service:AVTransport:1`
- RenderingControl: `urn:schemas-upnp-org:service:RenderingControl:1`

Request body template:
```xml
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:ACTION xmlns:u="SERVICE_URN"><InstanceID>0</InstanceID></u:ACTION></s:Body>
</s:Envelope>
```
Success = matching `<u:ActionNameResponse>` element. Failure = `UPnPError` XML.

### 2.1 RenderingControl tested

| Action | Args | Verified | Notes |
|---|---|---|---|
| `GetVolume` | `Channel=Master` | OK | returns `CurrentVolume` 0–100 |
| `SetVolume` | `DesiredVolume` 0–100 | OK (36→37→36) | immediate effect |
| `GetMute` | `Channel=Master` | OK | `CurrentMute` 0/1 |
| `SetMute` | `DesiredMute` 0/1 | OK on & off | |
| `GetEqualizer` | `Channel=Master` | OK | returns **numeric** preset (`0` = normal/flat; mapping TBD — try 1..N by ear) |
| `SetEqualizer` | `DesiredEqualizer` numeric | OK (0→2→0) | audible instantly |
| `ListPresets` | — | OK | returns only `FactoryDefaults` (media preset keys ≠ this; see PlayQueue) |
| `SetDeviceName` | `Name` | untested | rename "Zolo Halo (Kirill)" |
| `Get/SetAlarmQueue`, `DeleteAlarmQueue` | XML blob | untested | alarm management |
| `GetSimpleDeviceInfo`, `GetControlDeviceInfo`, slave-mask cmds | — | untested | **multi-room** group management |

### 2.2 AVTransport ✓ tested (playback engine)

| Action | Args | Verified | Purpose |
|---|---|---|---|
| `SetAVTransportURI` | `CurrentURI` (HTTP URL, mp3/mp3-stream), `CurrentURIMetaData` (can be empty) | OK | **play any HTTP audio URL** |
| `Play` | `Speed=1` | OK | also works w/o SetURI on last track |
| `Pause`, `Stop` | — | Stop OK | |
| `GetPositionInfo` | — | OK | `RelTime` (HH:MM:SS), `TrackDuration`, `CurrentTrackURI` |
| `GetTransportInfo` | — | OK | `CurrentTransportState`: `STOPPED`/`PLAYING`/`PAUSED_PLAYBACK`/`TRANSITIONING` — **poll this every ≤2 s for the UI** (device pushes no events reliably) |
| `GetMediaInfo` | — | OK | current URI, duration, NrTracks |
| `GetInfoEx` | — | untested | wiimu extended info (vol, battery, alarm flag, Spotify active…) — richer for UI than GetTransportInfo |
| `Seek` | `Unit=REL_TIME`, `Target=HH:MM:SS` | untested (listed in SCPD) | scrubbing |
| `Next`, `Previous`, `SetPlayMode`, `SeekForward/SeekBackward` | — | untested (listed in SCPD) | playlist hops / loop-shuffle mode |
| `GetPlayType`, `GetCurrentTransportActions`, `GetDeviceCapabilities` | — | untested | |

### 2.3 PlayQueue service (`PlayQueue1`) — untested, likely media presets
SCPD: `http://192.168.31.239:49152/upnp/PlayQueueSCPD.xml` (14 KB of actions). 6 hardware `preset_key`s exist. Worth exploring for: preset banks, queue editing, wiimu-native playlist features.

## 3. Gotchas cheat-sheet for implementation

- Hex-decode metadata (`Title/Artist/Album` in getPlayerStatus).
- Poll `GetTransportInfo`/`GetInfoEx` (no reliable UPnP GENA eventing — subscribing to `/upnp/event/*` exists but keep fallback polling).
- `RelTime`/durations are `HH:MM:SS` strings; `curpos` in getPlayerStatus is seconds.
- Volume jump post-`Play` (~48) — clamp/restore.
- `unknown command` = this UART-trimmed Alexa build doesn't implement generic LinkPlay play/volume verbs via port 80; always use SOAP for control.
- Dangerous admin verbs that exist but avoid: anything touching OTA/`updateFirmware`, Wi-Fi config, ` vitality`, UART passthrough on `8899` (raw DSP/MCU bytes!), reboot/reset.
- Optional next exploration: port 59152 (second UPnP mirror), PlayQueue SCPD dump, `GetInfoEx`, `Seek`, SetPlayMode loops, `SetDeviceName`.

## 4. Copy-paste snippets

```js
async function soap(port, path, service, action, argsXml) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
   <s:Body><u:${action} xmlns:u="${service}">${argsXml}</u:${action}></s:Body>
  </s:Envelope>`;
  const res = await fetch(`http://192.168.31.239:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPACTION: `"${service}#${action}"` },
    body,
  });
  return res.text();
}

soap(49152, "/upnp/control/rendercontrol1",
  "urn:schemas-upnp-org:service:RenderingControl:1", "GetVolume",
  `<InstanceID>0</InstanceID><Channel>Master</Channel>`);
soap(49152, "/upnp/control/rendercontrol1",
  "urn:schemas-upnp-org:service:RenderingControl:1", "SetVolume",
  `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>45</DesiredVolume>`);

soap(49152, "/upnp/control/rendertransport1",
  "urn:schemas-upnp-org:service:AVTransport:1", "SetAVTransportURI",
  `<InstanceID>0</InstanceID><CurrentURI>http://192.168.31.225:8888/song.mp3</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
soap(49152, "/upnp/control/rendertransport1",
  "urn:schemas-upnp-org:service:AVTransport:1", "Play",
  `<InstanceID>0</InstanceID><Speed>1</Speed>`);

await fetch("http://192.168.31.239/httpapi.asp?command=getPlayerStatus").then(r=>r.json());
```

## 5. Full endpoint index (quick copy)

```
GET  http://192.168.31.239/httpapi.asp?command=getStatusEx
GET  http://192.168.31.239/httpapi.asp?command=getStatus
GET  http://192.168.31.239/httpapi.asp?command=getPlayerStatus
GET  http://192.168.31.239/httpapi.asp?command=getDebugInfo
GET  http://192.168.31.239/httpapi.asp?command=getNetworkList
GET  http://192.168.31.239:49152/description.xml
GET  http://192.168.31.239:49152/upnp/rendertransportSCPD.xml
GET  http://192.168.31.239:49152/upnp/rendercontrolSCPD.xml
GET  http://192.168.31.239:49152/upnp/renderconnmgrSCPD.xml
GET  http://192.168.31.239:49152/upnp/PlayQueueSCPD.xml
POST http://192.168.31.239:49152/upnp/control/rendercontrol1      (RenderingControl SOAP)
POST http://192.168.31.239:49152/upnp/control/rendertransport1    (AVTransport SOAP)
POST http://192.168.31.239:49152/upnp/control/PlayQueue1          (wiimu PlayQueue, untested)
```

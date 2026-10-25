# Zolo Halo — Device Notes (LinkPlay A31 "wiimu")

> Device: Anker Zolo Halo (Alexa built-in), LAN IP `xxx`
> Discovered via network probing on 2026‑10‑25. All findings from read-only requests.

## Identity

| Property | Value |
|---|---|
| Chipset | LinkPlay **A31** (Mediatek-based Wi-Fi audio SoC, Linux 2.6.36+) |
| Firmware | **4.2.331854**, project `Zolo_Halo`, build name `a31ankera1alexa`, branch `stable/wiimu-4.2`, release 2021‑10‑08 |
| Alexa | version `20180604` (old embedded AVS build) |
| DSP | 6.120.0.12 |
| MCU | v128 |
| UUID | XXXXXXXXXXXXXXXXXXXXXXXX |
| MAC | 00:22:6C:A7:D0:50 (00:22:6C = Anker Technology) |
| Device name | Zolo Halo (xxx) |
| Hidden AP | `Zolo Halo_XXXX` (hidden SSID, internal network 10.10.10.254 on `ra0`) |
| Web server | GoAhead-Webs (port 80), Linux/2.6.36+ (UPnP server on 49152/59152) |
| Country | CN, RSSI −41 dBm |

## Open TCP ports (full 1–65535 scan)

| Port | Purpose |
|---|---|
| 53 | DNS proxy (device doubles as resolver when in hotspot mode) |
| 80, 443 | GoAhead web + LinkPlay HTTP API |
| 5356 | "eSDK" service |
| 8819 | communication_port (device-to-device) |
| 8899 | **uart_pass_port** — UART passthrough to DSP/MCU |
| 18100 / 19004 / 19100 | binary/nonstandard (HTTP/0.9-style) |
| 21001–21036 | multiroom audio data/control bank (banner: `Data-Port:21021 Ver:2 ntp:<ts>`) |
| 49152, 59152 | UPnP servers (`SERVER: Linux/2.6.36+`) |

**Closed:** 22 (SSH), 23 (Telnet), 5555 (ADB) — **no network shell, no ADB.**

## HTTP API (port 80, `/httpapi.asp?command=<cmd>`)

Open this in any browser: http://192.168.31.239/httpapi.asp?command=getStatusEx

### Confirmed working commands

- `getStatus` / `getStatusEx` — full device status JSON (identity, firmware, network, capabilities, ports)
- `getPlayerStatus` — playback state, title/artist/album (hex-encoded), volume, mute, loop, EQ
- `getDebugInfo` — deep internal state (ASR/Alexa state, crash counters, power ticks, UPnP action queue, OTA flags)
- `getNetworkList` — returns `{"securemode":"0"}`

### Sample: getPlayerStatus

```json
{"type":"0","ch":"0","mode":"0","loop":"0","eq":"0","status":"stop","curpos":"0",
 "Title":"556E6B6E6F776E","Artist":"556E6B6E6F776E","Album":"556E6B6E6F776E",
 "plicount":"0","plicurr":"0","vol":"36","mute":"0"}
```
(Title/Artist/Album are hex-encoded strings; `556E6B6E6F776E` = "Unknown".)

### Rejected / not present on this build

`getSysInfo`, `getLanguageList`, `getChannelList`, `getPlaylist`, `getAlarmList`, `getWifiList`, `getMacAddress`, `getDNS`, `getDSPVersion`, `getMCUVersion`, `getPresetKey`, `getDebugInfo`-style extras, etc. → "unknown command". The API surface is trimmed by the `a31ankera1alexa` project config — not all stock LinkPlay commands exist here.

## Key config flags from getStatusEx

- `web_firmware_update_hide: 0` — the web updater is present (not hidden)
- `uart_pass_port: 8899`, `communication_port: 8819`
- `hideSSID: 1` — device's own hidden setup AP exists
- `spotify_active: 0` (Spotify Connect not active… support flags exist though)
- `capability: 0x28084000`, `streams: 0x1e800008` — capability bitmaps (AirPlay etc.)
- `silenceOTATime: ""`, `ignore_silenceOTATime: 1`

## What this means (attack/repurpose surface)

1. **No ADB/shell over network** — device is embedded Linux (wiimu), not Android.
2. **Full local control via HTTP API** — playback (upnp/`SetAVTransportURI`-style), volume, grouping, EQ; browser-accessible JSON.
3. **Possible shell paths** (untested): hidden debug commands on wiimu builds, UART passthrough on 8899, hidden setup AP `Zolo Halo_D050` captive portal, or physical UART header on the A31 PCB (115200 baud).
4. **Firmware acquisition** — wiimu OTA often pullable over HTTP; would allow full filesystem analysis offline.

## Write/test results (2026‑10‑25)

**Direct HTTP control (`/httpapi.asp`) is read-mostly on this build** — all `setVolume`/`setMute` syntax variants return "unknown command". Real writes go through the **UPnP/DLNA SOAP interface** (port 49152, control URL `/upnp/control/rendercontrol1`):

### Critical quirk
- SOAPACTION header **must be quoted**: `SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"` — unquoted gives `UPnPError -111 Invalid Action` even for actions listed in the SCPD.

### Verified working (writes restored after test — final state unchanged)
- `SetVolume` (36→37→36, verified by `GetVolume` + HTTP `getPlayerStatus` both showing 36)
- `GetVolume`, `GetMute`
- `SetMute` (on→1, off→0, verified)

### Available but untested (from SCPD files)
- RenderingControl: `SetEqualizer`, `SetChannel`, `ListPresets`, `SelectPreset`, `StreamServicesCapability`, `Get/SetAlarmQueue`, `SetDeviceName`, multi-room slave commands (`GetSimpleDeviceInfo`, `GetControlDeviceInfo`, slave mask/multiroom)
- AVTransport (port 49152 `/upnp/control/rendertransport1`): `Play`, `Pause`, `Stop`, `Next`, `Previous`, `Seek`, `SetAVTransportURI` (URL playback push!), `SetPlayMode`, `GetInfoEx`, `GetPlayType`
- PlayQueue (wiimu custom service, `/upnp/control/PlayQueue1`)

### DLNA device description (port 49152 `/description.xml`)
- Device type: `MediaRenderer:1`, DLNA DMR‑1.50
- friendlyName: Zolo Halo (xxx) · manufacturer: **wiimu** · model: WiiMu LinkPlayer · modelNumber: V01‑Oct 8 2021
- Services: AVTransport:1, ConnectionManager:1, RenderingControl:1, PlayQueue:1 (wiimu), QPlay:1 (Tencent)

### Interface summary (how to control the speaker)

| Interface | Access | Verdict |
|---|---|---|
| HTTP API port 80 | `/httpapi.asp?command=...` | Reads: status, player, debug. Writes: rejected on this build |
| UPnP SOAP (49152/59152) | POST + quoted SOAPACTION | **Full control: volume, mute, playback URI push, EQ, presets, alarms, device name** |
| Direct raw | — | ADB/SSH/Telnet: none |

### Live playback test (2026‑10‑25) — all passed
- Served user's MP3 (`xxx.mp3`, ~13 MB) from Mac via `python3 -m http.server 8888` on `aaa` IP
- `SetAVTransportURI` + `Play` (quoted SOAPACTION) → speaker fetched the file (server log shows `xxx` IP GET) and played out loud
- `GetTransportInfo` → `PLAYING`, `GetPositionInfo` → `RelTime` advanced 00:00:05 → 00:00:12
- `Stop` → `STOPPED` confirmed. Stop mid-download causes the source server's broken-pipe (normal).
- **Volume quirk:** wiimu raised device volume 36 → 48 automatically when media playback started. Restored to 36 afterward. When automating playback, expect and correct the volume jump.
- On-body/app `getPlayerStatus` stays in sync with UPnP state.

### EQ test — passed
- `GetEqualizer` → `"0"` (numeric presets, 0 = flat/normal)
- `SetEqualizer` 0→2→0, verified by readback each time. Take: presets are numeric; mapping to named profiles (Rock/Classical/…) still unknown.

### AirPlay — NOT available on this build
- Full 1–65535 TCP scan: no 6000/6001/7000 (AirPlay/RAOP/mirror ports)
- mDNS browse of `_raop._tcp` & `_airplay._tcp`: speaker never advertises (only MacBook + Yandex devices appear)
- Capability bits in getStatusEx (`streams: 0x1e800008`) suggest LinkPlay's stream stack is partly compiled in, but AirPlay is disabled/cut by Anker. Re-enabling would need firmware modification (needs UART root access).

## Reference

- Community: "LinkPlay reverse engineering" wiki + wiimu firmware research (A31/A31G platform)
- LinkPlay stock API docs cover the generic command set; this device accepts a subset.

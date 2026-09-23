# Jumper Bridge (POC)

Bridges the modern Gecko web app to the legacy Chameleon EHR running in Edge's
IE mode, without requiring the full Jumper desktop app. Four components live
in this repo:

| Component | Path | Role |
|---|---|---|
| Extension | `edge/` | Manifest V3 extension. Intercepts the modern app's link and `window.open()` signals and routes each one through shared-session HTTP/navigation, a new tab, or a native app launch. Also hosts Gecko in a side panel. |
| Native messaging host | `native-host/` | `com.jumper.native_host` — queries department state through the BHO and launches Namer. |
| BHO | `bho-poc/` | `JumperBho.dll`, a Browser Helper Object loaded by Trident into `iexplore.exe`. Reads Chameleon's department-tab state. |
| Shared | `shared/` | `BridgeProtocol.cs` — the wire protocol linked (not project-referenced) into both C# projects. **Changing it means rebuilding both.** |

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/handoff.md`](docs/handoff.md) | Full architecture, how each link type is routed, known limitations. **Start here.** |
| [`docs/decisions.md`](docs/decisions.md) | Current design decisions and the maintenance constraints behind them. |

Key conclusions worth knowing up front (see
`docs/decisions.md`):

- **Patient opening is extension-only.** Edge's supported Enterprise Mode
  cookie sharing gives Chromium the authenticated Chameleon session. The
  extension primes the server's QuickOpen state in the background, then
  navigates IE mode to `Home/Main` with the corrected PatientNum/national-ID
  mapping. Verified with no false alert and no additional login.
- **Med Orders is extension-only.** The extension reproduces Chameleon's
  `GetUserSector()` data source with an authenticated `GetUserDetails` request
  through the shared session, then opens `MedOrdersFrm.aspx` with the returned
  sector. No BHO/native-host call is made.
- **The BHO remains only for department-tab detection.** Edge IE mode still
  exposes no scriptable document to extensions or external automation.
- **The BHO is optional if automatic מחלקות switching is not required.** In
  that configuration the native host is needed only for Gecko's Namer button.
  If Namer is also omitted, the runtime can be extension-only.
- **Signal URLs are stopped inside Gecko.** A document-start content bridge
  intercepts recognized links and `window.open()` calls before a temporary tab
  or IE-mode request exists, eliminating the download-prompt dependency.

Required Enterprise Mode Site List entries:

```xml
<shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="_cu"
               source-engine="Both" />
```

## Why two binaries, one repo

When used, the BHO and native host are **architecturally required to stay
separate binaries** — Trident instantiates the BHO via
`CoCreateInstance(CLSCTX_INPROC_SERVER)`, which needs an in-proc COM DLL
(`InprocServer32`); Edge launches the native host as a standalone process via
`connectNative`, which needs a normal EXE. One binary can't satisfy both
activation models. This repo only unifies the *source layout and install
tooling* — see `install-jumper-bridge.ps1` below.

## Prerequisites

- Chameleon (`http://chsw.tasmc.corp`) already opens in Edge IE mode on this
  machine (Enterprise Site List / neutral sites configured).
- .NET SDK with the `net472` targeting pack (for `dotnet build`).

## Quick install (recommended)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Dev\jumper-bridge\install-jumper-bridge.ps1
```

Self-elevates once (a single UAC prompt), builds both `bho-poc` and
`native-host` in Release, registers both, and installs the shared-cookie site
list:
- BHO: `regasm /codebase` (both 32/64-bit .NET) + the `Browser Helper Objects`
  activation key under HKLM (+ Wow6432Node) — the only step that needs admin.
- Native host: one HKCU key pointing Edge at `native-host/com.jumper.native_host.json`.
- Enterprise Mode: downloads the current `InternetExplorerIntegrationSiteList`,
  preserves its sites, adds the three Chameleon `<shared-cookie>` entries,
  writes `%ProgramData%\JumperBridge\sites-with-shared-cookies.xml`, and points
  the current user's Edge policy to that local merged copy.

Safe to re-run any time (rebuild, or after the extension ID changes).
Re-running also refreshes the local list from the original corporate URL saved
under `HKCU\Software\JumperBridge`.

## Manual install (equivalent, two steps)

```powershell
cd bho-poc; dotnet build -c Release; .\register-bho.ps1          # elevated
cd ..\native-host; dotnet build -c Release; .\register-native-host.ps1
```

## Load the extension

`edge://extensions` → Developer mode → **Load unpacked** → `C:\Dev\jumper-bridge\edge`.

**Important:** Edge derives an unpacked extension's ID from its absolute
folder path. If you ever move/rename this repo, the extension gets a **new
ID**, which breaks `native-host/com.jumper.native_host.json`'s
`allowed_origins` — check the extension's ID on its card (Details) and update
that file to match (no rebuild/re-registration needed, it's read fresh).

## Verify

1. Fully restart Edge (BHO activation keys are read once, at IE-mode host
   startup, and the new Enterprise Mode list must be loaded).
2. **Log out of Chameleon completely, then log back in.** Restoring an existing
   login is insufficient: the session cookies must be freshly issued after the
   shared-cookie rules are active.
3. Open a Chameleon IE-mode tab; confirm `C:\Temp\jumper-bho.log` is growing.
4. Confirm `C:\Temp\jumper-native-host.log` is growing (the extension polls
   it every ~1.5s).
5. Open the extension popup; confirm Settings loads (proves the native host +
   named-pipe round-trip end to end).
6. Click **Probe sector**; a returned sector confirms the Chromium side has the
   shared Chameleon session.

## Dev loop

- `JumperBho.dll` is locked by `iexplore.exe` **and** `explorer.exe` while
  loaded — close Edge (ends `iexplore.exe`) and, if still locked, restart
  Explorer before rebuilding. No re-registration needed after a rebuild
  (`/codebase` points straight at the build output).
- `JumperNativeHost.exe` is respawned every ~1.5s by the extension's poll.
- Bump `manifest.json`'s version on every extension change, to confirm a
  reload actually took effect.

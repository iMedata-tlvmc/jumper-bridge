# Jumper Bridge (POC)

Bridges the modern Gecko web app to the legacy Chameleon EHR running in Edge's
IE mode, without requiring the full Jumper desktop app. Four components live
in this repo:

| Component | Path | Role |
|---|---|---|
| Extension | `edge/` | Manifest V3 extension. Intercepts the modern app's `window.open()` signal URLs and routes each one (folderFrame script via the BHO, a new tab, or a native app launch). Also hosts Gecko in a side panel. |
| Native messaging host | `native-host/` | `com.jumper.native_host` — a stdio↔named-pipe relay the extension launches via `chrome.runtime.connectNative`. |
| BHO | `bho-poc/` | `JumperBho.dll`, a Browser Helper Object loaded by Trident into `iexplore.exe`. Drives Chameleon's `folderFrame` JS directly — the only way to reach IE-mode content, since `chrome.scripting`/`chrome.debugger` cannot. |
| Shared | `shared/` | `BridgeProtocol.cs` — the wire protocol linked (not project-referenced) into both C# projects. **Changing it means rebuilding both.** |

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/handoff.md`](docs/handoff.md) | Full architecture, how each link type is routed, known limitations. **Start here.** |
| [`docs/decisions.md`](docs/decisions.md) | Chronological engineering log — root-cause analyses, design decisions, and dead ends. Read before re-attempting anything. |

Two conclusions worth knowing up front, both proven the hard way (see
`docs/decisions.md`):

- **The BHO is not optional.** Edge IE mode exposes no scriptable document to any
  other process — `ShellWindows`/ROT, `WM_HTML_GET_OBJECT` and UI Automation were
  all tested and all fail. An in-process BHO is the only foothold available.
- **A URL-only patient open almost works.** `login.asp?quickOpen=1&Id=<nationalID>`
  opens the right patient, record and unit, but always raises a spurious
  "patient not found" alert because Chameleon's `quickOpen` handler puts the
  national ID into the `PatientNum` slot. If the vendor fixes that one mapping,
  both the BHO *and* the native host become unnecessary.

## Why two binaries, one repo

The BHO and native host are **architecturally required to stay separate
binaries** — Trident instantiates the BHO via
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
`native-host` in Release, then registers both:
- BHO: `regasm /codebase` (both 32/64-bit .NET) + the `Browser Helper Objects`
  activation key under HKLM (+ Wow6432Node) — the only step that needs admin.
- Native host: one HKCU key pointing Edge at `native-host/com.jumper.native_host.json`.

Safe to re-run any time (rebuild, or after the extension ID changes).

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
   startup).
2. Open a Chameleon IE-mode tab; confirm `C:\Temp\jumper-bho.log` is growing.
3. Confirm `C:\Temp\jumper-native-host.log` is growing (the extension polls
   it every ~1.5s).
4. Open the extension popup; confirm Settings loads (proves the native host +
   named-pipe round-trip end to end).

## Dev loop

- `JumperBho.dll` is locked by `iexplore.exe` **and** `explorer.exe` while
  loaded — close Edge (ends `iexplore.exe`) and, if still locked, restart
  Explorer before rebuilding. No re-registration needed after a rebuild
  (`/codebase` points straight at the build output).
- `JumperNativeHost.exe` is respawned every ~1.5s by the extension's poll.
- Bump `manifest.json`'s version on every extension change, to confirm a
  reload actually took effect.

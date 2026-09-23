# Jumper Bridge handoff

## Architecture

```text
Gecko
  -> document-start extension interception
  -> extension service worker
       -> shared-session HTTP/navigation for patient and Med Orders
       -> browser navigation for other Chameleon pages
       -> one-shot native host launch for Namer
```

| Component | Responsibility |
|---|---|
| `edge/` | Signal interception, Chameleon routing, shared-session requests, popup, and side panel |
| `native-host/` | Validate a patient number and launch Namer |
| `install-jumper-bridge.ps1` | Register the native host and install shared-cookie policy |

There is no BHO, COM browser component, named pipe, department-state detector,
or automatic Chameleon **מחלקות → Gecko** switching.

## Signal interception

`page-window-open-bridge.js` wraps recognized `window.open()` calls in Gecko's
main world. `content-bridge.js` captures recognized anchor clicks. Both run at
`document_start`, preventing temporary tabs and IE-mode signal requests.

The service worker validates sender origins and known URL patterns. Popup and
tab listeners remain defensive fallbacks.

## Routes

| Link | Route |
|---|---|
| Patient | QuickOpen prime, then corrected `Home/Main` navigation |
| Med Orders | `GetUserDetails`, then `MedOrdersFrm.aspx` with `Sector` |
| Orders for approval, Fluid balance, Lab, infectious disease, Cardio/Hobar | New tab |
| New record | Existing Chameleon tab |
| Namer | Native host launches `NamerButton.exe` |

Patient opening and sector lookup use `credentials: "include"` with the shared
Chameleon session. Neither has a native fallback.

## Shared cookies

The Enterprise Mode list needs:

```xml
<shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="_cu"
               source-engine="Both" />
```

The installer preserves the configured corporate list, adds these rules, writes
`%LOCALAPPDATA%\JumperBridge\sites-with-shared-cookies.xml`, and updates the
current-user Edge policy. Existing authenticated sessions are not copied
retroactively: restart Edge, log out of Chameleon, and log back in.

## Namer

Namer is not a web page. The extension sends a digits-only patient number to
`com.jumper.native_host`; the host ensures SAP Logon is running and starts:

```text
\\focus-fs\sap$\NamerButton.exe
```

The host is launched on demand for this action and exits when Edge closes the
native-messaging connection.

## Installation

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Dev\jumper-bridge\install-jumper-bridge.ps1
```

The installer also removes the retired Jumper BHO registry entries if found.
That upgrade cleanup requires one elevation prompt; normal installs and reruns
do not.

Load or reload `C:\Dev\jumper-bridge\edge` in `edge://extensions`.

## Troubleshooting

**Patient or Med Orders authentication fails:** run **Probe sector** in the
popup. Restart Edge and perform a full Chameleon logout/login if no valid sector
is returned.

**Signals are not intercepted:** reload the Gecko page after reloading the
extension, because interception scripts are installed at document start.

**Namer cannot connect:** verify the extension ID matches `allowed_origins` in
`native-host/com.jumper.native_host.json`, rerun the installer, and inspect
`C:\Temp\jumper-native-host.log`.

## Key files

- `edge/background.js`
- `edge/content-bridge.js`
- `edge/page-window-open-bridge.js`
- `edge/manifest.json`
- `native-host/Program.cs`
- `install-jumper-bridge.ps1`

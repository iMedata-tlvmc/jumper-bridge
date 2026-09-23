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
| `edge/` | Signal interception, Chameleon routing, shared-session requests, toolbar popup, optional side panel, and diagnostics |
| `native-host/` | Validate a patient number and launch Namer |
| `install-jumper-bridge.ps1` | Register the native host and install shared-cookie policy |

There is no BHO, COM browser component, named pipe, department-state detector,
or automatic Chameleon **מחלקות → Gecko** switching.

## Conditional BHO boundary

The retired BHO would be needed only to restore the previous automatic
Chameleon-to-Gecko transition based on Chameleon's page state. IE-mode content
is rendered by Trident in a separate process, and Edge extension APIs cannot
inspect its DOM. A BHO loaded by Trident can observe the active **מחלקות** view;
that state would then need to be relayed to the extension so it could focus or
open Gecko.

This does not apply to the current manual popup/side-panel buttons, Gecko-originated
signals, or a hypothetical direct Gecko link implemented inside Chameleon.

## Signal interception

`page-window-open-bridge.js` wraps recognized `window.open()` calls in Gecko's
main world. `content-bridge.js` captures recognized anchor clicks. Both run at
`document_start`, preventing temporary tabs and IE-mode signal requests.

The service worker validates sender origins and known URL patterns. Popup and
tab listeners remain defensive fallbacks.

## Toolbar popup and side panel

Clicking the extension toolbar icon opens the action popup with manual buttons
for Chameleon, Consultations, Nursing, and ER. The popup sends the existing
`openChameleonTab` and `openGeckoDept` messages; routing remains in the service
worker.

The popup's **Open side panel** button calls `chrome.sidePanel.open()` directly
from the click gesture. The optional side panel provides the same routing buttons
and a framed Gecko preview. It never opens or changes routes automatically from
Chameleon state.

The popup also includes a **Diagnostics** button. The same page is available
through Edge's standard extension Options entry and contains the event log,
Hospital ID setting, sector probe, signal simulator, and output pane.

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

**Patient or Med Orders authentication fails:** open **Diagnostics** from the
popup and run **Probe sector**. Restart Edge and perform a full Chameleon
logout/login if no valid sector is returned.

**Signals are not intercepted:** reload the Gecko page after reloading the
extension, because interception scripts are installed at document start.

**Namer cannot connect:** verify the extension ID matches `allowed_origins` in
`native-host/com.jumper.native_host.json`, rerun the installer, and inspect
`C:\Temp\jumper-native-host.log`.

**Namer integrity warnings in the log:** `LaunchNamer` logs an
`INTEGRITY_CHECK` line (SHA-256 + Authenticode trust) each launch. It is
advisory only and never blocks the launch — see the security review section
in `docs/decisions.md` for why.

## Security

`docs/decisions.md` has a "Security review" section listing what was
hardened here (PHI-redacted logs, Namer executable integrity logging, DNR
rule scope audit) versus what is accepted or out of scope for this repo
(plain-HTTP Chameleon, the cookie-sharing attack surface itself, other
extensions in the same profile, unpacked-extension/site-list tampering by
the same user, and Chameleon's lack of CSRF protection).

## Key files

- `edge/background.js`
- `edge/content-bridge.js`
- `edge/page-window-open-bridge.js`
- `edge/manifest.json`
- `edge/launcher.html`
- `edge/sidepanel.html`
- `edge/diagnostics.html`
- `native-host/Program.cs`
- `install-jumper-bridge.ps1`

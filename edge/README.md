# Jumper Edge Bridge

An unpacked Manifest V3 extension. Patient opening and Med Orders work extension-only when Edge Enterprise Mode
cookie sharing is configured. The BHO/native host remain for department-tab
detection, and the native host also launches Namer:

| Component | Location | Role |
|---|---|---|
| **This extension** | `C:\Dev\jumper-bridge\edge` | Intercepts the modern app's `window.open()` signal URLs and decides how to route each one |
| Native messaging host | `C:\Dev\jumper-bridge\native-host` | `com.jumper.native_host` — department-state bridge and Namer launcher |
| BHO | `C:\Dev\jumper-bridge\bho-poc` | `JumperBho.dll`, loaded by Trident into `iexplore.exe`; reads department-tab state |

Full background, architecture and gotchas:
[`../docs/handoff.md`](../docs/handoff.md).

## Why the BHO still exists

`chrome.scripting.executeScript` and `chrome.debugger` **both fail against IE-mode
content** — it is rendered by Trident in a separate process, not by Chromium. Both were
tried and empirically ruled out. A Browser Helper Object loaded by Trident itself is the
only way to inspect Chameleon's in-page state. Patient opening and all
current browser-page links use extension-only navigation. The BHO remains only
for department-tab detection.

## Prerequisites

- Chameleon (`http://chsw.tasmc.corp`) already opens in Edge IE mode on this machine
  (Enterprise Site List / neutral sites configured).
- The Enterprise Mode Site List shares Chameleon's session cookies both ways.
  `install-jumper-bridge.ps1` adds these to a local merged copy of the currently
  configured corporate list:
  ```xml
  <shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
                 path="/" source-engine="Both" />
  <shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
                 path="/" source-engine="Both" />
  <shared-cookie host="chsw.tasmc.corp" name="_cu"
                 source-engine="Both" />
  ```
  Re-run the installer to pull later corporate site-list updates into that
  local copy. After installation, fully restart Edge, then **log out of
  Chameleon and log back in** so the three session cookies are newly issued
  while the sharing rules are active.
- For department-tab detection, the BHO must be built and
  registered as admin (`register-bho.ps1`, or run
  `C:\Dev\jumper-bridge\install-jumper-bridge.ps1` to build+register both the
  BHO and native host in one elevated pass — this is the
  only step in the whole POC that needs elevation; see the handoff doc §8 for
  why).
- For department detection and native app launches, the native host must be built
  and registered (`register-native-host.ps1`, no
  admin needed). Its
  `com.jumper.native_host.json` pins this extension's ID —
  **update `allowed_origins` if the extension is ever repacked.**

## Load / reload

`edge://extensions` → Developer mode → **Load unpacked** → `C:\Dev\jumper-bridge\edge`
(or the **Reload** icon if already loaded). Pin the toolbar icon.

The `manifest.json` version is bumped on every change — check it on the extension card
to confirm a reload actually took effect.

## How routing works

The modern app signals intent with a link or `window.open()` to a URL that is
never meant to load. `page-window-open-bridge.js` and `content-bridge.js` run at
`document_start`, intercept recognized signals before navigation, and send the
URL to `background.js`. The older popup-tab listener and `rules.json` block
remain as defensive fallbacks.

| kind | What it does |
|---|---|
| shared session | background QuickOpen prime + corrected `Home/Main` — patient clicks, extension-only |
| shared session sector | authenticated `GetUserDetails` POST — Med Orders, extension-only |
| `newTab` | plain new Chameleon tab — `OrdersForApprove`, `MedOrder`, `FluidBalance`, `Lab`, `ContagiousDisease`, `Cardio` |
| `namer` | launches a native app |
| `navigate` | navigates the existing Chameleon tab — `NewRecord` |

Patient opening always uses the extension-only shared-session route.
Med Orders always uses the extension-only shared-session sector lookup.

Most links are `newTab` rather than modals on purpose: `showModalDialog` works, but the
dialog is created **inside the Chameleon tab**, which isn't focused when the click came
from the modern app — so the user sees nothing until they switch tabs manually.

Clicking **מחלקות** in Chameleon goes the other way: the BHO detects the department-list
state, the extension polls it every 1.5 s, and focuses the Gecko tab (or the side panel).

## Popup

1. **Bridge event log** — `bridge.*`, `deptTab.*`, `sidePanel.*` events. First place to look.
2. **Settings** — Hospital ID (needed by the corrected patient `Home/Main`
   navigation; it is not carried in the signal URL) and the Gecko display mode.
3. **Simulate window.open()** — fires a signal URL by hand through the popup
   fallback path, so routing can be tested without the modern app. Edit the placeholder
   `PatientNum` / `Unit` / `MedicalRecord` / `AdmissionDate` values to match a **test**
   patient before using.

## Side panel

`chrome.sidePanel` renders Gecko beside the IE-mode Chameleon tab. It works where an
in-page overlay iframe did not, because the panel is *browser UI* — an iframe inside an
IE-mode page is rendered by Trident and comes up blank.

`chrome.sidePanel.open()` **requires a user gesture, and the gesture does not survive a
`chrome.runtime.sendMessage` hop into the service worker.** So `popup.js` calls it
directly, and the poll-driven מחלקות path falls back to focusing the Gecko tab if the
panel isn't already open. Do not "simplify" this by routing the popup click through
`background.js` — it will silently stop working.

Because the panel can only point at an extension-relative path, the modern app is
iframed, which is what `rules.json` rule 2 (stripping `X-Frame-Options` / CSP for
inextdata sub-frames only) is for.

## Not done

- `NewRecord` does a plain navigation; real Jumper also switches the unit in the
  `Heading` frame and waits 500 ms.
- No packaging/deployment story for shipping three artefacts to clinician machines.

## Safety

Use non-production / test patient records. Do not put PHI in test navigations or paste
log output containing it into shared documents.

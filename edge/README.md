# Jumper Edge Bridge

An unpacked Manifest V3 extension. It is **one of three components** — on its own it
can do nothing to the legacy app:

| Component | Location | Role |
|---|---|---|
| **This extension** | `C:\Dev\jumper-bridge\edge` | Intercepts the modern app's `window.open()` signal URLs and decides how to route each one |
| Native messaging host | `C:\Dev\jumper-bridge\native-host` | `com.jumper.native_host` — stdio↔named-pipe relay |
| BHO | `C:\Dev\jumper-bridge\bho-poc` | `JumperBho.dll`, loaded by Trident into `iexplore.exe`; drives Chameleon's `folderFrame` JS |

Full background, architecture and gotchas:
`~\.copilot\session-state\9de0e8ef-142d-4cdc-991f-63d3ad6a52cc\files\jumper-edge-poc-handoff.md`

## Why the BHO exists

`chrome.scripting.executeScript` and `chrome.debugger` **both fail against IE-mode
content** — it is rendered by Trident in a separate process, not by Chromium. Both were
tried and empirically ruled out. A Browser Helper Object loaded by Trident itself is the
only way in. (The probe UI that established this has been removed; the result is
recorded in the handoff doc.)

## Prerequisites

- Chameleon (`http://chsw.tasmc.corp`) already opens in Edge IE mode on this machine
  (Enterprise Site List / neutral sites configured).
- The BHO is built and registered as admin (`register-bho.ps1`, or run
  `C:\Dev\jumper-bridge\install-jumper-bridge.ps1` to build+register both the
  BHO and native host in one elevated pass — this is the
  only step in the whole POC that needs elevation; see the handoff doc §8 for
  why).
- The native host is built and registered (`register-native-host.ps1`, no
  admin needed). Its
  `com.jumper.native_host.json` pins this extension's ID —
  **update `allowed_origins` if the extension is ever repacked.**

## Load / reload

`edge://extensions` → Developer mode → **Load unpacked** → `C:\Dev\jumper-bridge\edge`
(or the **Reload** icon if already loaded). Pin the toolbar icon.

The `manifest.json` version is bumped on every change — check it on the extension card
to confirm a reload actually took effect.

## How routing works

The modern app signals intent with a `window.open()` to a URL that is never meant to
load. `rules.json` rule 1 blocks it (matching the *dotless* host `chsw`, so it cannot
collide with the real `chsw.tasmc.corp`), and `background.js` intercepts the tab, closes
it, and routes:

| kind | What it does |
|---|---|
| BHO pipe | `OpenPatientRecord(...)` inside `folderFrame` — used for patient clicks |
| `script` | `showModalDialog` in `folderFrame` via the BHO — `Lab`, `OrdersForApprove` |
| `newTab` | plain new Chameleon tab — `MedOrder`, `FluidBalance`, `ContagiousDisease`, `Cardio` |
| `namer` | launches a native app |
| `navigate` | navigates the existing Chameleon tab — `NewRecord` |

Most links are `newTab` rather than modals on purpose: `showModalDialog` works, but the
dialog is created **inside the Chameleon tab**, which isn't focused when the click came
from the modern app — so the user sees nothing until they switch tabs manually.

Clicking **מחלקות** in Chameleon goes the other way: the BHO detects the department-list
state, the extension polls it every 1.5 s, and focuses the Gecko tab (or the side panel).

## Popup

1. **Bridge event log** — `bridge.*`, `deptTab.*`, `sidePanel.*` events. First place to look.
2. **Settings** — Hospital ID (needed to build the `OpenPatientRecord` deep link; it's a
   page-level JS global in Chameleon, not carried in the signal URL, so it can't be read
   automatically) and the Gecko display mode.
3. **Simulate window.open()** — fires a signal URL by hand through the real interception
   path, so routing can be tested without the modern app. Edit the placeholder
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

- No content script / `postMessage` handshake with the modern app — interception happens
  at the tab level, which needed no changes to the modern app.
- `NewRecord` does a plain navigation; real Jumper also switches the unit in the
  `Heading` frame and waits 500 ms.
- No packaging/deployment story for shipping three artefacts to clinician machines.

## Safety

Use non-production / test patient records. Do not put PHI in test navigations or paste
log output containing it into shared documents.

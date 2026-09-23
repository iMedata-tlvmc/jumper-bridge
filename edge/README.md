# Jumper Edge Bridge

An unpacked Manifest V3 extension that connects Gecko to Chameleon in Edge IE
mode. Patient opening and Med Orders use the shared authenticated Chameleon
session. The only native dependency is the Namer launcher.

Automatic Chameleon **מחלקות → Gecko** switching has been removed. The side
panel has also been removed; manual navigation is available from the standalone
launcher window.

To restore the previous automatic behavior, something must detect the active
**מחלקות** state inside Chameleon's Trident DOM. Extensions cannot access an
IE-mode document, so that specific trigger requires a BHO in the IE-mode process
and a bridge back to the extension. The BHO is not needed for the current manual
buttons or Gecko-to-Chameleon routes.

## Prerequisites

- Chameleon already opens in Edge IE mode.
- Run `C:\Dev\jumper-bridge\install-jumper-bridge.ps1` to install the shared
  cookies and register the Namer native host.
- After changing the cookie policy, fully restart Edge, log out of Chameleon,
  and log back in.

## Load or reload

Open `edge://extensions`, enable Developer mode, and load
`C:\Dev\jumper-bridge\edge` unpacked. Reload it after source changes.

## Routing

`page-window-open-bridge.js` and `content-bridge.js` run at `document_start`
and intercept recognized Gecko signals before browser navigation. The service
worker routes them as follows:

| Kind | Route |
|---|---|
| Patient | Shared-session QuickOpen prime and corrected `Home/Main` navigation |
| Med Orders | Shared-session `GetUserDetails` sector lookup and new tab |
| Other supported Chameleon pages | New tab or existing Chameleon tab |
| Namer | One-shot native message to launch `NamerButton.exe` |

## Launcher

Click the extension toolbar icon to open a compact standalone launcher with
buttons for Chameleon, Consultations, Nursing, and ER. Clicking the icon again
focuses the existing launcher instead of creating another window. Closing the
launcher is safe; the next click discards any stale saved window ID and creates a
new instance.

The buttons reuse the service worker's existing `openChameleonTab` and
`openGeckoDept` message routes, so patient, Med Orders, Namer, and all other
Gecko-to-Chameleon behavior is unchanged.

## Diagnostics and settings

Use **Diagnostics and settings** in the launcher or open the extension's standard
Options page. This page contains the event log, Hospital ID setting, authenticated
sector probe, signal simulator, and output pane.

## Safety

Use test patient records. Do not put PHI in test URLs or shared logs.

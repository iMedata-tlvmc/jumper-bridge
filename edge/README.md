# Jumper Edge Bridge

An unpacked Manifest V3 extension that connects Gecko to Chameleon in Edge IE
mode. Patient opening and Med Orders use the shared authenticated Chameleon
session. The only native dependency is the Namer launcher.

Automatic Chameleon **מחלקות → Gecko** switching has been removed. The side
panel's buttons remain available for manual navigation.

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

The popup provides the event log, Hospital ID setting, sector probe, simulation
tools, and a user-gesture button for opening the side panel.

## Side panel

The panel is browser UI rendered by Chromium beside the IE-mode tab. It can show
Gecko and provides manual buttons for Chameleon, consultations, nursing, and ER.
It does not react automatically to Chameleon page state.

Because a side panel can only use an extension-relative page, Gecko is framed.
`rules.json` strips framing restrictions only for approved inextdata subframes.

## Safety

Use test patient records. Do not put PHI in test URLs or shared logs.

# Jumper Bridge decisions

This file records decisions that constrain the current implementation.

## Intercept signals at document start

Main-world `window.open()` wrapping and capture-phase anchor handling stop
recognized Gecko signals before navigation. Sender-origin validation remains in
the service worker. Tab-level interception and DNR are defensive fallbacks.

## Use Enterprise Mode shared cookies

Patient opening and Med Orders use Chameleon's authenticated session from
Chromium. The installer merges the required bidirectional shared-cookie rules
into the configured site list.

Cookie sharing is not retroactive. After policy installation, restart Edge and
perform a complete Chameleon logout/login.

## Keep patient and Med Orders extension-only

Patient opening primes QuickOpen and navigates to corrected `Home/Main`
parameters. Med Orders reproduces `GetUserSector()` with an authenticated
`GetUserDetails` request.

There is no native fallback for either route.

## Remove the BHO and automatic department switching

Automatic Chameleon **מחלקות → Gecko** switching is no longer required.
Therefore the BHO, COM registration, named pipe, shared protocol, department
polling, and related display-mode setting were removed.

Manual standalone-launcher buttons still navigate to Gecko sections.

If automatic switching based on Chameleon's active **מחלקות** view is requested
again, a BHO or equivalent code running inside Trident is required because Edge
extensions cannot inspect IE-mode DOM state. The BHO would detect the state and
relay it to the extension; it would not be needed for manual navigation or
Gecko-to-Chameleon routing.

## Keep the native host only for Namer

Namer is a hospital native application rather than a web route. A small native
messaging host validates the patient number, ensures SAP Logon is running, and
launches the fixed `NamerButton.exe` path.

The host is started on demand and performs no polling.

## Prefer tabs over hidden IE-mode dialogs

Chameleon modal dialogs created inside an unfocused IE-mode tab are not visible
until the user switches tabs. Supported browser-page routes therefore use
normal tabs, accepting the Fluid Balance close-tab prompt.

## Use a compact single-instance launcher window

The wide side panel and its framed Gecko preview were replaced by a narrow
standalone extension window created with `chrome.windows.create({ type:
"popup" })`. The toolbar action opens this window or focuses the existing
instance.

The service worker stores the window ID but verifies the window and launcher URL
before focusing it. Missing, stale, or reused IDs are cleared, and existing
launcher popup windows are discovered before a new one is created.

The launcher remains extension-only and sends the existing manual routing
messages. Diagnostics and Hospital ID configuration live on the standard
extension Options page rather than in the normal toolbar action.

## Use a local merged site list for the POC

The installer preserves the centrally configured list, adds the shared-cookie
entries, assigns a monotonic version, and writes a current-user local copy.
Production should add the entries to the centrally hosted list.

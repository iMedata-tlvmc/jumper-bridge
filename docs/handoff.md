# Jumper Bridge handoff

## Current architecture

Jumper Bridge connects Gecko to Chameleon in Edge IE mode without the Jumper
desktop application's browser integration.

```text
Gecko page
  -> document-start extension scripts
  -> extension service worker
       -> shared-session HTTP/navigation for patient and Med Orders
       -> normal browser tabs for Chameleon pages
       -> native host for Namer
       -> native host -> named pipe -> BHO for department-state detection
```

| Component | Current responsibility |
|---|---|
| `edge/` | Intercept Gecko signals, route browser links, open patients, query Med Orders sector, show Gecko in a tab or side panel |
| `native-host/` | Query department state through the BHO and launch Namer |
| `bho-poc/` | Read Chameleon's IE-mode DOM to detect the active department tab |
| `shared/` | Constants for the department-state named-pipe protocol |

The BHO and native host do not open patients, query sectors, execute arbitrary
scripts, or suppress downloads.

## Signal interception

`page-window-open-bridge.js` wraps recognized `window.open()` calls in Gecko's
main world. `content-bridge.js` captures recognized anchor clicks. Both run at
`document_start`, preventing a temporary tab or IE-mode request from being
created.

The service worker accepts messages only from approved Gecko/dev origins and
routes only known signal URL patterns. Popup listeners and the DNR signal rule
remain defensive fallbacks for stale pages or an unknown future invocation
mechanism.

## Link routing

| Link | Route |
|---|---|
| Patient click | Shared-session QuickOpen prime, then corrected `Home/Main` navigation |
| Med Orders | Authenticated `GetUserDetails` request, then `MedOrdersFrm.aspx` with `Sector` |
| Orders for approval | New tab |
| Fluid balance | New tab |
| Lab | New tab with `Switch=1` |
| Contagious disease | New tab |
| Cardio/Hobar | New tab |
| New record | Existing Chameleon tab navigation |
| Namer | Native host launches `NamerButton.exe` |

## Patient opening

Patient opening is extension-only:

1. Confirm the shared Chameleon session with `GET /Chameleon/Home/Main`.
2. Fetch the original QuickOpen signal URL in the background to prime the
   server session.
3. Navigate the existing IE-mode Chameleon tab to corrected `Home/Main`
   parameters using the patient number for both `Patient` and `PatientID`.

No native-host or BHO patient route exists.

## Med Orders sector

The extension reproduces Chameleon's `GetUserSector()` data source:

```text
POST /Chameleon/Include/DataReaderXML.asp
SP=GetUserDetails
```

It reads `User_Details/@Sector`, validates it, and appends it to the Med Orders
URL. No native-host or BHO sector route exists.

## Enterprise Mode shared cookies

The site list must contain:

```xml
<shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="_cu"
               source-engine="Both" />
```

`install-jumper-bridge.ps1` downloads the currently configured corporate site
list, preserves its entries, adds these rules, writes
`%ProgramData%\JumperBridge\sites-with-shared-cookies.xml`, and points the
current user's Edge policy to the local copy. Re-running refreshes the copy from
the saved corporate source.

After installing or changing these rules:

1. Fully restart Edge.
2. Log out of Chameleon completely.
3. Log back in so fresh session cookies are issued under the active rules.

Restoring an existing authenticated tab is insufficient.

## Department detection

The BHO reads:

- `folderFrame` for `divHospPatientList`;
- `Heading` for `tdHospDoctor` or `tdHospSister` with class `tab_On`.

It exposes only a Boolean state over `QUERY_DEPT_TAB`. The extension polls the
native host every 1.5 seconds and focuses Gecko or its side panel when the state
changes to active.

The named-pipe server starts only in the IE-mode process whose top document has
`folderFrame`. This prevents popup processes from taking ownership of the pipe.

## Namer

Namer is not a web page. The extension sends a digits-only patient number to
the native host. The host ensures SAP Logon is running and launches:

```text
\\focus-fs\sap$\NamerButton.exe
```

The BHO is not involved.

## Installation

Run from an administrator PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Dev\jumper-bridge\install-jumper-bridge.ps1
```

The installer:

1. Builds and registers the BHO.
2. Builds and registers the native host.
3. Creates the merged Enterprise Mode site list.
4. Updates the current-user Edge policy.

Then load or reload `C:\Dev\jumper-bridge\edge` in `edge://extensions`, fully
restart Edge, and perform the Chameleon logout/login sequence above.

## Verification

1. Open Chameleon and confirm `C:\Temp\jumper-bho.log` grows.
2. Confirm `C:\Temp\jumper-native-host.log` receives `queryDeptTab`.
3. Open the extension popup and run **Probe sector**.
4. Click a Gecko patient and confirm the correct Chameleon record opens.
5. Click Med Orders and confirm the URL contains a valid sector.

## Troubleshooting

### Patient click does nothing

Run **Probe sector** in the extension popup.

- A valid sector means shared cookies are working; inspect the extension event
  log for patient routing errors.
- `GetUserDetails returned no valid User_Details/@Sector` usually means
  Chromium lacks the Chameleon session. Fully restart Edge, then log out of
  Chameleon and log back in.
- No interception event means reload the Gecko page after reloading the
  extension; content scripts are installed at document start.

### Department switching does not focus Gecko

Check:

- the BHO log for `[dept-tab] state changed`;
- the native-host log for `QUERY_DEPT_TAB`;
- that the BHO is registered in both 32-bit and 64-bit registry views.

### Extension cannot connect to the native host

The unpacked extension ID depends on its absolute directory. If the repository
moves, update `allowed_origins` in
`native-host/com.jumper.native_host.json` and rerun the native-host registration.

## Key files

- `edge/background.js`
- `edge/content-bridge.js`
- `edge/page-window-open-bridge.js`
- `edge/manifest.json`
- `native-host/Program.cs`
- `bho-poc/BhoObject.cs`
- `shared/BridgeProtocol.cs`
- `install-jumper-bridge.ps1`

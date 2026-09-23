# Jumper Bridge

Bridges the Gecko web app to the legacy Chameleon EHR in Edge IE mode.

| Component | Path | Role |
|---|---|---|
| Edge extension | `edge/` | Intercepts Gecko signals, opens patients and Chameleon pages, resolves Med Orders sectors, and optionally hosts Gecko in a side panel |
| Native messaging host | `native-host/` | Launches the hospital Namer application |

Automatic Chameleon **מחלקות → Gecko** switching has been removed. There is no
BHO, COM component, named pipe, or continuous native-host polling.

### If Chameleon-to-Gecko switching returns

The previous automatic switch depended on reading Chameleon's IE-mode DOM when
the **מחלקות** view became active. Edge extensions cannot inspect that
Trident-rendered DOM, so this trigger would require a BHO loaded inside the
IE-mode process and a relay back to the extension. A direct link added to
Chameleon itself would not require DOM detection, but that is a different
implementation.

## Requirements

- Chameleon already opens in Edge IE mode.
- A .NET SDK with the .NET Framework 4.7.2 targeting pack.
- Enterprise Mode shared-cookie rules for:

```xml
<shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="_cu"
               source-engine="Both" />
```

## Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Dev\jumper-bridge\install-jumper-bridge.ps1
```

The installer builds and registers the Namer host, merges the shared-cookie
rules into the configured corporate Enterprise Mode list, and points the
current-user Edge policy to `%LOCALAPPDATA%\JumperBridge\sites-with-shared-cookies.xml`.
If it finds the retired Jumper BHO registration, it requests elevation once to
remove that legacy registration.

Then load `C:\Dev\jumper-bridge\edge` from `edge://extensions`. Fully restart
Edge, log out of Chameleon, and log back in so fresh session cookies are shared.

The unpacked extension ID depends on its absolute folder path. If the repository
moves, update `allowed_origins` in
`native-host/com.jumper.native_host.json` and rerun the installer.

## Current routing

- Patient: authenticated QuickOpen prime, then corrected `Home/Main` navigation.
- Med Orders: authenticated `GetUserDetails` request, then
  `MedOrdersFrm.aspx` with the returned sector.
- Other supported Chameleon links: normal tab or existing-tab navigation.
- Namer: one-shot native message launches `\\focus-fs\sap$\NamerButton.exe`.
- Side-panel buttons: manual navigation between Chameleon and Gecko sections.

See [`docs/handoff.md`](docs/handoff.md) for operations and
[`docs/decisions.md`](docs/decisions.md) for current design constraints.

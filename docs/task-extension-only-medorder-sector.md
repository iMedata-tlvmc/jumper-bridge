# Task: remove the Med Orders sector lookup BHO dependency

> Paste-ready brief for a fresh Copilot session started in this repo.
> Start with: *"Read `docs/task-extension-only-medorder-sector.md` and work
> through it."*

## Goal

Make the Gecko **Med Orders / הוראות לתרופות** button open its Chameleon page
using only the Edge extension. The route must not use the BHO, native messaging
host, COM, or any installed desktop component to obtain `Sector`.

This is narrower than removing the BHO completely. Department-page detection
and Namer are out of scope. Patient opening is already extension-only.

## Current state

Extension **0.8.1** intercepts this signal URL pattern in
`edge/background.js`:

```text
.../MedOrdersFrm.aspx?FileFoldersRowId=...&Patient=...&Medical_Record=...
&Hospital=...&Unit=...&Order_ID=...&User=&Login_Name=...&Category=...&Sector=
```

The signal deliberately ends with an empty `Sector=`. The current route has
`needsSector: true`; `routeViaNewTab()` sends native message `querySector`, the
native host relays `QUERY_SECTOR` over the named pipe, and the BHO invokes
Chameleon's live `GetUserSector()` JavaScript function. It then appends the
returned value and opens a normal tab.

Current chain:

```text
Gecko click
  -> extension
  -> native host
  -> BHO
  -> GetUserSector()
  -> extension opens MedOrdersFrm.aspx?...&Sector=<value>
```

An empty sector has previously reached `PermissionDenied.aspx`. A healthy BHO
log example is:

```text
[sector] GetUserSector() returned '8'
```

Do not assume `8` is universal or stable.

## Important recent result to reuse

Patient opening was made extension-only in 0.8.0 by adding Enterprise Mode
bidirectional cookie sharing:

```xml
<shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="_cu"
               source-engine="Both" />
```

Authenticated `fetch(..., { credentials: "include" })` from the extension
service worker can therefore access Chameleon responses. The extension does
not read or persist cookie values.

This shared HTTP session is the most promising route for obtaining `Sector`
without touching the IE-mode DOM.

## Read first

1. `docs/handoff.md`, especially §4 and §9.
2. The final entries in `docs/decisions.md`.
3. `edge/background.js`:
   - `PATTERNS.medOrder`
   - the `needsSector` branch in `routeViaNewTab()`
   - the shared-session patient route as prior art
4. `bho-poc/BhoObject.cs`:
   - `QuerySectorOnUiThread()`
   - where it searches for and invokes `GetUserSector`
5. `native-host/Program.cs` and `shared/BridgeProtocol.cs` for the current
   `QUERY_SECTOR` bridge.
6. If available, the reference Jumper source:
   `C:\Dev\jumper\Chameleon.cs`, especially `OpenMedOrdersFromUrl`.

## Investigation strategy

Work from evidence, not guesses. The key question is:

> Where does Chameleon's `GetUserSector()` get its value, and can the extension
> obtain that same value through the shared authenticated HTTP session?

Recommended order:

1. **Capture a baseline.**
   Trigger Med Orders through the current BHO route and record:
   - the sector returned by `QUERY_SECTOR`;
   - the final URL opened;
   - whether the page succeeds.

2. **Find the function definition and data source.**
   Search Chameleon's already-referenced static JavaScript and HTML responses
   for `GetUserSector`, `Sector`, and the returned baseline value. Determine
   whether the function reads:
   - a server-rendered hidden field or JavaScript variable;
   - a cookie;
   - ASP.NET/ASP session state exposed by a page;
   - a response from an existing application endpoint;
   - a value derivable from Hospital, Unit, user, or another signal parameter.

3. **Use authenticated extension fetches.**
   Reuse the shared-session pattern from patient opening. Fetch only pages or
   assets the application itself normally requests. Inspect status,
   redirects, and response bodies for a trustworthy sector source.

4. **Run controlled URL tests.**
   Establish the known-good BHO-generated URL first. Then test one variable at
   a time: omitted `Sector`, empty `Sector`, values exposed by authenticated
   responses, and any application-produced equivalent URL. Do not invent or
   brute-force sectors.

5. **Prefer a deterministic runtime source.**
   In priority order:
   - derive the sector from an authenticated Chameleon response;
   - reuse an application endpoint that returns it;
   - derive it from existing signal/session fields only if proven across more
     than one context;
   - expose a user-configured sector only as an explicit fallback, never as a
     silent hardcoded default.

## Constraints

- The successful Med Orders route must work with the BHO and native host
  absent.
- Do not add broad host permissions or a `cookies` permission unless evidence
  proves they are necessary. Normal credentialed fetches already use the
  shared session.
- Do not store credentials or cookie values.
- Do not scrape or probe unrelated patient data.
- This is a live hospital system. Use application-generated URLs and existing
  responses; do not brute-force undocumented endpoints or identifiers.
- Keep the existing BHO route available as a temporary selectable fallback
  while developing, unless the extension-only route is fully verified.
- Bump `edge/manifest.json` for implementation changes.
- Preserve the existing patient shared-session route and all other link
  routing.
- The user must perform browser interactions. Give exact test steps, then
  verify with:
  - extension popup event log;
  - `C:\Temp\jumper-bho.log`;
  - `C:\Temp\jumper-native-host.log`.

## Avoid repeating settled work

- Extensions cannot script or debug IE-mode documents.
- `declarativeNetRequest` and `webRequest` cannot observe IE-mode traffic.
- External COM/ROT/UIA access to the IE-mode document failed.
- Opening Med Orders with an empty sector is not an acceptable solution.
- Hardcoding the observed sector value is not proof of a generic solution.

## Deliverable

Either:

1. Implement and verify a generic extension-only sector lookup and Med Orders
   route, remove its `querySector` dependency, bump the extension version, and
   update `README.md`, `edge/README.md`, `docs/handoff.md`, and
   `docs/decisions.md`; or
2. Record an evidence-backed blocker that identifies exactly where the sector
   exists and why the extension cannot obtain it, while preserving the current
   BHO route.

Do not claim success until the user confirms the correct Med Orders page opens
and the logs prove no `querySector` native/BHO call occurred. Do not commit
unless the user explicitly asks.

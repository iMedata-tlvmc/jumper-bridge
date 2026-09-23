# Handoff: Jumper → Edge-extension POC

**Last updated: 2026-09-22 15:02 — extension-only shared-session patient and
Med Orders opening verified; all other routes and the side panel remain operational.**

Supersedes `44db5c78-.../files/save-prompt-issue-handoff.md` (stale, covered only
the download-prompt bug, which is fixed).

---

## 1. What this is and why

`C:\Dev\jumper` is the **Jumper** desktop app (.NET Framework 4.7.2 WinForms,
`gecko.exe`). It glues two things together for clinicians:

- **Chameleon** (`http://chsw.tasmc.corp`) — legacy frameset EHR, only runs in
  **IE mode**. Real clinical actions live in JS functions inside its `folderFrame`.
- **Gecko / inextdata** (`https://inextdata.tasmc.corp`, repo
  `C:\Dev\platform-webapp`) — the modern web app. Jumper hosts it in a native
  WebView2 control composited on top of the Chameleon window.

When the user clicks something in the modern app, Jumper reaches into the
legacy app and drives it (open a patient, open a med-orders modal, etc.).

**Question this POC answers:** can a Microsoft Edge extension replace the
Jumper desktop app entirely?

**Answer:** yes for control, partially for presentation. Every link type routes
correctly and patient-open works. The one thing an extension cannot reproduce
is Jumper's *composited overlay* — see §7.

---

## 2. Architecture — three components

All four now live together in this repo (`jumper-bridge`), under `bho-poc/`,
`native-host/`, `shared/` and `edge/`. See the root `README.md` for install steps.

```
  Modern app (Chromium tab)
        │  link / window.open("<signal URL>")
        ▼
  document-start content bridge (prevents navigation)
        ▼
  Extension            C:\Dev\jumper-bridge\edge (unpacked)      ext id foogenbdjbghhmodemgdemkepedolald
        ├── shared cookies + HTTP/navigation ──► Chameleon patient open
        │
        └── chrome.runtime.connectNative
                    ▼
            Native messaging host C:\Dev\jumper-bridge\native-host
                    │  named pipe  \\.\pipe\JumperBhoBridge
                    ▼
            BHO (in-proc COM) C:\Dev\jumper-bridge\bho-poc
                    │  late-bound COM / IDispatch
                    ▼
            Chameleon's folderFrame DOM (department-state detection)
```

**What the native host does:** `JumperNativeHost.exe` implements Edge native
messaging. It queries `QUERY_DEPT_TAB` through `\\.\pipe\JumperBhoBridge` and
owns `LaunchNamer()`, which starts the separate Namer desktop app. It has no
patient-opening route and no direct DOM/COM access.

**Why the BHO exists:** `chrome.scripting.executeScript` and `chrome.debugger`
both fail against IE-mode content (rendered by Trident in a separate process,
not Chromium — proven, don't re-test). A Browser Helper Object loaded by
Trident itself is the only way in.

**Why two separate C# programs, not one:** forced by the environment, not a
choice. The BHO is a DLL Trident loads into `iexplore.exe`; the native host is
an EXE Edge launches on `connectNative` and kills when the port closes.
Different parents, different lifetimes, neither ours — they can't be merged
into one running process. (They *could* in principle be one COM-registered
`.exe` via `regasm /codebase` to cut deployment from three artefacts to two —
considered and deliberately deferred as an unusual path not worth the risk
alongside IE-mode debugging. Spike it standalone first if ever attempted.)
The extension can't reach the BHO directly either — native messaging is the
only IPC extensions have, and `allowed_origins` doubles as an auth boundary a
raw localhost socket wouldn't get for free.

**Duplication between them was factored out** into
`C:\Dev\jumper-bridge\shared\BridgeProtocol.cs`, linked (`<Compile Include=... Link=...>`)
into both `.csproj`s. It owns the pipe name, `QUERY_DEPT_TAB` command, and the
`1` / `0` reply vocabulary. Previously these were bare string literals
duplicated on both sides, and drift would have been **silent** (a hang or a
misrouted command, no compile error, no log line). **Changing this file means
rebuilding both projects.**

---

## 3. Current status — everything works

| Component | State |
|---|---|
| Extension `C:\Dev\jumper-bridge\edge` | manifest **0.9.1**. Pre-navigation Gecko interception plus extension-only patient and Med Orders routes verified. |
| Native host `C:\Dev\jumper-bridge\native-host` | Handles department polling and Namer launch. |
| BHO `C:\Dev\jumper-bridge\bho-poc` | Handles department-state detection only. |
| Shared `C:\Dev\jumper-bridge\shared` | `BridgeProtocol.cs`, linked into both C# projects. |

**Verified working (latest patient test 2026-09-22):** patient clicks open the
correct record through the extension-only shared-session route with no false
alert or additional login; מחלקות repeatably switches to Gecko; the spurious IE-mode download
prompt does not occur; all link types route correctly (§4); the side panel
opens from the popup and shows Gecko beside the Chameleon tab, framing
succeeds with no fallback needed. No known-broken paths.

---

## 4. Link routing — the table to trust

The modern app signals intent through links or `window.open()` URLs that are
never meant to load. Two document-start scripts now intercept recognized
`chsw` / `chsw.tasmc.corp` signals inside Gecko before browser navigation:

- `page-window-open-bridge.js` wraps `window.open()` in the page's main world.
- `content-bridge.js` captures anchor clicks and relays page messages to the
  service worker.

`background.js` validates the sender origin and routes the URL directly. The
older tab-level interception and `rules.json` block remain only as defensive
fallbacks.

Generated by `ExternalLinks.service.ts` in `platform-webapp`. Authoritative
legacy behaviour: `jumper\Chameleon.cs` / `Gecko.cs`; patterns in `Common.cs` 36–46.

| Hebrew / name | Pattern | Chameleon page | Route `kind` |
|---|---|---|---|
| (patient row click) | `patient` | corrected `Home/Main` after background QuickOpen prime | shared session (default; §4.1) |
| הוראות לתרופות | `medOrder` | `MedOrdersFrm.aspx` with sector from authenticated `GetUserDetails` | shared session + `newTab` |
| OrdersForApprove | `ordersForApprove` | `MedOrders4Approve.aspx?...&Stam=stam` | `newTab` |
| מאזן נוזלים | `fluidBalance` | `FluidBalanceFrm.aspx` | `newTab` |
| Lab | `lab` | `LabResultsModal?...&Switch=1` | `newTab` |
| ContagiousDisease | `contagiousDisease` | — | `newTab` |
| Cardio / Hobar | `cardio` | — | `newTab` |
| Namer | `namer` | — | `namer` (native app launch) |
| NewRecord | `newRecord` | — | `navigate` |

> **Identity gotcha:** הוראות לתרופות is `medOrder`, **not** `ordersForApprove`
> (that's the "unconfirmed instructions" book icon on a patient row). Confirm
> from the native-host log payload, not the Hebrew label.

### 4.1 Patient open is extension-only via Enterprise Mode cookie sharing

Patient opening always uses Microsoft's supported bidirectional cookie sharing to
make Chameleon's authenticated session available to the extension:

```xml
<shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
               path="/" source-engine="Both" />
<shared-cookie host="chsw.tasmc.corp" name="_cu"
               source-engine="Both" />
```

For each patient click the extension:

1. Auth-checks `/Chameleon/Home/Main` from its background service worker.
2. Fetches the original FQDN `login.asp?quickOpen=1...` signal URL to prime
   Chameleon's record/unit/admission state in the shared server session.
3. Navigates the IE-mode tab to `Home/Main` with corrected fields:
   `Patient=<PatientNum>`, `PatientID=<PatientNum>`, `idnum=<national ID>`.

Verified 2026-09-22 with two real Gecko clicks, both with no false alert and no
additional login. Passive BHO evidence showed:

- Patient A: PatientNum `9003397574`, record `16371953`, unit `831000`,
  admission date `26/08/2026`.
- Patient B: PatientNum `9001674042`, record `11152014`, unit `831000`,
  admission date `25/07/2023`.

The previous selectable BHO and degraded direct-URL patient modes were removed
in extension 0.9.1. Patient clicks no longer have a native-host or BHO route.

### 4.2 Med Orders sector lookup is extension-only

Chameleon's `/Chameleon/Content/Legacy/Include/Record.js` defines
`GetUserSector()` by calling:

```text
xmlHTTP_Send("GetUserDetails", ["User", "{user}"], "")
```

`xmlHTTP_Send` posts the parameter XML to
`/Chameleon/Include/DataReaderXML.asp`. Extension 0.8.2+ makes the equivalent
credentialed POST through the shared Chameleon session, reads only
`User_Details/@Sector`, validates the value, and appends it to the
`MedOrdersFrm.aspx` URL. It does not read or persist cookie values.

Verified 2026-09-22: the extension returned sector `8`, opened the correct Med
Orders page, and the popup logged `mode: "extension"` plus the final
`&Sector=8` URL. Native-host and BHO logs contained no `querySector`,
`QUERY_SECTOR`, or `[sector]` entry for the test. Extension 0.8.3 removes the
old native/BHO sector command entirely.

**Do not try to fix the alert by rewriting the request.** Proven 2026-09-17:
`declarativeNetRequest` cannot see IE-mode traffic at all — a `block` rule on a
`chsw.tasmc.corp` URL did not stop an IE-mode navigation (the server's 404 body
came back), while the identical rule shape redirected correctly in a Chromium
tab. IE mode fetches through WinINET, outside Chromium's network stack. This
also means `webRequest` is equally useless there. Full evidence in
`docs/decisions.md` (2026-09-17).

**Why links are `newTab`, not modals:** `showModalDialog` works in IE
mode, but renders inside the (unfocused) Chameleon tab, so a click from the
modern app shows nothing until the user switches tabs. Focusing the tab first
was offered and declined in favour of new tabs. `OrdersForApprove` moved to
`newTab` in 0.8.1; the accepted tradeoff is losing the
`RefreshXMLObject("HospNursingOrdersForm")` call that previously ran when its
modal closed. `Lab` moved to `newTab` earlier (2026-09-10) after the same
invisible-modal symptom showed up on manual tab switch. `FluidBalance` has a known, accepted
cosmetic quirk instead: its in-page close control calls `window.close()`,
and IE only allows that to close silently if the tab has a script-opener
relationship — a `chrome.tabs.create()` tab doesn't have one, so IE prompts
"trying to close the tab" (sometimes after the tab's already gone, where
it's inert — just dismiss it). A `window.open()`-from-folderFrame variant
was tried (2026-09-10) to give it that opener relationship and suppress the
prompt — it worked, but Trident then refocused that opener (Chameleon) on
close instead of Gecko, and 3 attempts at overriding that from the extension
all failed (§7). Reverted; **do not retry without being able to test
IE-mode directly** — the refocus appears to happen at the Win32 level inside
`iexplore.exe`, invisible to `chrome.tabs`/`chrome.windows`.

---

## 5. Root causes fixed — read before touching the BHO

### 5.1 Wrong COM receiver for `frames`
`InvokeGet(doc, "frames")` throws bare `E_FAIL` on Chameleon's frameset;
`InvokeGet(win, "frames")` works. **Use `FindFrameWindowByName()`** (Jumper's
`top.<frameName>` idiom, with `window.frames` enumeration only as fallback) —
don't hand-roll frame lookup.

### 5.2 Static site clobbering — the "worked, then stopped" bug
Trident creates one BHO instance **per browser object** (tabs, popups, some
frames). A `static _topWebBrowserSite` was overwritten/nulled by every other
instance's `SetSite`. Fixed with `_liveSites` (list) + `_mySite` (per-instance);
`GetTopWindow()` picks whichever live site still exposes `folderFrame`. **Never
cache the chosen site.**

### 5.3 Named-pipe ownership race
Any process seeing a `chsw.tasmc.corp` URL started a pipe server; popup
processes (no frameset) often won and answered commands they couldn't execute.
Fixed by gating `EnsurePipeServerStarted()` on `TopDocumentHasFolderFrame()` at
`DocumentComplete`.

### 5.4 Removed script bridge
The former `EXEC_SCRIPT` / `routeViaScript` path was removed in extension 0.8.3.
All browser-page routes now use extension navigation or authenticated HTTP, so
there is no generic arbitrary-script command in the native/BHO protocol.

### Symptom → cause map

| Symptom | Cause |
|---|---|
| `Frame 'folderFrame' not found among 0 frame(s)` | wrong process owns the pipe (§5.3) |
| `TargetInvocationException` from `[pipe-owner]`/`[dept-tab]` | wrong COM receiver (§5.1) or dead site (§5.2) |
| `GetUserSector` returns `''` → `&Sector=` empty | lands on `PermissionDenied.aspx` |

---

## 6. The side panel — verified working

Adopted from a colleague's extension. `chrome.sidePanel` is **browser UI**, so
Chromium renders it beside an IE-mode tab — unlike an iframe injected into
Chameleon's own DOM, which Trident renders (came up blank; that experiment is
deleted). Since `sidePanel` can only point at an extension-relative path,
`sidepanel.html` iframes the modern app, which needs `rules.json` rule 2
(strips `X-Frame-Options`/CSP for inextdata sub-frames only).

**⚠ Gesture rule — don't "simplify" this:** `chrome.sidePanel.open()` needs a
user gesture, and the gesture doesn't survive a `sendMessage` hop into the
service worker. `popup.js` calls it **directly**; the poll-driven מחלקות path
falls back to `bringGeckoTabToFront()` since it can't open the panel itself.

Settings: `chrome.storage.local` key `geckoDisplayMode` (`"tab"` default |
`"sidePanel"`), toggle in popup section 2.

Framing succeeded with just the header strip — no `<meta>`-delivered
`frame-ancestors` or off-origin login redirect got in the way in practice.

---

## 7. Proven limitations — do not re-investigate

- **Nothing outside an IE-mode tab can observe, modify or script what happens
  inside it.** Three independent mechanisms were tested and all fail:
  - `chrome.scripting.executeScript` and `chrome.debugger`/CDP cannot touch
    IE-mode content.
  - `declarativeNetRequest` (and therefore `webRequest`) cannot see IE-mode
    requests **at all** — proven 2026-09-17: a `block` rule did not stop an
    IE-mode navigation (the server's own 404 body came back), while the
    identical rule shape redirected correctly in a Chromium tab. IE mode
    fetches through WinINET, outside Chromium's network stack.
  - External COM/ROT/oleacc/UIA automation of the IE-mode tab returns nothing
    (proven 2026-09-16, with UAC disabled so they are real failures).

  The in-process BHO is the only foothold. A cross-document **POST** can be
  delivered into the live Chameleon process (proven 2026-09-17, correcting an
  earlier claim), but it cannot carry that process's session, so it is not a
  way in either.

- An iframe inside an IE-mode page is rendered by **Trident**, not Chromium —
  there is no way to get Chromium rendering inside an IE-mode tab's DOM. This
  is why real Jumper uses a native WebView2 control, not an HTML overlay.
- Consequence: an extension **cannot** reproduce Jumper's true side-by-side
  overlay. The side panel is the closest approximation (browser chrome, not
  page content).
- When a popup is opened via `window.open()` from inside an IE-mode frame
  (real script-opener relationship, e.g. the FluidBalance experiment above),
  Trident refocuses that opener on close — and this cannot be overridden
  from the extension. Tried opener-based detection, URL-based detection, and
  retry timing (all 2026-09-10); none worked. The refocus appears to happen
  at the Win32 level inside `iexplore.exe`, invisible to
  `chrome.tabs`/`chrome.windows`. **Don't route anything through
  folderFrame's `window.open()` if the user needs to land back on Gecko
  afterwards** — use `chrome.tabs.create()` instead and accept its one
  cosmetic downside (§4, FluidBalance).

---

## 8. Deployment

Three artefacts. **Admin is required for exactly one step** — the BHO
activation key. Verified empirically (see checkpoint
`001-fixing-ie-mode-download-prompt.md`): the BHO's COM class registers fine
per-user in `HKCU`, but Trident only ever honors the `Browser Helper Objects`
activation key from **HKLM**.

Build command for all `.csproj`s:
```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" `
    <path>.csproj /p:Configuration=Release /v:minimal /nologo
```

**8.1 Prerequisite** (assumed done): Chameleon configured to open in Edge IE mode.

**8.2 Quick path — unified installer (recommended, one prompt for both)**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Dev\install-jumper-bridge.ps1
```
Self-elevates once (relaunches itself via `Start-Process -Verb RunAs` if not
already admin), builds both projects (`dotnet build -c Release`), then runs
§8.3's `register-bho.ps1` and §8.4's `register-native-host.ps1` back-to-back.
**Does NOT merge the two binaries** — the BHO must stay an in-proc COM DLL
(Trident calls `CoCreateInstance(..., CLSCTX_INPROC_SERVER)`, which requires
`InprocServer32`) and the native host must stay a standalone EXE (Edge
launches it as a separate process via `connectNative`) — two different OS
activation models that can't be satisfied by one binary the normal way. This
script only removes the "two manual scripts, one needs admin" friction; it's
safe to re-run any time (e.g. after a rebuild, or after the extension ID
changes). Verified working end-to-end 2026-09-16.

**8.3 BHO — needs admin, once per machine or DLL move (what §8.2 wraps)**
```powershell
cd C:\Dev\jumper-bridge\bho-poc; <build>; .\register-bho.ps1     # elevated
```
`register-bho.ps1` runs `regasm /codebase` for both 32/64-bit .NET (assembly is
AnyCPU; bitness of IE mode's host isn't assumed) and creates the
`Browser Helper Objects\{6B1D4E2A-7F3C-4A9B-9E5D-2C8F1A3B6D71}` key under HKLM +
Wow6432Node — the actual admin-gated step. `/codebase` points COM straight at
the build output; **no copy/install step, no re-register after a rebuild**
(confirmed live: `CodeBase = file:///C:/Dev/jumper-bridge/bho-poc/bin/Release/...`).
`unregister-bho.ps1` reverses it. **`register-bho-peruser.ps1` is a dead-end
experiment** (it's what proved HKLM is required) — never use it as the real path.

**8.4 Native messaging host — no admin, per user (what §8.2 wraps)**
```powershell
cd C:\Dev\jumper-bridge\native-host; <build>; .\register-native-host.ps1
```
Writes one `HKCU` key pointing at `com.jumper.native_host.json`, which
hardcodes the exe path and `allowed_origins` (currently
`chrome-extension://foogenbdjbghhmodemgdemkepedolald/`). **Re-run whenever the
extension ID changes** (repacking, or unpacked from a different folder).

**8.5 Extension — no admin, per user, unpacked only**
`edge://extensions` → Developer mode → Load unpacked → `C:\Dev\jumper-bridge\edge`.
Bump `manifest.json` version on every change to confirm reload took effect.

**Not yet solved: production packaging.** Developer mode isn't realistic for
clinician machines. Needs an internal Edge Add-ons deployment or an
`ExtensionInstallForcelist` policy + internally-hosted `.crx`. Repacking
changes the extension ID → cascades into §8.4. (A real WiX/Inno-packaged
installer was considered for §8.2 but postponed in favor of the lightweight
script — revisit if/when this moves past POC.)

**8.6 Clean-machine order:** §8.1 → §8.2 (elevated, does both registrations) →
§8.5 → fully restart Edge (BHO activation keys are read once, at IE-mode host
startup, and the Enterprise Mode list must load) → **log out of Chameleon and
log back in** (restored/pre-existing sessions do not reissue the cookies) →
confirm `C:\Temp\jumper-bho.log` grows → open the popup, confirm Settings loads
(native host + pipe), then run **Probe sector** (shared session).

**8.7 Local dev loop:**
- `JumperBho.dll` is locked by `iexplore.exe` **and** `explorer.exe` — kill both
  by PID (`-Name` is rejected), build, `Start-Process explorer.exe` if it
  doesn't self-restart. No re-registration needed.
- `JumperNativeHost.exe` is respawned every 1.5 s by the extension's poll —
  run a background loop that kills it every ~150 ms for the build's duration.
- **JS can be validated locally** (this corrects an earlier note that it
  couldn't): headless **Chrome** works even though headless Edge `--dump-dom`
  came back empty —
  `& 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' --headless --dump-dom file:///…`
  will run a script and let you read the result out of `document.title`. For a
  pure syntax check, `pip install esprima` then parse each file, normalising
  `catch {` → `catch (e) {` first (esprima predates optional catch binding).
  Still no Node.js on this machine.

---

## 9. Debugging recipes

Logs: `C:\Temp\jumper-bho.log`, `C:\Temp\jumper-native-host.log`. The BHO log
is dominated by poll noise — always filter:

```powershell
Get-Content C:\Temp\jumper-bho.log |
  Where-Object { $_ -notmatch "QUERY_DEPT_TAB" -and
                 $_ -match "\[sites\]|\[dept-tab\] state|\[pipe|failed" } |
  Select-Object -Last 60
```

Healthy signatures: `[sites] Registered site; N live site(s)` and
`[dept-tab] state changed: ... -> ...`. Normal Gecko clicks should produce no
bare-host `http://chsw/...` BHO navigation or patient command.

If patient clicks are intercepted but nothing opens, run **Probe sector** in
the extension popup. `GetUserDetails returned no valid User_Details/@Sector`
after installing the site list means Chromium still lacks the Chameleon
session cookies. Confirm Edge cached the `<shared-cookie>` entries, then log out
of Chameleon completely and log back in; merely reopening a restored,
already-authenticated tab is not enough.

**Watch the `pid=` prefix** — multiple `iexplore.exe` processes log to the same
file; a command answered by the wrong pid is §5.3.

---

## 10. Key files

- `C:\Dev\jumper-bridge\bho-poc\BhoObject.cs` — the BHO.
- `C:\Dev\jumper-bridge\shared\BridgeProtocol.cs` — the wire protocol (§2). Change → rebuild both.
- `C:\Dev\jumper-bridge\native-host\Program.cs` — department query + `LaunchNamer`.
- `C:\Dev\jumper-bridge\native-host\com.jumper.native_host.json` — pins the extension ID.
- `C:\Dev\jumper-bridge\edge\` — `manifest.json` (0.9.1), `background.js` (routing +
  dept-tab poll + side panel), `page-window-open-bridge.js` /
  `content-bridge.js` (pre-navigation interception), `rules.json` (fallback
  signal-URL block + header strip),
  `popup.html`/`popup.js` (log / settings / simulate), `sidepanel.html`/`.js`,
  `README.md`.
- Reference only: `C:\Dev\jumper\Chameleon.cs` / `Gecko.cs` / `Common.cs`;
  `C:\Dev\platform-webapp\...\ExternalLinks.service.ts`.

---

## 11. Next steps

1. Decide the default `geckoDisplayMode` for real users (currently `"tab"`;
   side panel is opt-in via the popup).
2. **Production packaging** — the main open problem (§8.5). Note the machine
   already has a populated `HKCU\Software\Policies\Microsoft\Edge`, so
   `ExtensionInstallForcelist` is a realistic zero-touch channel for the
   extension. The BHO's **HKLM** activation key has no equivalent, so features
   that still require IE-mode scripting have a heavier deployment footprint;
   patient opening itself no longer has that dependency.
3. Roll the three proven `<shared-cookie>` entries into the centrally hosted
   `https://iemode/sites.xml`. Until then, `install-jumper-bridge.ps1` downloads
   the configured corporate list, merges the entries into
   `%ProgramData%\JumperBridge\sites-with-shared-cookies.xml`, and points the
   current user's policy to that local copy. Re-run it to import central list
   updates.
4. `NewRecord` still does a plain navigation; real Jumper also switches the
   unit in the `Heading` frame and waits 500 ms — not replicated.
5. If ever needed, revisit merging the BHO and native host into one
   COM-registered `.exe` (§2) — spike standalone first.

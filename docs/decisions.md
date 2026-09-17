# Engineering decision log

Chronological log of design decisions, root-cause analyses and dead ends from the
Jumper -> Edge-extension POC. Imported from the working notes so the reasoning lives
with the code.

Read `handoff.md` first for the architecture; read this when you want to know **why**
something is the way it is, or before re-attempting something that was already tried.

Most important entries:

- `2026-09-14` — why the BHO and the native host cannot be merged into one binary.
- `2026-09-16 18:05 / 18:10` — `login.asp?quickOpen=1` deep link: what works, and the
  server-side bug that makes it unusable.
- `2026-09-16 21:35` — proof that the BHO **cannot** be replaced by external automation.

---
# Fix: Gecko→Chameleon link routing (infinite loop + wrong mechanisms)

## Problem

Clicking Chameleon links from the modern app (מאזן נוזלים / הוראות לתרופות /
Cardio / Namer) hangs Edge.

Two independent bugs:

### 1. Infinite tab-churn loop (FIXED)
`maybeInterceptModernPopup` was wired to `webNavigation.onBeforeNavigate` and
`tabs.onUpdated`, which fire for EVERY navigation in EVERY tab.
`routeToChameleon` navigates the Chameleon tab to a URL that still contains the
matching pattern → re-intercepted → `tabs.remove` the tab it just routed into →
no Chameleon tab → `tabs.create` → matches again → unbounded churn.

Fix: `popupCandidateTabIds` — only genuine `window.open`/`target=_blank` tabs
(`onCreatedNavigationTarget`, or `tabs.onCreated` with an `openerTabId`) may be
intercepted. Mirrors Jumper, where `Gecko.cs` matches these patterns ONLY in
`WebView_NewWindowRequested` and never re-inspects Chameleon's own navigations.

### 2. Wrong routing mechanism for every non-patient link
`routeToChameleon` = `tabs.update(chameleonTab, {url})` for all of them, which
destroys the patient context. Jumper actually uses 3 distinct mechanisms:

| Link | Jumper (`Chameleon.cs`) | Correct extension action |
|---|---|---|
| Patient | `OpenPatientRecord` in folderFrame | BHO invoke (already OK) |
| Cardio/Hobar (`RedirectToApplication`) | `window.open(url,'_blank')` | plain new tab, URL as-is |
| Namer | `Process.Start(NamerButton.exe)` + SAP | native host `launchNamer` |
| FluidBalance (מאזן נוזלים) | `showModalDialog` in folderFrame | BHO `EXEC_SCRIPT` |
| OrdersForApprove (הוראות לתרופות) | `showModalDialog` + `RefreshXMLObject` | BHO `EXEC_SCRIPT` |
| Lab | `showModalDialog(url+"&Switch=1")` | BHO `EXEC_SCRIPT` |
| ContagiousDisease | `showModalDialog` | BHO `EXEC_SCRIPT` |
| MedOrder | `GetUserSector()` + `showModalDialog(url+sector)` | `QUERY_SECTOR` then `EXEC_SCRIPT` |
| NewRecord | Heading unit change, delay, navigate | left as-is for now (out of scope) |

`showModalDialog` is removed from Chromium but still works in Trident — which is
exactly why Jumper execs it inside folderFrame. The BHO can do the same.

## Design

New pipe commands (BHO, `\\.\pipe\JumperBhoBridge`), prefix-dispatched so the
existing bare 9-field patient line stays backward compatible:

- `EXEC_SCRIPT|<frameName>|<base64-utf8 script>` — base64 avoids delimiter and
  newline collisions with the script body.
- `QUERY_SECTOR` — duplex, replies with `GetUserSector()` (like QUERY_DEPT_TAB).

Native host message types: `execScript`, `querySector`, `launchNamer`.

SECURITY: `launchNamer` takes only a patient number (validated `^\d+$`) — never
a path or command line from the extension. The exe path stays hardcoded in the
host, matching `Constants.NAMER_PATH`.

## Steps

1. [done] Extension: `popupCandidateTabIds` loop fix
2. [done] BHO: `ExecScriptInFrame` + `EXEC_SCRIPT` / `QUERY_SECTOR` commands
3. [done] Native host: `execScript` / `querySector` / `launchNamer` (allowlisted)
4. [done] Extension: mechanism-based dispatch replacing blanket `routeToChameleon`
5. [done] Build all three components (BHO 11:04, native host 11:06, extension edited)
6. [ ] User test in Edge

## Verification notes

- No JS runtime on this machine and nodejs.org is blocked by the network, so
  `background.js` could not be syntax-checked offline. Headless Edge
  (`--dump-dom`) returns empty output in both headless modes, likely policy-
  restricted. The service worker console in `edge://extensions` is the
  authoritative check and is required for functional testing anyway.

## Confirmed requirements (from user, 2026-09-09)

- Cardio is an EXTERNAL app - must open as-is in its own tab, never routed into
  the Chameleon tab. Implemented as `kind: "newTab"`.
- הוראות לתרופות and מאזן נוזלים must be true modals (must be dismissed before
  Edge is usable again). `window.showModalDialog` in Trident gives exactly this;
  implemented as `kind: "script"` executed in folderFrame via BHO EXEC_SCRIPT.

## Test checklist

| Link | Expected |
|---|---|
| מאזן נוזלים | modal dialog over Chameleon, 70%x60%, blocks until closed |
| הוראות לתרופות | modal dialog 1020x800, blocks until closed |
| Cardio / Hobar | opens in its OWN new tab, URL unchanged, Chameleon tab untouched |
| Namer | NamerButton.exe launches (SAP), nothing opens in browser |
| Patient open | unchanged - full record in place |
| any of the above | no tab churn, Edge stays responsive |

Logs: `C:\Temp\jumper-bho.log` (look for `[exec-script]`, `[sector]`),
`C:\Temp\jumper-native-host.log` (`EXEC_SCRIPT`, `QUERY_SECTOR`, `LAUNCH_NAMER`),
and the extension's own `bridge.routed` entries (now include `mechanism`).

## 2026-09-09 11:41 - Modal links regression: ROOT CAUSE FOUND

Symptom: מאזן נוזלים / הוראות לתרופות did nothing after the modal rework.

Root cause (NOT showModalDialog): the BHO started its named-pipe server in ANY
process that saw a chsw.tasmc.corp URL. Every Chameleon popup page runs in its
own iexplore.exe, so they all raced for \\.\pipe\JumperBhoBridge. Commands
frequently landed in a single-page popup process with zero frames:
  [exec-script] Frame 'folderFrame' not found among 0 frame(s).
  [sector] GetUserSector() failed -> QUERY_SECTOR '' -> PermissionDenied.aspx
The bridge was a race between processes.

Fixes shipped:
- BHO: pipe server now starts only in the process whose top document contains
  'folderFrame' (TopDocumentHasFolderFrame), checked at DocumentComplete.
- BHO: EXEC_SCRIPT is duplex, replies OK / FAIL:<reason>; ExecScriptInFrame
  probes showModalDialog, distinguishes failure modes, falls back from
  execScript to <script>-element injection.
- Native host: SendToBhoPipeDuplex; execScript returns ok + status.
- Extension 0.5.1: routeViaScript falls back to routeViaNewTab on failure
  (every script target now carries fallbackUrl / buildFallbackUrl).

NEXT: retest. Log line that now decides the modal question:
  [exec-script] Frame 'folderFrame' found (index N); showModalDialog available = ?

## 2026-09-09 14:16 - Step 1 of 3 DONE: BHO cleanup

Order agreed with user: cleanup -> BHO fix verification -> side panel.

Removed from BhoObject.cs (1997 -> 1730 lines, -267):
- GECKO_OVERLAY_URL, SetGeckoOverlayVisible, BuildShowOverlayScript,
  BuildHideOverlayScript  (overlay-iframe experiment, only call site was
  already commented out)
- LogAllFrameNames        (only caller was the dead TryDirectFrameNavigate)
- TrySetNamedFrameLocation(call sites already commented out)
- TryDirectFrameNavigate  (never called)
- collapsed the long commented-out overlay rationale in
  TryUpdateDepartmentTabState into a 5-line note

KEPT deliberately:
- DismissSpuriousDownloadPrompt + Win32 helpers: live backstop for the IE-mode
  spurious download prompt (checkpoint 001), gated on the arm-window. Removing
  it risks regressing a fixed bug.
- TryInvokeIfTriggered / TriggerPath: 25 lines, lets the BHO be driven from
  C:\Temp\jumper-bho-invoke.txt without the extension. Useful for testing.

Backup of the pre-cleanup file: BhoObject.cs.bak (no git repo here).
Rebuilt clean: bin\Release\net472\JumperBho.dll 14:16:33. Same path as the
existing registration, so no re-register needed.

## NEXT (step 2): user must verify the 14:04 site-resolution fix
Test: click a patient in Gecko -> opens the patient FIRST click (not one click
late); click מחלקות repeatedly -> switches to Gecko every time.
Log lines to look for in C:\Temp\jumper-bho.log:
  [sites] Registered site; N live site(s)
  [dept-tab] state changed:
  [sector] GetUserSector() returned '8'

## THEN (step 3): finish side panel
manifest 0.6.0 + sidepanel.html/js + rules.json rule 2 are DONE.
Still missing: geckoDisplayMode in background.js (branch in handleDeptTabState,
line ~505) + toggle UI in popup.html/popup.js.

## 2026-09-09 14:24 - Step 2 VERIFIED, Step 3 side panel IMPLEMENTED

### Step 2: site-resolution fix confirmed working
Log evidence after the 14:18 restart (pid 21428 owns the pipe):
  14:18:52 [pipe] Received command -> [invoke:pipe-immediate] -> returned OK
  14:19:22 same, immediate again
  14:19:08/12/13/18/19 [dept-tab] state changed toggling repeatedly
No more '[pipe-owner] folderFrame check failed' spam (last one 14:02, i.e.
before the fixed build). 14:19:28 took the queue-and-navigate-back path and
still auto-fired 0.4s later - that is the intended graceful fallback for when
the user is already inside a patient record, not a bug.

### Step 3: side panel wired up (manifest 0.6.1)
background.js:
- getDisplayMode() / setDisplayMode() over chrome.storage.local key
  'geckoDisplayMode' ('tab' | 'sidePanel', default 'tab')
- handleDeptTabState branches on the mode; sidePanel path calls
  openGeckoSidePanel() and FALLS BACK to bringGeckoTabToFront() if it fails
- openGeckoSidePanel(windowId) - never throws, returns bool
- message cases 'setDisplayMode' and 'openSidePanel'
- getSettings() now also returns geckoDisplayMode
popup.html/popup.js: mode <select> + 'Open side panel now' button in section 5.

IMPORTANT GESTURE RULE: chrome.sidePanel.open() needs a user gesture and the
gesture does NOT survive a chrome.runtime.sendMessage hop into the service
worker. So popup.js calls chrome.sidePanel.open() DIRECTLY. The background
copy only works when the panel is already open - hence the tab fallback on
the poll path. Do not 'simplify' this by routing the popup click through
background.js; it will silently stop working.

### NEXT: user testing
Reload unpacked at C:\Dev\jumper-edge, open popup -> 'Open side panel now'.
Main open risk: inextdata may still refuse framing despite rules.json rule 2
(frame-ancestors delivered via <meta>, or a login redirect to another origin).
sidepanel.html shows an explicit error box + 'Open in a tab instead' if so.

## 2026-09-09 14:30 - Handoff doc rewritten
The old handoff (44db5c78/files/save-prompt-issue-handoff.md) was stale at 10:11
and scoped only to the download-prompt bug. Wrote a fresh whole-POC handoff at
  9de0e8ef-.../files/jumper-edge-poc-handoff.md
covering all 3 components, the routing table, the 4 hard-won root causes, the
proven limitations, build/deploy gotchas, log-filtering recipes and a file map.
Added a SUPERSEDED banner to the old one (kept for its download-prompt history).

## 2026-09-09 16:10 - Extension cleanup + shared protocol file

### Extension cleaned (manifest 0.7.0)
Removed Phase-1 probe scaffolding: findTabs/getAllTabs/navigateTab/focusTab/
createTab/tryExecuteScript/getCookiesForDomain/testDebuggerOnChameleon/safeTab
+ 8 message cases + popup sections 1,2,3,7, and 4 log-only event listeners
(onCommitted, onCompleted, tabs.onUpdated, tabs.onCreated) which were flooding
the 200-entry navLog and evicting the useful bridge.*/deptTab.* entries.
KEPT (load-bearing): onCreatedNavigationTarget, onBeforeNavigate, tabs.onRemoved.
Popup is now 3 sections: bridge log / settings / simulate.
  background.js 42413 -> 36542, popup.js 6853 -> 4564, popup.html 4785 -> 3079
MAIN WIN: dropped 'scripting', 'debugger', 'cookies' from manifest permissions.
Also rewrote README.md, which was badly stale (still claimed 'no native
messaging host - not yet built' and described routing as working WITHOUT
touching the IE-mode page, the opposite of reality).
Backups: background.js.bak, popup.js.bak, popup.html.bak in jumper-edge.

### 'Why 2 C# apps?' - answered, and duplication removed
Two PROCESSES is forced: the BHO is a DLL that Trident loads into iexplore.exe
(must be in-proc to reach the DOM via COM); the native host is an EXE that Edge
spawns and kills on stdio. Different parents, different lifetimes, neither ours.
The extension cannot reach the BHO directly - native messaging is the only IPC
available, and it doubles as authentication via allowed_origins (a localhost
socket inside the browser process would need us to build our own auth).
Two PROJECTS is NOT forced - one assembly could be both (regasm /codebase works
on an .exe) - considered, DEFERRED as an unusual path not worth debugging
alongside IE mode. Spike it standalone if ever attempted.
DONE INSTEAD: C:\Dev\jumper-shared\BridgeProtocol.cs, <Compile Include Link>'d
into BOTH csproj. Holds pipe name, connect timeout, command verbs, reply
vocabulary (OK/FAIL:/1/0), field separator, default frame, and the 9-field
OpenPatientRecord arg order + defaults. Previously "JumperBhoBridge" was a bare
literal 4x in the host alone; drift would have been SILENT (host times out on
Connect, or BHO treats the line as patient args).
*** CHANGING BridgeProtocol.cs MEANS REBUILDING BOTH PROJECTS. ***
Both rebuilt clean: JumperBho.dll 16:08:59, JumperNativeHost.exe 16:09:00.

### NEXT: user testing (nothing since 14:19 has been exercised)
1. Reload unpacked C:\Dev\jumper-edge, confirm card shows 0.7.0.
2. Re-test patient click + מחלקות (regression check on the C# refactor - the
   pipe protocol was touched on both sides).
3. Popup -> 'Open side panel now' (still never tested; framing may be refused).

## 2026-09-09 16:20 - USER CONFIRMED: everything works end to end

Patient click, מחלקות repeatable switch, and the side panel (framing succeeds,
no fallback needed) all verified working by the user after the BridgeProtocol
refactor. No known-broken paths remain. Removed all .bak files from
jumper-bho-poc, jumper-native-host, jumper-edge (BhoObject.cs.bak,
Program.cs.bak, background.js.bak, popup.js.bak, popup.html.bak).

### Handoff doc updated (jumper-edge-poc-handoff.md)
- Status/side-panel sections marked verified instead of untested.
- Section 8 rewritten from a 2-paragraph "build gotchas" note into a full
  deployment guide: per-artifact admin requirement (ONLY the BHO activation
  key needs HKLM/elevation - confirmed via checkpoint 001's HKCU experiment
  and by reading the live registry), what register-bho.ps1/register-native-
  host.ps1 actually do, what triggers a re-register (moving the DLL; the
  extension ID changing), the full clean-machine install order, and the
  local dev rebuild loop (moved here, unchanged).
- Flagged register-bho-peruser.ps1 as a dead-end experiment - do NOT use it as
  the real registration path, it's kept only because it proved (by failing)
  that the BHO activation key requires HKLM.
- Fixed jumper-edge/README.md, which still pointed at register-bho-peruser.ps1
  as the prerequisite.
- Next steps trimmed to what's actually left: default display mode decision,
  production packaging (the real open problem - Developer-mode unpacked load
  isn't viable for clinician machines), NewRecord's missing unit-switch,
  Lab/OrdersForApprove modal-vs-tab tradeoff, and the deferred BHO+host merge.

### This POC's state, in one sentence
All 3 components verified working together, including the side-panel toggle;
the only unsolved problem left is HOW TO SHIP the extension to a real machine
without Developer mode (see handoff doc \u00a78.4/\u00a711).

## 2026-09-10 - Handoff doc downsized (439 -> 251 lines)

User asked to trim the handoff doc. Condensed "why 2 C# apps" essay in section
2 to a short paragraph + pointer, dropped the granular BHO line-number file map
in section 10 (now a flat file list), tightened prose everywhere else. Kept
every table, command, root cause, and gotcha - only cut narrative text.

## 2026-09-10 - Lab link fixed, FluidBalance close-prompt/duplicate saga

### Lab moved script(modal) -> newTab
Same invisible-modal symptom as ContagiousDisease/FluidBalance had before
(modal renders inside the unfocused Chameleon tab). Now kind: "newTab".

### FluidBalance: 3 bugs found and fixed while chasing one user report
User reported the IE "trying to close the tab" dialog after closing
FluidBalance (opened via chrome.tabs.create - no script-opener, so
window.close() from the page's own close button isn't allowed to close
silently). Tried switching it to window.open() executed via the BHO in
folderFrame (gives it a real opener, suppresses the prompt) - this cascaded
into two more bugs, both found and fixed:
1. Opened TWICE - root cause: BhoObject.ExecScriptInFrame retries via a
   <script>-element injection whenever the execScript COM call throws, even
   after the script body already ran. A script with a side effect (window.open)
   then fires twice. FIXED with a one-shot guard flag on the frame's window
   object (kept - also applied to OrdersForApprove pre-emptively, since it has
   the same vulnerability class).
2. Closing it refocused Chameleon instead of Gecko. THREE attempts to fix this
   from the extension all failed (opener-based tab detection, URL-based tab
   detection, retry-timing against the native refocus). Root cause believed to
   be Win32-level focus restoration inside iexplore.exe itself, invisible to
   chrome.tabs/chrome.windows - NOT fixable from the extension.

DECISION (user): revert FluidBalance to chrome.tabs.create. Keep the harmless
"trying to close the tab" prompt (dismissable, sometimes appears after the tab
is already gone) rather than the worse regression (wrong tab focused). All
returnToGecko/opener-detection code removed again - back to the pre-9/10
onCreated/onUpdated listener shape. Manifest ended at 0.7.8.

Documented in handoff doc section 7 (Proven limitations) as a hard stop: don't
route anything through folderFrame's window.open() if the user needs to land
back on Gecko afterwards.

## 2026-09-14 - BHO+native-host merge: analysis done, POSTPONED

User asked to unify the BHO and native host into one project + build an
installer for both.

Analysis (not yet acted on): the native-host side is easy to merge, but the
BHO side has a hard COM constraint - Trident CoCreateInstance's a BHO with
CLSCTX_INPROC_SERVER, which requires an InprocServer32 (DLL-loaded-in-proc)
registration; a plain regasm'd EXE registers as LocalServer32 (out-of-process)
and won't work as a BHO at all. There's a theoretical trick (.NET COM interop
loads managed types via the mscoree.dll shim from an assembly path that could
point at an .exe, since CLR reflection doesn't care about PE subsystem type),
which could let ONE .exe be both the in-proc BHO (via COM activation) and the
native-messaging host (via direct process launch) - but this is UNVERIFIED and
would need a throwaway spike before ever touching the real, working project.
The installer part (WiX/Inno Setup, running register-bho.ps1 elevated +
register-native-host.ps1) is unambiguously doable regardless and carries no
risk to the current architecture.

User chose to POSTPONE this (wants to work on other things). Options left on
the table for whenever this resumes:
  (a) [recommended] Keep 2 binaries, just build the installer for both.
  (b) Spike the single-EXE-as-BHO idea in a disposable throwaway project first.
  (c) Attempt the real merge directly (accepts risk to the verified setup).
No code changes made for this request - analysis only.

### Current POC state (2026-09-14)
All 3 components still verified working (nothing touched since the 0.7.8
FluidBalance revert). Handoff doc is current through section 7's Win32-refocus
limitation. Next open items, in priority order: production packaging/installer
(handoff doc section 8.4/11), the deferred BHO+host merge above, NewRecord's
missing unit-switch, default geckoDisplayMode decision.

## 2026-09-16 — Investigating a BHO-free patient open (URL-only)

Goal: find a URL that opens a Chameleon patient page without the BHO.

**Established:**
- Clicking a patient in Chameleon causes NO top-level navigation. `OpenPatientRecord`
  is a JS orchestrator that independently navigates ~5 sibling frames
  (NameASP, NavigationButtons/Buttons, ietree.asp -> PatientTree,
  RecordsMedicalRecord/MedicalRecord, RecordsPleaseWait/PleaseWait).
  => There is no single "patient page URL" in normal operation. This is exactly
  why Jumper needs the BHO.
- `/Chameleon/Asp/RecordsMedicalRecord/MedicalRecord?...` standalone = record
  content only, no tree/header. Dead end on its own.
- `/Chameleon/Asp/Navigation/SearchPatient?...` standalone = broken single frame.
- `/Chameleon/Home/Main?...&QuickOpen=1` standalone = broken single frame.
  (Both are frame-level / depend on session state set earlier in the chain.)

**KEY FINDING — `login.asp?quickOpen=1` is a REAL, LIVE server-side deep link.**
The modern app's "signal URL" that Jumper always cancels is not a fake signal;
loading it actually works. Full chain observed in the BHO log:

    login.asp?quickOpen=1&Id=..&PatientNum=..&MedicalRecord=..&RecordChar=..&Unit=..&AdmissionDate=<ISO>
      -> /Chameleon/account/logon                 (session already valid -> NO login form)
      -> /Chameleon/Asp/Navigation/SearchPatient?Patient=<Id>&QuickOpen=1&Hospital=101&Unit=&Record=..
      -> full shell reload (Heading, Logo, Definitions, SessionTimer, SyncPatient.aspx)
      -> /Chameleon/Home/Main?Patient=<Id>&QuickOpen=1&...
      -> patient frames (tree, record, orders, ...)

- Works in an ALREADY-LOGGED-IN tab with no re-login. (Earlier re-login prompt
  was only because it was tried in a fresh tab.)
- Real signal URL format (captured from extension navLog):
  `http://chsw/chameleon/login.asp?quickOpen=1&Id=9996620&PatientNum=9001674042&MedicalRecord=11152014&RecordChar=0&Unit=831000&AdmissionDate=2023-07-25T10:52:00`
  Note: host is bare `chsw`, must be rewritten to `chsw.tasmc.corp`.
  `Id` is an internal patient id, NOT the national id. `AdmissionDate` is ISO.

**Remaining problem:** a spurious `מטופל/ת לא נמצא/ה במערכת` ("patient not found")
alert appears first; clicking OK then loads the full patient page correctly.
Hypothesis: login.asp passes `Id` through as the lookup key to SearchPatient;
when `Id` isn't a valid national id the first lookup fails/alerts, then it falls
back to PatientNum/MedicalRecord and succeeds. Currently testing variants that
drop `Id` or set `Id=PatientNum`.

**Tradeoffs if adopted:** full Chameleon shell reload (~2s, loses app state) vs the
BHO's instant in-place frame swap. And the BHO would still be required for the
modal links (OrdersForApprove) and dept-tab detection — this only removes it from
the patient-open flow.

**If it works, the code change is small:** replace `routePatientOpenViaBho()` with
`chrome.tabs.update(chameleonTab.id, { url: <signalUrl with host rewritten> })`,
and narrow the `rules.json` block so the FQDN form isn't blocked.

### 2026-09-16 18:05 — CONCLUSION: URL-only patient open is a FALLBACK, not a replacement

Correction to the notes above:
- `Id` is the **national ID** (== `idNum` in the BHO command), NOT an internal id.
  Confirmed by the captured signal URL `Id=332747500&PatientNum=9003397574`,
  which matches the BHO command `{ idNum: "332747500", patient: "9003397574" }`.
- `login.asp` DOES carry `PatientNum`/`MedicalRecord`/`Unit`/`RecordChar`/`AdmissionDate`
  through to the patient frames — but via **server session state**, not the query
  string. Proof from the BHO log after loading the signal URL verbatim:
      PatientTree?patient=9003397574&record=16371953&unit=831000&recordType=3&recordChar=0
      MedicalRecord?...Patient=9003397574&Record=16371953&Unit=831000
                     &Record_Type=Hospitalization&Start_Date=26/08/2026&End_Date=16/09/2026
  So the correct patient AND the correct record/admission DO open.

**The spurious alert is a server-side bug in login.asp and cannot be fixed client-side.**
`login.asp` maps `Id` (national ID) into `SearchPatient?Patient=<Id>`, but that slot
expects the **PatientNum**. The lookup fails -> `מטופל/ת לא נמצא/ה במערכת` alert.
The real open then proceeds correctly from session state.

Variants tested — ONLY the verbatim signal URL works:
| Variant                                   | Result                          |
|-------------------------------------------|---------------------------------|
| verbatim (`Id`=national ID)               | alert, then correct page  ✅/⚠️  |
| drop `Id`                                 | no alert, no patient      ❌     |
| `Id`=PatientNum                           | alert, no patient         ❌     |
| `Id`=PatientNum + `idnum`=nationalID      | alert, empty frame        ❌     |

Also note `login.asp` is **session-state dependent and stateful** — bad params can
pollute the session and force a re-login on the next attempt.

**DECISION: keep the BHO for patient opens.**

| | BHO (current) | URL-only |
|---|---|---|
| Correct patient + record + unit | yes | yes (via session state) |
| Spurious alert                  | none | every open |
| Speed                           | instant in-place frame swap | ~2s full shell reload |
| App state preserved             | yes | no |
| Modal links (OrdersForApprove)  | yes | not supported |
| Dept-tab detection              | yes | not supported |

Keep the URL path documented as a **degraded fallback** for machines where the BHO
cannot be registered (no admin / IE mode unavailable). If ever adopted, the change is:
replace `routePatientOpenViaBho()` with
`chrome.tabs.update(chameleonTab.id, { url: <signalUrl, host rewritten to chsw.tasmc.corp> })`
and narrow `rules.json` so the FQDN form isn't blocked.

Not worth further client-side iteration. The only real fix is for the Chameleon
vendor to correct `login.asp`'s `quickOpen` lookup to use `PatientNum`.

### 2026-09-16 18:10 — Root cause confirmed from server-delivered source

Fetched `login.asp` output and `Record.js` directly (no browser needed):

    Invoke-WebRequest -Uri '<url>' -UseDefaultCredentials -AllowUnencryptedAuthentication `
                      -UseBasicParsing -MaximumRedirection 0

`login.asp` renders a POST form to `/Chameleon/account/logon` containing ONLY:
    QuickOpen=1, Id=<nationalID>, Patient="", PatientID/User_Code, VisitDate="",
    AdmissionNo="", AuxCode="", Diary=""
-> `PatientNum` / `MedicalRecord` / `Unit` / `RecordChar` / `AdmissionDate` are NOT
   in the form; login.asp stashes them in ASP **Session**. (Explains the statefulness.)
-> The `Patient` hidden field is **hardcoded empty** — adding `&Patient=9003397574`
   to the query string does NOT populate it. So login.asp accepts only QuickOpen+Id.

`Record.js` (331 KB, no OpenPatientRecord, no alert text) confirms the field mapping:

    function OpenPatient(Patient, Id_Num, Id_Status) {
        top.Search.document.SearchPatient.PatientID.value = Patient;  // <- PatientNum
        top.Search.SearchPatient.Id_Num.value            = Id_Num;    // <- national ID
    }

The patient key belongs in **PatientID**, but login.asp always emits `PatientID=0`
and puts the national ID into `Patient`. That is the bug causing the alert, and it is
purely server-side. **Not fixable from the extension.**

=> Investigation CLOSED. Keep the BHO for patient opens. URL path stays documented
   as a degraded fallback only.

### 2026-09-16 21:20 — FINAL: every client-side lever exhausted

Located the alert string via the (session-free) translation endpoint:
    GET /Chameleon/Javascript/Translation?intovar=T&p=Folder<N>&p=...
Sweeping N=1000..2299 found:
    Folder1756_Patient_Not_Exists     => מטופל/ת לא נמצא/ה במערכת
    Folder1762_Patient_Not_In_System  => מטופל/ת לא נמצא/ה במערכת
    Folder1916_PatientNotExists       => מטופל/ת לא נמצא/ה במערכת
Not present in Record.js or Main.js => the alert is raised by the server-rendered
SearchPatient page (session-gated; curl gets 302, source unobtainable).

Levers tried and results:
| Lever                                              | Result                                   |
|----------------------------------------------------|------------------------------------------|
| login.asp param variants (Id / none / PatientNum / idnum) | only verbatim works, always alerts |
| `&Patient=` on login.asp                            | hidden field hardcoded value=""          |
| `&Patient=` on /Chameleon/Account/LogOn (GET)       | IGNORED; still Patient=<nationalID>&PatientID=0 |
| SearchPatient / Home/Main / MedicalRecord direct    | session-gated or broken single frame     |
| Record.js (331KB), Main.js, translation dict        | alert not client-side                    |

`/Chameleon/Account/LogOn` reads `Patient` only from the POST body and always falls
back to `Id`. Honoring it would need a cross-site POST into the IE-mode tab, which the
extension cannot inject — the exact limitation the BHO exists to solve. Circular.

**VENDOR BUG (Chameleon 8.5.13.11426)** — the one-line fix that would make a BHO-free
deep link possible:
  The QuickOpen flow passes the **national ID** into `SearchPatient?Patient=` (which is
  the PatientNum slot) and hardcodes `PatientID=0`. The lookup therefore always fails and
  raises `Folder1756_Patient_Not_Exists`, after which the open still succeeds from ASP
  Session. Per `Record.js`:
      function OpenPatient(Patient, Id_Num, Id_Status) {
          top.Search.document.SearchPatient.PatientID.value = Patient;  // PatientNum
          top.Search.SearchPatient.Id_Num.value            = Id_Num;    // national ID
      }
  i.e. PatientNum belongs in `PatientID`, national ID in `idnum`.

STATUS: CLOSED. Keep the BHO for patient opens. Do not reopen without a vendor fix.

Useful session-free probes for any future work:
    Invoke-WebRequest -Uri <url> -UseDefaultCredentials -AllowUnencryptedAuthentication `
                      -UseBasicParsing -MaximumRedirection 0
Reference copies kept: C:\Temp\Record.js, C:\Temp\Main.js, C:\Temp\translation.js

### 2026-09-16 21:35 — Can the BHO be replaced by EXTERNAL automation? NO. (tested)

Hypothesis: the BHO's job (call `OpenPatientRecord` on the Chameleon top window) could be
done from OUTSIDE the browser by the native-host EXE, removing the in-proc COM DLL and the
admin/HKLM registration. TESTED AND DISPROVEN.

Environment facts established first (important — they remove the usual excuses):
- Edge IE mode content runs in REAL `C:\Program Files (x86)\Internet Explorer\IEXPLORE.EXE`
  (here pid 26932; matches `[pid=26932]` in jumper-bho.log). A second iexplore (19920) is the frame.
- **UAC is DISABLED on this machine (`HKLM\...\Policies\System\EnableLUA = 0`).**
  Our probe process, iexplore 26932 and most msedge processes are ALL `S-1-16-12288` (High).
  => there is no integrity-level barrier, so the failures below are REAL, not artifacts.

Probes (all run at High integrity, Chameleon open and live in its IE-mode tab):
| Probe                                              | Result                                    |
|----------------------------------------------------|-------------------------------------------|
| `Shell.Application.Windows()` (ShellWindows / ROT)  | 0 windows — IE-mode tabs never register   |
| `WM_HTML_GET_OBJECT` -> `ObjectFromLresult`         | SendMessageTimeout rc=1 but **lResult=0** |
| UIA `AutomationElement.FromHandle(IE_Server)`       | 0 children                                |
| `EnumThreadWindows` over every thread of both pids  | NO live `Internet Explorer_Server`; only a hidden `TabThumbnailWindow "Chameleon - Internet Explorer"` and a hidden `IEFrame` |

CONCLUSION: Edge IE mode composites Trident content into Edge without exposing a scriptable
document to any other process. Classic external IE automation (COM/ROT/oleacc/UIA) does not
work against it. **An in-process BHO is the only foothold Microsoft leaves open.**
The BHO is therefore not a shortcut — it is a hard requirement for scripting the tab.

=> Any BHO-less solution must avoid scripting the tab entirely. Options:
  1. URL deep link `login.asp?quickOpen=1&Id=<nationalID>&...` — WORKS TODAY, no admin, no
     native code; costs the Patient_Not_Exists alert + ~2s full shell reload.
  2. **Vendor fixes login.asp** (PatientNum -> `PatientID`, national ID -> `idnum`). Then (1)
     becomes alert-free and BOTH the BHO AND the native host can be deleted — the extension
     reduces to a single `chrome.tabs.update`. No installer, no admin, no COM. BEST END STATE.
  3. Host Chameleon in our own Trident/WebView control = rebuilding Jumper; contradicts the POC.

Also worth raising with IT: the log shows a `/ChameleonNET/` path
(`/ChameleonNET/NET/Estimation/EstimationGradesDetails.aspx`), hinting at a modernised
non-IE branch. If a non-IE Chameleon UI exists the whole IE-mode problem disappears — and
given IE mode's end-of-support timeline this has to be faced eventually regardless.

DECISION: ship with the BHO for now; raise the login.asp bug with the vendor in parallel,
since that single server-side fix is what unlocks a genuinely BHO-less, install-free product.


### 2026-09-17 16:30 — H1 DISPROVEN: declarativeNetRequest does NOT reach IE-mode traffic

Question (task-bho-less-patient-open.md, H1): could DNR rewrite Chameleon's internal
`SearchPatient?...Patient=<nationalID>...&PatientID=0` request and kill the alert?
Answer: NO. IE-mode tabs do not traverse Chromium's network stack at all.

Experiment (extension 0.7.18, temporary rules 3/4/5 in `edge/rules.json`), all on
non-existent 404 paths so nothing could be polluted:
- rule 3  redirect  chsw.tasmc.corp + urlFilter `jumper-dnr-probe-R` -> `.../jumper-dnr-probe-HIT.html`
- rule 4  block     chsw.tasmc.corp + urlFilter `jumper-dnr-probe-B`
- rule 5  redirect  inextdata.tasmc.corp (Chromium control, identical rule shape)
All three listed main_frame, sub_frame, xmlhttprequest, script, image, other.

| Test | Address bar | jumper-bho.log |
|---|---|---|
| rule 5, Chromium control | `-R.html` -> **`-HIT.html`** | n/a |
| rule 3, IE mode | stayed `-R.html`, IIS 404 page | `[pid=20656] BeforeNavigate2 URL='http://chsw.tasmc.corp/jumper-dnr-probe-R.html'` + `DocumentComplete` same URL. `-HIT` appears nowhere in the log. |
| rule 4, IE mode | IIS 404 page, NOT ERR_BLOCKED_BY_CLIENT | `[pid=26044] BeforeNavigate2` + `DocumentComplete URL='http://chsw.tasmc.corp/jumper-dnr-probe-B.html'` |

The control proves the ruleset was live and correctly formed. In IE mode the redirect
never fired, and the **block did not stop the request** — the IIS 404 body proves it
reached the server. Independently, the fact that these URLs appear in `jumper-bho.log`
at all (with a pid) proves they were fetched by Trident inside `iexplore.exe`.

=> Edge IE mode fetches through WinINET, outside Chromium's network stack. DNR (and by
extension `webRequest`) cannot see, block, redirect or header-modify IE-mode requests.
Tested at `main_frame`; subresources follow a fortiori (the document itself never touched
the Chromium stack) but were not separately tested.

Corollary: `rules.json` rule 1 (block bare-host `chsw` signal URLs) only ever fires for
the **Chromium** tab that calls `window.open()` — which is correct and sufficient, since
that is where the modern app runs. It would not fire for an IE-mode tab.

Probe rules 3/4/5 are temporary and must be removed before this work is committed.

### 2026-09-17 16:45 — H4 CLOSED (not empirically tested): Chameleon needs IE mode

Per user (domain knowledge, not evidenced in this session's logs): Chameleon cannot be
rendered by a modern Chromium engine — legacy JS plus **ActiveX**. ActiveX alone is
decisive: Chromium has no ActiveX host, so there is no partial-success path.
The Chrome-based render test was therefore not run.

Supporting environment fact established while scoping the test: Edge forces IE mode for
the whole host via policy `InternetExplorerIntegrationSiteList` -> `https://iemode/sites.xml`,
which contains `<site url="chsw.tasmc.corp"><open-in>IE11</open-in></site>` (and `chsw`,
and `chsw.tasmc.corp/chameleon`). Confirmed incidentally by the H1 probe: even a bogus
404 path under chsw.tasmc.corp was handled by Trident (it appears in jumper-bho.log with
a `[pid=]`). So Edge cannot be used to test Chromium rendering of Chameleon.

Other endpoints probed session-free the same day (Invoke-WebRequest, no browser):
| Endpoint | Result |
|---|---|
| `/ChameleonNET/` , `/ChameleonNET/NET/` | 302 -> `/ChameleonNET/PermissionDenied.aspx` — the modernised branch EXISTS but this account has no permission |
| `http://chsw-qa.tasmc.corp/chameleon/` | 200 — a QA Chameleon exists; candidate sandbox for session-polluting experiments instead of production |
| `http://chs-readonly.tasmc.corp/chameleon/` | connection failure |
| `/Chameleon/` | 200, a 789-byte shim that `window.open`s `/Chameleon/Account/LogOn` |

Worth noting for H2/H3: a session-free GET of
`/Chameleon/Asp/Navigation/SearchPatient?Patient=9003397574&PatientID=9003397574&idnum=332747500&QuickOpen=1&Hospital=101`
returns 302 to
`/Chameleon/Account/Logon?ReturnUrl=%2fChameleon%2fAsp%2fNavigation%2fSearchPatient%3f...&Patient=9003397574&PatientID=9003397574&idnum=332747500&QuickOpen=1&Hospital=101`
i.e. it **preserves `PatientID` and `idnum` verbatim** and adds a `ReturnUrl`. That is a
different shape from the bare `Account/LogOn` GET tested on 2026-09-16 (no ReturnUrl),
so the earlier "LogOn ignores Patient" finding does not automatically apply here.

### 2026-09-17 16:47 — H2 INCONCLUSIVE; but SearchPatient is proven unusable as an entry point

Ran the two SearchPatient variants as top-level navigations in the already-logged-in
IE-mode tab (user pasted them; extension 0.7.18).

| # | Patient | PatientID | idnum | Rendered | Alert |
|---|---|---|---|---|---|
| H2a (control) | 332747500 (national ID) | 0 | (empty) | blue background only | NONE |
| H2b (hypothesis) | 9003397574 (PatientNum) | 9003397574 | 332747500 | blue background only | NONE |

BHO log evidence — each produced exactly ONE BeforeNavigate2 + DocumentComplete and
NOTHING downstream:

    16:47:34 [pid=26044] [BeforeNavigate2]  .../SearchPatient?Logout=0&Patient=332747500&...&PatientID=0&QuickOpen=1&idnum=&...
    16:47:34 [pid=26044] [DocumentComplete] (same URL)
    16:47:44 [pid=26044] [BeforeNavigate2]  .../SearchPatient?Logout=0&Patient=9003397574&...&PatientID=9003397574&QuickOpen=1&idnum=332747500&...
    16:47:44 [pid=26044] [DocumentComplete] (same URL)

Contrast with a genuine shell load captured in the same log at 16:47:07-09, which fires
BlankData x8, SyncPatient.aspx, Definitions, Heading, SessionTimer, Logo, SearchPatient,
HospPatientListMain, HospPatientList, then Home/Main.

**The control did not reproduce the alert**, so the lookup code never ran in either case.
=> H2's actual question ("does SearchPatient honour PatientID?") is STILL UNANSWERED.
Do not record H2 as a negative.

What IS proven: `SearchPatient` is not a usable top-level entry point at ANY parameter
combination. In the real shell it is a FRAME inside the `Home/Main` frameset, loaded with
`Patient=` and `QuickOpen=` both EMPTY (16:47:08.12):
    .../SearchPatient?Logout=0&Patient=&Unit=&...&PatientID=0&QuickOpen=&idnum=&isLogonRecordOpen=False
Loaded top-level it is an inert leaf document (the blue background). Note also that
`Home/Main` is the frameset root — its DocumentComplete fires LAST, after all the frames.
This corrects the earlier "Home/Main standalone = broken single frame" note: the issue is
missing ASP Session priming, not the URL.

Consistent conclusion across H2 and 2026-09-16: the QuickOpen flow is driven by ASP
**Session state**, which only `login.asp` can set — which is why only the verbatim URL works.

### 2026-09-17 17:04 — POST-into-account/logon lever: mechanics work, experiment inconclusive

`decisions.md` (2026-09-16 21:20) dismissed the `Patient`-via-POST lever with "would need a
cross-site POST into the IE-mode tab, which the extension cannot inject". That dismissal is
**wrong on the mechanics** and was never tested. Tested now.

Method: hand-built `C:\Temp\jumper-post-probe.html` replicating login.asp's own form verbatim
(`action=/Chameleon/account/logon method=post`, fields ReturnUrl/QuickOpen/Id/UserName/Password/
Domain/Patient/User_Code/computer/VisitDate/AdmissionNo/AuxCode/Diary/NumOfAttempts), opened via
"Reload in Internet Explorer mode" (policy `InternetExplorerIntegrationLocalFileAllowed=1`) so the
POST goes out on WinINET. V2 = control (Patient=""), V1 = hypothesis (Patient=<PatientNum>).

Result: BOTH produced a login page, then the department page. No alert, no patient.

BHO log (the POST arrived in pid 26044, the EXISTING Chameleon process — not the probe's own
pid 7260/24720):

    17:02:50 [pid=26044] [BeforeNavigate2]  http://chsw.tasmc.corp/Chameleon/account/logon
    17:02:50 [pid=26044] [DocumentComplete] http://chsw.tasmc.corp/Chameleon/account/logon
    17:02:55 [pid=26044] [BeforeNavigate2]  .../account/logon                     <- user's credentials
    17:02:55 [pid=26044] [BeforeNavigate2]  .../SearchPatient?Logout=0&Patient=&...&PatientID=0&QuickOpen=&idnum=&isLogonRecordOpen=False
    17:02:57 [pid=26044] [DocumentComplete] .../Home/Main?pReloginByUserRecord=0&PatientID=0&...

Findings:
1. A cross-document POST originated outside the IE-mode tab DOES survive into IE mode and is
   delivered to the Chameleon process. The mechanism is available.
2. But `account/logon` answered it with the **login form**: our POST presented empty
   UserName/Password and `User_Code=-2`, so it was treated as a fresh login attempt instead of
   reusing the live session. Cost: the user was logged out and had to re-authenticate.
3. After re-login the follow-up `SearchPatient` carried `Patient=` and `QuickOpen=` EMPTY — the
   QuickOpen intent was lost entirely.

=> The control (V2) did not reproduce the alert, so nothing can be concluded about `Patient`.

**Why both H2 and this run failed the same way — the unifying explanation:**
the alert is NOT a function of the query string / POST body alone. It requires the ASP **Session**
QuickOpen state that only `login.asp` sets. H2a had no such state (hence no alert, inert page);
the POST run wiped it. Any test that does not go through `login.asp` cannot reach the alert path,
and any test that DOES go through `login.asp` has already fired the alert. That is a closed loop.

This is the mechanical reason the 2026-09-16 conclusion stands, and it is stronger than the
reasoning given there.

### 2026-09-17 17:16 — POST lever CLOSED (credential-free variant also fails)

Follow-up to 17:04. Hypothesis was that the login form appeared only because our POST carried
empty UserName/Password/User_Code=-2. Retested credential-free (V6: ReturnUrl, QuickOpen=1,
Id=<nationalID>, Patient="" — nothing else).

Result: identical. Login page, then department page. No alert, no patient.

    17:16:14 [pid=26044] [BeforeNavigate2]  http://chsw.tasmc.corp/Chameleon/account/logon
    17:16:15 [pid=26044] [DocumentComplete] http://chsw.tasmc.corp/Chameleon/account/logon
    17:16:22 [pid=26044] [BeforeNavigate2]  .../SearchPatient?Logout=0&Patient=&...&PatientID=0&QuickOpen=&idnum=&isLogonRecordOpen=False
    17:16:24 [pid=26044] [DocumentComplete] .../Home/Main?pReloginByUserRecord=0&PatientID=0&...

Likely mechanism (INFERENCE — not directly evidenced): the probe page ran in its own IE-mode
process (pid=10380 this run, 7260/24720 the previous run) and IE session cookies are per-process,
so the POST was issued without Chameleon's session cookie even though the navigation was handed
to the session-owning process (pid=26044). Consistent with the server answering a
login form while pid 26044 demonstrably held a live session in the same log.

To originate the POST *inside* the session-owning process you must script that tab — which is
exactly what requires the BHO. Circular. This reaches the same conclusion as 2026-09-16 21:20 but
by mechanism rather than assumption, and it corrects that entry's claim that the POST "cannot be
injected": it CAN be injected and is delivered to the right process; it just cannot carry the session.

=> For an extension-only solution the alert is unavoidable. CLOSED.

### 2026-09-17 17:25 — SESSION SUMMARY: extension-only patient open is possible but NOT alert-free

Worked through `docs/task-bho-less-patient-open.md`. Net result:

| Hypothesis | Verdict | Basis |
|---|---|---|
| H1 — rewrite SearchPatient via declarativeNetRequest | **DISPROVEN** | direct experiment, BHO log |
| H2 — does SearchPatient honour `PatientID`? | **UNANSWERABLE** (control never reached the code path) | BHO log |
| H3 — another server-side deep link | none found; `/ChameleonNET/*` cannot even be enumerated (identical 302 for real and invented paths) | probe table |
| H4 — Chameleon under Chromium | **CLOSED** on user domain knowledge (ActiveX). Not tested by me. | user |
| POST into `account/logon` (new lever, not in the task doc) | **CLOSED** — reaches the right process, cannot carry the session | BHO log |
| H5 — URL fallback behind a flag | **IMPLEMENTED** (extension 0.7.19, `patientOpenMode`, default `bho`) | code |

**The single governing fact, now established by mechanism rather than assumption:**
Edge IE mode fetches through WinINET, entirely outside Chromium's network stack. Combined with
the previously-proven facts that `chrome.scripting`/`chrome.debugger` cannot touch IE-mode
documents and that external COM/UIA automation of the IE-mode tab is impossible, this means:

> **Nothing outside the IE-mode tab can observe, modify, or script what happens inside it.
> The BHO is the only foothold, and it is an in-process one.**

Every remaining avenue therefore has to either (a) not touch the IE-mode tab at all, or
(b) get Chameleon to do the work using its own code, triggered by a plain navigation.
(b) is what `login.asp?quickOpen=1` does — and it always raises
`מטופל/ת לא נמצא/ה במערכת` first, because of a server-side parameter-mapping bug we cannot
reach. That alert is the entire remaining gap between "extension-only works" and
"extension-only is good enough to ship".

**Corrections this session makes to earlier entries:**
- 2026-09-16 21:20 said a POST "cannot be injected" by the extension. Wrong: it CAN be, and is
  delivered to the live Chameleon process. It simply cannot carry that process's session.
- 2026-09-16 said `Home/Main` standalone is a "broken single frame". It is actually the frameset
  ROOT (its DocumentComplete fires last, after all child frames). The failure was missing ASP
  Session priming, not the URL.
- `handoff.md` §8.7 says there is no way to validate JS locally. Headless **Chrome**
  (`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe --headless --dump-dom`) works on
  this machine and was used to unit-test the URL-rewrite helper. `pip install esprima` also gives
  a usable JS syntax check (normalise `catch {` -> `catch (e) {` first; esprima predates optional
  catch binding).

Temporary H1 probe rules (rules.json ids 3/4/5) have been REMOVED; rules.json is back to ids 1/2.

### 2026-09-17 17:50 — H5 VERIFIED END TO END (extension 0.7.19, `patientOpenMode: "url"`)

User set the popup toggle to "Patient open via URL (degraded)" and clicked Patient A in the
modern app. Full chain from `C:\Temp\jumper-bho.log`:

    17:50:27 [pid=26652] [BeforeNavigate2]  http://chsw/chameleon/login.asp?quickOpen=1&Id=332747500&...   <- bare-host signal URL (popup tab, intercepted)
    17:50:27 [pid=26044] [BeforeNavigate2]  http://chsw.tasmc.corp/chameleon/login.asp?quickOpen=1&Id=332747500&...  <- OUR rewrite via chrome.tabs.update
    17:50:35 [pid=26044] [BeforeNavigate2]  .../SearchPatient?Logout=0&Patient=332747500&...&PatientID=0&QuickOpen=1&...   <- the alert-raising request
    17:50:37 [pid=26044] .../NavigationTrees/PatientTree?patient=9003397574&record=16371953&unit=831000&recordType=3&recordChar=0
    17:50:37 [pid=26044] .../Home/Main?Patient=332747500&...&QuickOpen=1
    17:50:37 [pid=26044] .../RecordsMedicalRecord/MedicalRecord?...Patient=9003397574&Record=16371953&Unit=831000&Record_Type=Hospitalization&Start_Date=26%2F08%2F2026
    17:50:44 [pid=26044] .../MedicalRecord?...&Record_Part=47&...      <- user navigating inside the record

Correct patient (PatientNum 9003397574), correct record (16371953), correct unit (831000) and
correct admission (Start_Date 26/08/2026 == AdmissionDate 2026-08-26). The `Record_Part=47`
load proves the record is actually usable afterwards, not merely rendered.

**The BHO was passive throughout.** The only BHO mention in the whole window is its own
`TryProbeOpenPatientRecord` DocumentComplete probe — no `[invoke:pipe-immediate]`, no
`EXEC_SCRIPT`, no queued command. This path therefore works with `bho-poc/` and
`native-host/` deleted, which is the requirement.

Defect confirmed present as documented: the `מטופל/ת לא נמצא/ה במערכת` alert fires first and
must be dismissed, and the full shell reloads (~10 s wall clock here, 17:50:27 -> 17:50:37).

STATUS: `patientOpenMode` stays **default `"bho"`**. The URL path is proven, but the alert on
every open is why it is not the default.

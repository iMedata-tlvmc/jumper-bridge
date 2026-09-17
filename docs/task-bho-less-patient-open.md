# Task: open a patient with a link — extension only, no BHO, no COM

> Paste-ready brief for a fresh Copilot session started in this repo.
> Start with: *"Read `docs/task-bho-less-patient-open.md` and work through it."*

## Goal

Make clicking a patient in the modern Gecko web app open that patient's full record in the
Chameleon EHR tab — **using only the Edge extension in `edge/`**. No BHO, no native messaging
host, no COM, no desktop app. Browser + extension only.

This is a hard problem that has already been investigated in depth. **Read these first:**

- `docs/handoff.md` — architecture, how each link type is routed today, known limitations.
- `docs/decisions.md` — chronological engineering log. Pay particular attention to the
  entries dated `2026-09-16`, which cover exactly this problem.
- `README.md` — components, install steps, the extension-ID gotcha.

## Hard constraints

- Do **not** modify `bho-poc/` or `native-host/`. They stay installed, but only as a
  **passive logger** — the BHO writes every IE-mode navigation to `C:\Temp\jumper-bho.log`,
  which is the primary evidence source. Any solution you propose must work with them deleted.
- Chameleon only runs in Edge **IE mode**. Chrome extension APIs (`chrome.scripting`,
  `chrome.debugger`) cannot touch IE-mode documents.
- Bump `edge/manifest.json` version on every change so reloads are verifiable.
- The user must manually test anything in the browser — you cannot click for them.
  Give exact URLs/steps, then read `C:\Temp\jumper-bho.log` yourself to verify.

## Already PROVEN — do not re-attempt

See `docs/decisions.md` for the full evidence.

1. **External automation of the IE-mode tab is impossible.** `ShellWindows`/ROT returns 0,
   `WM_HTML_GET_OBJECT` returns `lResult=0`, UIA returns 0 children, and no live
   `Internet Explorer_Server` window exists. UAC is disabled on this machine (`EnableLUA=0`,
   everything runs at High integrity), so these are real failures, not permission artifacts.
2. **Opening a patient causes no top-level navigation.** Chameleon's `OpenPatientRecord`
   independently repoints ~5 sibling frames. There is no single "patient page URL" in
   normal operation.
3. **Frame-level URLs don't work standalone.** `MedicalRecord?…` renders content with no
   tree/header; `SearchPatient?…` and `Home/Main?…` render a broken single frame.
4. **The patient search box in Chameleon's header is AJAX + in-place frame swap** — no URL.
5. **Recreating Chameleon's frameset ourselves fails on same-origin** — `Record.js` alone has
   322 cross-frame `top.*`/`parent.*` references and there is nowhere same-origin to host it.

## The one thing that DOES work (and its single defect)

Navigating the already-logged-in Chameleon tab to the modern app's own signal URL, with the
host rewritten from bare `chsw` to `chsw.tasmc.corp`, **does open the correct patient,
record and unit**:

```
http://chsw.tasmc.corp/chameleon/login.asp?quickOpen=1&Id=332747500&PatientNum=9003397574&MedicalRecord=16371953&RecordChar=0&Unit=831000&AdmissionDate=2026-08-26T21:38:00
```

`login.asp` carries `PatientNum`/`MedicalRecord`/`Unit`/`RecordChar`/`AdmissionDate` through
**ASP session state**, not the query string.

**The only defect:** a spurious `מטופל/ת לא נמצא/ה במערכת` alert fires first. Dismissing it
reveals the correct page. Root cause: `login.asp` puts `Id` (the **national ID**) into the
`Patient` slot of the internal redirect, and hardcodes `PatientID=0`:

```
/Chameleon/Asp/Navigation/SearchPatient?Logout=0&Patient=332747500&Unit=&Record=&Record_Type=
  &Record_Char=&Record_Title=&pReloginByUserRecord=0&Hospital=101&PatientID=0&QuickOpen=1
  &idnum=&isLogonRecordOpen=False&VisitDate=&AdmissionNo=&AuxCode=&Diary=
```

But `Record.js` proves the patient key belongs in `PatientID`, and the national ID in `idnum`:

```js
function OpenPatient(Patient, Id_Num, Id_Status) {
    top.Search.document.SearchPatient.PatientID.value = Patient;   // PatientNum
    top.Search.SearchPatient.Id_Num.value             = Id_Num;    // national ID
}
```

Variants already tested on `login.asp` — **only the verbatim URL works**:

| Variant | Result |
|---|---|
| verbatim (`Id` = national ID) | alert, then correct page |
| drop `Id` | no alert, no patient |
| `Id` = PatientNum | alert, no patient |
| `Id` = PatientNum + `idnum` = national ID | alert, empty frame |
| `&Patient=<PatientNum>` added | ignored — hidden field is hardcoded `value=""` |
| same params on `/Chameleon/Account/LogOn` (GET) | ignored; still `Patient=<nationalID>&PatientID=0` |

## Open hypotheses — work through these in order

### H1 (highest value): rewrite the internal `SearchPatient` request with `declarativeNetRequest`

If DNR can see and rewrite IE-mode subresource requests, redirecting
`SearchPatient?…Patient=<nationalID>…&PatientID=0…` to
`…Patient=<PatientNum>…&PatientID=<PatientNum>…&idnum=<nationalID>` would fix the lookup and
kill the alert — a pure-extension solution.

**First establish empirically whether DNR applies to IE-mode traffic at all** (IE mode may use
WinINET and bypass Edge's network stack entirely). Note `edge/rules.json` already blocks
bare-host `chsw` signal URLs; check whether those blocks actually fire for IE-mode tabs or
only Chromium ones. This single question decides H1.

### H2: does `SearchPatient` honour `PatientID`?

Have the user paste a `SearchPatient?…` URL with `PatientID=<PatientNum>` into the
already-logged-in tab and report whether the alert appears. Even a broken frame is a valid
signal here — only the presence/absence of the alert matters.

### H3: is there another server-side deep link?

Probe for one. Chameleon files can be fetched without a browser session:

```powershell
Invoke-WebRequest -Uri '<url>' -UseDefaultCredentials -AllowUnencryptedAuthentication `
                  -UseBasicParsing -MaximumRedirection 0
```

Static assets return 200; session-gated pages return 302. Already retrieved:
`/Chameleon/Content/Legacy/include/Record.js`, `/Chameleon/Scripts/Main.js`, and the
translation dictionary `/Chameleon/Javascript/Translation?intovar=T&p=Folder<N>`.
The alert string lives in `Folder1756_Patient_Not_Exists`, `Folder1762_Patient_Not_In_System`
and `Folder1916_PatientNotExists` — all server-rendered, not client-side.

### H4: does Chameleon actually still need IE mode?

Nobody has empirically tested it in a normal Chromium tab. The login page uses `expression()`
CSS and `showModalDialog`, but those may be cosmetic or legacy-only paths. If the patient
screens render acceptably in Chromium, the entire problem dissolves and `chrome.scripting`
becomes available. Cheap to test, huge payoff.

Also note `/ChameleonNET/…aspx` paths appear in the logs, hinting at a modernised branch
worth asking IT about.

### H5: accept the alert

If H1–H4 all fail, implement the URL approach behind a config flag (default off) as a
fallback for machines where the BHO can't be installed, and document the tradeoff: alert on
every open, ~2s full shell reload, loss of app state, and no support for modal links
(OrdersForApprove) or dept-tab detection.

## Test data

| | Patient A | Patient B |
|---|---|---|
| `Id` (national ID) | `332747500` | `9996620` |
| `PatientNum` | `9003397574` | `9001674042` |
| `MedicalRecord` | `16371953` | `11152014` |
| `Unit` | `831000` | `831000` |
| `RecordChar` | `0` | `0` |
| `AdmissionDate` | `2026-08-26T21:38:00` | `2023-07-25T10:52:00` |

- Chameleon: `http://chsw.tasmc.corp` (signal URLs use bare host `chsw`).
- Chameleon version: `8.5.13.11426`.
- BHO navigation log: `C:\Temp\jumper-bho.log`.
- Extension navLog: extension popup → **Refresh log**.

## Deliverable

Either:

- **a working pure-extension patient open** — implemented, version-bumped, verified by the
  user in the browser and by you in `C:\Temp\jumper-bho.log`, with `docs/decisions.md`
  updated; or
- **a definitive, evidence-backed negative** for H1–H4, recorded in `docs/decisions.md`, plus
  H5 implemented behind a flag.

Do not claim success until the user has confirmed it in the browser and you have confirmed the
frame URLs in the BHO log. Commit only when the user says so.

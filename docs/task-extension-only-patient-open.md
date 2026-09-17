# Task: extension-only patient open — stop hunting URLs, change the shape of the solution

> Paste-ready brief for a fresh Copilot session started in this repo.
> Start with: *"Read `docs/task-extension-only-patient-open.md` and work through it."*

## Goal

Clicking a patient in the modern Gecko web app should open that patient's record in the
Chameleon EHR tab, using **only the Edge extension in `edge/`** — no BHO, no native
messaging host, no COM, no desktop app, nothing that needs installing on the machine.

A BHO-free patient open **already exists and works** (`patientOpenMode: "url"`, see
`docs/handoff.md` §4.1). It is not shippable for one reason: a spurious
`מטופל/ת לא נמצא/ה במערכת` alert fires on every open and the whole Chameleon shell
reloads (~2 s, losing app state).

**Your job is to make that experience acceptable, or to find a fundamentally different
shape for the solution. Your job is NOT to find another URL.**

## Read these first

- `docs/handoff.md` — architecture, routing table, §4.1 (the URL fallback), §7 (proven
  limitations).
- `docs/decisions.md` — engineering log. The entries dated **2026-09-16** and
  **2026-09-17** are this exact problem and contain the evidence for everything below.
- `README.md` — components, install steps, the extension-ID gotcha.

## Hard constraints

- Do **not** modify `bho-poc/` or `native-host/`. They stay installed as a **passive
  logger** — the BHO writes every IE-mode navigation to `C:\Temp\jumper-bho.log`, which is
  the primary evidence source. Anything you propose must work with them deleted.
- Chameleon only runs in Edge **IE mode** (legacy JS + **ActiveX** — settled, don't retest).
- Bump `edge/manifest.json` version on every change so reloads are verifiable.
- The user must test anything in the browser — you cannot click for them. Give exact steps,
  then read `C:\Temp\jumper-bho.log` yourself to verify what actually happened.
- This is a live hospital system. Work within its supported, documented behaviour: navigate
  to URLs the application itself produces, and read its own logs. Do not go looking for
  undocumented parameters or ways to make the server do things it wasn't built to do.

## The governing fact — internalise this before proposing anything

> **Nothing outside an IE-mode tab can observe, modify, or script what happens inside it.**

Three independent mechanisms were tested and all fail (evidence in `decisions.md`):

| Mechanism | Result |
|---|---|
| `chrome.scripting` / `chrome.debugger` (CDP) | cannot touch IE-mode documents |
| `declarativeNetRequest` / `webRequest` | **cannot see IE-mode requests at all** — a `block` rule did not stop an IE-mode navigation (the server's 404 body came back), while the identical rule redirected fine in a Chromium tab. IE mode fetches via WinINET, outside Chromium's network stack. |
| External COM / ShellWindows / ROT / `WM_HTML_GET_OBJECT` / UIA | all return nothing, with UAC disabled, so these are real failures |

A cross-document **POST** *can* be delivered into the live Chameleon process, but it cannot
carry that process's session, so it is not a way in either.

**Therefore:** any solution must either (a) not touch the IE-mode tab at all, or (b) get
Chameleon to do the work with its own code, triggered by a plain navigation. (b) is exactly
what the URL fallback does — and the alert is a server-side parameter-mapping bug inside
that flow which we have no reach into.

## CLOSED — do not re-attempt, do not re-litigate

All of these have been tested with evidence recorded in `docs/decisions.md`:

1. Rewriting Chameleon's internal request with `declarativeNetRequest`.
2. External automation of the IE-mode tab (COM/ROT/UIA/window messages).
3. `SearchPatient`, `Home/Main` and `MedicalRecord` as standalone entry points.
4. `login.asp` query-string variants — only the verbatim signal URL works.
5. POSTing to `/Chameleon/account/logon`, with and without credential fields.
6. Rendering Chameleon in a Chromium engine.
7. Recreating Chameleon's frameset ourselves (same-origin; `Record.js` alone has 322
   cross-frame `top.*`/`parent.*` references).

If you find yourself composing another Chameleon URL and asking the user to paste it, stop.
That seam is exhausted.

## Directions worth exploring — think about the product, not the URL

These are unexplored. None of them is obviously right; pick the one you can get evidence on
fastest and say so.

### D1. Hide the cost instead of removing it
The alert and the ~2 s reload are only unacceptable because they happen **in front of the
user, on the tab they are looking at**. The extension fully controls tab lifecycle. Can the
deep-link load be done in a tab the user isn't looking at, and the tabs swapped once it has
settled? Open question that decides it: **does an IE-mode `alert()` block, and can it be
reached, in a non-active tab?** That is a single cheap experiment and it gates the whole
idea. Beware: `decisions.md` records that Trident does its own focus handling at the Win32
level, invisible to `chrome.tabs`/`chrome.windows` — so verify focus behaviour empirically.

### D2. Prefetch / keep-warm
The reload is expensive partly because the whole shell rebuilds. Could a second Chameleon
tab be kept logged in and pre-warmed so a patient open is a swap rather than a cold load?
Measure the real cost first from `jumper-bho.log` timestamps (the log gives you exact
per-frame timings) before designing anything.

### D3. Change what "open the patient" means
Does the clinician actually need Chameleon's full record shell for this action, or do they
need specific information? If the modern app can serve what they need from its own APIs, the
IE-mode problem disappears for this flow entirely. This is a product question for the user —
ask it early, because a positive answer makes everything above unnecessary.

### D4. The side panel, inverted
The side panel already renders the modern app beside the IE-mode tab (`handoff.md` §6) and
is proven to work. Is there a layout where the clinician drives from the panel and Chameleon
is simply the backdrop, so that a full shell reload is no longer disruptive?

### D5. Ask for the supported integration surface
`/ChameleonNET/` exists on the server but is permission-denied for this account (it returns
an identical 302 for real and invented paths, so it cannot be explored from outside). A
modern, non-IE Chameleon branch would dissolve this entire problem. This is a question for
IT and the vendor, not something to reverse-engineer. Likewise the alert itself: it is one
line of server-side parameter mapping (`Record.js` shows PatientNum belongs in `PatientID`
and the national ID in `idnum`; the QuickOpen flow puts the national ID in `Patient` and
hardcodes `PatientID=0`). A vendor fix makes the URL path alert-free and lets the BHO, the
native host and the COM registration all be deleted. **Raising this is probably the highest
value action available** — record it as a recommendation even if you also ship something.

## Ground rules for how you work

1. **Verify before concluding.** Back every claim with a line from `C:\Temp\jumper-bho.log`
   or an actual HTTP response — not with inference about what should happen. If you can't
   evidence it, say so explicitly.
2. **Controls matter.** Two experiments in the 2026-09-17 session produced confident-looking
   results that were actually meaningless because the control never reproduced the known
   behaviour. Always run the known-good case first; if it doesn't behave as expected, the
   experiment is invalid and the variant result tells you nothing.
3. **Settle one question at a time.** Identify the single cheapest experiment that kills or
   confirms a direction, run it, and don't drift until it's settled.
4. **Say "I don't know."** A clearly-labelled unknown is worth more than a confident guess.

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
- BHO navigation log: `C:\Temp\jumper-bho.log` — filter it, it is dominated by poll noise
  (`handoff.md` §9). Record the file length before a test and read only from that offset.
- Extension navLog: extension popup → **Refresh log**.

## Tooling notes (save yourself the rediscovery)

- No Node.js. But headless **Chrome** works for running JS and reading a result out of
  `document.title`:
  `& 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' --headless --dump-dom file:///…`
- `pip install esprima` gives a JS syntax check; normalise `catch {` → `catch (e) {` first.
- Session-free HTTP probes:
  `Invoke-WebRequest -Uri <url> -UseDefaultCredentials -AllowUnencryptedAuthentication -UseBasicParsing -MaximumRedirection 0`
- Edge forces IE mode for the whole `chsw.tasmc.corp` host via policy
  `InternetExplorerIntegrationSiteList` → `https://iemode/sites.xml`.

## Deliverable

Either:

- **an extension-only patient open the user would actually accept** — implemented,
  version-bumped, verified by the user in the browser *and* by you in
  `C:\Temp\jumper-bho.log`, with `docs/decisions.md` and `docs/handoff.md` updated; or
- **an evidence-backed statement that extension-only cannot be made acceptable**, naming
  precisely which constraint blocks it, with the URL fallback left in place behind its flag
  and a concrete written recommendation for the server-side fix that would unblock it.

Do not claim success until the user has confirmed it in the browser and you have confirmed
the frame URLs in the BHO log. Commit only when the user says so.

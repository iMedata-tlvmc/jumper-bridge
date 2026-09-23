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

Manual popup and side-panel buttons still navigate to Gecko sections.

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

## Use a compact toolbar popup with an optional side panel

The toolbar action uses a compact extension popup containing the four manual
routing buttons. This avoids a persistent floating browser window while keeping
the common actions immediately available.

The popup can explicitly open the Edge side panel from its user gesture. The
panel retains the four routing buttons and Gecko preview, but no Chameleon state
opens or focuses it automatically.

Both interfaces remain extension-only and send the existing manual routing
messages. Diagnostics and Hospital ID configuration remain on the standard
extension Options page rather than in the normal four-button control surface.

## Use a local merged site list for the POC

The installer preserves the centrally configured list, adds the shared-cookie
entries, assigns a monotonic version, and writes a current-user local copy.
Production should add the entries to the centrally hosted list.

## Security review: mitigated in-repo, accepted/out-of-scope elsewhere

A review of the shared-cookie architecture identified risks in two buckets.

**Mitigated in this repo:**

- **PHI in logs.** `native-host` and `background.js` logs (plaintext files /
  `chrome.storage.local`, both routinely copied into support tickets) masked
  patient numbers, medical records, units, and the same fields inside signal
  and Chameleon URLs, keeping only the last 3 characters for troubleshooting.
- **Namer executable integrity.** `NamerButton.exe` runs from a UNC file share
  with no code signing guarantee known to us. Rather than hard-block on an
  unverified assumption (which risks breaking a live clinical workflow if the
  file turns out not to be signed), the native host now logs the file's
  SHA-256 hash and Authenticode trust status on every launch, giving IT an
  audit trail and a basis for turning this into a hard pin once the real
  signing status is confirmed.
- **DNR rule scope audit.** `edge/rules.json`'s CSP/X-Frame-Options-stripping
  rule was confirmed to already be scoped to `sub_frame` requests on only
  `inextdata.tasmc.corp`/`dev-inextdata.tasmc.corp` — no broader than the
  Gecko iframe it exists for.

**Accepted / out of scope for this repo** (documented, not fixed here):

- **Chameleon is served over plain HTTP.** Shared session cookies and all
  Chameleon traffic are unencrypted on the wire. This requires TLS on the
  Chameleon server itself, outside the extension/installer's control.
- **Cookie sharing widens the attack surface into Chromium.** Any tab or
  extension in the same Edge profile with host access to `chsw.tasmc.corp`
  can read/use the shared session cookies. This is the fundamental tradeoff
  of removing the BHO in favor of Enterprise Mode shared cookies; it cannot
  be scoped to just this extension (cookies aren't extension-scoped).
- **Other extensions in the same profile.** Restricting which extensions can
  run in the profile requires an organizational `ExtensionInstallAllowlist` /
  `ExtensionInstallBlocklist` Edge policy — an IT decision, not something the
  installer or extension can enforce on themselves.
- **Unpacked/dev-mode extension source tampering, and the per-user
  site-list file being user-writable.** Both live under the current user's
  own profile, which that same user (or malware running as them) can always
  read/rewrite regardless of NTFS ACLs the installer sets, since the user
  owns those files. A real boundary needs packaging + signing + a managed
  force-install policy (Edge Add-ons store or a hosted update manifest with a
  signing key) — additional infrastructure outside this repo, not an ACL
  tweak.
- **No CSRF protection on Chameleon itself.** Chameleon accepts state-changing
  requests from any page with a valid session cookie. This is a legacy ASP
  application issue outside this repo's control.

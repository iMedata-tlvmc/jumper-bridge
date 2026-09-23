# Jumper Bridge decisions

This file records only decisions that still constrain the current
implementation. Obsolete experiments and completed task plans have been removed.

## Use document-start interception

Gecko signals are intercepted before navigation:

- main-world `window.open()` wrapper;
- capture-phase anchor listeners;
- sender-origin validation in the service worker.

This avoids temporary tabs, IE-mode signal requests, and download prompts.
Tab-level interception and DNR remain defensive fallbacks only.

## Use shared-session patient navigation

Patient opening uses Enterprise Mode bidirectional cookie sharing. The
extension primes QuickOpen state with the original signal URL and navigates
Chameleon to corrected `Home/Main` parameters.

This is the only patient route. Native/BHO patient invocation and degraded
direct-URL modes were removed.

## Require a fresh login after cookie-policy installation

Edge can load the shared-cookie rules while an existing Chameleon session
remains authenticated in IE mode. That old session does not retroactively copy
its cookies into Chromium.

After changing the site list, users must:

1. Fully restart Edge.
2. Log out of Chameleon.
3. Log back in.

The extension popup's **Probe sector** is the supported shared-session check.

## Reproduce GetUserSector through HTTP

Med Orders obtains the sector through authenticated
`GetUserDetails`/`DataReaderXML.asp`, matching Chameleon's own data source.
There is no native or BHO fallback.

## Keep the BHO only for department-state detection

Extensions cannot inspect IE-mode DOM content. The BHO therefore remains to
read the patient-list and heading-tab elements and expose a Boolean department
state.

It does not navigate, invoke page functions, execute scripts, open patients, or
handle downloads.

This dependency is optional at deployment time. If automatic
**מחלקות → Gecko** switching is not required, remove the BHO/COM installation,
department polling, named pipe, and shared protocol.

## Keep the native host separate

The BHO must be an in-process COM DLL loaded by Trident. Edge native messaging
requires a standalone executable. They cannot be one binary under the current
activation models.

The native host has two responsibilities:

- relay `QUERY_DEPT_TAB` to the BHO through the named pipe;
- launch Namer after validating the patient number.

Without department switching it is needed only for Namer. Without Namer it is
not needed at all.

## Start the pipe only in the Chameleon frameset process

IE mode can create several `iexplore.exe` processes. Starting the same named
pipe in popup processes creates an ownership race. The BHO starts its pipe only
when the top document exposes `folderFrame`.

## Prefer tabs over Chameleon modal dialogs

Modal dialogs created inside the unfocused IE-mode Chameleon tab are invisible
until the user switches tabs. Current browser-page routes therefore use normal
tabs, accepting that Fluid Balance may display an IE close-tab prompt.

## Use a local merged Enterprise Mode list for the POC

The installer preserves the centrally configured list, adds the required
shared-cookie entries, assigns a monotonic version, and writes a local copy
under `%ProgramData%\JumperBridge`.

Production should add the same entries to the centrally hosted list so updates
do not require rerunning the installer on each computer.

## Keep the side panel optional

The side panel can render Chromium content beside an IE-mode tab. Opening it
requires a user gesture, so the popup opens it initially; department transitions
fall back to focusing a normal Gecko tab if the panel is unavailable.

// background.js — service worker for the Jumper Edge bridge POC.
//
// Two things live here now:
//  1. The original API probe harness (tabs.query/update, scripting, cookies,
//     webNavigation logging) used to empirically test IE-mode capabilities.
//  2. The real Phase 2 bridge: intercepts window.open() calls matching
//     Jumper's Common.cs URL patterns and routes them to the Chameleon tab
//     using the reverse-engineered deep-link URL — no JS injection needed.
//
// Nothing here assumes success — every probe/action is wrapped so we capture
// the exact error (if any) rather than crashing the service worker.

const MAX_LOG_ENTRIES = 200;

// Serializes writes to chrome.storage.local so concurrent appendLog() calls
// (e.g. tabs.onCreated + tabs.onUpdated firing close together) don't clobber
// each other via a non-atomic read-modify-write race.
let logWriteQueue = Promise.resolve();

function appendLog(entry) {
  logWriteQueue = logWriteQueue.then(async () => {
    const { navLog = [] } = await chrome.storage.local.get("navLog");
    navLog.push({ ts: new Date().toISOString(), ...entry });
    while (navLog.length > MAX_LOG_ENTRIES) navLog.shift();
    await chrome.storage.local.set({ navLog });
  });
  return logWriteQueue;
}

// The exact analogue of Gecko.cs's WebView_NewWindowRequested: fires only for
// tabs created by window.open() / target=_blank, which are the only tabs that
// may carry a modern-app signal URL.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  appendLog({ event: "onCreatedNavigationTarget", details });
  markPopupCandidate(details.tabId);
  maybeInterceptModernPopup(details.tabId, details.url);
});

// Fires for every navigation in every tab, so it must never intercept on its
// own authority - it only serves to supply the URL for a tab already known to
// be a popup candidate (onCreatedNavigationTarget can arrive before the URL is
// resolved). The popupCandidateTabIds guard inside does the filtering.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  appendLog({ event: "onBeforeNavigate", details });
  maybeInterceptModernPopup(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  appendLog({ event: "tabs.onRemoved", tabId });
  // Keep the interception bookkeeping from growing without bound.
  handledPopupTabIds.delete(tabId);
  popupCandidateTabIds.delete(tabId);
});

async function wrap(fn) {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}


// ---------------------------------------------------------------------------
// Phase 2: the real bridge.
//
// Mirrors Gecko.cs `WebView_NewWindowRequested`: the modern app (inextdata)
// calls window.open(<signal URL>). In the real Jumper app that's a WebView2
// event; in a normal Chromium tab, window.open() creates a brand-new tab
// whose (pending) URL we can inspect via tabs.onCreated / tabs.onUpdated.
// We immediately close that throwaway tab and route the equivalent action to
// the real Chameleon tab instead — exactly what an extension CAN do (no JS
// injection required), based on the reverse-engineered deep-link URL format.
//
// IMPORTANT (2026-09-02 finding): WebView2's e.Handled = true cancels
// navigation BEFORE any network request is sent. tabs.remove() alone can
// only react AFTER the tab exists, which races against the real HTTP fetch
// to the signal URL (http://chsw/chameleon/login.asp?quickOpen=1&...) —
// observed in testing as a spurious, nameless file-download attempt, since
// that endpoint is a pure signal, never meant to actually be loaded. Fixed
// via declarativeNetRequest (rules.json): blocks requests to bare host
// "chsw" (distinct from the real chsw.tasmc.corp Chameleon domain) before
// they hit the network, matching WebView2's cancel-before-fetch behavior.
// tabs.onCreated still sees the original pendingUrl (with all query params)
// before the block takes effect, so parsing/routing below is unaffected.
//
// CORRECTION (2026-09-09): the rules.json block only covers navigations
// serviced by Chromium. If the throwaway tab lands in IE mode, the request is
// issued by Trident/WinINet, which bypasses Chromium's network stack entirely
// - no declarativeNetRequest rule is ever consulted, the signal URL really is
// fetched, and the nameless file-download attempt comes back. This was the
// actual source of the spurious "Download Options" prompt. The IE-mode half of
// the cancel now lives in the BHO (bho-poc/BhoObject.cs,
// IsModernAppSignalUrl + BeforeNavigate2 cancel). Keep BOTH: this rule covers
// Chromium-rendered tabs, the BHO covers IE-mode ones.
// ---------------------------------------------------------------------------

const CHAMELEON_BASE_URL = "http://chsw.tasmc.corp";
const DEFAULT_MED_ORDER_SECTOR_MODE = "extension";
const USER_DETAILS_ENDPOINT = `${CHAMELEON_BASE_URL}/Chameleon/Include/DataReaderXML.asp`;

// Mirrors Jumper's Common.cs Constants.INEXTDATA_BASE_URL + the "doctor" view
// ShowGecko() navigates to (Chameleon.cs HandlePatientsListOpen). Configurable
// via storage ("modernAppUrl") in case your deployment differs.
const MODERN_APP_URL = "https://inextdata.tasmc.corp/consultationsReportJumper";
const NURSING_JUMPER_URL = "https://inextdata.tasmc.corp/nursingJumper";
const ER_JUMPER_URL = "https://inextdata.tasmc.corp/erJumper";

// Regex patterns copied from Jumper's Common.cs (Constants.*_URL_PATTERN), with
// one deliberate fix: AdmissionDate is captured as "anything up to the next &"
// rather than Common.cs's `[\d/]+`, because the real modern-app URL uses an
// ISO datetime (e.g. "2026-08-31T13:33:00"), which `[\d/]+` would silently
// truncate to just the year — a latent bug in the existing production regex,
// not something we want to reproduce here.
const PATTERNS = {
  patient: /Id=(Z?\w*)&PatientNum=(\d+)&MedicalRecord=(\w*)&RecordChar=(\w*)&Unit=(\d+)&AdmissionDate=([^&]+)/,
  lab: /Chameleon\/LabResults\/LabResultsModal\?Patient=(\d+)/,
  contagiousDisease: /Chameleon\/Navigation\/ContagiousDiseaseWin\.asp\?Patient=(\d+)/,
  medOrder: /FileFoldersRowId=(\d+)&Patient=(\d+)&Medical_Record=(\d+)&Hospital=(\d+)&Unit=(\d+)&Order_ID=(\d+)&User=&Login_Name=([A-Za-z]+)&Category=(\d+)&Sector=/,
  newRecord: /Chameleon\/Asp\/Navigation_OpenNewRecord\/OpenNewRecord\?patient=(\d+)&unit=(\d+)/,
  fluidBalance: /ChameleonNET\/NET\/FluidBalance\/FluidBalanceFrm\.aspx\?Unit=(\d+)&RecordClosed=(\w*)&Record=(\d+)&Patient=(\d+)/,
  ordersForApprove: /ChameleonNET\/NET\/MedicineOrders\/MedOrders4Approve\.aspx\?Hospital=(\d+)&Unit=(\d+)&Patient=(\d+)&Field=1&Medical_Record=(\d+)&Stam=stam/,
  redirectToApplication: /Chameleon\/ApiRedirection\/RedirectToApplication\?ApplicationName=(\w*)&MedicalRecord=(\d*)&Patient=(\d*)&Id_Num=(\w*)/,
  namer: /Chameleon\/Namer\?NamerNo=(\d+)/,
};

function formatDateDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Chameleon's deep link expects dd/MM/yyyy (observed: Start_Date=25%2F07%2F2023).
// The modern app may send AdmissionDate as ISO ("2026-08-31T13:33:00") or
// already as dd/MM/yyyy — normalize either to the format Chameleon expects.
function normalizeToDDMMYYYY(raw) {
  if (!raw) return raw;
  // Already dd/MM/yyyy (or d/M/yyyy)?
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return raw; // give up gracefully, pass through as-is
  return formatDateDDMMYYYY(parsed);
}

// Hospital isn't in PATIENT_URL_PATTERN — inside OpenPatientRecord it's read
// as a bare page-level global, not passed as an arg. We couldn't script-read
// it from the IE-mode tab, so it's a configurable setting (default: the value
// observed during POC, "101"). Adjust via the popup if your deployment
// differs or spans multiple hospitals.
async function getHospitalId() {
  const { hospitalId } = await chrome.storage.local.get("hospitalId");
  return hospitalId || "101";
}

function toAbsoluteChameleonUrl(relativeOrAbsolute) {
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
  return `${CHAMELEON_BASE_URL}/${relativeOrAbsolute.replace(/^\/+/, "")}`;
}

// Translates a modern-app "signal URL" into a routing decision.
//
// CRITICAL (2026-09-09): the pattern selects a MECHANISM, not just a
// destination. An earlier version returned {label, url} for everything and fed
// it all to routeToChameleon (= tabs.update on the Chameleon tab), which was
// wrong for every single non-patient link: it replaced whatever the user was
// looking at, destroying their patient context, and caused an infinite
// intercept loop. Jumper (Gecko.cs -> Chameleon.cs) actually uses three
// different mechanisms, faithfully reproduced here:
//
//   kind: "script"  -> exec JS inside the live Chameleon page's folderFrame via
//                      the BHO. The remaining showModalDialog links. NOT a navigation.
//   kind: "newTab"  -> plain new tab, URL untouched (Chameleon.cs does
//                      window.open(url,'_blank')). These are external apps -
//                      plus מאזן נוזלים / הוראות לתרופות, which Jumper opens as
//                      modals but which are better as tabs here (see below).
//   kind: "namer"   -> not a web page at all; launch the native SAP
//                      NamerButton.exe via the native host.
//
// Returns a routing descriptor, or null if nothing matched.
async function buildChameleonTarget(sourceUrl) {
  let m;

  // NOTE: the "patient" pattern (OpenPatientRecord) is handled earlier in
  // maybeInterceptModernPopup via matchPatientCommand()+routePatientOpenViaBho
  // (the BHO path, preserves full chrome) instead of here.

  if ((m = sourceUrl.match(PATTERNS.lab))) {
    // OpenLabFromUrl: relative-from-/Chameleon URL, plus &Switch=1. Jumper
    // opens this as a centred showModalDialog, but as with ContagiousDisease
    // / FluidBalance the dialog is created inside the Chameleon tab, which is
    // not focused when the link is clicked from the modern app - so it stayed
    // invisible until the user manually switched tabs (2026-09-10). Use a
    // plain new tab instead, same as the other Chameleon links.
    const shortUrl = sourceUrl.substring(sourceUrl.indexOf("/Chameleon")) + "&Switch=1";
    return {
      label: "Lab",
      kind: "newTab",
      url: `${CHAMELEON_BASE_URL}${shortUrl}`,
    };
  }

  if ((m = sourceUrl.match(PATTERNS.contagiousDisease))) {
    // Jumper opens this as a centred showModalDialog, but as with מאזן נוזלים
    // and הוראות לתרופות the dialog is created inside the Chameleon tab, which
    // is not focused when the link is clicked from the modern app - so it stayed
    // invisible until the user manually switched tabs (2026-09-09). Use a plain
    // new tab instead.
    const shortUrl = sourceUrl.substring(sourceUrl.indexOf("/Chameleon"));
    return {
      label: "ContagiousDisease",
      kind: "newTab",
      url: `${CHAMELEON_BASE_URL}${shortUrl}`,
    };
  }

  if ((m = sourceUrl.match(PATTERNS.fluidBalance))) {
    // מאזן נוזלים. Jumper uses showModalDialog (70%x60% centred); that's a
    // same-tab overlay, invisible until the user manually switches to the
    // (unfocused) Chameleon tab - so we don't use it. A plain chrome.tabs
    // newTab has one known cosmetic downside: the page's in-form "close"
    // control calls window.close(), and Trident only allows a script-closed
    // tab to close silently if that tab was itself created via window.open()
    // - a chrome.tabs.create() tab has no such opener relationship, so IE
    // shows "The webpage you are viewing is trying to close the tab"
    // (sometimes after the tab is already gone, at which point the dialog is
    // inert - harmless, just dismiss it).
    //
    // Tried (2026-09-10) switching to window.open() from folderFrame via the
    // BHO instead, which does give the popup a real script opener and does
    // suppress that prompt - but Trident then refocuses that opener (the
    // Chameleon tab) when the popup closes, and 3 separate attempts at
    // overriding that from the extension (opener-based detection, URL-based
    // detection, retry timing) all failed to restore focus to Gecko
    // afterwards. That's a real regression (breaks the "back to Gecko on
    // close" behaviour every other Chameleon link has), so reverted back to
    // chrome.tabs.create and kept the harmless close-prompt. Do not retry the
    // window.open() approach without being able to test IE-mode directly -
    // the refocus appears to happen at the Win32 level inside iexplore.exe,
    // not through anything chrome.tabs/chrome.windows can see or override.
    return {
      label: "FluidBalance",
      kind: "newTab",
      url: toAbsoluteChameleonUrl(m[0]),
    };
  }

  if ((m = sourceUrl.match(PATTERNS.ordersForApprove))) {
    // This is the unconfirmed-orders book icon, not הוראות לתרופות. Jumper
    // opens it as a modal and refreshes HospNursingOrdersForm after close.
    // Use a visible tab instead; the accepted tradeoff is no close-time refresh.
    return {
      label: "OrdersForApprove",
      kind: "newTab",
      url: toAbsoluteChameleonUrl(m[0]),
    };
  }

  if ((m = sourceUrl.match(PATTERNS.medOrder))) {
    // הוראות לתרופות (MedOrdersFrm.aspx). Jumper opens this as a modal, but as
    // with מאזן נוזלים the dialog is hidden inside the unfocused Chameleon tab,
    // so we open a new tab instead (2026-09-09).
    //
    // This is still the one handler that needs a value from the live page: the
    // URL ends in "&Sector=" and must be completed with GetUserSector()'s
    // result, which only exists inside the Chameleon document. Without it
    // Chameleon serves PermissionDenied.aspx, so the sector round-trip is
    // required even for a plain new tab. needsSector is resolved in
    // routeViaNewTab.
    return {
      label: "MedOrder",
      kind: "newTab",
      needsSector: true,
      buildUrl: (sector) => toAbsoluteChameleonUrl(sourceUrl) + sector,
    };
  }

  // --- external applications ------------------------------------------------

  if ((m = sourceUrl.match(PATTERNS.redirectToApplication))) {
    // OpenRedirectFromUrl does window.open(url, '_blank') - Cardio / Hobar are
    // separate applications behind an ApiRedirection hop, NOT Chameleon pages.
    // They must open as their own tab with the URL untouched; routing them into
    // the Chameleon tab both breaks them and blows away the patient view.
    return { label: "RedirectToApplication", kind: "newTab", url: toAbsoluteChameleonUrl(m[0]) };
  }

  if ((m = sourceUrl.match(PATTERNS.namer))) {
    // OpenNamerFromUrl ignores the URL as a URL entirely: it extracts NamerNo
    // and launches \\focus-fs\sap$\NamerButton.exe. There is no page to open.
    return { label: "Namer", kind: "namer", patnum: m[1] };
  }

  // --- still navigation-based ----------------------------------------------

  if ((m = sourceUrl.match(PATTERNS.newRecord))) {
    // OpenNewRecordFromUrl additionally switches the unit in the Heading frame
    // before navigating. Not yet replicated - see plan; kept as a navigation so
    // behaviour is unchanged rather than silently dropped.
    return { label: "NewRecord", kind: "navigate", url: toAbsoluteChameleonUrl(m[0]) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Step 6: BHO bridge for patient-record opens.
//
// Instead of building the record-only deep-link URL (which loses Chameleon's
// list/header chrome — see edge-extension-feasibility.md §7b), patient opens
// are now relayed to the BHO running inside the live Chameleon IE-mode tab
// via a native messaging host (com.jumper.native_host), which forwards a
// pipe-delimited command over a named pipe ("\\.\pipe\JumperBhoBridge") that
// the BHO listens on. The BHO calls OpenPatientRecord(...) directly on the
// patient-list frame's own JS window, in place — same effect as a real user
// click, full chrome preserved (confirmed empirically in the BHO POC).
// ---------------------------------------------------------------------------

const NATIVE_HOST_NAME = "com.jumper.native_host";

function matchPatientCommand(sourceUrl) {
  const m = sourceUrl.match(PATTERNS.patient);
  if (!m) return null;
  const [, idNum, patientNum, medicalRecord, recordChar, unit, admissionDateRaw] = m;
  const today = formatDateDDMMYYYY(new Date());
  return {
    patient: patientNum,
    unit,
    medicalRecord,
    recordChar: recordChar || "0",
    // Not present in the modern app's signal URL — Record_Part/Unit_Name were
    // guessed (0 / empty) in the BHO POC and still rendered the full page
    // correctly. Id_Num defaults to the same hospitalId setting used
    // elsewhere since OpenPatientRecord reads it similarly to Hospital.
    recordPart: "0",
    unitName: "",
    admissionDate: normalizeToDDMMYYYY(admissionDateRaw),
    endDate: today,
    idNum: idNum || "101",
  };
}

// Wraps chrome.runtime.connectNative in a promise: opens a fresh port per
// command (simpler/more robust for a POC than keeping one long-lived port
// alive across service-worker suspends), sends the message, resolves with
// the host's JSON response (or rejects on timeout/disconnect).
function sendNativeCommand(message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { port && port.disconnect(); } catch (e) { /* ignore */ }
      reject(new Error("Native host timed out"));
    }, timeoutMs);

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    port.onMessage.addListener((response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch (e) { /* ignore */ }
      resolve(response);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      reject(new Error(err ? err.message : "Native host disconnected unexpectedly"));
    });

    port.postMessage(message);
  });
}

// ---------------------------------------------------------------------------
// "מחלקות" tab detection -> switch to Gecko tab (simple multi-tab approach,
// no in-place overlay). Mirrors Jumper's HandlePatientsListOpen/ShowGecko
// trigger (Chameleon.cs), but since MV3 service workers can't receive
// unsolicited pushes from the BHO reliably, we poll the BHO's live state via
// the native host's "queryDeptTab" command instead. A single long-lived
// native messaging port is kept open for the polling loop (not one-shot like
// sendNativeCommand above) - this also keeps the service worker alive
// per Chrome's documented long-lived-connection keepalive behavior.
// ---------------------------------------------------------------------------

const DEPT_TAB_POLL_MS = 1500;
let deptTabPort = null;
let deptTabPollTimer = null;
let deptTabLastActive = false;

function ensureDeptTabPort() {
  if (deptTabPort) return deptTabPort;
  try {
    deptTabPort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    appendLog({ event: "deptTab.connectNative.failed", error: String(err) });
    deptTabPort = null;
    return null;
  }

  deptTabPort.onMessage.addListener((response) => {
    if (response && response.ok) {
      handleDeptTabState(!!response.active);
    }
  });

  deptTabPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    appendLog({ event: "deptTab.port.disconnected", error: err ? err.message : null });
    deptTabPort = null; // recreated lazily on the next poll tick
  });

  return deptTabPort;
}

// How the modern app is surfaced when Chameleon's "מחלקות" tab becomes active.
//   "tab"       - focus/open a normal Gecko tab (default, proven)
//   "sidePanel" - show Gecko in the Edge side panel, side by side with the
//                 IE-mode Chameleon tab. The side panel is browser UI, so
//                 Chromium renders it even next to a Trident-rendered tab -
//                 unlike the in-page overlay iframe we abandoned earlier.
const DEFAULT_DISPLAY_MODE = "tab";

async function getDisplayMode() {
  try {
    const { geckoDisplayMode } = await chrome.storage.local.get("geckoDisplayMode");
    return geckoDisplayMode === "sidePanel" ? "sidePanel" : DEFAULT_DISPLAY_MODE;
  } catch {
    return DEFAULT_DISPLAY_MODE;
  }
}

// ---------------------------------------------------------------------------
// Patient open strategy (storage key "patientOpenMode")
//
//   "sharedSession" - default. Uses Enterprise Mode bidirectional cookie
//                     sharing to prime Chameleon's ASP session in Chromium,
//                     then navigates IE mode to corrected Home/Main parameters.
//   "bho"           - pipes OpenPatientRecord to the BHO.
//   "url"           - degraded direct QuickOpen URL fallback.
//
// sharedSession requires these Enterprise Mode Site List entries:
//   <shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
//                  path="/" source-engine="Both" />
//   <shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
//                  path="/" source-engine="Both" />
//   <shared-cookie host="chsw.tasmc.corp" name="_cu"
//                  source-engine="Both" />
//
// The direct "url" mode is DEGRADED, knowingly:
//   - a spurious `מטופל/ת לא נמצא/ה במערכת` alert fires on EVERY open and must
//     be dismissed before the correct page shows. This is a server-side bug in
//     login.asp (it puts the national ID into SearchPatient's `Patient` slot,
//     which expects the PatientNum, and hardcodes PatientID=0). Proven
//     unfixable from the extension - see docs/decisions.md 2026-09-16 and
//     2026-09-17 (H1 disproven: declarativeNetRequest cannot see IE-mode
//     traffic at all, so the request cannot be rewritten in flight).
//   - full Chameleon shell reload instead of an in-place frame swap (up to 10
//     seconds in measured traces), which loses whatever the user had open.
//   - the session-sensitive flow can require another login.
//   - does NOT cover dept-tab detection or sector lookup; those still require
//     the BHO.
const DEFAULT_PATIENT_OPEN_MODE = "sharedSession";

async function getPatientOpenMode() {
  try {
    const { patientOpenMode } = await chrome.storage.local.get("patientOpenMode");
    return ["sharedSession", "bho", "url"].includes(patientOpenMode)
      ? patientOpenMode
      : DEFAULT_PATIENT_OPEN_MODE;
  } catch {
    return DEFAULT_PATIENT_OPEN_MODE;
  }
}

async function setPatientOpenMode(mode) {
  return wrap(async () => {
    const value = ["sharedSession", "bho", "url"].includes(mode)
      ? mode
      : DEFAULT_PATIENT_OPEN_MODE;
    await chrome.storage.local.set({ patientOpenMode: value });
    appendLog({ event: "patientOpenMode.set", mode: value });
    return { patientOpenMode: value };
  });
}

async function getMedOrderSectorMode() {
  try {
    const { medOrderSectorMode } = await chrome.storage.local.get("medOrderSectorMode");
    return ["extension", "native"].includes(medOrderSectorMode)
      ? medOrderSectorMode
      : DEFAULT_MED_ORDER_SECTOR_MODE;
  } catch {
    return DEFAULT_MED_ORDER_SECTOR_MODE;
  }
}

async function setMedOrderSectorMode(mode) {
  return wrap(async () => {
    const value = ["extension", "native"].includes(mode)
      ? mode
      : DEFAULT_MED_ORDER_SECTOR_MODE;
    await chrome.storage.local.set({ medOrderSectorMode: value });
    appendLog({ event: "medOrderSectorMode.set", mode: value });
    return { medOrderSectorMode: value };
  });
}

// Rewrites the dotless signal host to the real FQDN. The dotless form is what
// rules.json rule 1 blocks; the FQDN form is a different requestDomain, so the
// block does not follow the rewrite.
function signalUrlToChameleonUrl(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (u.hostname !== "chsw") return null;
    u.hostname = "chsw.tasmc.corp";
    return u.toString();
  } catch {
    return null;
  }
}

async function handleDeptTabState(active) {
  if (active && !deptTabLastActive) {
    appendLog({ event: "deptTab.transition", to: active });
    // Overlay-iframe approach (BHO SetGeckoOverlayVisible) was tried and
    // reverted - an iframe inside an IE-mode page's DOM is rendered by the
    // legacy Trident engine, not Chromium, so the modern app can't run there
    // (confirmed blank + old IE context menu on right-click). Back to the
    // proven tab-switch approach as the primary/default behavior.
    const mode = await getDisplayMode();
    if (mode === "sidePanel") {
      const opened = await openGeckoSidePanel();
      // chrome.sidePanel.open() requires a user gesture, and this poll tick is
      // not one, so it throws unless the panel is already open. Falling back
      // keeps the transition useful instead of silently doing nothing; the
      // popup's "Open side panel now" button is a real gesture and is what
      // gets the panel open in the first place.
      if (!opened) await bringGeckoTabToFront();
    } else {
      await bringGeckoTabToFront();
    }
  }
  deptTabLastActive = active;
}

// Returns true only if the panel was actually opened. Never throws.
async function openGeckoSidePanel(windowId) {
  try {
    if (!chrome.sidePanel || !chrome.sidePanel.open) {
      appendLog({ event: "sidePanel.unsupported" });
      return false;
    }
    let wid = windowId;
    if (wid === undefined) {
      const win = await chrome.windows.getLastFocused();
      wid = win.id;
    }
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
    await chrome.sidePanel.open({ windowId: wid });
    appendLog({ event: "sidePanel.opened", windowId: wid });
    return true;
  } catch (err) {
    // Almost always "`sidePanel.open()` may only be called in response to a
    // user gesture" - expected on the polling path, so log at info level.
    appendLog({ event: "sidePanel.open.failed", error: String(err) });
    return false;
  }
}

async function setDisplayMode(mode) {
  return wrap(async () => {
    const value = mode === "sidePanel" ? "sidePanel" : "tab";
    await chrome.storage.local.set({ geckoDisplayMode: value });
    // Let the panel be opened by clicking the extension's toolbar icon too,
    // which is the only gesture-free way Chromium will open it for us.
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    } catch { /* not fatal - toolbar icon keeps opening the popup */ }
    appendLog({ event: "displayMode.set", mode: value });
    return { geckoDisplayMode: value };
  });
}

async function bringGeckoTabToFront() {
  try {
    const { modernAppUrl } = await chrome.storage.local.get("modernAppUrl");
    const url = modernAppUrl || MODERN_APP_URL;
    const tabs = await chrome.tabs.query({ url: "https://inextdata.tasmc.corp/*" });
    let geckoTab = tabs[0];
    if (!geckoTab) {
      geckoTab = await chrome.tabs.create({ url });
      appendLog({ event: "deptTab.openedGeckoTab", tabId: geckoTab.id, url });
    } else {
      await chrome.tabs.update(geckoTab.id, { active: true });
      appendLog({ event: "deptTab.focusedGeckoTab", tabId: geckoTab.id });
    }
    await chrome.windows.update(geckoTab.windowId, { focused: true });
  } catch (err) {
    appendLog({ event: "deptTab.bringToFront.failed", error: String(err) });
  }
}

// Finds (or creates) the Chameleon tab and focuses it, without navigating it
// anywhere - used by the side panel's "Chameleon" button.
async function openChameleonTab() {
  const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
  let chameleonTab = tabs[0];
  if (!chameleonTab) {
    chameleonTab = await chrome.tabs.create({ url: `${CHAMELEON_BASE_URL}/Chameleon/Account/LogOn` });
    appendLog({ event: "sidePanel.openedChameleonTab", tabId: chameleonTab.id });
  } else {
    await chrome.tabs.update(chameleonTab.id, { active: true });
    await chrome.windows.update(chameleonTab.windowId, { focused: true });
    appendLog({ event: "sidePanel.focusedChameleonTab", tabId: chameleonTab.id });
  }
  return chameleonTab;
}

// True if `tabUrl` is already inside the `deptUrl` section - either that
// exact page or a subpage of it (e.g. ".../nursingJumper/123?x=1" counts as
// inside ".../nursingJumper", but ".../nursingJumperExtra" does not - checked
// via the next character being one of path/query/fragment/end).
function isInsideGeckoSection(tabUrl, deptUrl) {
  if (!tabUrl || !tabUrl.startsWith(deptUrl)) return false;
  const next = tabUrl.charAt(deptUrl.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

// Finds any existing gecko (inextdata) tab and navigates it to `url`, or
// creates one if none exists - used by the side panel's department buttons.
// Deliberately enforces a SINGLE gecko tab: unlike bringGeckoTabToFront
// (which only focuses the default URL), this one re-navigates whatever gecko
// tab already exists rather than opening a second one for a different path -
// UNLESS it's already showing that section (or a subpage of it), in which
// case it's just focused as-is so in-page state/navigation isn't discarded.
async function openGeckoTabWithUrl(url) {
  const tabs = await chrome.tabs.query({ url: "https://inextdata.tasmc.corp/*" });
  let geckoTab = tabs[0];
  if (!geckoTab) {
    geckoTab = await chrome.tabs.create({ url });
    appendLog({ event: "sidePanel.openedGeckoTab", tabId: geckoTab.id, url });
  } else if (isInsideGeckoSection(geckoTab.url, url)) {
    await chrome.tabs.update(geckoTab.id, { active: true });
    appendLog({ event: "sidePanel.focusedGeckoTab", tabId: geckoTab.id, url: geckoTab.url });
  } else {
    await chrome.tabs.update(geckoTab.id, { url, active: true });
    appendLog({ event: "sidePanel.navigatedGeckoTab", tabId: geckoTab.id, url });
  }
  await chrome.windows.update(geckoTab.windowId, { focused: true });
  return geckoTab;
}

function pollDeptTabOnce() {
  const port = ensureDeptTabPort();
  if (!port) return;
  try {
    port.postMessage({ type: "queryDeptTab" });
  } catch (err) {
    appendLog({ event: "deptTab.postMessage.failed", error: String(err) });
    deptTabPort = null;
  }
}

function startDeptTabPolling() {
  if (deptTabPollTimer) return;
  deptTabPollTimer = setInterval(pollDeptTabOnce, DEPT_TAB_POLL_MS);
  pollDeptTabOnce();
}

startDeptTabPolling();

// Ensures a Chameleon tab exists (opens one to the login page if not), then
// unconditionally sends the patient command via native messaging — the BHO
// invokes OpenPatientRecord immediately if already on the patient list, or
// queues the command and auto-fires it the next time OpenPatientRecord is
// found reachable (i.e. right after the user finishes logging in manually).
async function routePatientOpenViaBho(patientCmd) {
  const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
  let chameleonTab = tabs[0];
  if (!chameleonTab) {
    chameleonTab = await chrome.tabs.create({ url: `${CHAMELEON_BASE_URL}/Chameleon/Account/LogOn` });
    appendLog({ event: "bho.openedLoginTab", tabId: chameleonTab.id });
  } else {
    await chrome.tabs.update(chameleonTab.id, { active: true });
    await chrome.windows.update(chameleonTab.windowId, { focused: true });
  }

  try {
    const response = await sendNativeCommand(patientCmd);
    appendLog({ event: "bho.command.response", patientCmd, response });
    return response;
  } catch (err) {
    appendLog({ event: "bho.command.failed", patientCmd, error: String(err) });
    return { ok: false, error: String(err) };
  }
}

// H5 fallback path. Navigates the existing Chameleon tab (or a new one) to the
// signal URL with the host rewritten to the FQDN. Never touches the BHO or the
// native host, so it still works with bho-poc/ and native-host/ deleted.
// Expect the spurious "patient not found" alert - see DEFAULT_PATIENT_OPEN_MODE.
async function routePatientOpenViaUrl(sourceUrl, patientCmd) {
  const url = signalUrlToChameleonUrl(sourceUrl);
  if (!url) {
    appendLog({ event: "patientOpen.url.badSignalUrl", sourceUrl });
    return { ok: false, error: "signal URL host is not the bare `chsw` form" };
  }

  const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
  const chameleonTab = tabs[0];
  try {
    if (chameleonTab) {
      await chrome.tabs.update(chameleonTab.id, { url, active: true });
      await chrome.windows.update(chameleonTab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    appendLog({ event: "patientOpen.url.navigated", url, patientCmd });
    return { ok: true, mode: "url", url };
  } catch (err) {
    appendLog({ event: "patientOpen.url.failed", url, error: String(err) });
    return { ok: false, error: String(err) };
  }
}

function normalizeSector(value) {
  const sector = String(value || "").trim();
  return /^[A-Za-z0-9._-]{1,32}$/.test(sector) ? sector : null;
}

function decodeXmlAttribute(value) {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

async function lookupSectorViaSharedSession() {
  const paramXml = '<ROOT><Param Name="User" Value="{user}" type="String"/></ROOT>';
  const body = `SP=GetUserDetails&ParamXML=${encodeURIComponent(paramXml)}&WithHeader=0`;
  const response = await fetch(USER_DETAILS_ENDPOINT, {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body,
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `GetUserDetails failed with HTTP ${response.status}.`,
      endpoint: USER_DETAILS_ENDPOINT,
    };
  }

  const responseText = await response.text();
  const userDetails = responseText.match(/<User_Details\b[^>]*\bSector\s*=\s*(["'])(.*?)\1/i);
  const sector = userDetails && normalizeSector(decodeXmlAttribute(userDetails[2]));
  if (!sector) {
    return {
      ok: false,
      error: "GetUserDetails returned no valid User_Details/@Sector value.",
      endpoint: USER_DETAILS_ENDPOINT,
    };
  }

  return {
    ok: true,
    sector,
    evidence: {
      method: "GetUserDetails",
      endpoint: USER_DETAILS_ENDPOINT,
      source: "/Chameleon/Content/Legacy/Include/Record.js GetUserSector()",
    },
  };
}

async function probeMedOrderSector() {
  return wrap(async () => {
    const result = await lookupSectorViaSharedSession();
    appendLog({ event: "medOrder.sectorProbe", ...result });
    return result;
  });
}

async function routePatientOpenViaSharedSession(sourceUrl, patientCmd) {
  const primeUrl = signalUrlToChameleonUrl(sourceUrl);
  if (!primeUrl) {
    appendLog({ event: "patientOpen.sharedSession.badSignalUrl", sourceUrl });
    return { ok: false, error: "signal URL host is not the bare `chsw` form" };
  }

  try {
    const sessionCheck = await fetch(`${CHAMELEON_BASE_URL}/Chameleon/Home/Main`, {
      method: "GET",
      credentials: "include",
      redirect: "manual",
      cache: "no-store",
    });
    if (sessionCheck.status !== 200) {
      throw new Error(
        "Shared Chameleon session unavailable. Check Enterprise Mode shared-cookie policy and log in."
      );
    }

    const primeResponse = await fetch(primeUrl, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
    });
    if (!primeResponse.ok) {
      throw new Error(`QuickOpen session prime failed with HTTP ${primeResponse.status}`);
    }

    const { hospitalId = "101" } = await chrome.storage.local.get("hospitalId");
    const correctedUrl = new URL(`${CHAMELEON_BASE_URL}/Chameleon/Home/Main`);
    correctedUrl.search = new URLSearchParams({
      Patient: patientCmd.patient,
      PatientID: patientCmd.patient,
      idnum: patientCmd.idNum,
      Hospital: hospitalId,
      QuickOpen: "1",
      pReloginByUserRecord: "0",
      IsPatientBlockForMultiUserUpdate: "False",
      ReopneInMedicalReocrd: "False",
      IsLogonRecordOpen: "False",
    }).toString();

    const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
    const chameleonTab = tabs[0];
    if (!chameleonTab) {
      await chrome.tabs.create({ url: `${CHAMELEON_BASE_URL}/Chameleon/Account/LogOn` });
      throw new Error("Opened Chameleon login. Log in once, then retry the patient.");
    }

    await chrome.tabs.update(chameleonTab.id, {
      url: correctedUrl.toString(),
      active: true,
    });
    await chrome.windows.update(chameleonTab.windowId, { focused: true });
    appendLog({
      event: "patientOpen.sharedSession.navigated",
      tabId: chameleonTab.id,
      primeStatus: primeResponse.status,
      correctedUrl: correctedUrl.toString(),
      patient: patientCmd.patient,
      medicalRecord: patientCmd.medicalRecord,
      unit: patientCmd.unit,
    });
    return {
      ok: true,
      mode: "sharedSession",
      tabId: chameleonTab.id,
      correctedUrl: correctedUrl.toString(),
    };
  } catch (err) {
    appendLog({
      event: "patientOpen.sharedSession.failed",
      sourceUrl,
      error: String(err),
    });
    return { ok: false, error: String(err) };
  }
}

// Executes a routing decision from buildChameleonTarget. Each branch mirrors the
// corresponding Chameleon.cs handler - see that function's comment for why the
// mechanism, not just the URL, matters.
async function routeToChameleon(target) {
  switch (target.kind) {
    case "script":
      return routeViaScript(target);
    case "newTab":
      return routeViaNewTab(target);
    case "namer":
      return routeViaNamer(target);
    case "navigate":
    default:
      return routeViaNavigation(target);
  }
}

// showModalDialog family: run the script inside the live Chameleon page's
// folderFrame via the BHO. Does NOT navigate or focus anything - the dialog
// appears over the page the user is already on, exactly as in Jumper.
async function routeViaScript(target) {
  const script = target.script;
  const fallbackUrl = target.fallbackUrl;

  const response = await sendNativeCommand({ type: "execScript", frame: "folderFrame", script });
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "script", response });

  // The modal is the preferred UX, but it depends on showModalDialog being
  // present in the Chameleon frame's document mode - and in Edge IE mode it
  // may not be. Before this fallback existed, that failure was completely
  // silent: the popup tab had already been removed, the script threw inside a
  // setTimeout where nothing could observe it, and the user saw the link
  // simply do nothing. Degrading to the plain new tab restores the behaviour
  // these links had before the modal rework.
  if ((!response || response.ok !== true) && fallbackUrl) {
    appendLog({
      event: "bridge.scriptFallback",
      label: target.label,
      status: response && response.status,
      url: fallbackUrl,
    });
    return routeViaNewTab({ label: target.label + "(fallback)", url: fallbackUrl });
  }

  return response;
}

// window.open(url, '_blank') equivalent: a separate application, opened as its
// own tab with the URL untouched. Must never reuse the Chameleon tab.
async function routeViaNewTab(target) {
  let url = target.url;

  // MedOrder only: the URL is incomplete without GetUserSector() from the live
  // Chameleon document. Opening it as-is yields PermissionDenied.aspx.
  if (target.needsSector) {
    const mode = await getMedOrderSectorMode();
    let sector = null;
    let response;
    if (mode === "extension") {
      response = await lookupSectorViaSharedSession();
      sector = response.ok ? response.sector : null;
      appendLog({ event: "bridge.sectorLookup", label: target.label, mode, ...response });
    } else {
      response = await sendNativeCommand({ type: "querySector" });
      sector = response && response.ok ? response.sector : null;
      appendLog({ event: "bridge.sectorLookup", label: target.label, mode, response });
    }
    if (sector === null || sector === undefined || sector === "") {
      appendLog({ event: "bridge.sectorUnavailable", label: target.label, mode, response });
      return { ok: false, error: `GetUserSector() unavailable in ${mode} mode` };
    }
    url = target.buildUrl(encodeURIComponent(sector));
  }

  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "newTab", url, tabId: tab.id });
  return tab;
}

// Namer: launch the native SAP app. Nothing is opened in the browser at all.
async function routeViaNamer(target) {
  const response = await sendNativeCommand({ type: "launchNamer", patnum: target.patnum }, 15000);
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "namer", patnum: target.patnum, response });
  return response;
}

// Finds (or creates) the Chameleon tab and navigates + focuses it.
async function routeViaNavigation(target) {
  const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
  let chameleonTab = tabs[0];
  if (!chameleonTab) {
    chameleonTab = await chrome.tabs.create({ url: target.url });
  } else {
    await chrome.tabs.update(chameleonTab.id, { url: target.url });
  }
  await chrome.tabs.update(chameleonTab.id, { active: true });
  await chrome.windows.update(chameleonTab.windowId, { focused: true });
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "navigate", url: target.url, tabId: chameleonTab.id });
  return chameleonTab;
}

// Tabs we've already dispatched, so we don't double-handle the same
// window.open() popup if both onCreated and onUpdated fire with a URL.
const handledPopupTabIds = new Set();

// ---------------------------------------------------------------------------
// Tabs that are GENUINE window.open() popups, and therefore the only tabs we
// are ever allowed to intercept.
//
// This guard exists to fix an infinite tab-churn loop that hung the whole
// browser (2026-09-09). The interception entry points below include
// webNavigation.onBeforeNavigate and tabs.onUpdated, which fire for EVERY
// navigation in EVERY tab — including the Chameleon tab that routeToChameleon
// itself has just navigated. Because routeToChameleon navigates to a URL that
// still contains the very pattern that matched (e.g. FluidBalanceFrm.aspx?...),
// the sequence ran away:
//
//   window.open(signal) -> intercept -> remove popup -> routeToChameleon
//     -> tabs.update(chameleonTab, url)
//     -> onBeforeNavigate/onUpdated fire FOR THE CHAMELEON TAB with that url
//     -> pattern matches again; the Chameleon tab has a different tab id so
//        handledPopupTabIds doesn't stop it
//     -> tabs.remove(chameleonTab)   <-- destroys the tab we just routed into
//     -> routeToChameleon finds no Chameleon tab, so tabs.create(url)
//     -> onCreated fires, matches again, new tab id again -> remove -> create...
//
// ...i.e. unbounded create/remove churn until Edge stops responding. It only
// affected the links whose route target keeps matching its own pattern
// (מאזן נוזלים / הוראות לתרופות / Cardio / Namer and friends); patient opens
// were immune because routePatientOpenViaBho never navigates a tab to a
// matching URL, it only pipes a command to the BHO.
//
// This mirrors what the real Jumper app does: Gecko.cs matches these patterns
// ONLY inside WebView_NewWindowRequested — a genuine popup request from the
// modern app's WebView. It never re-inspects the Chameleon browser's own
// navigations, so it can't feed its own output back into its own input.
// ---------------------------------------------------------------------------
const popupCandidateTabIds = new Set();
const POPUP_CANDIDATE_TTL_MS = 15000;

function markPopupCandidate(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return;
  popupCandidateTabIds.add(tabId);
  // Don't leak ids for popups that never resolve to a signal URL.
  setTimeout(() => popupCandidateTabIds.delete(tabId), POPUP_CANDIDATE_TTL_MS);
}

async function maybeInterceptModernPopup(tabId, url) {
  if (!url || handledPopupTabIds.has(tabId)) return false;

  // Only ever act on a real popup. Any tab we navigate ourselves (above all
  // the Chameleon tab) is never a candidate, which is what breaks the loop.
  if (!popupCandidateTabIds.has(tabId)) return false;

  // Patient records take the new BHO path (preserves full chrome); every
  // other signal URL pattern keeps the Phase-2 record-only deep-link flow.
  const patientCmd = matchPatientCommand(url);
  if (patientCmd) {
    handledPopupTabIds.add(tabId);
    const patientOpenMode = await getPatientOpenMode();
    appendLog({
      event: "bridge.intercepted",
      tabId,
      sourceUrl: url,
      label:
        patientOpenMode === "sharedSession"
          ? "OpenPatientRecord(shared session)"
          : patientOpenMode === "url"
            ? "OpenPatientRecord(URL fallback)"
            : "OpenPatientRecord(BHO)"
    });
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      // tab may already be gone
    }
    if (patientOpenMode === "sharedSession") {
      await routePatientOpenViaSharedSession(url, patientCmd);
    } else if (patientOpenMode === "url") {
      await routePatientOpenViaUrl(url, patientCmd);
    } else {
      await routePatientOpenViaBho(patientCmd);
    }
    return true;
  }

  const target = await buildChameleonTarget(url);
  if (!target) return false;

  handledPopupTabIds.add(tabId);
  appendLog({ event: "bridge.intercepted", tabId, sourceUrl: url, label: target.label });

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // tab may already be gone
  }
  await routeToChameleon(target);
  return true;
}

chrome.tabs.onCreated.addListener((tab) => {
  // A tab with an opener was opened by page script (window.open / target=_blank);
  // tabs the extension itself creates have no openerTabId and must NOT become
  // candidates, or routeToChameleon's own tab would feed back into the loop.
  //
  // (2026-09-10: FluidBalance briefly used a folderFrame window.open() here,
  // which meant a "modern app popup" could also be one WE triggered with the
  // Chameleon tab as opener - needed extra opener-origin filtering at the
  // time. Reverted back to chrome.tabs.create for FluidBalance (see §4/§5 in
  // the handoff doc), so no current route produces an opener-based popup,
  // and this listener is back to its original simple form. If a future route
  // does the same thing again, re-add that filtering rather than assuming
  // every openerTabId means "genuine modern-app popup".)
  if (tab.openerTabId !== undefined && tab.openerTabId !== null) {
    markPopupCandidate(tab.id);
  }
  if (tab.url || tab.pendingUrl) {
    maybeInterceptModernPopup(tab.id, tab.url || tab.pendingUrl);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Guarded by popupCandidateTabIds inside - this fires for the Chameleon tab
  // we navigate ourselves, which must never be intercepted.
  if (changeInfo.url) {
    maybeInterceptModernPopup(tabId, changeInfo.url);
  }
});

// Manual test hook for the popup UI — simulates the modern app calling
// window.open(signalUrl) without needing to be on the real inextdata site.
async function simulateModernPopup(signalUrl) {
  return wrap(async () => {
    const tab = await chrome.tabs.create({ url: signalUrl, active: false });
    // Extension-created tabs have no openerTabId, so they aren't popup
    // candidates automatically - mark it explicitly, otherwise this test hook
    // would be silently ignored by the interception guard.
    markPopupCandidate(tab.id);
    maybeInterceptModernPopup(tab.id, signalUrl);
    // The real interception listeners above do the actual work; this just
    // reports what will happen so the popup can show immediate feedback too.
    return { createdTabId: tab.id, note: "onCreated/onUpdated listeners will intercept and route this automatically" };
  });
}

async function setHospitalId(hospitalId) {
  return wrap(async () => {
    await chrome.storage.local.set({ hospitalId });
    return { hospitalId };
  });
}

async function getSettings() {
  return wrap(async () => {
    const { hospitalId, geckoDisplayMode, patientOpenMode, medOrderSectorMode } =
      await chrome.storage.local.get([
        "hospitalId",
        "geckoDisplayMode",
        "patientOpenMode",
        "medOrderSectorMode",
      ]);
    return {
      hospitalId: hospitalId || "101",
      geckoDisplayMode: geckoDisplayMode === "sidePanel" ? "sidePanel" : "tab",
      patientOpenMode: ["sharedSession", "bho", "url"].includes(patientOpenMode)
        ? patientOpenMode
        : DEFAULT_PATIENT_OPEN_MODE,
      medOrderSectorMode: ["extension", "native"].includes(medOrderSectorMode)
        ? medOrderSectorMode
        : DEFAULT_MED_ORDER_SECTOR_MODE,
    };
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "getNavLog": {
        const { navLog = [] } = await chrome.storage.local.get("navLog");
        sendResponse({ ok: true, result: navLog });
        break;
      }
      case "clearNavLog":
        await chrome.storage.local.set({ navLog: [] });
        sendResponse({ ok: true });
        break;
      case "simulateModernPopup":
        sendResponse(await simulateModernPopup(msg.url));
        break;
      case "setHospitalId":
        sendResponse(await setHospitalId(msg.hospitalId));
        break;
      case "getSettings":
        sendResponse(await getSettings());
        break;
      case "setDisplayMode":
        sendResponse(await setDisplayMode(msg.mode));
        break;
      case "setPatientOpenMode":
        sendResponse(await setPatientOpenMode(msg.mode));
        break;
      case "setMedOrderSectorMode":
        sendResponse(await setMedOrderSectorMode(msg.mode));
        break;
      case "probeMedOrderSector":
        sendResponse(await probeMedOrderSector());
        break;
      case "openChameleonTab":
        sendResponse(await wrap(() => openChameleonTab()));
        break;
      case "openGeckoDept": {
        const deptUrls = {
          consultations: MODERN_APP_URL,
          nursing: NURSING_JUMPER_URL,
          er: ER_JUMPER_URL,
        };
        const url = deptUrls[msg.dept];
        if (!url) {
          sendResponse({ ok: false, error: "unknown dept: " + msg.dept });
        } else {
          sendResponse(await wrap(() => openGeckoTabWithUrl(url)));
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type: " + msg.type });
    }
  })();
  return true; // keep the message channel open for the async response
});

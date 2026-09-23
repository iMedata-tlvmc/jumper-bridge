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

// The persisted navLog is surfaced verbatim on the Diagnostics page and is
// the first thing anyone (including us) copies into a support ticket, so
// patient identifiers are masked before anything is logged - keep the last 3
// characters for troubleshooting, mask the rest.
function maskIdentifier(value) {
  if (value === null || value === undefined) return value;
  const str = String(value);
  return str.length <= 3 ? "*".repeat(str.length) : "*".repeat(str.length - 3) + str.slice(-3);
}

// Signal/deep-link URLs carry patient identifiers as query params
// (Patient/PatientID/PatientNum/idnum/MedicalRecord/Unit). Mask just those
// values so the rest of the URL (host, path, other flags) stays readable for
// debugging.
const PHI_URL_PARAMS = ["Patient", "PatientID", "PatientNum", "MedicalRecord", "idnum", "Unit"];
function redactUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    for (const param of PHI_URL_PARAMS) {
      if (u.searchParams.has(param)) {
        u.searchParams.set(param, maskIdentifier(u.searchParams.get(param)));
      }
    }
    return u.toString();
  } catch {
    return url;
  }
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

async function getNormalBrowserWindow() {
  try {
    const lastFocused = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (Number.isInteger(lastFocused.id) && lastFocused.type === "normal") {
      return lastFocused;
    }
  } catch {
    // Fall back to any normal window if Edge has no last-focused normal window.
  }

  const normalWindows = await chrome.windows.getAll({
    windowTypes: ["normal"],
  });
  return normalWindows[0] || null;
}

async function createTabInNormalWindow({ url, active = true }) {
  const normalWindow = await getNormalBrowserWindow();
  if (!normalWindow) {
    const createdWindow = await chrome.windows.create({
      url,
      type: "normal",
      focused: active,
    });
    const createdTab = createdWindow.tabs?.[0];
    if (!createdTab) {
      throw new Error("Edge did not return a tab for the new browser window.");
    }
    return createdTab;
  }

  const tab = await chrome.tabs.create({
    url,
    active,
    windowId: normalWindow.id,
  });
  if (active) {
    await chrome.windows.update(normalWindow.id, { focused: true });
  }
  return tab;
}

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
// Gecko pages are intercepted at document start, before a signal navigation
// exists. The declarativeNetRequest rule and popup listeners remain defensive
// fallbacks for stale pages that were open before an extension reload.
// ---------------------------------------------------------------------------

const CHAMELEON_BASE_URL = "http://chsw.tasmc.corp";
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

  // NOTE: the patient pattern is handled earlier through the extension-only
  // shared-session route.

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
    // Creating this from inside the IE-mode page suppresses the prompt, but
    // Trident then refocuses Chameleon when the popup closes. Keep the harmless
    // close prompt rather than breaking the normal return-to-Gecko behavior.
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
// Native messaging remains only for Namer launch.
// ---------------------------------------------------------------------------

const NATIVE_HOST_NAME = "com.jumper.native_host";

function matchPatientSignal(sourceUrl) {
  const m = sourceUrl.match(PATTERNS.patient);
  if (!m) return null;
  const [, idNum, patientNum, medicalRecord, , unit] = m;
  return {
    patient: patientNum,
    unit,
    medicalRecord,
    idNum: idNum || "101",
  };
}

// Opens a short-lived native messaging port to launch Namer.
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
// Patient opening uses Enterprise Mode bidirectional cookie sharing to prime
// Chameleon's ASP session in Chromium, then navigates IE mode to corrected
// Home/Main parameters. It requires these Enterprise Mode Site List entries:
//   <shared-cookie host="chsw.tasmc.corp" name=".CHAMELEONAUTH"
//                  path="/" source-engine="Both" />
//   <shared-cookie host="chsw.tasmc.corp" name="ASP.NET_SessionId"
//                  path="/" source-engine="Both" />
//   <shared-cookie host="chsw.tasmc.corp" name="_cu"
//                  source-engine="Both" />
// Rewrites the dotless signal host to the real FQDN. The dotless form is what
// rules.json rule 1 blocks; the FQDN form is a different requestDomain, so the
// block does not follow the rewrite.
function signalUrlToChameleonUrl(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (u.hostname === "chsw") {
      u.hostname = "chsw.tasmc.corp";
    } else if (u.hostname !== "chsw.tasmc.corp") {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

// Finds (or creates) the Chameleon tab and focuses it, without navigating it
// anywhere - used by the popup and side panel "Chameleon" buttons.
async function openChameleonTab() {
  const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
  let chameleonTab = tabs[0];
  if (!chameleonTab) {
    chameleonTab = await createTabInNormalWindow({
      url: `${CHAMELEON_BASE_URL}/Chameleon/Account/LogOn`,
    });
    appendLog({ event: "manualNav.openedChameleonTab", tabId: chameleonTab.id });
  } else {
    await chrome.tabs.update(chameleonTab.id, { active: true });
    await chrome.windows.update(chameleonTab.windowId, { focused: true });
    appendLog({ event: "manualNav.focusedChameleonTab", tabId: chameleonTab.id });
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
// creates one if none exists - used by the popup and side panel department buttons.
// Deliberately enforces a single Gecko tab. It re-navigates an existing Gecko
// tab unless that tab is already showing the requested section or a subpage.
async function openGeckoTabWithUrl(url) {
  const tabs = await chrome.tabs.query({ url: "https://inextdata.tasmc.corp/*" });
  let geckoTab = tabs[0];
  if (!geckoTab) {
    geckoTab = await createTabInNormalWindow({ url });
    appendLog({ event: "manualNav.openedGeckoTab", tabId: geckoTab.id, url });
  } else if (isInsideGeckoSection(geckoTab.url, url)) {
    await chrome.tabs.update(geckoTab.id, { active: true });
    appendLog({ event: "manualNav.focusedGeckoTab", tabId: geckoTab.id, url: geckoTab.url });
  } else {
    await chrome.tabs.update(geckoTab.id, { url, active: true });
    appendLog({ event: "manualNav.navigatedGeckoTab", tabId: geckoTab.id, url });
  }
  await chrome.windows.update(geckoTab.windowId, { focused: true });
  return geckoTab;
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

async function routePatientOpenViaSharedSession(sourceUrl, patient) {
  const primeUrl = signalUrlToChameleonUrl(sourceUrl);
  if (!primeUrl) {
    appendLog({ event: "patientOpen.sharedSession.badSignalUrl", sourceUrl: redactUrl(sourceUrl) });
    return { ok: false, error: "signal URL host is not an approved Chameleon host" };
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
      Patient: patient.patient,
      PatientID: patient.patient,
      idnum: patient.idNum,
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
      await createTabInNormalWindow({
        url: `${CHAMELEON_BASE_URL}/Chameleon/Account/LogOn`,
      });
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
      correctedUrl: redactUrl(correctedUrl.toString()),
      patient: maskIdentifier(patient.patient),
      medicalRecord: maskIdentifier(patient.medicalRecord),
      unit: maskIdentifier(patient.unit),
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
      sourceUrl: redactUrl(sourceUrl),
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
    case "newTab":
      return routeViaNewTab(target);
    case "namer":
      return routeViaNamer(target);
    case "navigate":
    default:
      return routeViaNavigation(target);
  }
}

// window.open(url, '_blank') equivalent: a separate application, opened as its
// own tab with the URL untouched. Must never reuse the Chameleon tab.
async function routeViaNewTab(target) {
  let url = target.url;

  // MedOrder only: the URL is incomplete without GetUserSector() from the live
  // Chameleon document. Opening it as-is yields PermissionDenied.aspx.
  if (target.needsSector) {
    const response = await lookupSectorViaSharedSession();
    const sector = response.ok ? response.sector : null;
    appendLog({ event: "bridge.sectorLookup", label: target.label, mode: "extension", ...response });
    if (sector === null || sector === undefined || sector === "") {
      appendLog({ event: "bridge.sectorUnavailable", label: target.label, response });
      return { ok: false, error: "GetUserSector() unavailable from the shared session" };
    }
    url = target.buildUrl(encodeURIComponent(sector));
  }

  const tab = await createTabInNormalWindow({ url });
  await chrome.windows.update(tab.windowId, { focused: true });
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "newTab", url: redactUrl(url), tabId: tab.id });
  return tab;
}

// Namer: launch the native SAP app. Nothing is opened in the browser at all.
async function routeViaNamer(target) {
  const response = await sendNativeCommand({ type: "launchNamer", patnum: target.patnum }, 15000);
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "namer", patnum: maskIdentifier(target.patnum), response });
  return response;
}

// Finds (or creates) the Chameleon tab and navigates + focuses it.
async function routeViaNavigation(target) {
  const tabs = await chrome.tabs.query({ url: `${CHAMELEON_BASE_URL}/*` });
  let chameleonTab = tabs[0];
  if (!chameleonTab) {
    chameleonTab = await createTabInNormalWindow({ url: target.url });
  } else {
    await chrome.tabs.update(chameleonTab.id, { url: target.url });
  }
  await chrome.tabs.update(chameleonTab.id, { active: true });
  await chrome.windows.update(chameleonTab.windowId, { focused: true });
  appendLog({ event: "bridge.routed", label: target.label, mechanism: "navigate", url: redactUrl(target.url), tabId: chameleonTab.id });
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
// (מאזן נוזלים / הוראות לתרופות / Cardio / Namer and friends). Patient opens
// are also immune because the shared-session route navigates to corrected
// Home/Main parameters, which do not match the signal pattern.
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

async function routeModernSignal(url, context = {}) {
  const { source = "popup", tabId = null, closeTab = false } = context;
  const patient = matchPatientSignal(url);
  if (patient) {
    if (typeof tabId === "number") handledPopupTabIds.add(tabId);
    appendLog({
      event: "bridge.intercepted",
      tabId,
      source,
      sourceUrl: redactUrl(url),
      label: "Patient(shared session)"
    });
    if (closeTab && typeof tabId === "number") {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        // tab may already be gone
      }
    }
    await routePatientOpenViaSharedSession(url, patient);
    return true;
  }

  const target = await buildChameleonTarget(url);
  if (!target) return false;

  if (typeof tabId === "number") handledPopupTabIds.add(tabId);
  appendLog({ event: "bridge.intercepted", tabId, source, sourceUrl: redactUrl(url), label: target.label });

  if (closeTab && typeof tabId === "number") {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      // tab may already be gone
    }
  }
  await routeToChameleon(target);
  return true;
}

async function maybeInterceptModernPopup(tabId, url) {
  if (!url || handledPopupTabIds.has(tabId)) return false;

  // Only ever act on a real popup. Any tab we navigate ourselves (above all
  // the Chameleon tab) is never a candidate, which is what breaks the loop.
  if (!popupCandidateTabIds.has(tabId)) return false;

  return routeModernSignal(url, { source: "popupFallback", tabId, closeTab: true });
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
    const tab = await createTabInNormalWindow({ url: signalUrl, active: false });
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
    const { hospitalId } = await chrome.storage.local.get("hospitalId");
    return {
      hospitalId: hospitalId || "101",
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
      case "routeModernSignal": {
        const senderUrl = sender.url || "";
        const allowedSender =
          senderUrl.startsWith("https://inextdata.tasmc.corp/") ||
          senderUrl.startsWith("https://dev-inextdata.tasmc.corp/") ||
          senderUrl.startsWith("http://localhost/") ||
          senderUrl.startsWith("http://127.0.0.1/");
        if (!allowedSender) {
          sendResponse({ ok: false, error: "untrusted signal sender" });
          break;
        }
        sendResponse(await wrap(() =>
          routeModernSignal(msg.url, { source: "contentScript" })
        ));
        break;
      }
      case "setHospitalId":
        sendResponse(await setHospitalId(msg.hospitalId));
        break;
      case "getSettings":
        sendResponse(await getSettings());
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

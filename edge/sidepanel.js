// sidepanel.js — hosts the modern app inside the Edge side panel.
//
// WHY AN IFRAME: chrome.sidePanel can only point at an extension-relative
// path, so a remote URL cannot be the panel itself; it has to be framed.
//
// WHY THIS WORKS AT ALL: an earlier attempt injected the modern app as an
// iframe into Chameleon's OWN document (BHO SetGeckoOverlayVisible) and it
// rendered blank - anything inside an IE-mode page is drawn by Trident, not
// Chromium. The side panel is browser UI rather than page content, so it is
// rendered by Chromium even while the tab beside it is in IE mode. That is
// what makes side-by-side possible without a native WebView2 control.

const DEFAULT_MODERN_APP_URL = "https://inextdata.tasmc.corp/consultationsReportJumper";

const frame = document.getElementById("frame");
const errorBox = document.getElementById("error");

async function resolveUrl() {
  try {
    const { modernAppUrl } = await chrome.storage.local.get("modernAppUrl");
    return modernAppUrl || DEFAULT_MODERN_APP_URL;
  } catch {
    return DEFAULT_MODERN_APP_URL;
  }
}

function showError() {
  frame.style.display = "none";
  errorBox.style.display = "block";
}

async function load() {
  const url = await resolveUrl();

  // A refused frame fires onload with an inaccessible about:blank-ish document
  // in some cases and no event at all in others, so use both a load check and
  // a timeout rather than trusting either alone.
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) showError();
  }, 8000);

  frame.addEventListener("load", () => {
    settled = true;
    clearTimeout(timer);
  });

  frame.addEventListener("error", () => {
    settled = true;
    clearTimeout(timer);
    showError();
  });

  frame.src = url;
}

document.getElementById("btnOpenTab").addEventListener("click", async () => {
  const url = await resolveUrl();
  await chrome.tabs.create({ url });
});

// Top toolbar: Chameleon focuses/opens the IE-mode tab; the three gecko
// buttons all target the SAME single gecko tab (re-navigating it if it
// already exists) rather than opening a separate tab per department -
// resolution of the URL for each dept lives in background.js so there is
// one source of truth for the gecko URLs.
document.getElementById("btnChameleon").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "openChameleonTab" });
});
document.getElementById("btnConsultations").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "openGeckoDept", dept: "consultations" });
});
document.getElementById("btnNursing").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "openGeckoDept", dept: "nursing" });
});
document.getElementById("btnEr").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "openGeckoDept", dept: "er" });
});

// Preview toggle: when hidden, only the button row is shown so the panel can
// be used purely as a launcher. Persisted so it survives panel close/reopen.
const toggleBtn = document.getElementById("btnToggleFrame");

function applyFrameHidden(hidden) {
  document.body.classList.toggle("frame-hidden", hidden);
  toggleBtn.textContent = hidden ? "הצג תצוגה מקדימה" : "הסתר תצוגה מקדימה";
  toggleBtn.title = hidden ? "Show preview" : "Hide preview";
}

chrome.storage.local.get("sidePanelFrameHidden").then(({ sidePanelFrameHidden }) => {
  applyFrameHidden(!!sidePanelFrameHidden);
});

toggleBtn.addEventListener("click", async () => {
  const hidden = !document.body.classList.contains("frame-hidden");
  applyFrameHidden(hidden);
  await chrome.storage.local.set({ sidePanelFrameHidden: hidden });
});

load();

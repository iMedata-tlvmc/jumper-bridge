// popup.js — wires the probe buttons to background.js via chrome.runtime.sendMessage
// and prints results (or errors) to the output panel.

const output = document.getElementById("output");

function log(label, data) {
  const line = `\n--- ${label} @ ${new Date().toLocaleTimeString()} ---\n${JSON.stringify(data, null, 2)}\n`;
  output.textContent += line;
  output.scrollTop = output.scrollHeight;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

document.getElementById("btnRefreshLog").addEventListener("click", async () => {
  const res = await send({ type: "getNavLog" });
  log("passive event log", res);
});

document.getElementById("btnClearLog").addEventListener("click", async () => {
  await send({ type: "clearNavLog" });
  log("clearNavLog", "done");
});

// --- Phase 2 bridge ---------------------------------------------------------

const SIGNAL_URL_TEMPLATES = {
  // Placeholder values — replace with real ones before simulating against
  // your environment. The "patient" template matches the REAL modern-app URL
  // format confirmed by the user (ISO AdmissionDate, login.asp?quickOpen=1
  // path) — note this differs from Common.cs's PATIENT_URL_PATTERN, which
  // uses a stricter (and buggy) date-only regex. See background.js comments.
  patient:
    "http://chsw/chameleon/login.asp?quickOpen=1&Id=Z1234567&PatientNum=9001674042&MedicalRecord=11152014&RecordChar=0&Unit=111528&AdmissionDate=2026-08-31T13:33:00",
  lab: "https://inextdata.tasmc.corp/redirect?Chameleon/LabResults/LabResultsModal?Patient=9001674042",
  newRecord:
    "https://inextdata.tasmc.corp/redirect?Chameleon/Asp/Navigation_OpenNewRecord/OpenNewRecord?patient=9001674042&unit=831000",
  fluidBalance:
    "https://inextdata.tasmc.corp/redirect?ChameleonNET/NET/FluidBalance/FluidBalanceFrm.aspx?Unit=831000&RecordClosed=0&Record=11152014&Patient=9001674042",
};

const simSelect = document.getElementById("simSelect");
const simUrl = document.getElementById("simUrl");

function refreshSimUrlPlaceholder() {
  simUrl.value = SIGNAL_URL_TEMPLATES[simSelect.value] || "";
}
simSelect.addEventListener("change", refreshSimUrlPlaceholder);
refreshSimUrlPlaceholder();

document.getElementById("btnSimulate").addEventListener("click", async () => {
  const url = simUrl.value;
  if (!url) return log("ERROR", "Enter a signal URL first");
  const res = await send({ type: "simulateModernPopup", url });
  log(`simulateModernPopup("${url}")`, res);
  log("hint", "Check the Chameleon tab now, and/or Refresh log (step 1) for bridge.intercepted / bridge.routed events");
});

document.getElementById("btnSaveHospital").addEventListener("click", async () => {
  const hospitalId = document.getElementById("hospitalId").value;
  const res = await send({ type: "setHospitalId", hospitalId });
  log(`setHospitalId("${hospitalId}")`, res);
});

document.getElementById("displayMode").addEventListener("change", async (e) => {
  const mode = e.target.value;
  const res = await send({ type: "setDisplayMode", mode });
  log(`setDisplayMode("${mode}")`, res);
});

document.getElementById("btnOpenSidePanel").addEventListener("click", async () => {
  // Called DIRECTLY here rather than round-tripping through background.js:
  // chrome.sidePanel.open() requires a user gesture and the gesture does NOT
  // survive a chrome.runtime.sendMessage hop into the service worker, so the
  // background copy of this call only ever succeeds when the panel is already
  // open. This click is the real gesture, so do the work in the popup.
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
    await chrome.sidePanel.open({ windowId: win.id });
    log("sidePanel.open()", { ok: true, windowId: win.id });
    // Opening it implies the user wants it, so make it the active mode too.
    await send({ type: "setDisplayMode", mode: "sidePanel" });
    document.getElementById("displayMode").value = "sidePanel";
  } catch (err) {
    log("sidePanel.open() FAILED", { ok: false, error: String(err) });
  }
});

(async () => {
  const res = await send({ type: "getSettings" });
  if (res && res.ok && res.result) {
    if (res.result.hospitalId) {
      document.getElementById("hospitalId").value = res.result.hospitalId;
    }
    if (res.result.geckoDisplayMode) {
      document.getElementById("displayMode").value = res.result.geckoDisplayMode;
    }
  }
})();

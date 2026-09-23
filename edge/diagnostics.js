const output = document.getElementById("output");

function log(label, data) {
  const line = `\n--- ${label} @ ${new Date().toLocaleTimeString()} ---\n${JSON.stringify(data, null, 2)}\n`;
  output.textContent += line;
  output.scrollTop = output.scrollHeight;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

document.getElementById("btnRefreshLog").addEventListener("click", async () => {
  const response = await send({ type: "getNavLog" });
  log("passive event log", response);
});

document.getElementById("btnClearLog").addEventListener("click", async () => {
  await send({ type: "clearNavLog" });
  log("clearNavLog", "done");
});

const SIGNAL_URL_TEMPLATES = {
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
  if (!url) {
    log("ERROR", "Enter a signal URL first");
    return;
  }
  const response = await send({ type: "simulateModernPopup", url });
  log(`simulateModernPopup("${url}")`, response);
});

document.getElementById("btnSaveHospital").addEventListener("click", async () => {
  const hospitalId = document.getElementById("hospitalId").value;
  const response = await send({ type: "setHospitalId", hospitalId });
  log(`setHospitalId("${hospitalId}")`, response);
});

document.getElementById("btnProbeMedOrderSector").addEventListener("click", async () => {
  const response = await send({ type: "probeMedOrderSector" });
  log("probeMedOrderSector", response);
});

(async () => {
  const response = await send({ type: "getSettings" });
  if (response?.ok && response.result?.hospitalId) {
    document.getElementById("hospitalId").value = response.result.hospitalId;
  }
})();

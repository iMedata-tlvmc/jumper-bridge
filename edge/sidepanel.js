const DEFAULT_MODERN_APP_URL =
  "https://inextdata.tasmc.corp/consultationsReportJumper";

const frame = document.getElementById("frame");
const errorBox = document.getElementById("error");
const toggleButton = document.getElementById("btnToggleFrame");

async function resolveUrl() {
  const { modernAppUrl } = await chrome.storage.local.get("modernAppUrl");
  return modernAppUrl || DEFAULT_MODERN_APP_URL;
}

function showError() {
  frame.style.display = "none";
  errorBox.style.display = "block";
}

async function loadPreview() {
  const url = await resolveUrl();
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

function applyFrameHidden(hidden) {
  document.body.classList.toggle("frame-hidden", hidden);
  toggleButton.textContent = hidden ? "Show Gecko preview" : "Hide Gecko preview";
}

document.querySelectorAll(".route").forEach((button) => {
  button.addEventListener("click", () => {
    const message = button.dataset.dept
      ? { type: "openGeckoDept", dept: button.dataset.dept }
      : { type: button.dataset.message };
    chrome.runtime.sendMessage(message);
  });
});

document.getElementById("btnOpenTab").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "openGeckoDept",
    dept: "consultations",
  });
});

toggleButton.addEventListener("click", async () => {
  const hidden = !document.body.classList.contains("frame-hidden");
  applyFrameHidden(hidden);
  await chrome.storage.local.set({ sidePanelFrameHidden: hidden });
});

chrome.storage.local.get("sidePanelFrameHidden").then(({ sidePanelFrameHidden }) => {
  applyFrameHidden(Boolean(sidePanelFrameHidden));
});

loadPreview();

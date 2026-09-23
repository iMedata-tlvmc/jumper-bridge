const statusElement = document.getElementById("status");

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

async function runRoute(button) {
  const message = button.dataset.dept
    ? { type: "openGeckoDept", dept: button.dataset.dept }
    : { type: button.dataset.message };

  button.disabled = true;
  showStatus("Opening...");
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "The route could not be opened.");
    }
    showStatus("Opened.");
  } catch (err) {
    showStatus(String(err && err.message ? err.message : err), true);
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll(".route").forEach((button) => {
  button.addEventListener("click", () => runRoute(button));
});

document.getElementById("btnDiagnostics").addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (err) {
    showStatus(String(err && err.message ? err.message : err), true);
  }
});

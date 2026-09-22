const JUMPER_PAGE_MESSAGE_SOURCE = "jumper-bridge-page";
const SIGNAL_HOSTS = new Set(["chsw", "chsw.tasmc.corp"]);
const signalPatterns = [
  /\/chameleon\/login\.asp\?[^#]*\bquickOpen=1\b/i,
  /\/Chameleon\/LabResults\/LabResultsModal\?/i,
  /\/Chameleon\/Navigation\/ContagiousDiseaseWin\.asp\?/i,
  /\/ChameleonNET\/NET\/MedicineOrders\/MedOrdersFrm\.aspx\?/i,
  /\/Chameleon\/Asp\/Navigation_OpenNewRecord\/OpenNewRecord\?/i,
  /\/ChameleonNET\/NET\/FluidBalance\/FluidBalanceFrm\.aspx\?/i,
  /\/ChameleonNET\/NET\/MedicineOrders\/MedOrders4Approve\.aspx\?/i,
  /\/Chameleon\/ApiRedirection\/RedirectToApplication\?/i,
  /\/Chameleon\/Namer\?/i,
];

function isSignalUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  try {
    const url = new URL(rawUrl, window.location.href);
    return (
      SIGNAL_HOSTS.has(url.hostname.toLowerCase()) &&
      signalPatterns.some((pattern) => pattern.test(url.href))
    );
  } catch {
    return false;
  }
}

function routeSignalUrl(url) {
  chrome.runtime.sendMessage({ type: "routeModernSignal", url });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;

  const data = event.data;
  if (
    !data ||
    data.source !== JUMPER_PAGE_MESSAGE_SOURCE ||
    data.type !== "routeSignalUrl" ||
    typeof data.url !== "string"
  ) {
    return;
  }

  routeSignalUrl(data.url);
});

function interceptSignalLink(event) {
  const anchor = event
    .composedPath()
    .find((node) => node && node.tagName && node.tagName.toLowerCase() === "a");
  if (!anchor || !isSignalUrl(anchor.href)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  routeSignalUrl(anchor.href);
}

window.addEventListener("click", interceptSignalLink, true);
window.addEventListener("auxclick", interceptSignalLink, true);

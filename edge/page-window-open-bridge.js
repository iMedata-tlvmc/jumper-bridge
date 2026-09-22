(() => {
  const INSTALL_MARKER = "__jumperBridgeWindowOpenInstalled";
  const MESSAGE_SOURCE = "jumper-bridge-page";
  const SIGNAL_HOSTS = new Set(["chsw", "chsw.tasmc.corp"]);

  if (window[INSTALL_MARKER]) return;
  window[INSTALL_MARKER] = true;

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
    if (typeof rawUrl !== "string" && !(rawUrl instanceof URL)) return false;
    try {
      const url = new URL(String(rawUrl), window.location.href);
      return (
        SIGNAL_HOSTS.has(url.hostname.toLowerCase()) &&
        signalPatterns.some((pattern) => pattern.test(url.href))
      );
    } catch {
      return false;
    }
  }

  const originalWindowOpen = window.open;
  window.open = function jumperBridgeWindowOpen(url, ...args) {
    if (!isSignalUrl(url)) {
      return Reflect.apply(originalWindowOpen, this, [url, ...args]);
    }

    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "routeSignalUrl",
        url: String(url),
      },
      window.location.origin
    );
    return null;
  };
})();

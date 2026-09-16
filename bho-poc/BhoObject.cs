using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Jumper.Bridge;

namespace JumperBho
{
    // Minimal IObjectWithSite definition - .NET Framework doesn't ship this
    // interop declaration out of the box, so we declare it ourselves. This is
    // THE interface every Browser Helper Object must implement; Trident/MSHTML
    // calls SetSite(browserInstance) when the BHO is loaded into a page, and
    // SetSite(null) when it's being torn down.
    [ComImport]
    [Guid("FC4801A3-2BA9-11CF-A229-00AA003D7352")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IObjectWithSite
    {
        [PreserveSig]
        int SetSite([MarshalAs(UnmanagedType.IUnknown)] object pUnkSite);

        [PreserveSig]
        int GetSite(ref Guid riid, out IntPtr ppvSite);
    }

    // Minimal hand-declared IWebBrowser2 - just enough to read where the
    // browser is currently navigated to (LocationURL) and to know which
    // events fire (DWebBrowserEvents2, declared below). This avoids needing
    // the full Microsoft.mshtml / Interop.SHDocVw type library references for
    // this POC step - we only need a couple of members.
    [ComImport]
    [Guid("D30C1661-CDAF-11d0-8A3E-00C04FC9E26E")]
    [InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    public interface IWebBrowser2
    {
        // NOTE: IWebBrowser2's vtable has many members before LocationURL;
        // since this is an IDispatch-based dual interface accessed via COM
        // Interop with named properties (not raw vtable offsets), we can
        // declare just the members we need, in any order, and .NET's COM
        // interop will resolve them via IDispatch::GetIDsOfNames instead of
        // positional vtable matching. This only works because the interface
        // is marked InterfaceIsIDispatch (late-bound), not IUnknown.
        //
        // DISPIDs below are from Microsoft's exdisp.h (DISPID_LOCATIONNAME=210,
        // DISPID_LOCATIONURL=211) - an earlier attempt used 0x64/0x65 (100/101)
        // which are actually DISPID_GOBACK/DISPID_GOFORWARD and caused
        // DISP_E_MEMBERNOTFOUND when invoked as properties.
        [DispId(210)]
        string LocationName { get; }

        [DispId(211)]
        string LocationURL { get; }
    }

    // Standard OLE connection-point interfaces (well-known GUIDs from
    // ocidl.idl) - needed to Advise() our event sink onto the browser's
    // DWebBrowserEvents2 event source, so we get notified AFTER navigation
    // completes (SetSite fires too early - the browser is still blank/
    // about:blank at that instant, confirmed empirically: LocationURL read
    // synchronously inside SetSite came back as "").
    [ComImport]
    [Guid("B196B284-BAB4-101A-B69C-00AA00341D07")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IConnectionPointContainer
    {
        void EnumConnectionPoints(out IntPtr ppEnum);
        void FindConnectionPoint(ref Guid riid, out IConnectionPoint ppCP);
    }

    [ComImport]
    [Guid("B196B286-BAB4-101A-B69C-00AA00341D07")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IConnectionPoint
    {
        void GetConnectionInterface(out Guid pIID);
        void GetConnectionPointContainer(out IConnectionPointContainer ppCPC);
        void Advise([MarshalAs(UnmanagedType.IUnknown)] object pUnkSink, out int pdwCookie);
        void Unadvise(int dwCookie);
        void EnumConnections(out IntPtr ppEnum);
    }

    // DWebBrowserEvents2 - the dispinterface IWebBrowser2 fires events
    // through. We only declare the members we actually need
    // (DocumentComplete, BeforeNavigate2, DownloadBegin); a dispinterface is
    // invoked strictly by DISPID via IDispatch::Invoke, so declaring a subset
    // is safe - COM never inspects the rest of the interface's members.
    // DISPIDs are from Microsoft's exdisp.h: DISPID_BEFORENAVIGATE2=250 (0xFA),
    // DISPID_DOCUMENTCOMPLETE=259 (0x103), DISPID_DOWNLOADBEGIN=106 (0x6A).
    // DownloadBegin fires whenever IE is about to show its "open/save this
    // file" download UI for a navigated resource it can't render inline -
    // this is the hook we use to auto-dismiss the spurious ParseXsl download
    // prompt that only appears when a patient is opened programmatically via
    // this BHO (root cause: Chameleon's /Transform/ParseXsl endpoint returns
    // Content-Type: text/xml, which Trident won't render as a top-level/frame
    // navigation - it only ever renders correctly when the surrounding page's
    // own script loads it in a way (e.g. via a real user-gesture-backed frame
    // navigation) that isn't quite reproduced by our programmatic invocation).
    [ComImport]
    [Guid("34A715A0-6587-11D0-924A-0020AFC7AC4D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    public interface DWebBrowserEvents2
    {
        [DispId(250)]
        void BeforeNavigate2(
            [MarshalAs(UnmanagedType.IDispatch)] object pDisp,
            ref object URL, ref object flags, ref object targetFrameName,
            ref object postData, ref object headers, ref bool cancel);

        [DispId(259)]
        void DocumentComplete([MarshalAs(UnmanagedType.IDispatch)] object pDisp, ref object URL);

        [DispId(106)]
        void DownloadBegin();

        // DISPID_FILEDOWNLOAD = 270 (0x10E). Fired by Trident/urlmon BEFORE any
        // download UI is created, precisely when it has decided a resource must
        // be downloaded rather than rendered. Setting Cancel = VARIANT_TRUE
        // aborts the download outright, so the "Download Options" dialog is
        // never constructed in the first place. This is the supported,
        // race-free replacement for the old "poll for the dialog window and
        // click its Cancel button" workaround (which was inherently a race and
        // could, in a broader form, close unrelated dialogs).
        //
        // ActiveDocument is VARIANT_TRUE when the target is an ActiveDocument
        // (Word/Excel hosted in-place); the spurious ParseXsl pseudo-downloads
        // are always plain (VARIANT_FALSE) downloads.
        [DispId(270)]
        void FileDownload([In] bool ActiveDocument, [In, Out] ref bool Cancel);
    }

    // Our event sink. Exposed to COM (default IDispatch is auto-generated by
    // .NET for a ComVisible class using ClassInterfaceType.None + explicit
    // interface implementation) so IConnectionPoint.Advise can call back into
    // it by DISPID, matching DWebBrowserEvents2 above.
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public class BrowserEventSink : DWebBrowserEvents2
    {
        private readonly Action<string, object, object> _onEvent;
        private readonly Func<bool, bool> _onFileDownload;
        private readonly Func<string, bool> _shouldCancelNavigation;

        public BrowserEventSink(
            Action<string, object, object> onEvent,
            Func<bool, bool> onFileDownload = null,
            Func<string, bool> shouldCancelNavigation = null)
        {
            _onEvent = onEvent;
            _onFileDownload = onFileDownload;
            _shouldCancelNavigation = shouldCancelNavigation;
        }

        public void BeforeNavigate2(object pDisp, ref object URL, ref object flags, ref object targetFrameName, ref object postData, ref object headers, ref bool cancel)
        {
            _onEvent("BeforeNavigate2", pDisp, URL);

            // Setting cancel = VARIANT_TRUE here aborts the navigation BEFORE
            // Trident issues any network request - the exact equivalent of
            // WebView2's NewWindowRequested e.Handled = true, which is how the
            // production Jumper app suppresses these same signal URLs.
            try
            {
                if (_shouldCancelNavigation != null && _shouldCancelNavigation(URL as string))
                {
                    cancel = true;
                }
            }
            catch
            {
            }
        }

        public void DocumentComplete(object pDisp, ref object URL)
        {
            _onEvent("DocumentComplete", pDisp, URL);
        }

        public void DownloadBegin()
        {
            _onEvent("DownloadBegin", null, null);
        }

        public void FileDownload(bool ActiveDocument, ref bool Cancel)
        {
            // Never let an exception escape into Trident's event dispatch - a
            // throw here would surface as a scripting error in the host page.
            try
            {
                if (_onFileDownload != null && _onFileDownload(ActiveDocument))
                {
                    Cancel = true;
                }
            }
            catch
            {
            }
        }
    }

    // The BHO itself. Step 2: reads LocationURL immediately on SetSite
    // (confirmed too early - browser is still blank at that point), and now
    // additionally Advises a DWebBrowserEvents2 sink so we get
    // BeforeNavigate2/DocumentComplete callbacks with the real URL, to
    // determine whether the browser instance we've been attached to is
    // actually rendering Chameleon content (chsw.tasmc.corp) or something
    // unrelated - step 1's test showed SetSite firing even for what turned
    // out to be an unrelated Windows Explorer WebBrowser-control use, so we
    // need real evidence of which URL(s) this BHO instance actually observes.
    //
    // IMPORTANT: this CLSID must stay in sync with register-bho.ps1's registry
    // entries. If you regenerate this GUID, update the script too.
    [ComVisible(true)]
    [Guid("6B1D4E2A-7F3C-4A9B-9E5D-2C8F1A3B6D71")]
    [ClassInterface(ClassInterfaceType.None)]
    [ProgId("JumperBho.BhoObject")]
    public class BhoObject : IObjectWithSite
    {
        private static readonly string LogPath = @"C:\Temp\jumper-bho.log";
        private IConnectionPoint _connectionPoint;
        private int _adviseCookie;

        // Cross-thread bridge/pending-command state (all POC additions for the
        // extension<->BHO IPC pipeline - see PipeServerLoop/EnsureUiMarshaller
        // below for how these get populated/consumed).
        //
        // IMPORTANT (2026-09-07 fix): we do NOT cache the patient-list frame's
        // *window* object across events anymore - empirically confirmed that
        // reference goes stale (DISP_E_UNKNOWNNAME on the next invoke) once
        // the user has since opened a patient record, even though the list
        // frame itself never navigates away. Instead we cache the top-level
        // IWebBrowser2 site (stable for the tab's entire lifetime) and do a
        // FRESH frame-tree walk (FindOpenPatientRecordWindow) every time we
        // actually need to invoke - Document/parentWindow/frames are all live
        // properties, so this always reflects the current, valid state.
        private static readonly object _stateLock = new object();
        private static Control _uiMarshaller;
        // ALL browser sites currently alive in this process. Trident creates a
        // BHO instance per browser object (tabs, popups, some frames), so a
        // single static "the" site is wrong - see GetTopWindow for the full
        // root-cause note. Each instance registers its own site here and
        // removes exactly that one on teardown, so one tab closing can no
        // longer blind the bridge to another tab that is still open.
        private static readonly object _sitesLock = new object();
        private static readonly List<object> _liveSites = new List<object>();
        // Cache of the specific frame's own IWebBrowser2-ish pDisp (from a
        // DocumentComplete event) where OpenPatientRecord was last confirmed
        // to exist (e.g. the patient-list frame). Unlike caching the *window*
        // object, this frame identity is expected to stay valid across
        // navigations that happen in OTHER frames (e.g. opening a patient
        // record only navigates folderFrame, not the list frame itself) -
        // we still re-derive Document/parentWindow FRESH from it every time
        // rather than reusing an old window reference, since that live
        // property lookup is cheap and avoids any staleness either way.
        private static object _cachedFramePDisp;
        private static string _lastKnownListUrl;
        // Mirrors Jumper's HandlePatientsListOpen detection (Chameleon.cs):
        // true when folderFrame currently shows the bare patient list
        // (divHospPatientList exists) AND the Heading frame's "מחלקות"/doctor
        // tab (tdHospDoctor) or nursing tab (tdHospSister) has className
        // "tab_On" - i.e. the user just clicked/landed on that Chameleon tab.
        // Updated on every DocumentComplete; polled by the extension via the
        // named pipe (QUERY_DEPT_TAB) so it can bring the Gecko/modern-app
        // tab to the front, same trigger the real app uses to ShowGecko().
        private static volatile bool _departmentTabActive;
        private static string[] _pendingArgs;
        private static bool _pipeStarted;
        private const string PipeName = BridgeProtocol.PipeName;

        private static void Log(string message)
        {
            try
            {
                var dir = Path.GetDirectoryName(LogPath);
                if (dir != null) Directory.CreateDirectory(dir);
                File.AppendAllText(LogPath, $"{DateTime.Now:O} [pid={System.Diagnostics.Process.GetCurrentProcess().Id}] {message}{Environment.NewLine}");
            }
            catch
            {
                // Never let logging crash the host process - a misbehaving BHO
                // can take down the whole IE-mode tab (or historically, all of
                // Internet Explorer). Fail silently.
            }
        }

        public BhoObject()
        {
            Log("BhoObject constructed (COM activation happened).");
        }

        // This instance's own site, so teardown removes exactly the right one.
        private object _mySite;

        public int SetSite(object pUnkSite)
        {
            if (pUnkSite != null)
            {
                Log($"SetSite(non-null) - BHO is now attached to a browser instance. site type = {pUnkSite.GetType().FullName}");
                _mySite = pUnkSite;
                lock (_sitesLock)
                {
                    if (!_liveSites.Contains(pUnkSite)) _liveSites.Add(pUnkSite);
                    Log($"  -> [sites] Registered site; {_liveSites.Count} live site(s) in this process.");
                }
                EnsureUiMarshaller();
                TryLogLocation(pUnkSite);
                TryAdviseEvents(pUnkSite);
            }
            else
            {
                Log("SetSite(null) - BHO is being detached/unloaded.");
                // Remove only THIS instance's site. Nulling the shared static
                // unconditionally is what used to break the bridge for every
                // other still-open tab in the process.
                lock (_sitesLock)
                {
                    if (_mySite != null) _liveSites.Remove(_mySite);
                    Log($"  -> [sites] Unregistered site; {_liveSites.Count} live site(s) remain.");
                }
                _mySite = null;
                TryUnadviseEvents();
            }
            return 0; // S_OK
        }

        // Creates (once) a hidden WinForms Control purely to get an HWND with a
        // message loop on THIS thread - the STA thread Trident/MSHTML calls
        // SetSite/BeforeNavigate2/DocumentComplete on. The background pipe
        // listener thread (PipeServerLoop) has no safe way to touch the live
        // COM objects directly (wrong apartment/thread => RPC_E_WRONG_THREAD),
        // so it marshals over via _uiMarshaller.Invoke(...), the same pattern
        // any WinForms app uses to update the UI from a background thread.
        private static void EnsureUiMarshaller()
        {
            if (_uiMarshaller == null)
            {
                _uiMarshaller = new Control();
                var forceHandleCreation = _uiMarshaller.Handle; // touch it now, on this thread
                Log($"  -> UI marshaller Control created (handle=0x{forceHandleCreation.ToInt64():X}).");
            }
        }

        private static void TryLogLocation(object pUnkSite)
        {
            try
            {
                var web = pUnkSite as IWebBrowser2;
                if (web == null)
                {
                    Log("  -> Site does not expose IWebBrowser2 (or QI failed) - cannot read LocationURL this way.");
                    return;
                }
                string url = null;
                string name = null;
                try { url = web.LocationURL; } catch (Exception ex) { url = $"<error reading LocationURL: {ex.Message}>"; }
                try { name = web.LocationName; } catch (Exception ex) { name = $"<error reading LocationName: {ex.Message}>"; }
                Log($"  -> LocationURL='{url}' LocationName='{name}' (read synchronously at SetSite time - often blank/about:blank; see DocumentComplete events for the real value)");
            }
            catch (Exception ex)
            {
                Log($"  -> TryLogLocation failed: {ex}");
            }
        }

        // Step 3/4: on each DocumentComplete (fired once per frame as well as
        // the top-level document), reach the frame's Document -> parentWindow
        // via plain late-bound COM reflection (Type.InvokeMember against the
        // System.__ComObject RCW - no typed interop assembly needed, same
        // technique VBScript/JScript late binding has always used) and check
        // whether "OpenPatientRecord" exists as a member of that window's
        // global scope. This tells us, per-frame, which frame's script
        // context actually owns the function - critical for knowing where to
        // eventually invoke it from (the real desktop app calls it via
        // InvokeScriptInFrame("folderFrame", "OpenPatientRecord", args) per
        // Chameleon.cs, implying it's likely reachable from folderFrame's own
        // window, or possibly only from the top frameset window - we don't
        // yet know for certain, hence probing every frame).
        private static void TryProbeOpenPatientRecord(object pDisp, string url)
        {
            try
            {
                if (pDisp == null)
                {
                    Log("  -> [probe] pDisp is null, skipping.");
                    return;
                }

                object doc = InvokeGet(pDisp, "Document");
                if (doc == null)
                {
                    Log("  -> [probe] Document property returned null.");
                    return;
                }

                object win = InvokeGet(doc, "parentWindow");
                if (win == null)
                {
                    Log("  -> [probe] parentWindow property returned null.");
                    return;
                }

                object fn = null;
                string fnError = null;
                try
                {
                    fn = win.GetType().InvokeMember("OpenPatientRecord", BindingFlags.GetProperty, null, win, null);
                }
                catch (Exception ex)
                {
                    fnError = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
                }

                if (fn != null)
                {
                    Log($"  -> [probe] url='{url}': OpenPatientRecord EXISTS on this window! type={fn.GetType().FullName}");
                    _cachedFramePDisp = pDisp; // remember this frame's own site for fast, non-walk re-lookup later
                    _lastKnownListUrl = url;   // remember the URL that hosts OpenPatientRecord, so we can
                                               // navigate folderFrame BACK to it on demand (see
                                               // HandleIncomingCommandOnUiThread / TryNavigateBackToListThenInvoke) -
                                               // this mirrors what the real Jumper desktop app's users actually do:
                                               // always return to the patient list before opening the next patient,
                                               // since OpenPatientRecord only lives in the list page's own script
                                               // (confirmed 2026-09-07: switching directly from one open record to
                                               // another isn't actually supported even by the real production app -
                                               // Gecko's overlay just visually hides that list-flash from the user).

                    string[] pendingFromPipe = null;
                    lock (_stateLock)
                    {
                        if (_pendingArgs != null)
                        {
                            pendingFromPipe = _pendingArgs;
                            _pendingArgs = null;
                        }
                    }

                    TryInvokeIfTriggered(win, url); // legacy file-trigger POC path, kept for manual testing

                    if (pendingFromPipe != null)
                    {
                        InvokeOpenPatientRecord(win, pendingFromPipe, "pipe-pending-after-login");
                    }
                }
                else
                {
                    Log($"  -> [probe] url='{url}': OpenPatientRecord not found on this window ({fnError ?? "returned null/undefined"}).");
                }
            }
            catch (Exception ex)
            {
                Log($"  -> [probe] TryProbeOpenPatientRecord failed for url='{url}': {ex}");
            }
        }

        // Fresh, non-cached lookup of the frame whose window currently exposes
        // OpenPatientRecord. PRIMARY strategy (added 2026-09-07 after reading
        // Jumper's own production C# source - ChameleonWebBrowser.cs /
        // ChameleonSHDocVw.cs): replicate exactly what GetFrameByName +
        // InvokeScriptInFrame("folderFrame", "OpenPatientRecord", args) does -
        // a fresh, ONE-LEVEL, BY-NAME lookup of "folderFrame" directly off the
        // top window, every single time, no caching, no recursion. Our
        // earlier recursive BFS-by-index walk through window.frames was a
        // more roundabout (and apparently unreliable) reimplementation of the
        // same idea - Jumper's own working code never does that, it always
        // goes straight to topWin.folderFrame by name.
        private static object FindOpenPatientRecordWindow()
        {
            try
            {
                object topWin = GetTopWindow();
                if (topWin == null)
                {
                    Log("  -> [find] Could not resolve a top window from any live site.");
                    return null;
                }

                try
                {
                    object folderFrameWin = topWin.GetType().InvokeMember("folderFrame", BindingFlags.GetProperty, null, topWin, null);
                    if (folderFrameWin != null)
                    {
                        object fn = null;
                        try
                        {
                            fn = folderFrameWin.GetType().InvokeMember("OpenPatientRecord", BindingFlags.GetProperty, null, folderFrameWin, null);
                        }
                        catch (Exception exProp)
                        {
                            Log($"  -> [find] top.folderFrame direct lookup: OpenPatientRecord not on it: {exProp.Message}");
                        }

                        if (fn != null)
                        {
                            Log("  -> [find] top.folderFrame direct lookup: FOUND OpenPatientRecord (matches Jumper's own production mechanism).");
                            return folderFrameWin;
                        }
                    }
                    else
                    {
                        Log("  -> [find] top.folderFrame returned null.");
                    }
                }
                catch (Exception exFrame)
                {
                    Log($"  -> [find] top.folderFrame not reachable: {exFrame.Message}");
                }

                Log("  -> [find] Falling back to recursive frame-tree walk (diagnostic backup)...");
                return SearchFramesForFunction(topWin, "OpenPatientRecord", 6);
            }
            catch (Exception ex)
            {
                Log($"  -> [find] FindOpenPatientRecordWindow failed: {ex}");
                return null;
            }
        }

        private static object SearchFramesForFunction(object win, string funcName, int maxDepth)
        {
            if (win == null || maxDepth <= 0)
            {
                Log($"  -> [find] SearchFramesForFunction: stopping (win-null={win == null}, maxDepth={maxDepth}).");
                return null;
            }

            try
            {
                object fn = win.GetType().InvokeMember(funcName, BindingFlags.GetProperty, null, win, null);
                if (fn != null)
                {
                    Log($"  -> [find] SearchFramesForFunction: FOUND {funcName} at depth={maxDepth}.");
                    return win;
                }
            }
            catch (Exception ex)
            {
                Log($"  -> [find] SearchFramesForFunction: {funcName} not on this window (depth={maxDepth}): {ex.Message}");
            }

            try
            {
                object frames = InvokeGet(win, "frames");
                if (frames == null)
                {
                    Log($"  -> [find] SearchFramesForFunction: frames property is null (depth={maxDepth}).");
                    return null;
                }
                object lengthObj = InvokeGet(frames, "length");
                int length = Convert.ToInt32(lengthObj);
                Log($"  -> [find] SearchFramesForFunction: depth={maxDepth}, frames.length={length}.");

                for (int i = 0; i < length; i++)
                {
                    object childWin = null;
                    try
                    {
                        // "item(i)" is the standard named method IE's collection
                        // objects (frames, elements, etc.) expose for indexed
                        // access - more reliable via late-bound reflection than
                        // the anonymous default-indexer trick (DISPID_VALUE via
                        // an empty member name), which this session's testing
                        // showed returning something that isn't a real window.
                        childWin = frames.GetType().InvokeMember(
                            "item", BindingFlags.InvokeMethod, null, frames, new object[] { i });
                    }
                    catch (Exception itemEx)
                    {
                        try
                        {
                            childWin = frames.GetType().InvokeMember(
                                "", BindingFlags.GetProperty, null, frames, new object[] { i });
                        }
                        catch (Exception ex)
                        {
                            Log($"  -> [find] SearchFramesForFunction: frames[{i}] indexer failed (item(): {itemEx.Message}; default-prop: {ex.Message}).");
                            continue;
                        }
                    }

                    Log($"  -> [find] SearchFramesForFunction: frames[{i}] -> {(childWin == null ? "null" : childWin.GetType().FullName)}");
                    object found = SearchFramesForFunction(childWin, funcName, maxDepth - 1);
                    if (found != null) return found;
                }
            }
            catch (Exception ex)
            {
                Log($"  -> [find] SearchFramesForFunction: frames enumeration failed (depth={maxDepth}): {ex.Message}");
            }

            return null;
        }

        // Step 5: the actual invocation test. Deliberately gated behind a
        // one-shot trigger file (rather than firing automatically on every
        // page that has OpenPatientRecord) so this only runs when we
        // explicitly want it to, with args we choose - avoids repeatedly
        // re-navigating the user's live patient list every time they merely
        // browse it. Trigger file format (pipe-separated, one line):
        //   Patient|Unit|Medical_Record|Record_Char|Record_Part|Unit_Name|Admission_Date|End_Date|Id_Num
        // matching OpenPatientRecord's real JS parameter order as reverse-
        // engineered earlier in this POC (view-source of the function body).
        // Renamed to .used immediately after an attempt so it never re-fires.
        private const string TriggerPath = @"C:\Temp\jumper-bho-invoke.txt";

        private static void TryInvokeIfTriggered(object win, string url)
        {
            try
            {
                if (!File.Exists(TriggerPath)) return;

                string line = File.ReadAllText(TriggerPath).Trim();
                string usedPath = TriggerPath + "." + DateTime.Now.Ticks + ".used";
                File.Move(TriggerPath, usedPath); // one-shot: consume it now so we never double-invoke

                var parts = line.Split('|');
                Log($"  -> [invoke] Trigger found ({parts.Length} args) for url='{url}': {line}");
                InvokeOpenPatientRecord(win, parts, "file-trigger");
            }
            catch (Exception ex)
            {
                Log($"  -> [invoke] TryInvokeIfTriggered failed: {ex.Message}");
            }
        }

        // Shared invocation helper - OpenPatientRecord's real params are a mix
        // of numeric IDs and strings; JScript is loosely typed so passing
        // everything as .NET strings and letting COM/JScript coerce is
        // expected to work the same way it would from any other late-bound
        // caller (e.g. VBScript), matching how Jumper's own C# already calls
        // frame-hosted JS functions via InvokeScriptInFrame.
        private static void InvokeOpenPatientRecord(object win, string[] parts, string source)
        {
            try
            {
                Log($"  -> [invoke:{source}] Invoking OpenPatientRecord with {parts.Length} args: {string.Join("|", parts)}");
                ArmDownloadSuppression($"invoke:{source}");
                object[] args = parts.Cast<object>().ToArray();
                object result = win.GetType().InvokeMember(
                    "OpenPatientRecord", BindingFlags.InvokeMethod, null, win, args);
                Log($"  -> [invoke:{source}] OpenPatientRecord(...) call returned without throwing. result={(result ?? "<null/undefined>")}");
            }
            catch (Exception ex)
            {
                var inner = ex.InnerException;
                Log($"  -> [invoke:{source}] OpenPatientRecord(...) call THREW: {ex.Message}" + (inner != null ? $" | inner: {inner.Message}" : ""));
            }
        }

        // Step 6: real IPC. A named pipe server ("\\.\pipe\JumperBhoBridge")
        // listens for one-line, pipe-delimited commands from the (future)
        // native messaging host, in the same 9-field order as the file
        // trigger above. Deliberately only started once THIS process has been
        // confirmed to host the Chameleon FRAMESET (its top document contains
        // 'folderFrame' - see TopDocumentHasFolderFrame). Gating on merely
        // having seen a chsw.tasmc.corp URL is NOT sufficient: every Chameleon
        // popup page runs in its own iexplore.exe and would then race this
        // process for the same pipe name, silently stealing commands it has no
        // frames to execute.
        //
        // Threading note: NamedPipeServerStream callbacks/loops run on a plain
        // background thread, which is NOT the STA thread that owns the live
        // COM objects (IWebBrowser2/IHTMLWindow2 etc. from Trident). Calling
        // into them from the wrong thread throws RPC_E_WRONG_THREAD, so every
        // actual COM call is marshaled back via _uiMarshaller.Invoke(...).
        // Returns true if THIS process's top document is the Chameleon frameset
        // (i.e. it actually contains the 'folderFrame' every bridge command
        // targets). Must be called on the UI thread - it touches live COM.
        //
        // ROOT CAUSE this exists to fix (2026-09-09): the pipe was previously
        // started by ANY process that merely saw a chsw.tasmc.corp URL. Every
        // Chameleon popup (FluidBalanceFrm.aspx, MedOrdersFrm.aspx, ...) opens
        // in its own iexplore.exe, each of which qualified and started its own
        // server on the same pipe name. Since PipeServerLoop recreates the
        // server after every client disconnect, whichever process happened to
        // win the next WaitForConnection received the command - frequently a
        // single-page popup process with NO frames at all, producing
        // "Frame 'folderFrame' not found among 0 frame(s)" and an empty
        // GetUserSector(). The bridge was effectively a race between processes.
        private static bool TopDocumentHasFolderFrame()
        {
            try
            {
                return FindFrameWindowByName("folderFrame") != null;
            }
            catch (Exception ex)
            {
                Log($"  -> [pipe-owner] folderFrame check failed: {ex.Message}");
                return false;
            }
        }

        private static void EnsurePipeServerStarted()
        {
            lock (_stateLock)
            {
                if (_pipeStarted) return;
                _pipeStarted = true;
            }
            var thread = new Thread(PipeServerLoop) { IsBackground = true, Name = "JumperBhoPipeServer" };
            thread.Start();
            Log(@"  -> Named pipe server thread started (\\.\pipe\JumperBhoBridge).");
        }

        private static void PipeServerLoop()
        {
            while (true)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                    {
                        server.WaitForConnection();
                        using (var reader = new StreamReader(server))
                        using (var writer = new StreamWriter(server) { AutoFlush = true })
                        {
                            string line = reader.ReadLine();
                            if (!string.IsNullOrWhiteSpace(line))
                            {
                                line = line.Trim();
                                if (string.Equals(line, BridgeProtocol.CmdQueryDeptTab, StringComparison.OrdinalIgnoreCase))
                                {
                                    bool active = _departmentTabActive;
                                    writer.WriteLine(active ? BridgeProtocol.ReplyTrue : BridgeProtocol.ReplyFalse);
                                    Log($"  -> [pipe] Replied to QUERY_DEPT_TAB: {(active ? "1" : "0")}");
                                }
                                else if (string.Equals(line, BridgeProtocol.CmdQuerySector, StringComparison.OrdinalIgnoreCase))
                                {
                                    // Mirrors Chameleon.OpenMedOrdersFromUrl, which reads
                                    // GetUserSector() off the top document before it can build
                                    // the MedOrders URL. Duplex like QUERY_DEPT_TAB.
                                    string sector = QuerySectorOnUiThread();
                                    writer.WriteLine(sector ?? "");
                                    Log($"  -> [pipe] Replied to QUERY_SECTOR: '{sector}'");
                                }
                                else if (line.StartsWith(BridgeProtocol.CmdExecScriptPrefix, StringComparison.OrdinalIgnoreCase))
                                {
                                    // Duplex: the caller needs to know whether the
                                    // script actually ran so it can fall back to a
                                    // plain new tab, rather than the user being
                                    // shown nothing at all when the modal API is
                                    // unavailable in this document mode.
                                    Log("  -> [pipe] Received command: EXEC_SCRIPT (payload elided).");
                                    string status = ExecScriptOnUiThread(line);
                                    writer.WriteLine(status);
                                    Log($"  -> [pipe] Replied to EXEC_SCRIPT: {status}");
                                }
                                else
                                {
                                    Log($"  -> [pipe] Received command: {line}");
                                    DispatchIncomingCommand(line);
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log($"  -> [pipe] Pipe server loop error (will retry in 500ms): {ex.Message}");
                    Thread.Sleep(500);
                }
            }
        }

        private static void DispatchIncomingCommand(string line)
        {
            try
            {
                if (_uiMarshaller == null || !_uiMarshaller.IsHandleCreated)
                {
                    Log("  -> [pipe] No UI marshaller available yet - dropping command.");
                    return;
                }
                _uiMarshaller.Invoke(new Action(() => HandleIncomingCommandOnUiThread(line)));
            }
            catch (Exception ex)
            {
                Log($"  -> [pipe] Failed to marshal command to UI thread: {ex.Message}");
            }
        }

        // Runs ON the STA/UI thread (via Control.Invoke above) - safe to touch
        // the live COM objects here. Always does a FRESH frame-tree search
        // (not a cached reference) so this works whether the user is
        // currently on the bare patient list OR already viewing a patient
        // record.
        //
        // KEY FINDING (2026-09-07): confirmed with the user that even the
        // REAL Jumper desktop app requires returning to the bare patient list
        // before it can open a NEW patient - Chameleon.OpenPatientFromUrl
        // always calls InvokeScriptInFrame("folderFrame", "OpenPatientRecord",
        // args) with NO retry/fallback logic, meaning it only ever works when
        // folderFrame currently hosts the list page (which is the only place
        // OpenPatientRecord is ever defined - confirmed empirically, it never
        // appears on any record-view page). Jumper's Gecko overlay just
        // visually HIDES this "flash back to list" transition from the user,
        // creating an illusion of seamless in-place switching. We replicate
        // the same real requirement: if OpenPatientRecord isn't currently
        // reachable, navigate folderFrame back to the last-known list URL,
        // queue the incoming args as pending (TryProbeOpenPatientRecord
        // already auto-fires any pending args the moment OpenPatientRecord is
        // next found - i.e. once that list-URL navigation completes).
        private static void HandleIncomingCommandOnUiThread(string line)
        {
            // Prefix-dispatched commands. Anything without a known prefix is
            // the original bare 9-field patient-open line, kept for backward
            // compatibility with the existing native-host/file-trigger format.
            if (line.StartsWith(BridgeProtocol.CmdExecScriptPrefix, StringComparison.OrdinalIgnoreCase))
            {
                HandleExecScriptCommand(line);
                return;
            }

            var parts = line.Split('|');
            object win = FindOpenPatientRecordWindow();

            if (win != null)
            {
                InvokeOpenPatientRecord(win, parts, "pipe-immediate");
                return;
            }

            lock (_stateLock)
            {
                _pendingArgs = parts;
            }

            if (TryNavigateBackToList())
            {
                Log("  -> [pipe] OpenPatientRecord not currently reachable - navigated folderFrame back to the list; queued as pending, will fire once the list finishes loading.");
            }
            else
            {
                Log("  -> [pipe] OpenPatientRecord not currently reachable and no known list URL to navigate back to yet - queued as pending; will fire automatically once it's next found (e.g. after manual login).");
            }
        }

        // Navigates top.folderFrame back to the last URL we saw
        // OpenPatientRecord confirmed on (the patient-list page) - this is
        // what actually makes it reachable again, matching the real app's own
        // required "return to list" workflow.
        private static bool TryNavigateBackToList()
        {
            if (string.IsNullOrEmpty(_lastKnownListUrl))
            {
                Log("  -> [back-to-list] No _lastKnownListUrl captured yet - cannot navigate back.");
                return false;
            }

            try
            {
                object topWin = GetTopWindow();
                if (topWin == null)
                {
                    Log("  -> [back-to-list] Could not resolve top window.");
                    return false;
                }

                object folderFrameWin = topWin.GetType().InvokeMember("folderFrame", BindingFlags.GetProperty, null, topWin, null);
                if (folderFrameWin == null)
                {
                    Log("  -> [back-to-list] top.folderFrame not reachable.");
                    return false;
                }

                object folderDoc = InvokeGet(folderFrameWin, "document");
                if (folderDoc == null)
                {
                    Log("  -> [back-to-list] top.folderFrame.document is null.");
                    return false;
                }

                ArmDownloadSuppression("back-to-list");
                folderDoc.GetType().InvokeMember("location", BindingFlags.SetProperty, null, folderDoc, new object[] { _lastKnownListUrl });
                Log($"  -> [back-to-list] Set top.folderFrame.document.location = '{_lastKnownListUrl}'");
                return true;
            }
            catch (Exception ex)
            {
                Log($"  -> [back-to-list] TryNavigateBackToList failed: {ex}");
                return false;
            }
        }

        // Mirrors Jumper's HandlePatientsListOpen (Chameleon.cs lines ~344-397):
        // read-only DOM checks, no navigation/writes - safe to run on every
        // DocumentComplete. Always re-derives everything fresh from
        // _topWebBrowserSite (same staleness rationale as TryNavigateBackToList).
        private static void TryUpdateDepartmentTabState()
        {
            try
            {
                object folderFrameWin = FindFrameWindowByName("folderFrame");
                object headingFrameWin = FindFrameWindowByName("Heading");
                if (folderFrameWin == null || headingFrameWin == null)
                {
                    // Frameset not loaded yet (e.g. still on login page) - not an error.
                    return;
                }

                object folderDoc;
                object headingDoc;
                try
                {
                    folderDoc = InvokeGet(folderFrameWin, "document");
                    headingDoc = InvokeGet(headingFrameWin, "document");
                }
                catch (Exception ex)
                {
                    // Cross-frame document access can transiently fail while a
                    // frame is mid-navigation. Logged distinctly so it is not
                    // confused with a real failure to read the tab state.
                    Log($"  -> [dept-tab] frame document not readable yet: {ex.Message}");
                    return;
                }
                if (folderDoc == null || headingDoc == null) return;

                object patientListEl;
                try
                {
                    patientListEl = folderDoc.GetType().InvokeMember(
                        "getElementById", BindingFlags.InvokeMethod, null, folderDoc, new object[] { "divHospPatientList" });
                }
                catch (Exception ex)
                {
                    Log($"  -> [dept-tab] folderFrame getElementById failed: {ex.Message}");
                    return;
                }
                bool patientListShown = patientListEl != null;

                bool tabOn = false;
                if (patientListShown)
                {
                    tabOn = IsTabOn(headingDoc, "tdHospDoctor") || IsTabOn(headingDoc, "tdHospSister");
                }

                bool newState = patientListShown && tabOn;
                if (newState != _departmentTabActive)
                {
                    // State only - the extension polls it via QUERY_DEPT_TAB and
                    // focuses the Gecko tab itself (background.js
                    // handleDeptTabState). An in-page overlay iframe was tried
                    // and abandoned: Trident renders it, not Chromium, so the
                    // modern app is blank inside it.
                    Log($"  -> [dept-tab] state changed: {_departmentTabActive} -> {newState} (patientListShown={patientListShown}, tabOn={tabOn})");
                }
                _departmentTabActive = newState;
            }
            catch (Exception ex)
            {
                Log($"  -> [dept-tab] TryUpdateDepartmentTabState failed: {ex.Message}");
            }
        }

        private static bool IsTabOn(object doc, string elementId)
        {
            try
            {
                object el = doc.GetType().InvokeMember(
                    "getElementById", BindingFlags.InvokeMethod, null, doc, new object[] { elementId });
                if (el == null) return false;
                object className = el.GetType().InvokeMember("className", BindingFlags.GetProperty, null, el, null);
                return string.Equals(className as string, "tab_On", StringComparison.Ordinal);
            }
            catch
            {
                return false;
            }
        }


        // Small helper around Type.InvokeMember for property-get late binding
        // against a raw COM IDispatch object (System.__ComObject) - this is
        // exactly how VBScript/JScript "obj.Foo" late-bound property access
        // has always worked under the hood, just done explicitly via
        // reflection instead of the compiler doing it for us.
        private static object InvokeGet(object comObject, string memberName)
        {
            return comObject.GetType().InvokeMember(
                memberName, BindingFlags.GetProperty, null, comObject, null);
        }

        private void TryAdviseEvents(object pUnkSite)
        {
            try
            {
                var cpc = pUnkSite as IConnectionPointContainer;
                if (cpc == null)
                {
                    Log("  -> Site does not expose IConnectionPointContainer - cannot subscribe to navigation events.");
                    return;
                }
                var iid = typeof(DWebBrowserEvents2).GUID;
                cpc.FindConnectionPoint(ref iid, out _connectionPoint);
                if (_connectionPoint == null)
                {
                    Log("  -> FindConnectionPoint returned null for DWebBrowserEvents2.");
                    return;
                }
                var sink = new BrowserEventSink((eventName, pDispObj, urlObj) =>
                {
                    Log($"  -> [{eventName}] URL='{urlObj}'");
                    var urlStr = urlObj as string;
                    if (eventName == "DocumentComplete"
                        && urlStr != null
                        && urlStr.IndexOf("chsw.tasmc.corp", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        // Only the process hosting the Chameleon FRAMESET may own
                        // the bridge pipe. See EnsurePipeServerStarted for why.
                        // Checked at DocumentComplete because document.frames is
                        // empty until the frameset has actually finished loading.
                        if (TopDocumentHasFolderFrame())
                        {
                            EnsurePipeServerStarted();
                        }
                    }
                    if (eventName == "DocumentComplete")
                    {
                        TryProbeOpenPatientRecord(pDispObj, urlStr);
                        TryUpdateDepartmentTabState();
                    }
                    else if (eventName == "DownloadBegin")
                    {
                        // Backstop only. FileDownload (below) is the primary,
                        // race-free suppression mechanism; this window-closing
                        // fallback exists in case a download slips past it (e.g.
                        // one raised in a sibling iexplore.exe process whose
                        // browser object we're not advised on). It is deliberately
                        // gated on the same arm-window, so outside a programmatic
                        // navigation of ours it never runs at all and therefore can
                        // never touch a user-initiated or legitimate dialog.
                        if (IsDownloadSuppressionArmed())
                        {
                            ThreadPool.QueueUserWorkItem(_ => DismissSpuriousDownloadPrompt());
                        }
                    }
                },
                activeDocument =>
                {
                    // Return true => Cancel the download before any UI appears.
                    bool armed = IsDownloadSuppressionArmed();
                    Log($"  -> [FileDownload] activeDocument={activeDocument} suppressionArmed={armed} -> {(armed && !activeDocument ? "CANCELLING (spurious)" : "allowing")}");
                    return armed && !activeDocument;
                },
                navUrl =>
                {
                    // Return true => cancel this navigation outright.
                    if (!IsModernAppSignalUrl(navUrl)) return false;

                    // Belt and braces: also arm the download guard in THIS
                    // process. BeforeNavigate2 and the resulting FileDownload
                    // both fire on this same browser object, so if the cancel
                    // is ever ignored the FileDownload hook still catches it.
                    ArmDownloadSuppression("signal-url");
                    Log($"  -> [signal-url] CANCELLING navigation to pure-signal URL (never meant to be fetched): '{navUrl}'");
                    return true;
                });
                _connectionPoint.Advise(sink, out _adviseCookie);
                Log($"  -> Advised DWebBrowserEvents2 sink successfully (cookie={_adviseCookie}). Waiting for BeforeNavigate2/DocumentComplete...");
            }
            catch (Exception ex)
            {
                Log($"  -> TryAdviseEvents failed: {ex}");
            }
        }

        private void TryUnadviseEvents()
        {
            try
            {
                if (_connectionPoint != null && _adviseCookie != 0)
                {
                    _connectionPoint.Unadvise(_adviseCookie);
                    Log("  -> Unadvised DWebBrowserEvents2 sink.");
                }
            }
            catch (Exception ex)
            {
                Log($"  -> TryUnadviseEvents failed: {ex}");
            }
            finally
            {
                _connectionPoint = null;
                _adviseCookie = 0;
            }
        }

        public int GetSite(ref Guid riid, out IntPtr ppvSite)
        {
            ppvSite = IntPtr.Zero;
            return unchecked((int)0x80004001); // E_NOTIMPL - we don't need to hand the site back out for this POC
        }

        // --- EXEC_SCRIPT / QUERY_SECTOR: replicating Jumper's non-patient links ---
        //
        // Every non-patient Gecko→Chameleon link in the real app is performed by
        // executing JS inside the "folderFrame" window of the live Chameleon page
        // (Chameleon.cs: OpenFluidBalanceFromUrl, OpenOrdersForApproveFromUrl,
        // OpenLabFromUrl, OpenContagiousDiseaseFromUrl, OpenMedOrdersFromUrl) -
        // NOT by navigating the browser to the URL. They all end up calling
        // window.showModalDialog(...), which Chromium removed but Trident still
        // supports; running it inside the IE-mode frame is the only way to get
        // the same behaviour, and it leaves the user's patient context intact.
        //
        // Wire format: EXEC_SCRIPT|<frameName>|<base64-utf8 script>
        // The script is base64-encoded because it contains quotes, newlines and
        // '|' characters that would otherwise collide with the delimiter.
        // Returns "OK" on success, or "FAIL:<reason>" so the caller (native
        // host -> extension) can fall back to a plain new tab instead of the
        // user getting silently nothing. Parsing/decoding happens on whatever
        // thread calls this; only ExecScriptInFrame touches COM.
        private static string HandleExecScriptCommand(string line)
        {
            try
            {
                // Split into exactly 3 so any '|' inside the payload is safe.
                var parts = line.Split(new[] { '|' }, BridgeProtocol.ExecScriptFieldCount);
                if (parts.Length != BridgeProtocol.ExecScriptFieldCount)
                {
                    Log($"  -> [exec-script] Malformed command (expected {BridgeProtocol.ExecScriptFieldCount} fields, got {parts.Length}).");
                    return BridgeProtocol.Fail("malformed-command");
                }

                string frameName = parts[1];
                string script;
                try
                {
                    script = Encoding.UTF8.GetString(Convert.FromBase64String(parts[2]));
                }
                catch (FormatException ex)
                {
                    Log($"  -> [exec-script] Payload is not valid base64: {ex.Message}");
                    return BridgeProtocol.Fail("bad-base64");
                }

                Log($"  -> [exec-script] frame='{frameName}' script={script.Length} chars.");
                return ExecScriptInFrame(frameName, script);
            }
            catch (Exception ex)
            {
                Log($"  -> [exec-script] HandleExecScriptCommand failed: {ex}");
                return BridgeProtocol.Fail(ex.GetType().Name);
            }
        }

        // Marshals HandleExecScriptCommand onto the STA/UI thread and blocks
        // for its status, mirroring QuerySectorOnUiThread. Used by the duplex
        // EXEC_SCRIPT pipe branch.
        private static string ExecScriptOnUiThread(string line)
        {
            try
            {
                if (_uiMarshaller == null || !_uiMarshaller.IsHandleCreated)
                {
                    Log("  -> [exec-script] No UI marshaller available yet.");
                    return BridgeProtocol.Fail("no-ui-marshaller");
                }

                string result = BridgeProtocol.Fail("unknown");
                _uiMarshaller.Invoke(new Action(() => { result = HandleExecScriptCommand(line); }));
                return result;
            }
            catch (Exception ex)
            {
                Log($"  -> [exec-script] ExecScriptOnUiThread failed: {ex.Message}");
                return BridgeProtocol.Fail(ex.GetType().Name);
            }
        }

        // Reports whether the modal script we are about to run can possibly
        // work in this frame. showModalDialog is the single load-bearing API
        // for the Chameleon modal links, and IE11/Edge-IE-mode can have it
        // absent depending on document mode - in which case the script fails
        // at runtime inside a setTimeout, where nothing can observe it. Probing
        // the property directly turns that silent failure into a clear signal.
        private static bool FrameSupportsModalDialog(object frameWindow)
        {
            try
            {
                object fn = InvokeGet(frameWindow, "showModalDialog");
                return fn != null;
            }
            catch (Exception ex)
            {
                Log($"  -> [exec-script] showModalDialog probe failed: {ex.Message}");
                return false;
            }
        }

        // Fallback execution path for when window.execScript is unavailable or
        // rejects the call (E_FAIL). Appends a <script> element to the frame's
        // document, which works in every document mode. Best-effort only.
        private static bool TryInjectScriptElement(object frameWindow, string script)
        {
            try
            {
                object doc = InvokeGet(frameWindow, "document");
                if (doc == null) return false;

                object el = doc.GetType().InvokeMember(
                    "createElement", BindingFlags.InvokeMethod, null, doc, new object[] { "script" });
                if (el == null) return false;

                el.GetType().InvokeMember("text", BindingFlags.SetProperty, null, el, new object[] { script });

                object head = doc.GetType().InvokeMember(
                    "getElementsByTagName", BindingFlags.InvokeMethod, null, doc, new object[] { "head" });
                object parent = null;
                if (head != null)
                {
                    try
                    {
                        parent = head.GetType().InvokeMember(
                            "item", BindingFlags.InvokeMethod, null, head, new object[] { 0 });
                    }
                    catch { }
                }
                if (parent == null) parent = InvokeGet(doc, "body");
                if (parent == null) return false;

                parent.GetType().InvokeMember(
                    "appendChild", BindingFlags.InvokeMethod, null, parent, new object[] { el });
                return true;
            }
            catch (Exception ex)
            {
                Log($"  -> [exec-script] Script-element injection failed: {ex.Message}");
                return false;
            }
        }

        // Direct port of ChameleonSHDocVw.ExecScriptInFrame: walk the top
        // document's frames collection, match by window .name, and call the
        // frame window's own execScript. Deliberately resolved fresh each time
        // (never cached) - the frame objects are replaced on every navigation.
        // Resolves the top-level window that actually hosts the Chameleon
        // frameset in this process.
        //
        // ROOT CAUSE this exists to fix (2026-09-09): _topWebBrowserSite is a
        // STATIC, but Trident creates a BHO instance per browser object in the
        // process (tabs, popups, some frames). Every SetSite(non-null)
        // overwrote it, and SetSite(null) from ANY instance nulled it - even
        // when a different, still-live instance was the real Chameleon
        // frameset. So the bridge worked right after the tab opened and then
        // silently broke the moment any other browser object appeared or went
        // away: web.Document then threw TargetInvocationException, which is
        // what produced the endless "[pipe-owner] folderFrame check failed"
        // and "[dept-tab] ... failed", made patient clicks fall back to
        // "navigate back to list" (tab opens, patient never loads), and left
        // מחלקות stuck reporting inactive.
        //
        // We therefore keep ALL live sites and pick the right one on demand,
        // preferring whichever still exposes folderFrame. Never cached: the
        // correct site changes as tabs come and go.
        private static object GetTopWindow()
        {
            object[] sites;
            lock (_sitesLock)
            {
                sites = _liveSites.ToArray();
            }

            object fallback = null;
            foreach (var site in sites)
            {
                object win = TryGetWindowFromSite(site);
                if (win == null) continue;
                if (WindowHasFrame(win, "folderFrame")) return win;
                if (fallback == null) fallback = win;
            }
            return fallback;
        }

        // Reads site -> Document -> parentWindow, returning null instead of
        // throwing when the browser object is dead or still navigating.
        private static object TryGetWindowFromSite(object site)
        {
            try
            {
                var web = site as IWebBrowser2;
                if (web == null) return null;
                object doc = InvokeGet(web, "Document");
                return doc != null ? InvokeGet(doc, "parentWindow") : null;
            }
            catch
            {
                return null;
            }
        }

        private static bool WindowHasFrame(object win, string frameName)
        {
            try
            {
                return win.GetType().InvokeMember(
                    frameName, BindingFlags.GetProperty, null, win, null) != null;
            }
            catch
            {
                return false;
            }
        }

        // Resolves a named frame window off the TOP WINDOW.
        //
        // GOTCHA (2026-09-09): this must go through window.frames, NOT
        // document.frames. Reading "frames" off the document object throws a
        // bare COMException E_FAIL on Chameleon's frameset - which is exactly
        // what silently broke pipe-ownership detection and every exec-script.
        // The primary path here is the same idiom Jumper itself uses in
        // production (top.<frameName> as a property), with window.frames
        // enumeration only as a fallback.
        private static object FindFrameWindowByName(string frameName)
        {
            object topWin = GetTopWindow();
            if (topWin == null) return null;

            try
            {
                object direct = topWin.GetType().InvokeMember(
                    frameName, BindingFlags.GetProperty, null, topWin, null);
                if (direct != null) return direct;
            }
            catch
            {
                // Frameset not loaded yet, or no such frame - fall through.
            }

            try
            {
                object frames = InvokeGet(topWin, "frames");
                if (frames == null) return null;

                int frameCount = Convert.ToInt32(InvokeGet(frames, "length"));
                for (int i = 0; i < frameCount; i++)
                {
                    try
                    {
                        object frameWindow = frames.GetType().InvokeMember(
                            "item", BindingFlags.InvokeMethod, null, frames, new object[] { i });
                        if (frameWindow == null) continue;
                        if (string.Equals(InvokeGet(frameWindow, "name") as string, frameName, StringComparison.Ordinal))
                        {
                            return frameWindow;
                        }
                    }
                    catch
                    {
                        // inaccessible frame - keep looking
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"  -> [frames] window.frames enumeration failed: {ex.Message}");
            }

            return null;
        }

        private static string ExecScriptInFrame(string frameName, string script)
        {
            try
            {
                object frameWindow = FindFrameWindowByName(frameName);
                if (frameWindow == null)
                {
                    Log($"  -> [exec-script] Frame '{frameName}' not reachable from the top window.");
                    return BridgeProtocol.Fail("frame-not-found");
                }

                bool modalOk = FrameSupportsModalDialog(frameWindow);
                Log($"  -> [exec-script] Frame '{frameName}' found; showModalDialog available = {modalOk}.");

                if (!modalOk && script.IndexOf("showModalDialog", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    // Running it anyway would throw inside a setTimeout where
                    // no one can see it, and the user would just get nothing.
                    Log("  -> [exec-script] Frame cannot host showModalDialog - reporting failure so the caller can fall back.");
                    return BridgeProtocol.Fail("no-showmodaldialog");
                }

                try
                {
                    frameWindow.GetType().InvokeMember(
                        "execScript", BindingFlags.InvokeMethod, null, frameWindow,
                        new object[] { script, "JavaScript" });
                    Log($"  -> [exec-script] Executed in frame '{frameName}' via execScript.");
                    return BridgeProtocol.ReplyOk;
                }
                catch (Exception ex)
                {
                    // execScript was removed in IE11 standards mode and can
                    // also return a bare E_FAIL; fall back to injecting a
                    // <script> element, which works in every document mode.
                    Log($"  -> [exec-script] execScript failed ({ex.GetType().Name}: {ex.Message}); trying script-element injection.");
                }

                if (TryInjectScriptElement(frameWindow, script))
                {
                    Log($"  -> [exec-script] Executed in frame '{frameName}' via script-element injection.");
                    return BridgeProtocol.ReplyOk;
                }

                return BridgeProtocol.Fail("exec-rejected");
            }
            catch (Exception ex)
            {
                Log($"  -> [exec-script] ExecScriptInFrame failed: {ex}");
                return BridgeProtocol.Fail(ex.GetType().Name);
            }
        }

        // Mirrors Chameleon.OpenMedOrdersFromUrl's
        // internalBrowser.Document.InvokeScript("GetUserSector"). Touches live
        // COM objects so it must run on the UI thread; called synchronously from
        // the pipe thread, which blocks for the reply.
        private static string QuerySectorOnUiThread()
        {
            try
            {
                if (_uiMarshaller == null || !_uiMarshaller.IsHandleCreated)
                {
                    Log("  -> [sector] No UI marshaller available yet.");
                    return null;
                }

                string result = null;
                _uiMarshaller.Invoke(new Action(() =>
                {
                    try
                    {
                        object win = GetTopWindow();
                        if (win == null)
                        {
                            Log("  -> [sector] No top window available.");
                            return;
                        }

                        // GetUserSector() is not guaranteed to live on the top
                        // window - on the frameset it is defined inside one of
                        // the frames, where calling it on top throws. Locate the
                        // window that actually defines it, reusing the same
                        // search that finds OpenPatientRecord.
                        object target = SearchFramesForFunction(win, "GetUserSector", 6);
                        if (target == null)
                        {
                            Log("  -> [sector] GetUserSector not found on the top window or any frame.");
                            return;
                        }

                        object value = target.GetType().InvokeMember(
                            "GetUserSector", BindingFlags.InvokeMethod, null, target, null);
                        result = value != null ? value.ToString() : null;
                        Log($"  -> [sector] GetUserSector() returned '{result}'.");
                    }
                    catch (Exception ex)
                    {
                        Log($"  -> [sector] GetUserSector() failed: {ex.Message}");
                    }
                }));
                return result;
            }
            catch (Exception ex)
            {
                Log($"  -> [sector] QuerySectorOnUiThread failed: {ex.Message}");
                return null;
            }
        }

        // --- ROOT CAUSE of the spurious "Download Options" prompt ---
        //
        // The modern app (inextdata) asks for a patient to be opened by calling
        // window.open() on a SIGNAL URL on the bare, dotless host "chsw":
        //
        //   http://chsw/chameleon/login.asp?quickOpen=1&Id=...&PatientNum=...
        //
        // That endpoint is a pure signal. It carries the whole request in its
        // query string and is NEVER meant to actually be fetched - the
        // production Jumper app cancels it in WebView2's NewWindowRequested
        // handler with e.Handled = true, before any request leaves the process
        // (see Gecko.cs). Whatever the server returns for it is not renderable,
        // so if it IS fetched Trident routes the response down the download
        // path, producing the nameless ~6 KB "Download Options" entries.
        //
        // Confirmed from the log: a BRAND NEW iexplore.exe content process is
        // spun up, its very first BeforeNavigate2 is this signal URL, and 45 ms
        // later FileDownload fires twice. It is not the /Transform/ParseXsl
        // endpoint that was originally suspected - which is why no
        // Content-Disposition ever showed up in the Fiddler capture, and why it
        // only ever happens on a programmatic open (a manually clicked patient
        // never goes through a signal URL at all).
        //
        // The Edge extension already tries to reproduce WebView2's cancel via a
        // declarativeNetRequest block rule on host "chsw" (edge/rules.json).
        // That rule CANNOT work here: IE mode navigations are serviced by
        // Trident/WinINet and bypass Chromium's network stack entirely, so no
        // declarativeNetRequest rule is ever consulted. Cancelling in
        // BeforeNavigate2 is the IE-mode-side equivalent, and it is the only
        // place in this architecture where the fetch can be stopped before it
        // is issued.
        //
        // The match is deliberately restricted to the BARE, DOTLESS host "chsw"
        // - exactly what rules.json blocks. The real Chameleon origin
        // (chsw.tasmc.corp) contains a dot and can never match, so ordinary
        // browsing is untouched.
        private static bool IsModernAppSignalUrl(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;

            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;

            return string.Equals(uri.Host, "chsw", StringComparison.OrdinalIgnoreCase);
        }

        // --- Defence in depth: suppressing any download that still slips out ---
        //
        // With the signal URL cancelled above, no spurious download should ever
        // be started. The two layers below remain as backstops in case a
        // variant signal URL appears that the host match doesn't cover.
        //
        // Layer 1 - DWebBrowserEvents2::FileDownload (DISPID 270): the one
        // supported point where Trident asks before it acts. It fires the
        // instant a resource is classified as "must download", BEFORE any
        // download UI object exists; returning Cancel = true aborts the
        // transfer, so no dialog is ever constructed. No polling, no race.
        //
        // SAFETY: blanket-cancelling downloads would break legitimate ones (an
        // EHR does export documents), so this only cancels while suppression is
        // armed - a short window opened only by navigations WE initiate. A
        // user-initiated download never arms it and is never touched.
        // ActiveDocument downloads (in-place Office documents) always pass
        // through, since the spurious ones are never ActiveDocuments.
        //
        // NOTE: the armed flag is per-process on purpose. Arming it is only
        // useful in the process that will receive the FileDownload event, and
        // every site that arms it (BeforeNavigate2 on a signal URL, and our own
        // programmatic navigations) runs in that same process.
        private const int DownloadSuppressionWindowSeconds = 10;
        private static long _suppressDownloadsUntilTicks; // DateTime.UtcNow.Ticks; read/written via Interlocked

        // Call immediately BEFORE any navigation this BHO triggers itself.
        private static void ArmDownloadSuppression(string reason)
        {
            long until = DateTime.UtcNow.AddSeconds(DownloadSuppressionWindowSeconds).Ticks;
            long previous = Interlocked.Read(ref _suppressDownloadsUntilTicks);
            if (until > previous)
            {
                Interlocked.Exchange(ref _suppressDownloadsUntilTicks, until);
            }
            Log($"  -> [download-guard] armed for {DownloadSuppressionWindowSeconds}s ({reason}).");
        }

        private static bool IsDownloadSuppressionArmed()
        {
            return DateTime.UtcNow.Ticks < Interlocked.Read(ref _suppressDownloadsUntilTicks);
        }

        // --- Layer 2 backstop: dismiss a download prompt that still appears ---
        //
        // Only reached while suppression is armed (see the DownloadBegin branch
        // in TryAdviseEvents), i.e. only during a navigation we initiated, so it
        // can never touch a dialog belonging to a user-initiated action.
        //
        // Known limitation: it only closes a prompt that appears AFTER the
        // baseline snapshot taken when DownloadBegin fires; one raised earlier
        // is already in the baseline and gets skipped. That is acceptable
        // because layer 0 (cancelling the signal URL) stops the download before
        // any dialog can exist. Do not "fix" it by dropping the baseline - that
        // would make this close pre-existing, unrelated windows.
        //
        // This BHO instance is loaded into ONE of possibly several iexplore.exe
        // processes for the tab (IE mode can split into a broker + content
        // process under Enhanced Protected Mode). Confirmed via testing: the
        // prompt is a native #32770 dialog living in a DIFFERENT iexplore.exe
        // process than the one hosting this BHO, so we scan all iexplore.exe
        // processes by name. We only close windows matching that exact
        // class+title signature - an earlier, broader "close any new window"
        // version accidentally closed an unrelated legitimate app dialog
        // ("Message Center" / ריכוז הודעות, a real showModalDialog Chameleon
        // feature, class "Internet Explorer_TridentDlgFrame") - so we
        // deliberately do NOT touch anything but the specific
        // #32770/"...Download..." signature. Never widen this filter.
        private static readonly object _dismissLock = new object();

        private void DismissSpuriousDownloadPrompt()
        {
            // Only one dismiss-poll loop at a time; DownloadBegin can fire multiple
            // times in a burst (matches the "5 identical prompts" symptom).
            if (!Monitor.TryEnter(_dismissLock))
            {
                return;
            }
            try
            {
                var baseline = new HashSet<IntPtr>(EnumTopLevelWindowsForProcessName("iexplore"));
                Log($"  -> [DownloadBegin] snapshotting {baseline.Count} existing top-level window(s) across all iexplore.exe processes, polling for the download prompt...");

                var deadline = DateTime.UtcNow.AddSeconds(3);
                while (DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(150);
                    foreach (var hwnd in EnumTopLevelWindowsForProcessName("iexplore"))
                    {
                        if (baseline.Contains(hwnd)) continue;
                        if (!IsWindowVisible(hwnd)) continue;

                        string title = GetWindowTitle(hwnd);
                        string cls = GetWindowClass(hwnd);
                        baseline.Add(hwnd); // don't re-evaluate it again this loop

                        // Confirmed via testing: the real "View Downloads" prompt is a
                        // native #32770 dialog (NOT the Trident-hosted
                        // "Internet Explorer_TridentDlgFrame" class used by legitimate
                        // app modal dialogs like Chameleon's own Message Center) living
                        // in a *different* iexplore.exe process (IE mode's Enhanced
                        // Protected Mode broker/content split) - only close windows
                        // matching this exact signature so we never touch unrelated
                        // dialogs.
                        bool isDownloadPrompt = string.Equals(cls, "#32770", StringComparison.OrdinalIgnoreCase)
                            && title.IndexOf("Download", StringComparison.OrdinalIgnoreCase) >= 0;
                        if (isDownloadPrompt)
                        {
                            GetWindowThreadProcessId(hwnd, out int windowPid);
                            Log($"  -> [DownloadBegin] closing spurious download prompt: hwnd=0x{hwnd.ToInt64():X} pid={windowPid} class='{cls}' title='{title}'.");
                            CloseDialog(hwnd);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"  -> DismissSpuriousDownloadPrompt failed: {ex}");
            }
            finally
            {
                Monitor.Exit(_dismissLock);
            }
        }

        private static IEnumerable<IntPtr> EnumTopLevelWindowsForProcessName(string processNameWithoutExe)
        {
            var pids = new HashSet<int>(
                Process.GetProcesses()
                    .Where(p => string.Equals(p.ProcessName, processNameWithoutExe, StringComparison.OrdinalIgnoreCase))
                    .Select(p => p.Id));

            var result = new List<IntPtr>();
            EnumWindows((hwnd, _) =>
            {
                GetWindowThreadProcessId(hwnd, out int windowPid);
                if (pids.Contains(windowPid))
                {
                    result.Add(hwnd);
                }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        private static string GetWindowTitle(IntPtr hwnd)
        {
            var sb = new StringBuilder(256);
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static string GetWindowClass(IntPtr hwnd)
        {
            var sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        private const uint WM_CLOSE = 0x0010;
        private const uint WM_COMMAND = 0x0111;
        private const uint BM_CLICK = 0x00F5;
        private const int IDCANCEL = 2;

        // Native #32770 dialogs (like IE mode's "Download Options" prompt) often
        // don't respond to WM_CLOSE at all - they only act when their Cancel
        // button is actually clicked. GetDlgItem+BM_CLICK simulates that click
        // directly (works cross-process for standard Win32 controls), which is
        // far more reliable than WM_CLOSE. WM_CLOSE is kept as a fallback in case
        // the dialog has no child with the standard IDCANCEL=2 id.
        private static void CloseDialog(IntPtr hwndDialog)
        {
            IntPtr cancelButton = GetDlgItem(hwndDialog, IDCANCEL);
            if (cancelButton != IntPtr.Zero)
            {
                PostMessage(cancelButton, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
            }
            else
            {
                PostMessage(hwndDialog, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    }
}



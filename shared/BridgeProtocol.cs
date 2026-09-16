using System;

namespace Jumper.Bridge
{
    // SINGLE SOURCE OF TRUTH for the wire protocol between the native messaging
    // host (JumperNativeHost.exe, launched by Edge) and the BHO (JumperBho.dll,
    // loaded by Trident into iexplore.exe).
    //
    // This file is LINKED into both projects rather than shared via a project
    // reference, because the two assemblies are deployed and registered
    // completely independently - the BHO is COM-registered for iexplore, the
    // host is spawned by Edge - and neither should acquire a dependency on the
    // other's binary. Each assembly compiles its own copy of these constants.
    //
    // WHY THIS EXISTS: these values were previously duplicated as bare string
    // literals on both sides ("JumperBhoBridge" appeared four times in the host
    // alone). A drift between the two would not fail to compile and would not
    // log an error - the host would simply hang on Connect() until it timed
    // out, or the BHO would fall through to its "unknown command" branch and
    // treat the line as patient arguments. Silent failure is the whole reason
    // this file exists; keep new protocol values here.
    //
    // If you change anything in this file, REBUILD BOTH PROJECTS. Rebuilding
    // only one reintroduces exactly the drift this is meant to prevent.
    internal static class BridgeProtocol
    {
        // --- Transport ---------------------------------------------------

        // The BHO hosts the server; the native host is always the client.
        // Note the BHO only starts a server in a process whose top document
        // actually has a folderFrame - otherwise popup processes race for
        // ownership of this name and answer commands they cannot execute.
        public const string PipeName = "JumperBhoBridge";

        // For log messages only - never pass this to NamedPipeClientStream,
        // which takes the bare name above.
        public const string PipeDisplayPath = @"\\.\pipe\" + PipeName;

        // How long the host waits for a BHO to accept a connection. A miss
        // means "no Chameleon tab is open", which is a normal state, not an
        // error - callers should degrade rather than throw.
        public const int ConnectTimeoutMs = 3000;

        // --- Commands (host -> BHO) --------------------------------------
        //
        // One line per command, UTF8, newline-terminated. Compared with
        // OrdinalIgnoreCase on the BHO side.

        public const string FieldSeparator = "|";

        // Duplex. Reply: ReplyTrue / ReplyFalse.
        public const string CmdQueryDeptTab = "QUERY_DEPT_TAB";

        // Duplex. Reply: the sector string, or empty if unavailable.
        // An empty sector produces a MedOrders URL ending in "&Sector=", which
        // Chameleon answers with PermissionDenied.aspx - so callers must treat
        // empty as a failure, not as a usable value.
        public const string CmdQuerySector = "QUERY_SECTOR";

        // Duplex, parameterised. Full wire format:
        //     EXEC_SCRIPT|<frameName>|<base64-utf8 script>
        // Reply: ReplyOk or ReplyFailPrefix + reason.
        // Base64 is used so the script body can contain the field separator.
        public const string CmdExecScript = "EXEC_SCRIPT";
        public const string CmdExecScriptPrefix = CmdExecScript + FieldSeparator;
        public const int ExecScriptFieldCount = 3;

        // Anything not matching the above is treated as an OpenPatientRecord
        // argument line - see PatientFieldOrder.

        // The frame that hosts Chameleon's callable JS (OpenPatientRecord,
        // and the target for showModalDialog).
        public const string DefaultFrame = "folderFrame";

        // --- Replies (BHO -> host) ---------------------------------------

        public const string ReplyOk = "OK";

        // Always followed by a short machine-readable reason, e.g.
        // "FAIL:no-showmodaldialog", "FAIL:frame-not-found". The extension
        // uses any FAIL to fall back to opening a plain new tab, so that a
        // failure is visible to the user instead of silently doing nothing.
        public const string ReplyFailPrefix = "FAIL:";

        public const string ReplyTrue = "1";
        public const string ReplyFalse = "0";

        public static string Fail(string reason)
        {
            return ReplyFailPrefix + reason;
        }

        public static bool IsOk(string reply)
        {
            return string.Equals(reply, ReplyOk, StringComparison.OrdinalIgnoreCase);
        }

        // --- OpenPatientRecord argument order ----------------------------

        // The order Chameleon's OpenPatientRecord(...) expects its arguments,
        // reverse-engineered from view-source of the function body. The host
        // builds the line in this order and the BHO passes the split parts
        // straight through to the JS call, so the two MUST agree.
        //
        // These are the keys the extension sends in its JSON message.
        public static readonly string[] PatientFieldOrder =
        {
            "patient",
            "unit",
            "medicalRecord",
            "recordChar",
            "recordPart",
            "unitName",
            "admissionDate",
            "endDate",
            "idNum",
        };

        // Defaults, positionally aligned with PatientFieldOrder above.
        // The POC proved even guessed values ("0", "", hospital-as-idNum)
        // render the full record page correctly.
        public static readonly string[] PatientFieldDefaults =
        {
            "",     // patient
            "",     // unit
            "",     // medicalRecord
            "0",    // recordChar
            "0",    // recordPart
            "",     // unitName
            "",     // admissionDate
            "",     // endDate
            "101",  // idNum
        };

        public const int PatientFieldCount = 9;
    }
}

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

        // --- Commands (host -> BHO) --------------------------------------
        //
        // One line per command, UTF8, newline-terminated. Compared with
        // OrdinalIgnoreCase on the BHO side.

        // Duplex. Reply: ReplyTrue / ReplyFalse.
        public const string CmdQueryDeptTab = "QUERY_DEPT_TAB";

        // --- Replies (BHO -> host) ---------------------------------------

        public const string ReplyTrue = "1";
        public const string ReplyFalse = "0";

    }
}

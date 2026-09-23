using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Jumper.Bridge;

namespace JumperNativeHost
{
    // Minimal native messaging host: implements Chrome/Edge's stdio protocol
    // (4-byte little-endian length prefix + UTF8 JSON, both directions),
    // queries the BHO's department-tab state, and launches Namer.
    //
    // Edge launches this process on demand when the extension calls
    // chrome.runtime.connectNative(hostName), and keeps it alive for as long
    // as the port stays connected; it kills the process (closes stdin) when
    // the extension disconnects, which is what ends our main loop below.
    internal static class Program
    {
        private static readonly string LogPath = @"C:\Temp\jumper-native-host.log";

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
                // Never let logging crash the host.
            }
        }

        private static int Main(string[] args)
        {
            Log("JumperNativeHost started.");
            var serializer = new JavaScriptSerializer();

            using (var stdin = Console.OpenStandardInput())
            using (var stdout = Console.OpenStandardOutput())
            {
                while (true)
                {
                    byte[] lengthBytes = ReadExact(stdin, 4);
                    if (lengthBytes == null)
                    {
                        Log("stdin closed (extension disconnected) - exiting.");
                        break;
                    }

                    int length = BitConverter.ToInt32(lengthBytes, 0);
                    byte[] payload = ReadExact(stdin, length);
                    if (payload == null)
                    {
                        Log("stdin closed mid-message - exiting.");
                        break;
                    }

                    string json = Encoding.UTF8.GetString(payload);
                    Log($"Received: {json}");

                    Dictionary<string, object> response;
                    try
                    {
                        var msg = serializer.Deserialize<Dictionary<string, object>>(json);
                        string type = msg != null && msg.TryGetValue("type", out var t) && t != null ? t.ToString() : null;

                        if (string.Equals(type, "queryDeptTab", StringComparison.OrdinalIgnoreCase))
                        {
                            bool active = QueryDeptTabState();
                            response = new Dictionary<string, object> { { "ok", true }, { "active", active } };
                            Log($"QUERY_DEPT_TAB -> active={active}");
                        }
                        else if (string.Equals(type, "launchNamer", StringComparison.OrdinalIgnoreCase))
                        {
                            string patnum = msg.TryGetValue("patnum", out var p) && p != null ? p.ToString() : null;
                            LaunchNamer(patnum);
                            response = new Dictionary<string, object> { { "ok", true } };
                            Log($"LAUNCH_NAMER -> patnum={patnum}");
                        }
                        else
                        {
                            throw new ArgumentException($"Unknown native message type '{type}'.");
                        }
                    }
                    catch (Exception ex)
                    {
                        Log($"Failed to relay: {ex}");
                        response = new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } };
                    }

                    WriteMessage(stdout, serializer.Serialize(response));
                }
            }

            return 0;
        }

        // --- Namer: launching the native SAP app ---
        //
        // Mirrors Chameleon.OpenNamerFromUrl. Namer is NOT a web page - the
        // Chameleon/Namer?NamerNo=... URL is a pure signal, and the real app
        // responds by launching \\focus-fs\sap$\NamerButton.exe with
        // "PROD <patnum> <patnum>". Navigating a browser to that URL (which is
        // what the extension used to do) is meaningless.
        //
        // SECURITY: the extension supplies ONLY a patient number, never a path
        // or command line, and it is validated as digits-only before use. The
        // executable path is hardcoded here, matching Constants.NAMER_PATH, so
        // a compromised/buggy extension cannot turn this into arbitrary process
        // execution.
        private const string NamerPath = @"\\focus-fs\sap$\NamerButton.exe";
        private const string SapLogonPath = @"C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplgpad.exe";

        private static void LaunchNamer(string patnum)
        {
            if (string.IsNullOrWhiteSpace(patnum) || !Regex.IsMatch(patnum, @"^\d+$"))
            {
                throw new ArgumentException($"launchNamer requires a digits-only 'patnum' (got '{patnum}').");
            }

            EnsureSapLogonRunning();

            Process.Start(new ProcessStartInfo
            {
                FileName = NamerPath,
                Arguments = "PROD " + patnum + " " + patnum,
                UseShellExecute = true,
            });
        }

        // Mirrors Chameleon.EnsureSapLogonRunning - NamerButton.exe throws a VBS
        // error if SAP Logon isn't already running (noted in Jumper's source as
        // "not our bug").
        private static void EnsureSapLogonRunning()
        {
            try
            {
                if (Process.GetProcessesByName("saplgpad").Any()) return;

                Process.Start(new ProcessStartInfo
                {
                    FileName = SapLogonPath,
                    UseShellExecute = true,
                });

                Thread.Sleep(2000);
            }
            catch (Exception ex)
            {
                Log($"EnsureSapLogonRunning failed (continuing anyway): {ex.Message}");
            }
        }

        // Sends "QUERY_DEPT_TAB" over a duplex connection and reads the
        // single "1"/"0" response line the BHO's pipe server writes back
        // (see BhoObject.cs PipeServerLoop). Returns false (not active) if no
        // Chameleon tab/BHO is currently listening, rather than throwing -
        // this is a routine, expected state (e.g. before Chameleon is opened).
        private static bool QueryDeptTabState()
        {
            using (var client = new NamedPipeClientStream(".", BridgeProtocol.PipeName, PipeDirection.InOut))
            {
                try
                {
                    client.Connect(1500);
                }
                catch (TimeoutException)
                {
                    return false;
                }

                // NOTE: writer and reader both wrap the SAME underlying
                // `client` stream, and both StreamWriter/StreamReader close
                // their underlying stream on Dispose by default - nesting
                // them in separate `using` blocks caused a double-dispose
                // (ObjectDisposedException: "Cannot access a closed pipe")
                // once the first one closed `client` out from under the
                // second. Don't wrap them in `using` here; the outer
                // `using (client)` above already closes everything once.
                var writer = new StreamWriter(client, Encoding.UTF8) { AutoFlush = true };
                var reader = new StreamReader(client);
                writer.WriteLine(BridgeProtocol.CmdQueryDeptTab);
                string response = reader.ReadLine();
                return response != null && response.Trim() == "1";
            }
        }

        private static byte[] ReadExact(Stream stream, int count)
        {
            var buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read == 0) return null; // EOF
                offset += read;
            }
            return buffer;
        }

        private static void WriteMessage(Stream stdout, string json)
        {
            byte[] payload = Encoding.UTF8.GetBytes(json);
            byte[] length = BitConverter.GetBytes(payload.Length);
            stdout.Write(length, 0, length.Length);
            stdout.Write(payload, 0, payload.Length);
            stdout.Flush();
        }
    }
}

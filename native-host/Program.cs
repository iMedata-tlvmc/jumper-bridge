using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace JumperNativeHost
{
    // Minimal native messaging host: implements Chrome/Edge's stdio protocol
    // (4-byte little-endian length prefix + UTF8 JSON, both directions) and
    // launches Namer.
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

                        if (string.Equals(type, "launchNamer", StringComparison.OrdinalIgnoreCase))
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
                        Log($"Command failed: {ex}");
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

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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

        // The log file is plaintext on disk (C:\Temp) and may be copied into a
        // support ticket, so patient numbers are masked before being written -
        // keep the last 3 digits for troubleshooting, mask the rest.
        private static string MaskPatnum(string patnum)
        {
            if (string.IsNullOrEmpty(patnum)) return patnum;
            return patnum.Length <= 3
                ? new string('*', patnum.Length)
                : new string('*', patnum.Length - 3) + patnum.Substring(patnum.Length - 3);
        }

        // Best-effort: the only PHI-shaped field in native messages today is
        // "patnum". Mask its value inside the raw JSON before it hits the log.
        private static string RedactPatnumInJson(string json)
        {
            try
            {
                return Regex.Replace(
                    json,
                    "(\"patnum\"\\s*:\\s*\")(\\d+)(\")",
                    m => m.Groups[1].Value + MaskPatnum(m.Groups[2].Value) + m.Groups[3].Value);
            }
            catch
            {
                return "[unredactable]";
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
                    Log($"Received: {RedactPatnumInJson(json)}");

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
                            Log($"LAUNCH_NAMER -> patnum={MaskPatnum(patnum)}");
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
            LogExecutableIntegrity(NamerPath);

            Process.Start(new ProcessStartInfo
            {
                FileName = NamerPath,
                Arguments = "PROD " + patnum + " " + patnum,
                UseShellExecute = true,
            });
        }

        // SECURITY (advisory, not enforced): NamerPath is a UNC path on a file
        // share, not a locally-installed executable, so unlike SapLogonPath it
        // has no local ACL/AV protection we control. This does NOT block the
        // launch - we don't know whether NamerButton.exe is Authenticode-signed
        // by SAP/IT, so a hard fail-closed check here risks breaking a live
        // clinical workflow (opening Namer) on unverified assumptions.
        // Instead we log the file's SHA-256 hash and signature status every
        // launch, giving IT an audit trail to detect tampering after the fact
        // and a basis for turning this into a hard pin once the real signing
        // status is confirmed. See docs/decisions.md.
        private static void LogExecutableIntegrity(string path)
        {
            try
            {
                if (!File.Exists(path))
                {
                    Log($"INTEGRITY_CHECK {path} -> file not found (skipped).");
                    return;
                }

                string hash;
                using (var sha256 = SHA256.Create())
                using (var stream = File.OpenRead(path))
                {
                    hash = BitConverter.ToString(sha256.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                }

                bool trusted = Authenticode.IsSignedAndTrusted(path);
                Log($"INTEGRITY_CHECK {path} -> sha256={hash} signedAndTrusted={trusted}");
            }
            catch (Exception ex)
            {
                Log($"INTEGRITY_CHECK {path} -> failed: {ex.Message}");
            }
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

    // Thin WinVerifyTrust wrapper: reports whether a file has an Authenticode
    // signature that chains to a trusted root, without requiring a network
    // round-trip (revocation checking is intentionally disabled, since this
    // runs on a hospital LAN and must not hang/fail just because a CRL/OCSP
    // endpoint is unreachable). Used for advisory logging only - see
    // LogExecutableIntegrity above for why this isn't a hard gate.
    internal static class Authenticode
    {
        private const uint WTD_UI_NONE = 2;
        private const uint WTD_REVOKE_NONE = 0;
        private const uint WTD_CHOICE_FILE = 1;
        private const uint WTD_STATEACTION_VERIFY = 1;
        private const uint WTD_STATEACTION_CLOSE = 2;
        private static readonly Guid WINTRUST_ACTION_GENERIC_VERIFY_V2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pInfoStruct;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public string pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid pgActionID, IntPtr pWVTData);

        public static bool IsSignedAndTrusted(string filePath)
        {
            var fileInfo = new WINTRUST_FILE_INFO
            {
                cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)),
                pcwszFilePath = filePath,
            };

            IntPtr fileInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(fileInfo));
            IntPtr dataPtr = IntPtr.Zero;
            try
            {
                Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);

                var data = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                    dwUIChoice = WTD_UI_NONE,
                    fdwRevocationChecks = WTD_REVOKE_NONE,
                    dwUnionChoice = WTD_CHOICE_FILE,
                    pInfoStruct = fileInfoPtr,
                    dwStateAction = WTD_STATEACTION_VERIFY,
                };

                dataPtr = Marshal.AllocHGlobal(Marshal.SizeOf(data));
                Marshal.StructureToPtr(data, dataPtr, false);

                int result = WinVerifyTrust(new IntPtr(-1), WINTRUST_ACTION_GENERIC_VERIFY_V2, dataPtr);

                // Always release the state handle WinVerifyTrust allocated,
                // regardless of the verification result.
                data.dwStateAction = WTD_STATEACTION_CLOSE;
                Marshal.StructureToPtr(data, dataPtr, true);
                WinVerifyTrust(new IntPtr(-1), WINTRUST_ACTION_GENERIC_VERIFY_V2, dataPtr);

                return result == 0; // 0 == ERROR_SUCCESS: fully trusted chain.
            }
            catch
            {
                return false;
            }
            finally
            {
                Marshal.FreeHGlobal(fileInfoPtr);
                if (dataPtr != IntPtr.Zero) Marshal.FreeHGlobal(dataPtr);
            }
        }
    }
}

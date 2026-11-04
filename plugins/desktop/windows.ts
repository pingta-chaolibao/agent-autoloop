// Notification text travels as JSON on stdin; none of it is interpolated into PowerShell source.
import { execFile } from "node:child_process";
import { powershell } from "../../host/windows.ts";

const script = `$ErrorActionPreference='Stop';
Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
$message=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$icon=New-Object System.Windows.Forms.NotifyIcon;
$icon.Icon=[System.Drawing.SystemIcons]::Information; $icon.Visible=$true;
try { $icon.ShowBalloonTip(5000,$message.title,$message.body,[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Milliseconds 5500 }
finally { $icon.Dispose() }`;

const [title, body] = process.argv.slice(2);
const child = execFile(
  powershell,
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  { windowsHide: true, timeout: 20_000 },
  (error) => {
    if (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  },
);
child.stdin!.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.stdin!.end(JSON.stringify({ title, body }));

// Notification text travels as JSON on stdin; none of it is interpolated into PowerShell source.
import { execFile } from "node:child_process";
import { powershell } from "../../host/windows.ts";

export const readMessage = `$ErrorActionPreference='Stop';
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
$message=[Console]::In.ReadToEnd() | ConvertFrom-Json;`;
const script = `${readMessage}
Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
$icon=New-Object System.Windows.Forms.NotifyIcon;
$icon.Icon=[System.Drawing.SystemIcons]::Information; $icon.Visible=$true;
try { $icon.ShowBalloonTip(5000,$message.title,$message.body,[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Milliseconds 5500 }
finally { $icon.Dispose() }`;

export function notifyWindows(title: string, body: string) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 20_000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
    child.stdin!.on("error", (error) => {
      reject(error);
    });
    child.stdin!.end(JSON.stringify({ title, body }));
  });
}
if (import.meta.main)
  notifyWindows(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import { powershell, processInfo, psLiteral, windowsScript } from "./windows.ts";

const identity = path.join(HOME, "up.identity.json");
export const stopFile = path.join(HOME, "up.stop");
const description = `Agent Autoloop ${HOME}`;

export function recordWindowsUp() {
  const info = processInfo(process.pid);
  if (!info) throw new Error("无法确认中台进程身份");
  writeFileSync(identity, JSON.stringify({ pid: process.pid, ...info }), { mode: 0o600 });
  rmSync(stopFile, { force: true });
}
export function clearWindowsUp() {
  rmSync(identity, { force: true });
}
export function runningWindowsUp() {
  if (!existsSync(identity) || !existsSync(path.join(HOME, "up.pid"))) return null;
  const saved = JSON.parse(readFileSync(identity, "utf8"));
  if (Number(readFileSync(path.join(HOME, "up.pid"), "utf8")) !== saved.pid) return null;
  const current = processInfo(saved.pid);
  return current && current.created === saved.created && current.command === saved.command
    ? (saved.pid as number)
    : null;
}
export function installWindowsService(label: string, program: string, commit: string, stop: () => void) {
  const command = `& ${[process.execPath, "--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, "windows-background.ts"), program, HOME, commit].map(psLiteral).join(" ")}; exit $LASTEXITCODE`;
  const args = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
  windowsScript(`
    $name=${psLiteral(label)}; $description=${psLiteral(description)};
    $old=Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $name };
    if($old -and $old.Description -ne $description){throw '同名任务属于其他程序，未修改'}
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $action=New-ScheduledTaskAction -Execute ${psLiteral(powershell)} -Argument ${psLiteral(args)} -WorkingDirectory ${psLiteral(path.dirname(path.dirname(program)))};
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew;
    Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null;
  `);
  rmSync(path.join(HOME, "service.stop"), { force: true });
  stop();
  windowsScript(
    `for($i=0;$i -lt 50;$i++){ $task=Get-ScheduledTask -TaskName ${psLiteral(label)} -TaskPath '\\'; if($task.State -ne 'Running'){break}; Start-Sleep -Milliseconds 100 }; Start-ScheduledTask -TaskName ${psLiteral(label)} -TaskPath '\\';`,
  );
}
export function removeWindowsService(label: string, stop: () => void) {
  if (existsSync(HOME)) writeFileSync(path.join(HOME, "service.stop"), "stop");
  stop();
  windowsScript(
    `$task=Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq ${psLiteral(label)} }; if($task -and $task.Description -eq ${psLiteral(description)}) { Stop-ScheduledTask -TaskName ${psLiteral(label)} -TaskPath '\\' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psLiteral(label)} -TaskPath '\\' -Confirm:$false }`,
  );
}
export function windowsServiceRunning(label: string) {
  return (
    windowsScript(
      `$task=Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq ${psLiteral(label)} }; if($task -and $task.Description -eq ${psLiteral(description)} -and $task.State -eq 'Running'){'yes'}`,
    ) === "yes"
  );
}

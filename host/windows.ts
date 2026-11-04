// Windows host operations stay outside the deterministic kernel. Values become arguments or quoted literals, never code.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";

export const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
export const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function windowsScript(script: string): string {
  const prefix =
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
  return execFileSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(prefix + script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

export function processInfo(pid: number): { command: string | null; created: string } | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const text = nativeWindows("process", String(pid));
  return text ? JSON.parse(text) : null;
}

let nativeHost: string | undefined;
export function windowsHost() {
  if (nativeHost) return nativeHost;
  const source = path.join(import.meta.dirname, "../worker/windows-job.cs");
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const folder = path.join(HOME, "native");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = path.join(folder, `windows-${hash}.exe`);
  if (!existsSync(target)) {
    const temporary = path.join(folder, `${randomUUID()}.exe`);
    try {
      windowsScript(
        `Add-Type -Path ${psLiteral(source)} -ReferencedAssemblies @('System.dll','System.Core.dll','System.Management.dll','System.Web.Extensions.dll') -OutputAssembly ${psLiteral(temporary)} -OutputType ConsoleApplication`,
      );
      if (!existsSync(target)) renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return (nativeHost = target);
}

export function nativeWindows(...args: string[]) {
  return execFileSync(windowsHost(), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** npm's batch shims only launch Node. Resolve that script so a prompt never passes through cmd.exe expansion. */
export function windowsCommand(argv: string[]): string[] {
  const [program, ...args] = argv;
  if (!/\.(cmd|bat)$/i.test(program)) return argv;
  const shim = readFileSync(program, "utf8");
  const script = /[" ]%dp0%[\\/]([^"\r\n]+\.(?:m?js|cjs))[" ]/i.exec(shim)?.[1];
  const file = script && path.resolve(path.dirname(program), script);
  if (!file || !existsSync(file))
    throw new Error(`Windows 命令请使用可执行文件或 node 脚本，不能安全地直接启动 ${program}`);
  return [process.execPath, file, ...args];
}

let sid: string | undefined;
export function privateWindowsDirectory(directory: string) {
  sid ??= /S-1-\d+(?:-\d+)+/.exec(
    execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }),
  )?.[0];
  if (!sid) throw new Error("无法确定本机用户，不能保护中台资料目录");
  execFileSync(
    "icacls.exe",
    [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
    { stdio: "ignore", windowsHide: true },
  );
}

// The detached Windows runner owns the process Job Object and publishes its exit only after every descendant stops.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nativeWindows, processInfo, windowsCommand, windowsHost } from "../host/windows.ts";
import { findProgram } from "./agents.ts";

export const windowsFiles = (dir: string, turn: number) => ({
  spec: path.join(dir, `command-${turn}.json`),
  stop: path.join(dir, `stop-${turn}`),
});
const jobName = (spec: string) =>
  `Local\\AgentAutoloop-${createHash("sha256").update(spec).digest("hex").slice(0, 40)}`;

export function launchWindows(
  dir: string,
  turn: number,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  marker: string,
  log: (line: string) => void,
) {
  const { spec, stop } = windowsFiles(dir, turn);
  const [program, ...args] = windowsCommand([findProgram(argv[0]), ...argv.slice(1)]);
  const files = {
    out: path.join(dir, `stdout-${turn}.log`),
    err: path.join(dir, `stderr-${turn}.log`),
    exit: path.join(dir, `exit-${turn}`),
  };
  writeFileSync(spec, JSON.stringify({ program, args, cwd, ...files, stop, job: jobName(spec) }), { mode: 0o600 });
  const bootstrap = path.join(dir, `runner-${turn}.log`);
  const output = openSync(bootstrap, "w");
  const child = spawn(windowsHost(), ["run", spec, marker], {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  child.on("error", (error) => {
    writeFileSync(files.err, error.message);
    writeFileSync(files.exit, "1");
    log(String(error));
  });
  child.on("exit", (code) => {
    if (existsSync(files.exit)) return;
    appendFileSync(files.err, readFileSync(bootstrap, "utf8") || `Windows 启动进程退出：${code}`);
    writeFileSync(files.exit, "1");
  });
  child.unref();
  return { pid: child.pid, created: child.pid ? processInfo(child.pid)?.created : undefined };
}

export function windowsAlive(pid: number | undefined, dir: string, turn: number, marker: string, created?: string) {
  const { spec } = windowsFiles(dir, turn);
  const info = pid && processInfo(pid);
  if (info && (created ? info.created === created : info.command?.includes(marker) && info.command?.includes(spec)))
    return true;
  // A killed runner closes its job, but termination of its children can still be in flight.
  return Number(nativeWindows("active", jobName(spec))) > 0;
}

export function stopWindows(
  pid: number | undefined,
  dir: string,
  turn: number,
  marker: string,
  force: boolean,
  created?: string,
) {
  const { spec, stop } = windowsFiles(dir, turn);
  writeFileSync(stop, "stop");
  if (!force) return;
  nativeWindows("stop", jobName(spec));
  const info = pid && processInfo(pid);
  if (info && (created ? info.created === created : info.command?.includes(marker) && info.command?.includes(spec)))
    process.kill(pid!, "SIGKILL");
}

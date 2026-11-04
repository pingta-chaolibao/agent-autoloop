// Task Scheduler starts this hidden process with the installed program and data directory as literal arguments.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

const [program, home, commit] = process.argv.slice(2);
if (!path.isAbsolute(program) || !path.isAbsolute(home))
  throw new Error("Windows 常驻入口需要程序和资料目录的绝对路径");
mkdirSync(path.join(home, "logs"), { recursive: true });
const log = path.join(home, "logs/up.log");
const serviceStop = path.join(home, "service.stop");
function current() {
  const file = path.join(home, "installation.json");
  if (!existsSync(file)) return { program, commit };
  const installation = JSON.parse(readFileSync(file, "utf8"));
  const active = JSON.parse(readFileSync(path.join(installation.root, "active.json"), "utf8"));
  const expected = path.resolve(installation.root, "releases", active.commit, "bin/agent-autoloop.ts");
  if (
    active.application !== "agent-autoloop" ||
    active.id !== installation.id ||
    !/^[a-f0-9]{40}$/.test(active.commit) ||
    path.resolve(active.home).toLowerCase() !== path.resolve(home).toLowerCase() ||
    path.resolve(active.program).toLowerCase() !== expected.toLowerCase()
  )
    throw new Error("运行版本记录与此安装不一致");
  return active as { program: string; commit: string };
}
// Keep the Scheduler action alive across worker restarts, so its outer process job cannot reap running Agents.
while (!existsSync(serviceStop)) {
  let code = 1;
  try {
    const active = current();
    const output = openSync(log, "a");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", active.program, "up"], {
      cwd: path.dirname(path.dirname(active.program)),
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_COMMIT: active.commit },
      windowsHide: true,
      stdio: ["ignore", output, output],
    });
    closeSync(output);
    code = await new Promise<number>((resolve) => {
      child.on("error", (error) => {
        appendFileSync(log, String(error) + "\n");
        resolve(1);
      });
      child.on("exit", (value) => resolve(value ?? 1));
    });
  } catch (error) {
    appendFileSync(log, String(error) + "\n");
  }
  if (existsSync(serviceStop)) break;
  await new Promise((resolve) => setTimeout(resolve, code === 0 ? 1000 : 10_000));
}

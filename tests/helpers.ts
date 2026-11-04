// Each test file runs in its own process with its own home and the fixture rules; modules are imported after this sets
// the environment they read.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after } from "node:test";

export function setup(name: string, rules = "rules.fixture.json") {
  const directory = mkdtempSync(join(tmpdir(), `agent-autoloop-${name}-`));
  process.env.AGENT_AUTOLOOP_HOME = directory;
  process.env.AGENT_AUTOLOOP_RULES = rules.startsWith("/") ? rules : join(import.meta.dirname, rules);
  process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
  const clean = () => {
    // SQLite keeps Windows files open until the last handle closes; exit follows the server's after hooks.
    if (process.platform === "win32" && existsSync(join(directory, "hub.db"))) {
      const { db } = createRequire(import.meta.url)("../host/runtime.ts") as typeof import("../host/runtime.ts");
      if (db.isOpen) db.close();
    }
    rmSync(directory, { recursive: true, force: true });
  };
  if (process.platform === "win32") process.once("exit", clean);
  else after(clean);
  return directory;
}

/** A moment in a test's own time, minutes after a fixed start: 10:00 in Asia/Shanghai. */
export const at = (minutes: number) => Date.parse("2026-10-18T02:00:00.000Z") + minutes * 60_000;

/** A fake CLI with the same Node entry on both systems, without interpreting any command arguments as shell text. */
export function nodeCommand(file: string, source: string) {
  if (process.platform !== "win32") {
    writeFileSync(file, source, { mode: 0o755 });
    return file;
  }
  writeFileSync(`${file}.mjs`, source);
  writeFileSync(`${file}.cmd`, `@node "%dp0%\\${basename(file)}.mjs" %*`);
  return `${file}.cmd`;
}

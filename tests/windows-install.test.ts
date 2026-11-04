// Failure modes: the installer deploys uncommitted files, replaces configuration, cannot launch from a Windows path,
// or uninstall deletes data/source/unrelated files. No real service, notification or model is started.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { nodeCommand } from "./helpers.ts";

test(
  "Windows installs the committed HEAD and uninstalls only its own program, preserving data",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async (t) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "autoloop-windows-install-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
    const source = path.join(scratch, "source");
    const root = path.join(scratch, "install ' & %local%");
    const home = path.join(root, "data");
    const engine = path.join(import.meta.dirname, "..");
    for (const name of [
      "bin",
      "cli",
      "host",
      "kernel",
      "plugins",
      "protocol",
      "skills",
      "worker",
      "install.ps1",
      "package.json",
      ".gitignore",
    ])
      cpSync(path.join(engine, name), path.join(source, name), { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Windows Test", "-c", "user.email=test@example.invalid", ...args], {
        cwd: source,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "fixture");
    const commit = git("rev-parse", "HEAD");
    writeFileSync(path.join(source, "uncommitted.txt"), "must not be installed");
    const tools = path.join(scratch, "tools");
    mkdirSync(tools);
    nodeCommand(path.join(tools, "codex"), `#!${process.execPath}\nconsole.log('fake Codex');`);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, "rules.json"),
      JSON.stringify({ sources: { local: { name: "本机" } }, agents: {}, channels: {}, rules: [] }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}` };
    delete env.AGENT_AUTOLOOP_HOME;
    delete env.AGENT_AUTOLOOP_RULES;
    delete env.AGENT_AUTOLOOP_COMMIT;
    const powershell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const install = () =>
      promisify(execFile)(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(source, "install.ps1"),
          "-Repo",
          source,
          "-Root",
          root,
          "-DataDirectory",
          home,
          "-NoService",
        ],
        { env, windowsHide: true, timeout: 30_000 },
      );
    await install();
    const release = path.join(root, "releases", commit);
    assert.ok(existsSync(path.join(release, "bin/agent-autoloop.ts")));
    assert.ok(!existsSync(path.join(release, "uncommitted.txt")));
    const launcher = path.join(root, "bin/agent-autoloop.cjs");
    const cli = (...args: string[]) =>
      promisify(execFile)(process.execPath, [launcher, ...args], { env, windowsHide: true, timeout: 30_000 });
    assert.ok((await cli("--version")).stdout.includes(commit.slice(0, 12)));
    const version = await promisify(execFile)(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "bin/agent-autoloop.ps1"),
        "--version",
      ],
      { env, windowsHide: true },
    );
    assert.ok(version.stdout.includes(commit.slice(0, 12)));
    const config = path.join(home, "config.json");
    const digest = () => createHash("sha256").update(readFileSync(config)).digest("hex");
    const before = digest();
    writeFileSync(path.join(home, "keep.txt"), "keep data");
    writeFileSync(path.join(root, "bin/other.cmd"), "keep program");
    mkdirSync(path.join(root, "releases/unrelated"));
    writeFileSync(path.join(root, "releases/unrelated/keep.txt"), "keep unrelated");
    await install();
    assert.equal(digest(), before);
    await cli("uninstall", "--yes");
    assert.equal(digest(), before);
    assert.equal(readFileSync(path.join(home, "keep.txt"), "utf8"), "keep data");
    assert.ok(!existsSync(release));
    assert.ok(!existsSync(launcher));
    assert.ok(existsSync(path.join(source, ".git")));
    assert.equal(readFileSync(path.join(root, "bin/other.cmd"), "utf8"), "keep program");
    assert.equal(readFileSync(path.join(root, "releases/unrelated/keep.txt"), "utf8"), "keep unrelated");
  },
);

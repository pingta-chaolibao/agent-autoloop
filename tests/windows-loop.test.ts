// Failure modes: native init cannot run; a second up ignores the first; Windows file watching misses rules edits;
// a question loses its answer; stopping the hub kills unrelated processes or leaves its database open.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

test(
  "Windows init, try, answer, hot reload, duplicate start and graceful stop",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "autoloop-windows-loop-"));
    process.env.AGENT_AUTOLOOP_HOME = home;
    const program = path.join(import.meta.dirname, "../bin/agent-autoloop.ts");
    const project = path.join(home, "project");
    mkdirSync(project);
    const agent = path.join(project, "agent.cjs");
    writeFileSync(
      agent,
      `const c=JSON.parse(require('node:fs').readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8'));
if(process.argv[2].includes('热更新'))console.log('热更新已生效');
else if(c.answers.length)console.log('你选了绿色，试跑通过');
else console.log('问了一个问题\\n\\n'+String.fromCharCode(96).repeat(3)+'agent-autoloop\\n'+JSON.stringify({ask:[{title:'试跑：选一个颜色',text:'选哪个都行',options:['蓝色','绿色'],key:'try-color'}]})+'\\n'+String.fromCharCode(96).repeat(3));`,
    );
    const rules = {
      sources: { local: { name: "本机" } },
      agents: {
        local: { name: "本机", worker: "local", use: "command", command: [process.execPath, agent, "{prompt}"] },
      },
      channels: {},
      rules: [
        { name: "试一下", when: { source: "local", types: ["try.*"] }, to: "local", cwd: project, prompt: "试跑" },
      ],
    };
    writeFileSync(path.join(home, "rules.json"), JSON.stringify(rules));
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: home };
    delete env.AGENT_AUTOLOOP_RULES;
    const cli = (...args: string[]) =>
      promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", program, ...args], {
        env,
        windowsHide: true,
        timeout: 30_000,
      });

    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await cli("init", "--no-service", "--command", "unused", "--port", String(port));
    const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
    rules.agents.local.worker = config.worker.name;
    writeFileSync(path.join(home, "rules.json"), JSON.stringify(rules));
    const up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", program, "up"], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    up.stdout.on("data", (chunk) => (output += chunk));
    up.stderr.on("data", (chunk) => (output += chunk));
    const ended = once(up, "exit");
    t.after(async () => {
      if (up.exitCode === null && up.signalCode === null) {
        writeFileSync(path.join(home, "up.stop"), "stop");
        await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000))]);
      }
      if (up.exitCode === null && up.signalCode === null) {
        up.kill();
        await ended;
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });
    const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        const value = await read();
        if (done(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Windows loop did not complete: ${output}`);
    };
    await until(
      () =>
        fetch(`${config.url}/healthz`).then(
          (r) => r.ok,
          () => false,
        ),
      Boolean,
    );
    await assert.rejects(
      () => cli("up"),
      (error: any) => /已经在跑了/.test(error.stderr),
    );
    const tried = await cli("try");
    assert.match(tried.stdout, /试跑：选一个颜色/);
    const card = /agent-autoloop answer (\d+)/.exec(tried.stdout)![1];
    await cli("answer", card, "2");
    const state = () =>
      fetch(`${config.url}/v1/state`, { headers: { authorization: `Bearer ${config.owner}` } }).then((r) => r.json());
    await until(state, (s) => s.recentCards.some((c: any) => c.id === Number(card) && c.state === "done"));
    assert.match((await cli("status")).stdout, /你选了绿色，试跑通过/);
    rules.rules[0].prompt = "热更新";
    writeFileSync(path.join(home, "rules.json"), JSON.stringify(rules));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cli("emit", "try.hot", "--id", "hot-reload");
    await until(state, (s) => s.runs.some((r: any) => r.summary === "热更新已生效"));
    const { stopUp } = await import("../host/service.ts");
    stopUp();
    await ended;
    assert.equal(up.exitCode, 0, output);
  },
);

test(
  "the hidden host restarts its worker without reaping a running native Agent",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "autoloop-background-"));
    const program = path.join(import.meta.dirname, "../bin/agent-autoloop.ts");
    const project = path.join(home, "project");
    mkdirSync(project);
    const count = path.join(project, "count");
    const agent = path.join(project, "agent.cjs");
    writeFileSync(
      agent,
      `require('node:fs').appendFileSync(${JSON.stringify(count)},'once\\n');setTimeout(()=>console.log('后台恢复完成'),3500);`,
    );
    const rules = {
      sources: { local: { name: "本机" } },
      agents: { local: { name: "本机", worker: "local", use: "command", command: [process.execPath, agent] } },
      channels: {},
      rules: [{ name: "后台恢复", when: { source: "local", types: ["recover.start"] }, to: "local", cwd: project }],
    };
    writeFileSync(path.join(home, "rules.json"), JSON.stringify(rules));
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: home };
    delete env.AGENT_AUTOLOOP_RULES;
    await promisify(execFile)(
      process.execPath,
      [program, "init", "--no-service", "--command", "unused", "--port", String(port)],
      { env, windowsHide: true },
    );
    const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
    rules.agents.local.worker = config.worker.name;
    writeFileSync(path.join(home, "rules.json"), JSON.stringify(rules));
    const background = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "../host/windows-background.ts"), program, home, "fixture"],
      { env, windowsHide: true, stdio: "ignore" },
    );
    const ended = once(background, "exit");
    t.after(async () => {
      writeFileSync(path.join(home, "service.stop"), "stop");
      writeFileSync(path.join(home, "up.stop"), "stop");
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (background.exitCode === null && background.signalCode === null) {
        background.kill();
        await ended;
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });
    const until = async (done: () => Promise<boolean>) => {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        if (await done()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("background host did not recover");
    };
    const healthy = () =>
      fetch(`${config.url}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
    await until(healthy);
    await fetch(`${config.url}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.source.key}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "background", type: "recover.start" }),
    });
    await until(async () => existsSync(count));
    const firstPid = readFileSync(path.join(home, "up.pid"), "utf8");
    writeFileSync(path.join(home, "up.stop"), "restart");
    await until(
      async () =>
        existsSync(path.join(home, "up.pid")) &&
        readFileSync(path.join(home, "up.pid"), "utf8") !== firstPid &&
        (await healthy()),
    );
    await until(async () => {
      const state = await fetch(`${config.url}/v1/state`, {
        headers: { authorization: `Bearer ${config.owner}` },
      }).then((r) => r.json());
      return state.runs.some((r: any) => r.summary === "后台恢复完成");
    });
    assert.equal(readFileSync(count, "utf8"), "once\n");
    assert.equal(background.exitCode, null);
  },
);

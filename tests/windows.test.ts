// Failure modes: Windows paths are rejected; an argument becomes shell source; a restarted worker loses its process
// or result; a parent exits and leaves a child running after cancellation; an npm shim cannot start without cmd.exe.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import type { Job } from "../protocol/job.ts";

if (process.platform !== "win32") {
  test("Windows native processes", { skip: "Windows only" }, () => {});
} else {
  const scratch = mkdtempSync(path.join(tmpdir(), "autoloop-windows-"));
  const home = path.join(scratch, "quote' & %literal%");
  const project = path.join(scratch, "project");
  mkdirSync(project);
  process.env.AGENT_AUTOLOOP_HOME = home;
  const { createWorker } = await import("../worker/worker.ts");
  after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  afterEach(async () => {
    const cleanup = createWorker({
      name: "local",
      wait: 0,
      hub: {
        work: async () => ({ job: null, cancel: cleanup.entries().map((entry) => entry.run) }),
        started: async () => ({}),
        result: async () => ({}),
      },
    });
    await until(cleanup, () => cleanup.entries().length === 0);
  });

  const config = (cwd: string) => ({
    sources: { local: { name: "本机" } },
    agents: { local: { name: "本机", worker: "local", use: "command", command: [process.execPath] } },
    rules: [{ name: "本机任务", when: { source: "local", types: ["local.test"] }, to: "local", cwd }],
  });
  test("rules accept absolute Windows and UNC paths but refuse drive-relative paths", () => {
    for (const cwd of [project, "D:/projects/app", "\\\\server\\share\\app"])
      assert.equal(parseRules(JSON.stringify(config(cwd)), 0, "UTC").rules[0].cwd, cwd);
    for (const cwd of ["D:relative", "relative\\app", "\\relative"])
      assert.throws(() => parseRules(JSON.stringify(config(cwd)), 0, "UTC"));
  });

  let sequence = 0;
  const job = (command: string[]): Job => ({
    run: ++sequence,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "本机任务", cwd: project, prompt: "读资料后完成。" },
    agent: { id: "local", name: "本机", use: "command", access: "edit", command },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  });
  function hubFor(given: Job) {
    let available = true;
    const hub = {
      results: [] as any[],
      cancel: [] as number[],
      failResult: false,
      async work(query: { capacity: boolean }) {
        const next = available && query.capacity ? given : null;
        if (next) available = false;
        return { job: next, cancel: hub.cancel };
      },
      async started() {
        return {};
      },
      async result(_id: number, _token: string, result: any) {
        if (hub.failResult) throw new Error("模拟断网");
        hub.results.push(result);
        return { rejected: [] };
      },
    };
    return hub;
  }
  async function until(worker: { tick(): Promise<boolean> }, done: () => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) {
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(done(), "Windows task did not reach the expected state");
  }
  const script = (name: string, code: string) => {
    const file = path.join(project, `${name}.cjs`);
    writeFileSync(file, code);
    return file;
  };
  const workerFor = (hub: ReturnType<typeof hubFor>) => createWorker({ hub, name: "local", wait: 0, capacity: 1 });

  test("a native worker preserves literal arguments and context through a path with shell characters", async () => {
    const text = 'literal "quoted" & | ^ %PATH% $(touch injected) `echo no`\n下一行 😀 \\';
    const file = script("literal", "console.log('完成'); console.log(JSON.stringify(process.argv.slice(2))); ");
    const given = job(["node", file, text, ""]);
    const hub = hubFor(given);
    await until(workerFor(hub), () => hub.results.length === 1);
    assert.equal(hub.results[0].outcome, "done", JSON.stringify(hub.results[0]));
    const output = readFileSync(path.join(home, "worker/runs", `${given.run}-1`, "stdout-1.log"), "utf8");
    assert.deepEqual(JSON.parse(output.trim().split("\n")[1]), [text, ""]);
    assert.ok(!existsSync(path.join(project, "injected")));
  });

  test("a restarted worker keeps a native task and retries its saved result without rerunning work", async () => {
    const count = path.join(project, "count");
    const file = script(
      "recover",
      `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'once\\n'); setTimeout(()=>console.log('恢复完成'), 700);`,
    );
    const given = job([process.execPath, file]);
    const hub = hubFor(given);
    hub.failResult = true;
    const first = workerFor(hub);
    await first.tick();
    const again = workerFor(hub);
    await until(again, () => again.entries().some((entry) => entry.result !== undefined));
    assert.equal(hub.results.length, 0);
    hub.failResult = false;
    await until(workerFor(hub), () => hub.results.length === 1);
    assert.equal(hub.results[0].summary, "恢复完成", JSON.stringify(hub.results[0]));
    assert.equal(readFileSync(count, "utf8"), "once\n");
  });

  test("cancellation after parent exit stops the entire native job across worker restart", async () => {
    const ready = path.join(project, "child-pid");
    const child = script(
      "child",
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{}, 1000);`,
    );
    const parent = script(
      "parent",
      `require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore',detached:true}).unref(); console.log('父进程结束');`,
    );
    const given = job([process.execPath, parent]);
    const hub = hubFor(given);
    const first = workerFor(hub);
    await until(first, () => existsSync(ready));
    assert.equal(hub.results.length, 0, "a live child must keep its round active");
    hub.cancel = [given.run];
    await first.tick();
    await until(workerFor(hub), () => hub.results.length === 1);
    assert.equal(hub.results[0].outcome, "cancelled");
    const pid = Number(readFileSync(ready, "utf8"));
    assert.throws(() => process.kill(pid, 0));
  });
}

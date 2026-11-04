// Failure modes: loading history becomes this turn's answer; a restarted bridge forgets the agent's session; thought/tool
// output becomes a receipt; unknown permissions are approved; paths escape through symlinks; an RPC error looks successful.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { permission } from "../plugins/acp/bridge.ts";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-acp-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fake = join(home, "fake.mjs");
writeFileSync(
  fake,
  `
import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=(sessionUpdate,text)=>send({method:'session/update',params:{sessionId:'agent-session',update:{sessionUpdate,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
if(m.method==='session/new')send({id:m.id,result:{sessionId:'agent-session'}});
if(m.method==='session/load'){if(m.params.sessionId!=='agent-session')return send({id:m.id,error:{code:-1,message:'bad session'}});update('agent_message_chunk','旧历史');send({id:m.id,result:{}});}
if(m.method==='session/prompt'){update('agent_thought_chunk','思考');update('agent_message_chunk','中间消息');update('tool_call','');update('agent_message_chunk',m.params.prompt[0].text);send({id:m.id,result:{stopReason:'end_turn'}});}
});`,
);
const run = (resume: string | null) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../plugins/acp/bridge.ts"),
        JSON.stringify({ command: [process.execPath, fake], cwd: home, prompt: "完成了", access: "read", resume }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
test("ACP speaks v1, resumes across processes, discards history and returns only the final answer", async () => {
  for (const resume of [null, "agent-session"]) {
    const r = await run(resume);
    assert.equal(r.code, 0, r.err);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).text, "完成了");
    assert.equal(lines.at(-1).session, "agent-session");
    assert.ok(!r.out.includes("旧历史"));
    assert.ok(!r.out.includes("思考"));
  }
  const bad = await run("missing-session");
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /bad session/);
});
test("ACP chooses only a one-time permission and respects structured kinds and resolved paths", () => {
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const ask = (access: string, toolCall: any) => permission({ access, cwd: home } as any, { options, toolCall });
  assert.equal(ask("read", { kind: "read" }).outcome, "selected");
  assert.equal(ask("read", { kind: "execute", title: "read file" }).optionId, "no");
  assert.equal(ask("edit", { kind: "edit", locations: [{ path: join(home, "new.txt") }] }).optionId, "once");
  mkdirSync(join(home, "work"));
  symlinkSync(tmpdir(), join(home, "work", "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    ask("edit", { kind: "edit", locations: [{ path: join(home, "work", "escape", "outside") }] }).optionId,
    "no",
  );
  assert.equal(ask("edit", { kind: "other" }).optionId, "no");
  assert.equal(ask("full", { kind: "other" }).optionId, "once");
});
test("ACP refuses incompatible versions and premature process exit", async () => {
  const original = await import("node:fs").then((fs) => fs.readFileSync(fake, "utf8"));
  try {
    writeFileSync(fake, original.replace("protocolVersion:1", "protocolVersion:99"));
    assert.notEqual((await run(null)).code, 0);
    writeFileSync(fake, "process.exit(0)");
    assert.notEqual((await run(null)).code, 0);
  } finally {
    writeFileSync(fake, original);
  }
});

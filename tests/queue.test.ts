// Reordering must change actual dispatch order, survive replay, reject stale snapshots and other workers,
// and preserve held claims, group limits and retry cooldowns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { Conflict, InputError } from "../kernel/errors.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "queue-test", publicUrl: "https://hub.test" };
function fixture(t: any, sharedGroup = false) {
  let view = empty();
  t.after(() => view.db.close());
  const facts: Fact[] = [];
  const send = (type: string, args: any[], now = 1000) => {
    const decision = decide(view, { type, args }, now, environment);
    facts.push(...decision.facts);
    view = evolve(view, decision.facts);
    return decision.value;
  };
  const rules = parseRules(
    JSON.stringify({
      sources: { local: { name: "本机" } },
      agents: {
        a: { name: "本机", use: "command", command: ["echo"], worker: "w1" },
        b: { name: "远端", use: "command", command: ["echo"], worker: "w2" },
      },
      rules: ["a", "b", "c", "d"].map((name) => ({
        name,
        when: { source: "local", types: [name] },
        to: name === "d" ? "b" : "a",
        cwd: "/tmp",
        ...(sharedGroup && name !== "c" ? { group: "shared" } : {}),
      })),
    }),
    0,
    "UTC",
  );
  send("rules", [rules]);
  for (const type of ["a", "b", "c", "d"]) send("ingest", ["local", { id: type, type }]);
  return { send, facts, view: () => view, queued: () => rows(view, "runs", { state: "queued" }) };
}

test("owner queue order changes the next eligible job and survives replay", (t) => {
  const f = fixture(t);
  const result = f.send("reorderQueue", [{ worker: "w1", runs: [3, 1, 2] }]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.runs, [3, 1, 2]);
  const rebuilt = evolve(empty(), f.facts);
  t.after(() => rebuilt.db.close());
  assert.deepEqual(snapshot(rebuilt), snapshot(f.view()));
  assert.equal(decide(rebuilt, { type: "claimNext", args: ["w1", "next"] }, 1000, environment).value.run, 3);
  const repeat = f.send("reorderQueue", [{ worker: "w1", runs: [3, 1, 2] }]);
  assert.equal(repeat.changed, false);
  assert.equal(f.send("claimNext", ["w1", "next"]).run, 3);
  assert.equal(f.send("claimNext", ["w2", "other"]).run, 4);
});

test("queue changes reject malformed, duplicate, cross-worker and stale membership without mutations", (t) => {
  const f = fixture(t);
  for (const given of [
    null,
    { worker: "w1", runs: [3, 1, 1] },
    { worker: "w1", runs: ["3", 1, 2] },
    { worker: "w1", runs: [3, 1, 2], state: "done" },
  ]) {
    const before = snapshot(f.view());
    assert.throws(() => f.send("reorderQueue", [given]), InputError);
    assert.deepEqual(snapshot(f.view()), before);
  }
  for (const runs of [
    [3, 1],
    [4, 3, 1, 2],
  ]) {
    const before = snapshot(f.view());
    assert.throws(() => f.send("reorderQueue", [{ worker: "w1", runs }]), Conflict);
    assert.deepEqual(snapshot(f.view()), before);
  }
  const held = f.send("claimNext", ["w1", "held"]);
  const before = snapshot(f.view());
  assert.throws(() => f.send("reorderQueue", [{ worker: "w1", runs: [3, 1, 2] }]), Conflict);
  assert.deepEqual(snapshot(f.view()), before);
  const repeated = f.send("claimNext", ["w1", "held"]);
  assert.equal(repeated.run, held.run);
  assert.deepEqual(repeated.rule, held.rule);
});

test("prioritizing queued work neither interrupts a run nor bypasses its group limit", (t) => {
  const f = fixture(t, true);
  const held = f.send("claimNext", ["w1", "first"]);
  assert.equal(held.run, 1);
  f.send("reorderQueue", [{ worker: "w1", runs: [2, 3] }]);
  assert.equal(f.view().get("runs", 1)!.state, "claimed");
  assert.equal(f.send("claimNext", ["w1", "next"]).run, 3);
  f.send("finish", [held.run, held.token, { outcome: "done" }]);
  assert.equal(f.send("claimNext", ["w1", "after"]).run, 2);
});

test("priority preserves retry backoff and newly arriving jobs follow the reordered queue", (t) => {
  const f = fixture(t);
  const first = f.send("claimNext", ["w1", "first"]);
  f.send("finish", [first.run, first.token, { outcome: "failed", error: "temporary" }]);
  const notBefore = f.view().get("runs", first.run)!.not_before;
  f.send("reorderQueue", [{ worker: "w1", runs: [1, 3, 2] }]);
  assert.equal(f.view().get("runs", first.run)!.not_before, notBefore);
  assert.equal(f.send("claimNext", ["w1", "ready"]).run, 3);
  f.send("ingest", ["local", { id: "c-new", type: "c" }]);
  assert.equal(f.send("claimNext", ["w1", "before-new"]).run, 2);
  assert.equal(f.send("claimNext", ["w1", "retry"], 301001).run, 1);
});

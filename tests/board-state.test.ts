// An old round waiting for an answer must stay on the board beyond the history page, and queue positions reflect dispatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, at } from "./helpers.ts";

setup("board-state");
const hub = await import("../host/runtime.ts");

test("open questions retain old rounds and queue controls use the actual worker order", () => {
  const event = (id: string) => ({ id, type: "feedback.new", subject: `#${id}` });
  hub.ingest("app", event("first"), at(0));
  const first = hub.claimNext("w1", "first", at(0))!;
  hub.finish(
    first.run,
    first.token,
    { outcome: "done", summary: "等待回答", ask: [{ title: "等你決定", text: "請選擇", options: ["是", "否"] }] },
    at(1),
  );
  for (let index = 0; index < 65; index++) {
    hub.ingest("app", event(`history-${index}`), at(index + 2));
    const job = hub.claimNext("w1", `history-${index}`, at(index + 2))!;
    hub.finish(job.run, job.token, { outcome: "done", summary: "完成" }, at(index + 2));
  }
  const state: any = hub.stateOf(at(100));
  const waiting = state.runs.find((run: any) => run.id === first.run);
  assert.ok(waiting, "the first history page must retain the pending decision");
  assert.equal(waiting.waitingCards.length, 1);
  hub.ingest("app", event("queued-a"), at(101));
  hub.ingest("app", event("queued-b"), at(101));
  const queued: any = hub.stateOf(at(101));
  const queue = queued.queues.find((queue: any) => queue.worker === "w1");
  const order = [...queue.runs].reverse();
  hub.execute("reorderQueue", [{ worker: "w1", runs: order }], at(101));
  const reordered: any = hub.stateOf(at(101));
  assert.deepEqual(reordered.queues.find((queue: any) => queue.worker === "w1").runs, order);
  assert.equal(reordered.runs.find((run: any) => run.id === order[0]).queuePosition, 1);
  assert.equal(hub.claimNext("w1", "priority", at(101))!.run, order[0]);
});

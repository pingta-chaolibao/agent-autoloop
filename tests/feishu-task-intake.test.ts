// Task-card actions must reach the local intake without being counted as answers to existing hub cards.
// Other users, groups and ordinary chat must never reach this owner-only capability.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import feishu from "../plugins/feishu/channel.ts";
import { nodeCommand } from "./helpers.ts";

test("feishu shares the CLI bus for task commands and menus, routing intake cards separately", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-task-channel-"));
  const stop = new AbortController();
  const received: any[] = [],
    answers: any[] = [];
  const finished = () => {
    if (received.length === 3 && answers.length === 1) stop.abort();
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ auth: req.headers.authorization, ...JSON.parse(body) });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
    finished();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    stop.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true, force: true });
  });
  const message = {
    sender_id: "ou_owner",
    sender_type: "user",
    chat_type: "p2p",
    message_type: "text",
    message_id: "om_new",
    content: "新任務",
  };
  const events = {
    "im.message.receive_v1": [
      message,
      { ...message, sender_id: "ou_other" },
      { ...message, chat_type: "group" },
      { ...message, content: "普通聊天" },
    ],
    "application.bot.menu_v6": [
      { operator_open_id: "ou_owner", event_key: "autoloop.new_task", event_id: "menu-event" },
      { operator_open_id: "ou_other", event_key: "autoloop.new_task", event_id: "bad-menu" },
    ],
    "card.action.trigger": [
      {
        operator_id: "ou_owner",
        message_id: "om_form",
        action_value: '{"intake":"draft-id","action":"submit"}',
        form_value: '{"title":"中文"}',
        token: "do-not-forward",
        card_content: "not-needed",
      },
      { operator_id: "ou_other", message_id: "om_form", action_value: '{"intake":"draft-id","action":"submit"}' },
      { operator_id: "ou_owner", message_id: "om_5", action_value: '{"card":5,"choice":0}' },
    ],
  };
  const lark = nodeCommand(
    path.join(dir, "lark-cli"),
    `
const events=${JSON.stringify(events)};
const key=process.argv[4];
console.error('[event] ready event_key='+key);
for(const event of events[key]??[])console.log(JSON.stringify(event));
setInterval(()=>{},1000);
`,
  );
  const timeout = setTimeout(() => stop.abort(), 5000);
  try {
    await feishu({
      options: {
        user: "ou_owner",
        lark,
        taskIntake: {
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lark/events`,
          token: "a".repeat(64),
          menu: true,
        },
      },
      signal: stop.signal,
      log: () => {},
      hub: {
        async nextCard() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { card: null };
        },
        async answer(...args: unknown[]) {
          answers.push(args);
          finished();
          return { changed: true };
        },
      } as any,
    });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(received.length, 3);
  assert.ok(received.every((input) => input.auth === `Bearer ${"a".repeat(64)}`));
  assert.deepEqual(received.map(({ event }) => event.type).sort(), Object.keys(events).sort());
  assert.ok(received.every(({ event }) => event.token === undefined && event.card_content === undefined));
  assert.deepEqual(answers, [[5, { choice: 0, by: "ou_owner", ref: "om_5" }]]);
});

test("the intake capability cannot be forwarded to a remote server", async () => {
  await assert.rejects(
    feishu({
      options: { user: "ou_owner", taskIntake: { url: "https://example.com/api/lark/events", token: "a".repeat(64) } },
      signal: new AbortController().signal,
      log: () => {},
      hub: {} as any,
    }),
    /本機/,
  );
});

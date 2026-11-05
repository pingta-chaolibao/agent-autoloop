// The channels that ship and the webhook adapter. No real listener runs here: only one can hold an app's card clicks.
// Failure cases: a first send uses a key that changes with the version, or an update sends a new message; a failed send
// isn't reported; a click that isn't a card's is taken; a card's options don't show while it's open or still show after;
// the listener dying isn't started again. A GitHub webhook with a bad signature, or with none, is taken; what isn't an
// identifier reaches the subject; a ping makes an event; replacement tokens in card text rewrite a webhook template.
// A slow CLI call must not block the hub's HTTP loop while looking up a user, sending or updating a card.
// A free-text reply must reach the same card with its author and message, without becoming an option or a blank answer.
// JSON 2.0 must identify the submit button with form_action_type, or Lark rejects the whole form.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu, { render } from "../plugins/feishu/channel.ts";
import webhook from "../plugins/webhook/channel.ts";
import github from "../plugins/github/source.ts";
import type { Card } from "../host/channels.ts";
import { nodeCommand } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-channels-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

test("a card shows its options while it's open, and what became of it after", () => {
  const open = render(base);
  const blocks = open.body.elements.filter((e) => e.tag === "interactive_container") as any[];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].behaviors[0].value, { card: 5, choice: 1 });
  assert.equal(blocks[1].border_color, "blue", "what's recommended stands out");
  const said = (card: Card) => JSON.stringify(render(card).body.elements);
  assert.match(said({ ...base, state: "decided", choice: 1 }), /你选了「留着」，已记录/);
  assert.ok(!said({ ...base, state: "decided", choice: 1 }).includes("callback"));
  assert.match(said({ ...base, state: "done", choice: 0, result: "删了" }), /你选了「删」。已执行：删了/);
  assert.match(said({ ...base, state: "decided", answer: "归档" }), /你选了「归档」/);
  assert.match(said({ ...base, state: "closed", result: "问题自己好了" }), /不用决定了：问题自己好了/);
  assert.match(said({ ...base, kind: "notice", state: "closed", options: [], result: "已处理" }), /已处理/);
});

test("an open question accepts an independent multiline answer and removes the input after a decision", () => {
  const open = render(base);
  const form = open.body.elements.find((element: any) => element.tag === "form") as any;
  assert.ok(form, "a reply must not require choosing one of the proposed options");
  const input = form.elements.find((element: any) => element.tag === "input");
  assert.equal(input.name, "answer_text");
  assert.equal(input.input_type, "multiline_text");
  const submit = form.elements.find((element: any) => element.tag === "button");
  assert.equal(submit.form_action_type, "submit");
  assert.equal(submit.action_type, undefined);
  assert.deepEqual(submit.behaviors[0].value, { card: base.id, action: "answer_text" });
  for (const card of [
    { ...base, state: "decided" as const, answer: "两者都不是" },
    { ...base, kind: "notice" as const },
  ])
    assert.ok(!render(card).body.elements.some((element: any) => element.tag === "form"));
});

test("feishu forwards Unicode form replies with the original author/message and ignores empty or malformed submissions", async () => {
  const text = '两者都不是，墙只在指定条件消失。\n请先核对 "收尾" 的业务含义 🧶';
  const event = (action: object, form: unknown = JSON.stringify({ answer_text: `  ${text}\n` })) => ({
    action_value: JSON.stringify(action),
    form_value: form,
    operator_id: "ou_me",
    message_id: "om_5",
  });
  const events = [
    event({ card: 5, action: "answer_text" }),
    event({ card: 5, action: "answer_text" }, JSON.stringify({ answer_text: " \n " })),
    event({ card: 5, action: "answer_text" }, JSON.stringify({ answer_text: 12 })),
    event({ card: 5, action: "answer_text" }, "not-json"),
    event({ card: 5, action: "unknown" }),
    { ...event({ card: 5, action: "answer_text" }), operator_id: "" },
    { ...event({ card: 5, action: "answer_text" }), message_id: "" },
    event({ card: 5, choice: 0 }),
  ];
  const lark = nodeCommand(
    join(dir, "text-answer-lark"),
    `#!${process.execPath}\nconst events=${JSON.stringify(events)};if(process.argv[2]==='event'){for(const event of events)console.log(JSON.stringify(event));setInterval(()=>{},1000);}else{for await(const chunk of process.stdin){}console.log(JSON.stringify({ok:true}));}`,
  );
  const stop = new AbortController();
  const answers: unknown[][] = [];
  const logs: string[] = [];
  const timeout = setTimeout(() => stop.abort(), 5000);
  try {
    await feishu({
      hub: {
        async nextCard() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { card: null };
        },
        async answer(...args: unknown[]) {
          answers.push(args);
          if (answers.length === 2) stop.abort();
          return { changed: true };
        },
      } as any,
      options: { user: "ou_me", lark },
      signal: stop.signal,
      log: (line) => logs.push(line),
    });
  } finally {
    clearTimeout(timeout);
    stop.abort();
  }
  assert.deepEqual(answers, [
    [5, { text, by: "ou_me", ref: "om_5" }],
    [5, { choice: 0, by: "ou_me", ref: "om_5" }],
  ]);
  assert.ok(!logs.some((line) => line.includes(text)), "answer contents must not be written to channel logs");
});

test("feishu sends result media with stable keys before the interactive card, using the private cache", async () => {
  const recorded = join(dir, "media-lark.log");
  const lark = nodeCommand(
    join(dir, "media-lark"),
    `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='event')setInterval(()=>{},1000);
else {let body='';for await(const chunk of process.stdin)body+=chunk;fs.appendFileSync(${JSON.stringify(recorded)},JSON.stringify({args,cwd:process.cwd(),body})+'\\n');console.log(JSON.stringify({ok:true,data:{message_id:args.includes('--image')?'om_image':'om_card'}}));}
`,
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
    "base64",
  );
  const asset = { id: "a".repeat(64), name: "結果.png", type: "image/png", size: png.length };
  const stop = new AbortController();
  const cards = [{ ...base, kind: "notice" as const, state: "closed" as const, options: [], artifacts: [asset] }];
  const delivered: unknown[] = [];
  const cache = join(dir, "private-media");
  await feishu({
    hub: {
      async nextCard() {
        const card = cards.shift();
        if (!card) stop.abort();
        return { card: card ?? null };
      },
      async cardAsset(id: number, value: string) {
        assert.equal(id, base.id);
        assert.equal(value, asset.id);
        return png;
      },
      async delivered(...args: unknown[]) {
        delivered.push(args);
      },
      async failed() {
        assert.fail("media delivery failed");
      },
    } as any,
    options: { user: "ou_me", lark },
    directory: cache,
    signal: stop.signal,
    log: () => {},
  });
  const calls = readFileSync(recorded, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls[0].args.includes("--image"), true);
  assert.equal(calls[1].args.includes("interactive"), true);
  assert.equal(calls[0].cwd, cache);
  assert.ok(calls[0].args.includes(`autoloop-${base.id}-${asset.id.slice(0, 24)}`));
  assert.deepEqual(delivered, [[base.id, base.version, "om_card"]]);
});

test("feishu CLI calls leave the HTTP loop available", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lark = nodeCommand(
    join(dir, "async-lark"),
    `#!${process.execPath}
if (process.argv[2] === 'event') { setInterval(() => {}, 1000); }
else {
  (async () => {
    if (process.argv[2] !== 'auth') for await (const chunk of process.stdin) {}
    await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2000) });
    console.log(JSON.stringify({ ok: true, identities: { user: { openId: 'ou_me' } }, data: { message_id: 'om_5' } }));
  })().catch(() => process.exit(1));
}
`,
  );
  const stop = new AbortController();
  const cards = [base, { ...base, version: 2, ref: "om_5" }];
  let delivered = 0;
  const failed: unknown[] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift() ?? null;
      if (!card) stop.abort();
      return { card };
    },
    async delivered() {
      delivered++;
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
  };
  try {
    await feishu({ hub: hub as any, options: { lark }, log: () => {}, signal: stop.signal });
    assert.deepEqual(failed, []);
    assert.equal(delivered, 2);
    assert.equal(requests, 3, "user lookup, send and patch each allowed HTTP to respond");
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("feishu: sends once per card, updates in place, reports failure, and only real clicks count", async () => {
  const log = join(dir, "lark.log");
  const lark = nodeCommand(
    join(dir, "lark-cli"),
    `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},args.join(' ')+'\\n');
if(args[0]==='event') {
 console.log(JSON.stringify({action_value:JSON.stringify({card:5,choice:1}),operator_id:'ou_me',message_id:'om_5'}));
 console.log(JSON.stringify({action_value:JSON.stringify({other:1}),operator_id:'ou_me',message_id:'om_5'}));
 setInterval(()=>{},1000);
} else {
 let body='';for await(const chunk of process.stdin)body+=chunk;
 if(body.includes('fail-me'))process.exit(1);
 console.log(JSON.stringify({ok:true,data:{message_id:'om_5'}}));
}
`,
  );
  const stop = new AbortController();
  const cards: (Card | null)[] = [
    base,
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, id: 6, title: "fail-me", ref: null },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5"), "the key doesn't change with the version");
  assert.ok(sends[0].includes("--user-id ou_me"));
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_5")),
    "an update changes the message that was sent",
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 1),
    ["delivered", 5, 1, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 2),
    ["delivered", 5, 2, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "failed"),
    ["failed", 6, 1],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 5, { choice: 1, by: "ou_me", ref: "om_5" }]],
  );
});

test("a webhook channel posts words and the link once, and has nothing to do for an update", async () => {
  const seen: any[] = [];
  const target = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push(JSON.parse(text));
      res.statusCode = seen.length === 2 ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const stop = new AbortController();
  const literal = '$& $` $\' {text} "},"admin":true';
  const cards: Card[] = [
    { ...base, text: literal },
    { ...base, version: 2, ref: "sent-5", state: "decided", choice: 0 },
    { ...base, id: 7 },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await webhook({
    hub: hub as any,
    options: {
      url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
      body: { msgtype: "text", text: { content: "{text}" } },
    },
    log: () => {},
    signal: stop.signal,
  });
  target.close();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].text.content, `${base.title}\n\n${literal}\n\n1. 删\n2. 留着\n\n${base.link}`);
  assert.match(seen[0].text.content, /要不要删[\s\S]*1\. 删[\s\S]*https:\/\/hub\.test\/c\/x/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "sent-5"],
    ["delivered", 5, 2, "sent-5"],
    ["failed", 7, 1],
  ]);
});

test("GitHub: signed or not taken, and what it says becomes a plain event", () => {
  const secret = "s3cret";
  const body = JSON.stringify({
    action: "opened",
    issue: { number: 12, title: "首页打不开", body: "详情", html_url: "https://github.com/a/b/issues/12" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  const headers = (b: string, over: object = {}) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`,
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
    ...over,
  });
  assert.deepEqual(github({ headers: headers(body), body, secret }), [
    {
      id: "d-1",
      type: "issues.opened",
      subject: "a/b#12",
      summary: "首页打不开",
      detail: "详情",
      link: "https://github.com/a/b/issues/12",
    },
  ]);
  assert.throws(() => github({ headers: headers(body, { "x-hub-signature-256": "sha256=00" }), body, secret }));
  assert.throws(() => github({ headers: { "x-github-event": "issues" }, body, secret }));
  assert.throws(() => github({ headers: headers(body), body, secret: "" }), "no secret set up takes nothing");
  assert.deepEqual(github({ headers: headers("{}", { "x-github-event": "ping" }), body: "{}", secret }), []);
  const odd = JSON.stringify({ repository: { full_name: "a/b c" } });
  assert.match(
    (github({ headers: headers(odd, { "x-github-event": "push" }), body: odd, secret }) as any)[0].subject,
    /^a\/b-c$/,
  );
});

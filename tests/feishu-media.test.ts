// Video notifications retain the human file name and use a generated cover, the owner identity and a stable send key.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import feishu from "../plugins/feishu/channel.ts";
import { nodeCommand } from "./helpers.ts";

test("feishu videos upload with their original name and send a video plus cover before the card", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-video-channel-"));
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true, force: true });
  });
  nodeCommand(
    path.join(dir, "ffmpeg"),
    `import fs from 'node:fs';fs.writeFileSync(process.argv.at(-1),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64'));`,
  );
  process.env.PATH = dir + path.delimiter + previousPath;
  const log = path.join(dir, "calls.jsonl");
  const lark = nodeCommand(
    path.join(dir, "lark-cli"),
    `import fs from 'node:fs';const args=process.argv.slice(2);if(args[0]==='event')setInterval(()=>{},1000);else{let body='';for await(const chunk of process.stdin)body+=chunk;fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,body})+'\\n');console.log(JSON.stringify({ok:true,data:args.includes('files')?{file_key:'file_video'}:{message_id:args.includes('--video')?'om_video':'om_card'}}));}`,
  );
  const bytes = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
  const asset = { id: "b".repeat(64), name: "結果影片.mp4", type: "video/mp4", size: bytes.length };
  const stop = new AbortController();
  const cards = [
    {
      id: 1,
      version: 1,
      ref: null,
      kind: "notice",
      state: "closed",
      title: "完成",
      text: "已產生影片",
      options: [],
      choice: null,
      answer: null,
      result: null,
      recommend: null,
      link: null,
      artifacts: [asset],
    },
  ];
  const delivered: unknown[] = [];
  await feishu({
    options: { lark, user: "ou_owner" },
    directory: path.join(dir, "cache"),
    signal: stop.signal,
    log: () => {},
    hub: {
      async nextCard() {
        const card = cards.shift();
        if (!card) stop.abort();
        return { card: card ?? null };
      },
      async cardAsset() {
        return bytes;
      },
      async delivered(...args: unknown[]) {
        delivered.push(args);
      },
      async failed(_id: number, _version: number, error: string) {
        assert.fail(error);
      },
    } as any,
  });
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(JSON.parse(calls[0].body).file_name, asset.name);
  assert.ok(calls[1].args.includes("--video"));
  assert.ok(calls[1].args.includes("file_video"));
  assert.ok(calls[1].args.includes("--video-cover"));
  assert.ok(calls[1].args.includes("ou_owner"));
  assert.deepEqual(delivered, [[1, 1, "om_card"]]);
});

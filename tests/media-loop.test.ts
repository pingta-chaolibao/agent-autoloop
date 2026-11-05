// Finished work survives an upload/result transport retry without rerunning the agent; actual input/output bytes cross the hub.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("media-loop");
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient, HubError } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const { parseRules } = await import("../protocol/rules.ts");
const server = serve(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;

test("input media, output upload and persisted completion form one recoverable worker flow", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
    "base64",
  );
  const owner = hub.addKey("owner", "owner");
  const workerKey = hub.addKey("worker", "w1");
  const uploaded = await fetch(base + "/v1/assets", {
    method: "POST",
    headers: { authorization: `Bearer ${owner}`, "content-type": "image/png", "x-file-name": "input.png" },
    body: png,
  });
  const input = await uploaded.json();
  const script = path.join(home, "fake-media-agent.mjs");
  writeFileSync(
    script,
    `import fs from 'node:fs';import path from 'node:path';const file=process.env.AGENT_AUTOLOOP_CONTEXT;const context=JSON.parse(fs.readFileSync(file,'utf8'));if(!context.attachments?.[0]?.path)process.exit(2);fs.appendFileSync(${JSON.stringify(path.join(home, "launches.txt"))},'launched\\n');fs.copyFileSync(context.attachments[0].path,path.join(path.dirname(file),'outputs','result.png'));console.log('完成：結果圖片已產生');`,
  );
  hub.execute("rules", [
    parseRules(
      JSON.stringify({
        sources: { app: { name: "本机" } },
        agents: { a: { name: "测试脚本", worker: "w1", use: "command", command: [process.execPath, script] } },
        channels: { chat: { name: "通知" } },
        rules: [
          {
            name: "media",
            when: { source: "app", types: ["media"] },
            to: "a",
            cwd: home,
            tell: "always",
            attachments: [input],
          },
        ],
      }),
      Date.now(),
      "UTC",
    ),
  ]);
  hub.ingest("app", { id: "media-loop", type: "media" });
  const client = hubClient(base, workerKey);
  let uploads = 0,
    reports = 0;
  const transport = {
    ...client,
    uploadAsset: async (...args: Parameters<typeof client.uploadAsset>) => {
      uploads++;
      return client.uploadAsset(...args);
    },
    result: async (...args: Parameters<typeof client.result>) => {
      if (++reports === 1) throw new HubError(503, "temporary");
      return client.result(...args);
    },
  };
  const worker = createWorker({ hub: transport, name: "w1", wait: 0 });
  await worker.tick();
  for (let attempt = 0; attempt < 60 && reports === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.tick();
  }
  assert.equal(reports, 1);
  assert.equal(uploads, 1);
  const restarted = createWorker({ hub: transport, name: "w1", wait: 0 });
  await restarted.tick();
  assert.equal(reports, 2);
  assert.equal(uploads, 1);
  assert.equal(readFileSync(path.join(home, "launches.txt"), "utf8").trim().split("\n").length, 1);
  const run = hub.one<any>("SELECT state,artifacts FROM runs WHERE rule='media'")!;
  assert.equal(run.state, "done");
  const artifacts = JSON.parse(run.artifacts);
  assert.equal(artifacts[0].name, "result.png");
  const downloaded = await fetch(base + `/v1/assets/${artifacts[0].id}`, {
    headers: { authorization: `Bearer ${owner}` },
  });
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  const channelKey = hub.addKey("channel", "chat");
  const channel = hubClient(base, channelKey);
  const card = (await channel.nextCard(0)).card;
  assert.equal(card.artifacts[0].id, artifacts[0].id);
  assert.deepEqual(Buffer.from(await channel.cardAsset(card.id, artifacts[0].id)), png);
  await assert.rejects(
    channel.cardAsset(card.id, input.id),
    (error: unknown) => error instanceof HubError && error.status === 403,
  );
});

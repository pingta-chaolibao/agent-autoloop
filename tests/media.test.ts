// Media is authenticated, content-checked, immutable, range-readable, and scoped to the claiming run's own inputs.
import assert from "node:assert/strict";
import { truncateSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("media");
const { serve } = await import("../host/http.ts");
const hub = await import("../host/runtime.ts");
const { parseRules } = await import("../protocol/rules.ts");
const keys = {
  owner: hub.addKey("owner", "owner"),
  source: hub.addKey("source", "app"),
  worker: hub.addKey("worker", "w1"),
};
const server = serve(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
const request = (route: string, key: string, options: RequestInit = {}) =>
  fetch(base + route, { ...options, headers: { authorization: `Bearer ${key}`, ...options.headers } });
const upload = (key = keys.owner, name = "參考.png", type = "image/png", body = png) =>
  request("/v1/assets", key, {
    method: "POST",
    headers: { "content-type": type, "x-file-name": encodeURIComponent(name) },
    body,
  });

test("owner uploads can be read back with video-style ranges but other roles cannot browse them", async () => {
  const response = await upload();
  assert.equal(response.status, 200);
  const asset = await response.json();
  assert.equal(asset.name, "參考.png");
  assert.equal(asset.size, png.length);
  assert.equal(asset.type, "image/png");
  assert.match(asset.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await (await upload()).json(), asset);
  truncateSync(path.join(home, "assets", `${asset.id}.bin`), 0);
  assert.deepEqual(await (await upload()).json(), asset);
  const repaired = await request(`/v1/assets/${asset.id}`, keys.owner);
  assert.deepEqual(
    Buffer.from(await repaired.arrayBuffer()),
    png,
    "retry must repair a partial file after interruption",
  );
  for (const key of [keys.source, keys.worker, "made-up"])
    assert.equal((await request(`/v1/assets/${asset.id}`, key)).status, 403);
  const ranged = await request(`/v1/assets/${asset.id}`, keys.owner, { headers: { range: "bytes=2-6" } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(2, 7));
  assert.equal((await request(`/v1/assets/${asset.id}`, keys.owner, { headers: { range: "bytes=999-" } })).status, 416);
});

test("uploads reject unauthorized callers, unsafe names and mismatched content", async () => {
  assert.equal((await upload(keys.source)).status, 403);
  assert.equal((await upload(keys.owner, "../secret.png")).status, 400);
  assert.equal((await upload(keys.owner, "fake.mp4", "video/mp4")).status, 400);
  assert.equal((await upload(keys.owner, "page.html", "text/html", Buffer.from("<script>bad</script>"))).status, 400);
});

test("a run token can read only its own declared inputs and upload results while its claim is active", async () => {
  const asset = await (await upload()).json();
  const other = await (await upload(keys.owner, "other.png")).json();
  const rules = parseRules(
    JSON.stringify({
      sources: { app: { name: "本机" } },
      agents: { a: { name: "脚本", worker: "w1", use: "command", command: ["echo"] } },
      rules: [{ name: "media", when: { source: "app", types: ["media"] }, to: "a", cwd: "/tmp", attachments: [asset] }],
    }),
    Date.now(),
    "UTC",
  );
  hub.execute("rules", [rules]);
  hub.ingest("app", { id: "media-1", type: "media" });
  const job = hub.claimNext("w1", "media-claim")!;
  assert.deepEqual(job.rule.attachments, [asset]);
  assert.equal((await request(`/v1/runs/${job.run}/assets/${asset.id}`, job.token)).status, 200);
  assert.equal((await request(`/v1/runs/${job.run}/assets/${other.id}`, job.token)).status, 403);
  assert.equal((await request(`/v1/runs/${job.run}/assets/${asset.id}`, keys.worker)).status, 403);
  const output = await request(`/v1/runs/${job.run}/assets`, job.token, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": "result.png" },
    body: png,
  });
  assert.equal(output.status, 200);
  const artifact = await output.json();
  hub.finish(job.run, job.token, { outcome: "done", summary: "完成", artifacts: [artifact] });
  assert.equal((await request(`/v1/runs/${job.run}/assets/${asset.id}`, job.token)).status, 403);
});

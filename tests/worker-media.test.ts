// Inputs must reach the private run directory; output collection must not follow links, read unrelated files,
// or lose completed business results because an attachment is too large.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, truncateSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareMedia, collectMedia } from "../worker/media.ts";
import codex from "../plugins/codex/agent.ts";
import { nodeCommand } from "./helpers.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
const asset = { id: "a".repeat(64), name: "參考.png", type: "image/png", size: png.length };
function directory(t: any) {
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-worker-media-"));
  t.after(() => {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("input images are downloaded under the run and supplied as actual image paths", async (t) => {
  const folder = directory(t);
  const job = { run: 12, token: "run-only-token", rule: { attachments: [asset] } } as any;
  const media = await prepareMedia(
    {
      inputAsset: async (run: number, token: string, id: string) => {
        assert.equal(run, 12);
        assert.equal(token, job.token);
        assert.equal(id, asset.id);
        return png;
      },
    },
    job,
    folder,
  );
  assert.equal(media.attachments[0].name, asset.name);
  assert.ok(media.images[0].startsWith(folder + path.sep));
  assert.deepEqual(readFileSync(media.images[0]), png);
});

test("only supported regular output files are uploaded and attached to a result", async (t) => {
  const folder = directory(t);
  mkdirSync(path.join(folder, "outputs"));
  writeFileSync(path.join(folder, "outputs", "result.png"), png);
  writeFileSync(path.join(folder, "outputs", "credentials.txt"), "must not upload");
  const calls: string[] = [];
  const result = await collectMedia(
    {
      uploadAsset: async (_run: number, _token: string, file: any) => {
        calls.push(file.name);
        assert.deepEqual(Buffer.from(file.bytes), png);
        return {
          id: createHash("sha256").update(png).digest("hex"),
          name: file.name,
          type: file.type,
          size: png.length,
        };
      },
    },
    { run: 1, token: "token" } as any,
    folder,
  );
  assert.deepEqual(calls, ["result.png"]);
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(result.issues, []);
});

test("oversized results become an explicit attachment issue without uploading them", async (t) => {
  const folder = directory(t);
  mkdirSync(path.join(folder, "outputs"));
  const file = path.join(folder, "outputs", "large.mp4");
  writeFileSync(file, Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]));
  truncateSync(file, 30_000_001);
  const result = await collectMedia(
    {
      uploadAsset: async () => {
        throw new Error("must not upload");
      },
    },
    { run: 1, token: "token" } as any,
    folder,
  );
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /large\.mp4/);
});

test("output directory links and path-bearing input references cannot escape the run", async (t) => {
  const folder = directory(t);
  const outside = path.join(folder, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.png"), png);
  symlinkSync(outside, path.join(folder, "outputs"), process.platform === "win32" ? "junction" : "dir");
  const result = await collectMedia(
    {
      uploadAsset: async () => {
        throw new Error("must not upload");
      },
    },
    { run: 1, token: "token" },
    folder,
  );
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.issues.length, 1);
  await assert.rejects(
    prepareMedia(
      {},
      { run: 1, token: "token", rule: { attachments: [{ ...asset, name: "../secret.png" }] } } as any,
      folder,
    ),
  );
});

test("Codex image arguments leave session and prompt as positional arguments", (t) => {
  const folder = directory(t);
  nodeCommand(path.join(folder, "codex"), "console.log('fake codex');");
  const originalPath = process.env.PATH;
  process.env.PATH = folder + path.delimiter + originalPath;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const images = [path.join(folder, "one.png"), path.join(folder, "two.png")];
  for (const image of images) writeFileSync(image, png);
  for (const resume of [null, "previous-session"]) {
    const argv = codex.command({
      prompt: "describe the image",
      session: "session",
      resume,
      cwd: folder,
      access: "edit",
      contextFile: path.join(folder, "context.json"),
      folder,
      images,
    });
    const separator = argv.indexOf("--");
    assert.ok(separator > argv.lastIndexOf("--image"), "image values must end before positional arguments");
    assert.deepEqual(argv.slice(separator + 1).slice(0, resume ? 1 : 0), resume ? [resume] : []);
    assert.ok(argv.at(-1)!.includes("describe the image"));
  }
});

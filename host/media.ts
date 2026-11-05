import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { credential, whose, type Environment } from "../kernel/credentials.ts";
import { configuration } from "../kernel/query.ts";
import type { View } from "../kernel/evolve.ts";
import { MEDIA_LIMITS, mediaName, mediaType, validAssets, type Asset } from "../protocol/media.ts";

class MediaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const denied = () => {
  throw new MediaError(403, "没有这份附件的访问权限");
};
const matches = (bytes: Buffer, type: string) =>
  type === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : type === "image/jpeg"
      ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : type === "image/webp"
        ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        : type === "video/mp4" && bytes.toString("ascii", 4, 8) === "ftyp";

export function mediaStore(home: string) {
  const directory = path.join(home, "assets");
  function read(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new MediaError(404, "没有这份附件");
    const file = path.join(directory, `${id}.bin`);
    const manifest = path.join(directory, `${id}.json`);
    if (!existsSync(file) || !existsSync(manifest)) throw new MediaError(404, "没有这份附件");
    if (
      !lstatSync(file).isFile() ||
      lstatSync(file).isSymbolicLink() ||
      !lstatSync(manifest).isFile() ||
      lstatSync(manifest).isSymbolicLink()
    )
      throw new MediaError(500, "附件资料无效");
    const asset: Asset = JSON.parse(readFileSync(manifest, "utf8"));
    if (!validAssets([asset]) || asset.id !== id || statSync(file).size !== asset.size)
      throw new MediaError(500, "附件资料不完整");
    return { asset, file };
  }
  async function upload(request: Request) {
    let name: string;
    try {
      name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
    } catch {
      throw new MediaError(400, "附件名称无效");
    }
    const type = request.headers.get("content-type")?.split(";")[0] ?? "";
    if (!mediaName(name) || mediaType(name) !== type)
      throw new MediaError(400, "只支持 PNG、JPG、WebP 图片和 MP4 影片");
    const maximum = type.startsWith("image/") ? MEDIA_LIMITS.image : MEDIA_LIMITS.video;
    if (Number(request.headers.get("content-length")) > maximum) throw new MediaError(413, "附件超过大小限制");
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!request.body) throw new MediaError(400, "附件不能为空");
    for await (const chunk of request.body as any) {
      size += chunk.length;
      if (size > maximum) throw new MediaError(413, "附件超过大小限制");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!size || !matches(bytes, type)) throw new MediaError(400, "附件内容与类型不符");
    const id = createHash("sha256").update(`${name}\0${type}\0`).update(bytes).digest("hex");
    const asset = { id, name, type, size };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [file, content] of [
      [`${id}.bin`, bytes],
      [`${id}.json`, JSON.stringify(asset)],
    ] as const) {
      const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, content, { flag: "wx", mode: 0o600, flush: true });
        renameSync(temporary, path.join(directory, file));
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    return asset;
  }
  function serve(id: string, request: Request) {
    const { asset, file } = read(id);
    let start = 0,
      end = asset.size - 1,
      status = 200;
    const headers: Record<string, string> = {
      "content-type": asset.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    };
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${asset.size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, asset.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.size)
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${asset.size}` } });
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${asset.size}`;
    }
    headers["content-length"] = String(end - start + 1);
    return new Response(
      request.method === "HEAD" ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream),
      { status, headers },
    );
  }
  return { read, upload, serve };
}

export function createMediaHandler({
  home,
  view,
  environment,
}: {
  home: string;
  view(): View;
  environment: Environment;
}) {
  const store = mediaStore(home);
  return async (request: Request): Promise<Response | null> => {
    const route = new URL(request.url).pathname;
    const owner = /^\/v1\/assets(?:\/([a-f0-9]{64}))?$/.exec(route);
    const runRoute = /^\/v1\/runs\/([1-9][0-9]*)\/assets(?:\/([a-f0-9]{64}))?$/.exec(route);
    const cardRoute = /^\/v1\/cards\/([1-9][0-9]*)\/assets\/([a-f0-9]{64})$/.exec(route);
    if (!owner && !runRoute && !cardRoute) return null;
    try {
      const current = view();
      const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      let id = owner?.[1] ?? runRoute?.[2] ?? cardRoute?.[2];
      if (owner) {
        if (!whose(current, "owner", token)) denied();
      } else if (runRoute) {
        const run = current.get("runs", Number(runRoute[1]));
        if (
          !run ||
          run.state !== "claimed" ||
          run.issued == null ||
          credential(environment, "run", run.id, run.issued) !== token
        )
          denied();
        if (id) {
          const rule = configuration(current, run!.rules_version).rules.find((rule) => rule.name === run!.rule);
          if (!rule?.attachments?.some((asset) => asset.id === id)) denied();
        }
      } else {
        const channel = whose(current, "channel", token);
        const card = current.get("cards", Number(cardRoute![1]));
        const assets: Asset[] = JSON.parse(card?.artifacts ?? "[]");
        if (
          !channel ||
          !configuration(current).channels[channel] ||
          !card ||
          card.quiet ||
          !assets.some((asset) => asset.id === id)
        )
          denied();
      }
      if (request.method === "POST" && !id && !cardRoute) return Response.json(await store.upload(request));
      if (["GET", "HEAD"].includes(request.method) && id) return store.serve(id, request);
      return new Response(null, { status: 405 });
    } catch (error) {
      if (error instanceof MediaError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  };
}

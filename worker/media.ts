import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { HubError, type Hub } from "../protocol/client.ts";
import type { Job } from "../protocol/job.ts";
import { MEDIA_LIMITS, MEDIA_TYPES, mediaType, parseAssets, type Asset } from "../protocol/media.ts";
import { programCommand } from "./agents.ts";

const execute = promisify(execFile);
export async function previewImage(video: string, image: string) {
  try {
    const command = programCommand("ffmpeg");
    await execute(
      command[0],
      [
        ...command.slice(1),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        video,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-2",
        image,
      ],
      { timeout: 15000, windowsHide: true },
    );
    return existsSync(image) && statSync(image).size > 0;
  } catch {
    return false;
  }
}

type MediaHub = Partial<Pick<Hub, "inputAsset" | "uploadAsset">>;
export async function prepareMedia(hub: MediaHub, job: Job, folder: string) {
  const assets = parseAssets(job.rule.attachments ?? []);
  const inputs = path.join(folder, "inputs");
  const outputFolder = path.join(folder, "outputs");
  mkdirSync(inputs, { recursive: true, mode: 0o700 });
  mkdirSync(outputFolder, { recursive: true, mode: 0o700 });
  const images: string[] = [];
  const attachments: (Asset & { path: string; preview?: string })[] = [];
  for (const asset of assets) {
    if (!hub.inputAsset) throw new Error("接单程序没有附件下载接口，请升级后再运行");
    const file = path.join(inputs, asset.id + MEDIA_TYPES[asset.type]);
    const bytes = await hub.inputAsset(job.run, job.token, asset.id);
    if (bytes.length !== asset.size) throw new Error("输入附件不完整，请重新上传");
    writeFileSync(file, bytes, { mode: 0o600 });
    const local: Asset & { path: string; preview?: string } = { ...asset, path: file };
    if (asset.type.startsWith("image/")) images.push(file);
    else {
      const preview = path.join(inputs, `${asset.id}.preview.png`);
      if (await previewImage(file, preview)) {
        local.preview = preview;
        images.push(preview);
      }
    }
    attachments.push(local);
  }
  return { images, attachments, outputFolder };
}

export async function collectMedia(hub: MediaHub, job: Pick<Job, "run" | "token">, folder: string) {
  const directory = path.join(folder, "outputs");
  const artifacts: Asset[] = [];
  const issues: string[] = [];
  if (!existsSync(directory)) return { artifacts, issues };
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== path.join(realpathSync(folder), "outputs"))
    return { artifacts, issues: ["结果附件目录不能是链接"] };
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((file) => mediaType(file.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > MEDIA_LIMITS.count) issues.push("结果附件超过 10 个，仅提交前 10 个");
  for (const item of files.slice(0, MEDIA_LIMITS.count)) {
    const file = path.join(directory, item.name);
    const type = mediaType(item.name)!;
    const size = lstatSync(file);
    const maximum = type.startsWith("image/") ? MEDIA_LIMITS.image : MEDIA_LIMITS.video;
    if (item.isSymbolicLink() || !item.isFile() || size.size < 1 || size.size > maximum) {
      issues.push(`${item.name}：文件无效或超过大小限制`);
      continue;
    }
    if (!hub.uploadAsset) {
      issues.push(`${item.name}：接单程序没有附件上传接口`);
      continue;
    }
    try {
      const asset = await hub.uploadAsset(job.run, job.token, { name: item.name, type, bytes: readFileSync(file) });
      artifacts.push(...parseAssets([asset]));
    } catch (error) {
      if (error instanceof HubError && error.status >= 400 && error.status < 500)
        issues.push(`${item.name}：${error.message}`);
      else throw error;
    }
  }
  return { artifacts, issues };
}

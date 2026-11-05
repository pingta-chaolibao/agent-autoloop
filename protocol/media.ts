import { InputError } from "../kernel/errors.ts";

export type Asset = { id: string; name: string; type: string; size: number };
export const MEDIA_LIMITS = { image: 10_000_000, video: 30_000_000, count: 10 };
export const MEDIA_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
};
export const mediaName = (name: unknown): name is string =>
  typeof name === "string" && !!name.trim() && [...name].length <= 200 && !/[\x00-\x1f\x7f/\\]/.test(name);
export const mediaType = (name: string) =>
  Object.keys(MEDIA_TYPES).find((type) =>
    type === "image/jpeg" ? /\.jpe?g$/i.test(name) : name.toLowerCase().endsWith(MEDIA_TYPES[type]),
  );
export function validAssets(value: unknown): value is Asset[] {
  return (
    Array.isArray(value) &&
    value.length <= MEDIA_LIMITS.count &&
    value.every(
      (asset) =>
        asset &&
        typeof asset === "object" &&
        !Array.isArray(asset) &&
        Object.keys(asset).every((key) => ["id", "name", "type", "size"].includes(key)) &&
        typeof asset.id === "string" &&
        /^[a-f0-9]{64}$/.test(asset.id) &&
        mediaName(asset.name) &&
        Object.hasOwn(MEDIA_TYPES, asset.type) &&
        mediaType(asset.name) === asset.type &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= (asset.type.startsWith("image/") ? MEDIA_LIMITS.image : MEDIA_LIMITS.video),
    )
  );
}
export function parseAssets(value: unknown): Asset[] {
  if (!validAssets(value))
    throw new InputError("附件最多 10 个，只支持 10 MB 以内的 PNG、JPG、WebP 和 30 MB 以内的 MP4");
  return value.map((asset) => ({ ...asset }));
}

import { chmodSync, mkdirSync } from "node:fs";
import { privateWindowsDirectory } from "./windows.ts";

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") privateWindowsDirectory(directory);
  else chmodSync(directory, 0o700);
}

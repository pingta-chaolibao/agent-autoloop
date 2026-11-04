// Failure mode: PowerShell decodes UTF-8 JSON with the OEM code page, corrupting Chinese and emoji before notification.
// Only the production JSON-reading prefix runs; no actual desktop notification is shown.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { powershell } from "../host/windows.ts";
import { readMessage } from "../plugins/desktop/windows.ts";

test("Windows notifications read UTF-8 text as literal JSON", { skip: process.platform !== "win32" }, async () => {
  const expected = { title: "Agent 问你一个问题 😀", body: '试跑：选一个颜色\n保留 "quoted" & %PATH% $(literal)' };
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${readMessage}\n$message | ConvertTo-Json -Compress`],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin!.on("error", reject);
    child.stdin!.end(JSON.stringify(expected));
  });
  assert.deepEqual(JSON.parse(output), expected);
});

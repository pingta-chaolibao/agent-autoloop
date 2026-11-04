// POSIX-only integration fixtures keep running on Linux/macOS. Native Windows has its own process and install fixtures.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const posix = new Set([
  "desktop.test.ts",
  "examples.test.ts",
  "install.test.ts",
  "uninstall.test.ts",
  "loop.test.ts",
  "recipes.test.ts",
  "worker.test.ts",
  "worker-path.test.ts",
  "worker-login-shell.test.ts",
  "try.test.ts",
  "example-plugins.test.ts",
]);
const quick = process.argv.includes("--quick");
const files = readdirSync(path.join(import.meta.dirname, "../tests"))
  .filter((file) => file.endsWith(".test.ts") && !(quick && file === "simulation.test.ts"))
  .filter((file) => {
    if (process.platform !== "win32" || !posix.has(file)) return true;
    console.log(`Windows 使用原生整合测试；POSIX 脚本场景保留在 Linux/macOS：${file}`);
    return false;
  })
  .map((file) => path.join(import.meta.dirname, "../tests", file));
if (process.platform !== "win32") {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...files], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  // Separate processes preserve each fixture's HOME and module cache without Node's Windows IPC test isolation.
  let failed = 0;
  for (const file of files) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", file], {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) failed++;
  }
  console.log(`Windows 测试文件：${files.length}；失败：${failed}`);
  process.exitCode = failed ? 1 : 0;
}

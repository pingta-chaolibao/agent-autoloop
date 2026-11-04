import { existsSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";

type Installation = {
  application: string;
  id: string;
  root: string;
  home: string;
  source: string;
  commit: string;
  program: string;
};
export function windowsInstallation(): Installation | null {
  const file = path.join(HOME, "installation.json");
  if (!existsSync(file)) return null;
  const install = JSON.parse(readFileSync(file, "utf8"));
  if (install.application !== "agent-autoloop" || !/^[a-f0-9]{16}$/.test(install.id) || !path.isAbsolute(install.root))
    return null;
  if (path.resolve(install.home).toLowerCase() !== HOME.toLowerCase()) return null;
  return install;
}

export function removeWindowsInstallation(programRoot: string) {
  const install = windowsInstallation();
  if (!install) return false;
  const releases = path.resolve(install.root, "releases");
  const inside = (file: string) => {
    const relative = path.relative(realpathSync(releases), realpathSync(file));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const markerAt = (directory: string) => {
    const file = path.join(directory, "agent-autoloop-release.json");
    if (!existsSync(file)) return null;
    const marker = JSON.parse(readFileSync(file, "utf8"));
    return marker.application === "agent-autoloop" &&
      marker.id === install.id &&
      marker.commit === path.basename(directory) &&
      /^[a-f0-9]{40}$/.test(marker.commit)
      ? marker
      : null;
  };
  if (!existsSync(releases) || !inside(programRoot) || !markerAt(programRoot)) return false;
  const signature = `Agent Autoloop install ${install.id}`;
  for (const name of ["agent-autoloop.cjs", "agent-autoloop.cmd", "agent-autoloop.ps1"]) {
    const file = path.join(install.root, "bin", name);
    if (existsSync(file) && readFileSync(file, "utf8").includes(signature)) rmSync(file);
  }
  for (const name of ["active.json", "active.previous.json"]) {
    const file = path.join(install.root, name);
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).id === install.id) rmSync(file);
  }
  for (const item of readdirSync(releases, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const directory = path.resolve(releases, item.name);
    if (inside(directory) && markerAt(directory)) rmSync(directory, { recursive: true });
  }
  return true;
}

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectDir = path.resolve(__dirname, "..");
const moduleDir = path.join(projectDir, "node_modules", "better-sqlite3");
const prebuildInstall = path.join(projectDir, "node_modules", ".bin", "prebuild-install");
const electronVersion = require(path.join(projectDir, "node_modules", "electron", "package.json")).version;
const binaryPath = path.join(moduleDir, "build", "Release", "better_sqlite3.node");

const result = spawnSync(prebuildInstall, [
  "--runtime", "electron",
  "--target", electronVersion,
  "--platform", "win32",
  "--arch", "x64",
  "--force"
], {
  cwd: moduleDir,
  stdio: "inherit"
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

const magic = fs.readFileSync(binaryPath).subarray(0, 2).toString("ascii");
if (magic !== "MZ") {
  throw new Error(`Windows native module validation failed: ${binaryPath}`);
}

console.log(`Windows x64 native module ready for Electron ${electronVersion}`);

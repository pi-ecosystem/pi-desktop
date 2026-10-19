#!/usr/bin/env node
// pi-desktop standard install: app + wrapper + owned pi extensions.
// Idempotent — safe to re-run. Everything lands in $HOME, no sudo.
//
//   node scripts/install.mjs                  # full: build + install + extensions
//   node scripts/install.mjs --skip-build      # reuse target/release binary
//   node scripts/install.mjs --extensions-only # just (re)install pi extensions
//   node scripts/install.mjs --skip-extensions # app only
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

if (args.has("-h") || args.has("--help")) {
  console.log("usage: node scripts/install.mjs [--skip-build] [--extensions-only] [--skip-extensions]");
  process.exit(0);
}
for (const a of args) {
  if (!["--skip-build", "--extensions-only", "--skip-extensions"].includes(a)) {
    console.error(`unknown flag: ${a}`);
    process.exit(1);
  }
}

// Owned pi-ecosystem extensions the desktop lights up. Installed via
// `pi install` (single copy in ~/.pi/agent) — never vendored, so pi and
// desktop can never disagree about which copy is loaded.
const EXTENSIONS = [
  "git:github.com/pi-ecosystem/pi-spawn",           // subagents (Agents panel)
  "git:github.com/pi-ecosystem/pi-shadow-browser", // browser_* tools
];

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: platform() === "win32", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`failed: ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function need(cmd) {
  const probe = platform() === "win32" ? ["where", [cmd]] : ["sh", ["-c", `command -v ${cmd}`]];
  const r = spawnSync(probe[0], probe[1], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error(`missing prerequisite: ${cmd}`);
    process.exit(1);
  }
}

function installExtensions() {
  need("pi");
  for (const ext of EXTENSIONS) {
    console.log(`→ pi install ${ext}`);
    run("pi", ["install", ext]);
  }
}

if (args.has("--extensions-only")) {
  installExtensions();
  console.log("extensions done.");
  process.exit(0);
}

// Linux installs the raw binary (no .deb — nothing consumes it), so skip
// bundling there (plain cargo build). macOS needs the .app (dmg),
// Windows the nsis installer.
const BUNDLES = { linux: [], darwin: ["dmg"], win32: ["nsis"] };
const bundles = BUNDLES[platform()] ?? ["deb"];

if (!args.has("--skip-build")) {
  need("npm");
  need("cargo");
  console.log("→ npm install");
  run("npm", ["install"]);
  console.log("→ npm run build");
  run("npm", ["run", "build"]);
  const env = { ...process.env };
  if (platform() === "linux" && process.env.WAYLAND_DISPLAY) {
    try {
      const out = spawnSync("nvidia-smi", [], { stdio: "ignore" });
      if (out.status === 0) env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
    } catch { /* no nvidia-smi: plain build */ }
  }
  // No bundles on Linux: raw binary install. Everywhere else the
  // bundler runs (dmq/nsis/deb per platform above).
  if (bundles.length === 0) {
    console.log("→ cargo build --release (no bundle — takes minutes)");
    run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"], { env });
  } else {
    console.log(`→ tauri build --bundles ${bundles.join(",")} (release — takes minutes)`);
    run("npx", ["tauri", "build", "--bundles", ...bundles], { env });
  }
}

if (platform() === "win32") {
  const dir = join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
  console.log(`→ run the installer in ${dir} (per-user, no admin needed), then re-run with --extensions-only if skipped.`);
} else if (platform() === "darwin") {
  const macosDir = join(ROOT, "src-tauri", "target", "release", "bundle", "macos");
  const app = existsSync(macosDir) ? readdirSync(macosDir).find((f) => f.endsWith(".app")) : null;
  if (!app) {
    console.error("no .app bundle found (run without --skip-build first)");
    process.exit(1);
  }
  const dest = join(homedir(), "Applications");
  mkdirSync(dest, { recursive: true });
  console.log(`→ install ${app} to ~/Applications`);
  cpSync(join(macosDir, app), join(dest, app), { recursive: true, force: true });
} else {
  const bin = join(ROOT, "src-tauri", "target", "release", "pi-desktop");
  if (!existsSync(bin)) {
    console.error("no release binary (run without --skip-build first)");
    process.exit(1);
  }
  const binDir = join(homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  console.log(`→ install ${binDir}/pi-desktop-bin`);
  cpSync(bin, join(binDir, "pi-desktop-bin"), { force: true });
  chmodSync(join(binDir, "pi-desktop-bin"), 0o755);
  writeFileSync(
    join(binDir, "pi-desktop"),
    '#!/bin/sh\nexec env WEBKIT_DISABLE_DMABUF_RENDERER=1 "$HOME/.local/bin/pi-desktop-bin" "$@"\n',
  );
  chmodSync(join(binDir, "pi-desktop"), 0o755);
  // Launcher entry (Linux only: macOS gets it from the .app, Windows
  // from the nsis installer). Puts Pi in the app grid; hotkeys are
  // still the way in (KDE custom shortcut, see README).
  const appsDir = join(homedir(), ".local", "share", "applications");
  const iconsDir = join(homedir(), ".local", "share", "icons");
  mkdirSync(appsDir, { recursive: true });
  mkdirSync(iconsDir, { recursive: true });
  const srcIcon = join(ROOT, "src-tauri", "icons", "128x128.png");
  if (existsSync(srcIcon)) cpSync(srcIcon, join(iconsDir, "pi-desktop.png"), { force: true });
  writeFileSync(
    join(appsDir, "pi-desktop.desktop"),
    `[Desktop Entry]\nType=Application\nName=Pi Desktop\nExec=${join(binDir, "pi-desktop")}\nIcon=pi-desktop\nTerminal=false\nCategories=Utility;\n`,
  );
  try { spawnSync("update-desktop-database", [appsDir], { stdio: "ignore" }); } catch { /* optional */ }
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    console.error(`note: ${binDir} is not on PATH — add it to your shell rc`);
  }
}

if (!args.has("--skip-extensions")) installExtensions();

console.log("done. launch: pi-desktop --toggle-main  (quickbar: --toggle-quickbar)");

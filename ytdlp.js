// Finds a yt-dlp binary, downloading the official standalone build into ./bin if none is installed.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const BIN_DIR = path.join(__dirname, "bin");
const LOCAL = path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

function assetName() {
  const { platform, arch } = process;
  if (platform === "win32") return arch === "arm64" ? "yt-dlp_arm64.exe" : arch === "ia32" ? "yt-dlp_x86.exe" : "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") return arch === "arm64" ? "yt-dlp_linux_aarch64" : arch === "arm" ? "yt-dlp_linux_armv7l" : "yt-dlp_linux";
  return "yt-dlp"; // zipapp, needs python3
}

function works(cmd) {
  return spawnSync(cmd, ["--version"]).status === 0;
}

async function download() {
  const url = RELEASES + assetName();
  console.log(`yt-dlp not found, downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(LOCAL, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  console.log(`Saved yt-dlp to ${LOCAL}`);
}

async function findYtdlp() {
  if (process.env.YTDLP) return process.env.YTDLP;
  if (fs.existsSync(LOCAL) && works(LOCAL)) return LOCAL;
  if (works("yt-dlp")) return "yt-dlp";
  await download();
  if (!works(LOCAL)) throw new Error(`Downloaded ${LOCAL} but it doesn't run. Install yt-dlp manually and set YTDLP=/path/to/yt-dlp.`);
  return LOCAL;
}

module.exports = { findYtdlp };

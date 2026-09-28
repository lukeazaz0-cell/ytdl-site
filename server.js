const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");
const { findYtdlp } = require("./ytdlp");

const PORT = Number(process.env.PORT) || 3000;
let YTDLP;
const ALLOWED_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

function validUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function cleanError(stderr) {
  const line = stderr.split("\n").find((l) => l.startsWith("ERROR:")) || stderr.trim().split("\n").pop() || "yt-dlp failed.";
  return line.replace(/^ERROR:\s*/, "");
}

function sizeOf(f) {
  const size = f.filesize || f.filesize_approx;
  return size ? `${(size / 1024 / 1024).toFixed(1)} MB` : "";
}

function simplifyFormats(info) {
  const formats = [
    HAS_FFMPEG
      ? { id: "bv*+ba/b", label: "Best quality (video + audio)" }
      : { id: "b", label: "Best single file (video + audio)" },
  ];
  for (const f of [...(info.formats || [])].reverse()) {
    const hasVideo = f.vcodec && f.vcodec !== "none";
    const hasAudio = f.acodec && f.acodec !== "none";
    let kind;
    if (hasVideo && hasAudio) kind = `Video ${f.height || "?"}p`;
    else if (hasAudio) kind = f.abr ? `Audio ${Math.round(f.abr)}k` : "Audio";
    else continue; // video-only streams need merging; covered by "best" above
    formats.push({ id: f.format_id, label: [kind, f.ext, sizeOf(f)].filter(Boolean).join(" · ") });
  }
  return formats;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleInfo(req, res) {
  let url = "";
  try {
    url = String(JSON.parse(await readBody(req)).url || "").trim();
  } catch {}
  if (!validUrl(url)) return sendJson(res, 400, { error: "Please enter a valid YouTube URL." });

  execFile(YTDLP, ["-J", "--no-playlist", "--no-warnings", "--", url], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return sendJson(res, 422, { error: cleanError(stderr || err.message) });
    const data = JSON.parse(stdout);
    sendJson(res, 200, {
      title: data.title,
      uploader: data.uploader,
      duration: data.duration_string,
      thumbnail: data.thumbnail,
      formats: simplifyFormats(data),
    });
  });
}

function handleDownload(req, res, params) {
  const url = (params.get("url") || "").trim();
  const format = params.get("format") || "b";
  if (!validUrl(url)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Invalid URL");
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
  const cleanup = () => fs.rm(tmpdir, { recursive: true, force: true }, () => {});
  const args = ["-f", format, "--no-playlist", "--no-warnings", "-o", path.join(tmpdir, "%(title).150B [%(id)s].%(ext)s"), "--", url];
  const child = spawn(YTDLP, args);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (err) => (stderr += err.message));
  child.on("close", (code) => {
    const name = code === 0 && fs.readdirSync(tmpdir)[0];
    if (!name) {
      cleanup();
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(`Download failed: ${cleanError(stderr)}`);
    }
    const file = path.join(tmpdir, name);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": fs.statSync(file).size,
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    fs.createReadStream(file).pipe(res).on("close", cleanup);
  });
  res.on("close", () => {
    if (!res.headersSent) child.kill(); // client gave up before the file was ready
  });
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INDEX);
  }
  if (req.method === "POST" && pathname === "/api/info") return handleInfo(req, res);
  if (req.method === "GET" && pathname === "/api/download") return handleDownload(req, res, searchParams);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

findYtdlp()
  .then((bin) => {
    YTDLP = bin;
    server.listen(PORT, () => console.log(`YTDL running on http://localhost:${PORT} (using ${YTDLP})`));
  })
  .catch((err) => {
    console.error(`Could not set up yt-dlp: ${err.message}`);
    process.exit(1);
  });

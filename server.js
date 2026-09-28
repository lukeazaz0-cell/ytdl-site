const http = require("node:http");
const crypto = require("node:crypto");
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

// Downloads run as background jobs so no single request outlives a proxy timeout (e.g. Cloudflare's 100s):
// the page starts a job, polls its progress, then fetches the finished file.
const jobs = new Map();
const JOB_TTL = 60 * 60 * 1000; // finished files are kept for an hour
const MAX_RUNNING = 5;
const PROGRESS = "download:[progress] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s";

function publicJob(job) {
  const { status, percent, part, parts, speed, eta, error } = job;
  return { status, percent, part, parts, speed, eta, error, file: job.name };
}

function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.child) job.child.kill();
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  jobs.delete(id);
}

setInterval(() => {
  for (const [id, job] of jobs) if (Date.now() - job.updated > JOB_TTL) removeJob(id);
}, 5 * 60 * 1000).unref();

function onOutput(job, line) {
  job.updated = Date.now();
  if (line.startsWith("[download] Destination:")) {
    job.part = Math.min(job.part + 1, job.parts);
    job.percent = 0;
  } else if (line.startsWith("[progress] ")) {
    const [done, total, estimate, speed, eta] = line.slice(11).split(" ").map(Number);
    const size = total || estimate;
    if (size) job.percent = Math.min(100, Math.round((done / size) * 1000) / 10);
    job.speed = speed || null;
    job.eta = Number.isFinite(eta) ? eta : null;
  } else if (/^\[(Merger|ExtractAudio|VideoConvertor|Fixup\w*|FFmpeg\w*)\]/.test(line)) {
    job.status = "processing";
  }
}

function lines(stream, fn) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r?\n|\r/);
    buf = parts.pop();
    parts.forEach(fn);
  });
}

async function handleStartJob(req, res) {
  let body = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {}
  const url = String(body.url || "").trim();
  const format = String(body.format || "b");
  if (!validUrl(url)) return sendJson(res, 400, { error: "Please enter a valid YouTube URL." });
  if ([...jobs.values()].filter((j) => j.status === "downloading" || j.status === "processing").length >= MAX_RUNNING) {
    return sendJson(res, 429, { error: "The server is busy, try again in a minute." });
  }

  const id = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
  const job = { dir, status: "downloading", percent: 0, part: 0, parts: format.includes("+") ? 2 : 1, updated: Date.now() };
  jobs.set(id, job);

  const args = [
    "-f", format, "--no-playlist", "--no-warnings", "--newline", "--progress-template", PROGRESS,
    "-o", path.join(dir, "%(title).150B [%(id)s].%(ext)s"), "--", url,
  ];
  const child = (job.child = spawn(YTDLP, args));
  let stderr = "";
  lines(child.stdout, (line) => onOutput(job, line));
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-10_000)));
  child.on("error", (err) => (stderr += err.message));
  child.on("close", (code) => {
    job.child = null;
    job.updated = Date.now();
    const name = code === 0 && fs.readdirSync(dir).find((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"));
    if (name) Object.assign(job, { status: "done", percent: 100, name, path: path.join(dir, name) });
    else Object.assign(job, { status: "error", error: cleanError(stderr) });
  });

  sendJson(res, 202, { id });
}

function handleJobFile(req, res, job) {
  if (!job || job.status !== "done") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("File not found or expired.");
  }
  job.updated = Date.now();
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": fs.statSync(job.path).size,
    "Content-Disposition": `attachment; filename="${job.name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(job.name)}`,
  });
  fs.createReadStream(job.path).pipe(res);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INDEX);
  }
  if (req.method === "POST" && pathname === "/api/info") return handleInfo(req, res);
  if (req.method === "POST" && pathname === "/api/jobs") return handleStartJob(req, res);
  const match = pathname.match(/^\/api\/jobs\/([\w-]+)(\/file)?$/);
  if (match && req.method === "GET") {
    const job = jobs.get(match[1]);
    if (match[2]) return handleJobFile(req, res, job);
    return job ? sendJson(res, 200, publicJob(job)) : sendJson(res, 404, { error: "Job not found or expired." });
  }
  if (match && req.method === "DELETE") {
    removeJob(match[1]);
    res.writeHead(204);
    return res.end();
  }
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

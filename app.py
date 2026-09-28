import os
import shutil
import tempfile
from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request, send_file
import yt_dlp

app = Flask(__name__)

ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
HAS_FFMPEG = shutil.which("ffmpeg") is not None


def valid_url(url):
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and parsed.hostname in ALLOWED_HOSTS


def base_opts():
    return {"quiet": True, "no_warnings": True, "noplaylist": True}


def size_of(f):
    size = f.get("filesize") or f.get("filesize_approx")
    return f"{size / 1024 / 1024:.1f} MB" if size else ""


def simplify_formats(info):
    formats = []
    if HAS_FFMPEG:
        formats.append({"id": "bv*+ba/b", "label": "Best quality (video + audio)"})
    else:
        formats.append({"id": "b", "label": "Best single file (video + audio)"})

    for f in reversed(info.get("formats") or []):
        vcodec, acodec = f.get("vcodec"), f.get("acodec")
        if vcodec not in (None, "none") and acodec not in (None, "none"):
            kind = f"Video {f.get('height') or '?'}p"
        elif vcodec in (None, "none") and acodec not in (None, "none"):
            abr = f.get("abr")
            kind = f"Audio {round(abr)}k" if abr else "Audio"
        else:
            continue  # video-only streams need merging; covered by "best" above
        label = " · ".join(p for p in (kind, f.get("ext"), size_of(f)) if p)
        formats.append({"id": f["format_id"], "label": label})
    return formats


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/info")
def info():
    url = (request.get_json(silent=True) or {}).get("url", "").strip()
    if not valid_url(url):
        return jsonify(error="Please enter a valid YouTube URL."), 400
    try:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            data = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        return jsonify(error=str(e).removeprefix("ERROR: ")), 422
    return jsonify(
        title=data.get("title"),
        uploader=data.get("uploader"),
        duration=data.get("duration_string"),
        thumbnail=data.get("thumbnail"),
        formats=simplify_formats(data),
    )


@app.get("/api/download")
def download():
    url = request.args.get("url", "").strip()
    fmt = request.args.get("format", "b")
    if not valid_url(url):
        return "Invalid URL", 400

    tmpdir = tempfile.mkdtemp(prefix="ytdl-")
    opts = base_opts() | {
        "format": fmt,
        "outtmpl": os.path.join(tmpdir, "%(title).150B [%(id)s].%(ext)s"),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        path = os.path.join(tmpdir, os.listdir(tmpdir)[0])
    except (yt_dlp.utils.DownloadError, IndexError) as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return f"Download failed: {e}", 500

    response = send_file(path, as_attachment=True, download_name=os.path.basename(path))
    response.call_on_close(lambda: shutil.rmtree(tmpdir, ignore_errors=True))
    return response


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))

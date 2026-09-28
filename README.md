# ytdl-site

A minimal YouTube downloader: Flask + [yt-dlp](https://github.com/yt-dlp/yt-dlp) on the back end, plain Bootstrap 5 on the front end (no custom CSS).

## Run

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000, paste a YouTube link, pick a format and hit **Download**.

Install [ffmpeg](https://ffmpeg.org/) to unlock the "Best quality" option (merges the best video and audio streams). Without it, only formats that already contain both, or audio-only formats, are offered.

## Endpoints

- `POST /api/info` — `{"url": "..."}` → title, uploader, duration, thumbnail and available formats.
- `GET /api/download?url=...&format=...` — downloads with yt-dlp to a temp dir and streams the file back.

Only YouTube URLs are accepted. Only download content you have the right to download.

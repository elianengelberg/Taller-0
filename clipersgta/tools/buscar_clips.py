#!/usr/bin/env python3
"""Buscador de clips virales de GTA 6 para Clipersgta._

Usa SOLO APIs oficiales:
  - Twitch Helix  (clips más vistos y streams en vivo de la categoría GTA VI)
  - YouTube Data API v3 (Shorts/videos de GTA 6 más vistos de las últimas horas)

Credenciales (gratis):
  Twitch:  TWITCH_CLIENT_ID (no es secreto) + token Bearer para api.twitch.tv
  YouTube: clave de API para www.googleapis.com (header X-goog-api-key)
En la sesión de Claude los tokens los inyecta el proxy: no hace falta ponerlos acá.
Fuera de ella: exportar TWITCH_TOKEN y YOUTUBE_API_KEY.

Uso:
  python3 tools/buscar_clips.py               # últimas 24 h
  python3 tools/buscar_clips.py --horas 6     # últimas 6 h
Salida: ojeo/AAAA-MM-DD_HHMM.md (ranking con links, creador, idioma, duración)
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

GAME_NAME = "Grand Theft Auto VI"
YT_QUERIES = ["GTA 6", "GTA VI", "GTA 6 gameplay", "GTA 6 clip", "GTA 6 español"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "ojeo")


def get(url, headers):
    req = urllib.request.Request(url, headers={"User-Agent": "clip-scout/1.0", **headers})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# ---------------- Twitch ----------------
def twitch_headers():
    cid = os.environ.get("TWITCH_CLIENT_ID")
    if not cid:
        raise RuntimeError("falta TWITCH_CLIENT_ID")
    return {"Client-Id": cid,
            "Authorization": "Bearer " + os.environ.get("TWITCH_TOKEN", "proxy-injected")}


def twitch(horas):
    h = twitch_headers()
    base = "https://api.twitch.tv/helix"
    games = get(f"{base}/games?name={urllib.parse.quote(GAME_NAME)}", h)["data"]
    if not games:
        raise RuntimeError(f"Twitch no encontró la categoría '{GAME_NAME}'")
    gid = games[0]["id"]
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=horas)).strftime("%Y-%m-%dT%H:%M:%SZ")
    clips, cursor = [], None
    for _ in range(3):  # hasta 300 clips
        url = f"{base}/clips?game_id={gid}&first=100&started_at={since}"
        if cursor:
            url += f"&after={cursor}"
        r = get(url, h)
        clips += r["data"]
        cursor = r.get("pagination", {}).get("cursor")
        if not cursor:
            break
    streams = get(f"{base}/streams?game_id={gid}&first=25", h)["data"]
    return clips, streams


# ---------------- YouTube ----------------
def yt_get(path, params):
    key = os.environ.get("YOUTUBE_API_KEY")
    if key:
        params = {**params, "key": key}
    hdr = {} if key else {"X-goog-api-key": "proxy-injected"}
    return get(f"https://www.googleapis.com/youtube/v3/{path}?{urllib.parse.urlencode(params)}", hdr)


def iso_dur(s):
    import re
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    hh, mm, ss = (int(x or 0) for x in m.groups())
    return hh * 3600 + mm * 60 + ss


def youtube(horas):
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=horas)).strftime("%Y-%m-%dT%H:%M:%SZ")
    ids = []
    for q in YT_QUERIES:
        r = yt_get("search", {"part": "id", "q": q, "type": "video", "order": "viewCount",
                              "publishedAfter": since, "maxResults": 25})
        ids += [i["id"]["videoId"] for i in r.get("items", [])]
    ids = list(dict.fromkeys(ids))
    vids = []
    for i in range(0, len(ids), 50):
        r = yt_get("videos", {"part": "snippet,statistics,contentDetails", "id": ",".join(ids[i:i + 50])})
        vids += r.get("items", [])
    return vids


# ---------------- Reporte ----------------
def lang_flag(code):
    code = (code or "").lower()
    if code.startswith("es"):
        return "ES"
    if code.startswith("en"):
        return "EN"
    return code.upper() or "?"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--horas", type=int, default=24)
    ap.add_argument("--top", type=int, default=25)
    a = ap.parse_args()

    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3)))
    lines = [f"# Ojeo de clips GTA 6 — {now:%Y-%m-%d %H:%M} ART (últimas {a.horas} h)", "",
             "Prioridad: ES y EN con más vistas. Siempre acreditar al creador. Saltar leaks/spoilers fuertes.", ""]
    errors = []

    try:
        clips, streams = twitch(a.horas)
        clips.sort(key=lambda c: c["view_count"], reverse=True)
        lines += ["## Twitch — clips más vistos", "",
                  "| # | Vistas | Idioma | Creador | Dur. | Título | Link |", "|---|---|---|---|---|---|---|"]
        for n, c in enumerate(clips[:a.top], 1):
            t = c["title"].replace("|", "/")
            lines.append(f"| {n} | {c['view_count']:,} | {lang_flag(c['language'])} | @{c['broadcaster_name']} | "
                         f"{c['duration']:.0f}s | {t} | {c['url']} |")
        lines += ["", "## Twitch — en vivo ahora (para buscar momentos)", "",
                  "| Espectadores | Idioma | Canal | Título |", "|---|---|---|---|"]
        for s in streams:
            lines.append(f"| {s['viewer_count']:,} | {lang_flag(s['language'])} | "
                         f"[{s['user_name']}](https://twitch.tv/{s['user_login']}) | {s['title'].replace('|', '/')} |")
        lines.append("")
    except Exception as e:  # noqa: BLE001
        errors.append(f"Twitch: {e}")

    try:
        vids = youtube(a.horas)
        vids.sort(key=lambda v: int(v["statistics"].get("viewCount", 0)), reverse=True)
        lines += ["## YouTube — lo más visto", "",
                  "| # | Vistas | Idioma | Canal | Dur. | Título | Link |", "|---|---|---|---|---|---|---|"]
        for n, v in enumerate(vids[:a.top], 1):
            sn = v["snippet"]
            d = iso_dur(v["contentDetails"].get("duration"))
            kind = "Short" if d <= 60 else f"{d // 60}m"
            lang = sn.get("defaultAudioLanguage") or sn.get("defaultLanguage")
            lines.append(f"| {n} | {int(v['statistics'].get('viewCount', 0)):,} | {lang_flag(lang)} | "
                         f"{sn['channelTitle']} | {kind} | {sn['title'].replace('|', '/')} | "
                         f"https://youtu.be/{v['id']} |")
        lines.append("")
    except Exception as e:  # noqa: BLE001
        errors.append(f"YouTube: {e}")

    if errors:
        lines += ["## Fuentes que fallaron", ""] + [f"- {x}" for x in errors]

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{now:%Y-%m-%d_%H%M}.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Reporte: {os.path.abspath(out)}")
    for e in errors:
        print("AVISO", e, file=sys.stderr)


if __name__ == "__main__":
    main()

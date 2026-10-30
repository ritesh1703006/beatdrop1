import os
import re
import json
import logging
from urllib.parse import urlparse, parse_qs
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests
import yt_dlp

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("beatdrop")

# In-memory caches
PLAYLIST_CACHE = {}
TRACK_RESOLVE_CACHE = {}

# Curated presets including dedicated Desi Hip Hop (DHH)
PRESETS = [
    {
        "id": "PLtlu7gv0lIvEO-MozJ4UNW0YgA8rhWifg",
        "name": "👑 Desi Hip Hop (DHH) Anthems",
        "category": "DHH Legends • Seedhe Maut, KR$NA, DIVINE, Talha Anjum",
        "description": "The ultimate Indian & Pakistani hip hop collection. Hard bars, classic flows.",
        "platform": "youtube"
    },
    {
        "id": "PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i",
        "name": "🔥 Global Top 100",
        "category": "Global Chart Toppers",
        "description": "The hottest songs streaming worldwide right now.",
        "platform": "youtube"
    },
    {
        "id": "PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj",
        "name": "✨ 2000s Pop Throwbacks",
        "category": "Timeless Hits & Nostalgia",
        "description": "Britney, Eminem, Lady Gaga, Rihanna, Katy Perry & Usher.",
        "platform": "youtube"
    },
    {
        "id": "PLDIoUOhQQPlXr63I_vwF9GD8sAKh77dWU",
        "name": "🎧 Golden Era 90s & 2000s Hip Hop",
        "category": "West Coast, East Coast & Boom Bap",
        "description": "2Pac, Biggie, 50 Cent, Snoop Dogg, Jay-Z & Outkast.",
        "platform": "youtube"
    },
    {
        "id": "PL15B1E77BB5708555",
        "name": "🌟 Billion+ Views Club",
        "category": "All-Time Most Streamed",
        "description": "The biggest legendary songs with over 1 billion views.",
        "platform": "youtube"
    }
]

HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}


def clean_title(title: str) -> str:
    """Strip clutter like (Official Video), (HD), [Lyric Video], etc."""
    if not title:
        return ""
    patterns = [
        r"\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Music\s*Video|Official\s*Audio|Audio|Lyric\s*Video|Lyrics|Visualizer|HD|4K|Remastered|HQ)[\)\]]",
        r"\s*[\(\[](?:ft\.|feat\.|featuring)[^\)\]]+[\)\]]",
        r"\s*[\(\[](?:Official|Explicit|Clean|Live|Video)[\)\]]",
        r"\s*\|\s*Official\s*Video.*$",
    ]
    cleaned = title
    for p in patterns:
        cleaned = re.sub(p, "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def detect_platform(raw_url: str) -> str:
    """Identify if URL belongs to Spotify, Apple Music, or YouTube."""
    raw = raw_url.strip().lower()
    if "spotify.com" in raw:
        return "spotify"
    if "music.apple.com" in raw or "apple.com" in raw:
        return "apple"
    return "youtube"


# ============================================================
# SPOTIFY PLAYLIST & ALBUM EXTRACTOR
# ============================================================

def fetch_spotify_playlist(url: str):
    """Extract tracks, title, and cover artwork from public Spotify playlist or album."""
    # Match ID
    m = re.search(r"(playlist|album)/([a-zA-Z0-9]+)", url)
    if not m:
        raise ValueError("Invalid Spotify link. Please provide a Spotify playlist or album URL.")

    entity_type = m.group(1)
    entity_id = m.group(2)
    cache_key = f"spotify:{entity_type}:{entity_id}"

    if cache_key in PLAYLIST_CACHE:
        return PLAYLIST_CACHE[cache_key]

    embed_url = f"https://open.spotify.com/embed/{entity_type}/{entity_id}"
    logger.info(f"Extracting Spotify {entity_type} from {embed_url}...")

    resp = requests.get(embed_url, headers=HTTP_HEADERS, timeout=12)
    if resp.status_code != 200:
        raise ValueError(f"Could not load Spotify playlist (HTTP {resp.status_code}). Check if playlist is public.")

    # Parse NEXT_DATA JSON
    match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', resp.text, re.DOTALL)
    if not match:
        # Fallback to search script
        scripts = re.findall(r'<script[^>]*>(.*?)</script>', resp.text, re.DOTALL)
        json_str = None
        for s in scripts:
            if "trackList" in s:
                json_str = s
                break
        if not json_str:
            raise ValueError("Could not parse Spotify playlist structure. Ensure playlist is public.")
    else:
        json_str = match.group(1)

    data = json.loads(json_str)
    props = data.get("props", {}).get("pageProps", {})
    entity = props.get("state", {}).get("data", {}).get("entity", {})

    playlist_title = entity.get("title") or "Spotify Playlist"
    cover_art = entity.get("coverArt", {}).get("sources", [{}])[0].get("url", "")
    raw_tracks = entity.get("trackList", [])

    if not raw_tracks:
        raise ValueError("No playable tracks found in this Spotify playlist.")

    tracks = []
    for item in raw_tracks:
        raw_title = item.get("title") or ""
        subtitle = item.get("subtitle") or ""
        artist = subtitle.replace("\xa0", " ").strip()
        cleaned_t = clean_title(raw_title)
        duration_sec = int(item.get("duration", 0) / 1000)

        tracks.append({
            "id": None, # Resolved on demand
            "title": cleaned_t,
            "rawTitle": f"{cleaned_t} - {artist}",
            "artist": artist,
            "duration": duration_sec,
            "thumbnail": cover_art or "https://open.spotify.com/favicon.ico",
            "platform": "spotify"
        })

    result = {
        "id": cache_key,
        "title": playlist_title,
        "platform": "spotify",
        "platformBadge": "Spotify Playlist",
        "trackCount": len(tracks),
        "tracks": tracks
    }

    PLAYLIST_CACHE[cache_key] = result
    return result


# ============================================================
# APPLE MUSIC PLAYLIST & ALBUM EXTRACTOR
# ============================================================

def fetch_apple_music_playlist(url: str):
    """Extract tracks, title, and cover artwork from public Apple Music playlist or album."""
    cache_key = f"apple:{url}"
    if cache_key in PLAYLIST_CACHE:
        return PLAYLIST_CACHE[cache_key]

    logger.info(f"Extracting Apple Music playlist from {url}...")
    resp = requests.get(url, headers=HTTP_HEADERS, timeout=12)
    if resp.status_code != 200:
        raise ValueError(f"Could not load Apple Music playlist (HTTP {resp.status_code}). Ensure link is public.")

    # Parse serialized-server-data JSON
    match = re.search(r'<script[^>]*id="serialized-server-data"[^>]*>(.*?)</script>', resp.text, re.DOTALL)
    if not match:
        raise ValueError("Could not parse Apple Music page structure. Please verify the URL.")

    data = json.loads(match.group(1))
    root_data = data.get("data", [])

    playlist_title = "Apple Music Playlist"
    tracks = []
    seen = set()

    # Look for og:title
    og_title = re.search(r'<meta property="og:title" content="([^"]+)"', resp.text)
    if og_title:
        playlist_title = og_title.group(1).replace(" on Apple Music", "")

    for entry in root_data:
        d = entry.get("data", {})
        for sec in d.get("sections", []):
            for it in sec.get("items", []):
                t = it.get("title")
                a = it.get("artistName")
                if not t or not a:
                    continue
                pair = (t.lower(), a.lower())
                if pair in seen:
                    continue
                seen.add(pair)

                cleaned_t = clean_title(t)
                tracks.append({
                    "id": None, # Resolved on demand
                    "title": cleaned_t,
                    "rawTitle": f"{cleaned_t} - {a}",
                    "artist": a,
                    "duration": 0,
                    "thumbnail": "https://music.apple.com/favicon.ico",
                    "platform": "apple"
                })

    if not tracks:
        raise ValueError("No tracks found in this Apple Music playlist.")

    result = {
        "id": cache_key,
        "title": playlist_title,
        "platform": "apple",
        "platformBadge": "Apple Music Playlist",
        "trackCount": len(tracks),
        "tracks": tracks
    }

    PLAYLIST_CACHE[cache_key] = result
    return result


# ============================================================
# YOUTUBE & YOUTUBE MUSIC PLAYLIST EXTRACTOR
# ============================================================

def extract_youtube_url_and_id(raw_input: str):
    """Normalize YouTube / YouTube Music URL or playlist ID."""
    raw = raw_input.strip()

    if "youtube.com" in raw or "youtu.be" in raw:
        try:
            parsed = urlparse(raw)
            qs = parse_qs(parsed.query)

            if "list" in qs and qs["list"]:
                list_id = qs["list"][0].strip()
                if list_id.startswith("VL"):
                    list_id = list_id[2:]

                if list_id.startswith("RD"):
                    if "v" in qs and qs["v"]:
                        return list_id, f"https://www.youtube.com/watch?v={qs['v'][0]}&list={list_id}"
                    return list_id, f"https://www.youtube.com/watch?list={list_id}"

                return list_id, f"https://www.youtube.com/playlist?list={list_id}"

            if "/browse/VL" in parsed.path:
                list_id = parsed.path.split("/browse/VL")[-1]
                return list_id, f"https://www.youtube.com/playlist?list={list_id}"

            match = re.search(r"([A-Za-z0-9_-]{12,40})", parsed.path)
            if match:
                list_id = match.group(1)
                if list_id.startswith("VL"):
                    list_id = list_id[2:]
                return list_id, f"https://www.youtube.com/playlist?list={list_id}"
        except Exception as e:
            logger.warning(f"Error parsing YouTube URL {raw}: {e}")

    clean_id = raw
    if clean_id.startswith("VL"):
        clean_id = clean_id[2:]
    clean_id = clean_id.split("&")[0].split("#")[0].split("?")[0].strip()

    return clean_id, f"https://www.youtube.com/playlist?list={clean_id}"


def fetch_youtube_playlist(playlist_id: str, fetch_url: str, max_items: int = 500, force_refresh: bool = False):
    """Fetch YouTube metadata and track list fast using yt-dlp."""
    if not force_refresh and playlist_id in PLAYLIST_CACHE:
        cached = PLAYLIST_CACHE[playlist_id]
        logger.info(f"Serving playlist {playlist_id} from cache ({len(cached.get('tracks', []))} tracks)")
        return cached

    logger.info(f"Extracting YouTube tracks for {fetch_url} (up to {max_items} tracks)...")

    ydl_opts = {
        "extract_flat": True,
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,
        "playlistend": max_items,
        "extractor_retries": 1,
        "socket_timeout": 12,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(fetch_url, download=False)

    if not result:
        raise ValueError("Could not extract playlist. Make sure the playlist is public or unlisted.")

    title = result.get("title") or "YouTube Music Playlist"
    entries = result.get("entries") or []

    tracks = []
    seen_ids = set()

    for entry in entries:
        if not entry:
            continue
        vid = entry.get("id")
        raw_title = entry.get("title")
        if not vid or not raw_title:
            continue
        if vid in seen_ids:
            continue
        seen_ids.add(vid)

        if "[private video]" in raw_title.lower() or "[deleted video]" in raw_title.lower():
            continue

        uploader = entry.get("uploader") or entry.get("artist") or ""
        cleaned = clean_title(raw_title)

        display_artist = uploader
        display_title = cleaned
        if " - " in cleaned:
            parts = cleaned.split(" - ", 1)
            display_artist = parts[0].strip()
            display_title = parts[1].strip()

        duration = entry.get("duration") or 0

        tracks.append({
            "id": vid,
            "title": display_title,
            "rawTitle": raw_title,
            "artist": display_artist,
            "duration": duration,
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "platform": "youtube"
        })

    data = {
        "id": playlist_id,
        "title": title,
        "platform": "youtube",
        "platformBadge": "YouTube Music Playlist",
        "trackCount": len(tracks),
        "tracks": tracks
    }

    if tracks:
        PLAYLIST_CACHE[playlist_id] = data

    return data


# ============================================================
# UNIVERSAL TRACK RESOLVER (Bridge Spotify/Apple -> YouTube)
# ============================================================

def resolve_song_to_youtube(artist: str, title: str):
    """Find the best clean YouTube audio stream for any artist & song title."""
    cache_key = f"{artist.lower().strip()}:{title.lower().strip()}"
    if cache_key in TRACK_RESOLVE_CACHE:
        return TRACK_RESOLVE_CACHE[cache_key]

    query = f"{artist} {title} audio"
    logger.info(f"Resolving track to YouTube audio: '{query}'...")

    ydl_opts = {
        "extract_flat": True,
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,
        "socket_timeout": 8,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        res = ydl.extract_info(f"ytsearch1:{query}", download=False)
        entries = res.get("entries", [])
        if entries and entries[0]:
            top_hit = entries[0]
            resolved = {
                "videoId": top_hit.get("id"),
                "title": top_hit.get("title"),
                "thumbnail": f"https://i.ytimg.com/vi/{top_hit.get('id')}/hqdefault.jpg"
            }
            TRACK_RESOLVE_CACHE[cache_key] = resolved
            return resolved

    raise ValueError(f"Could not find YouTube audio for '{title}' by '{artist}'")


# ============================================================
# API ROUTES
# ============================================================

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok", "app": "beatdrop", "engineered_by": "Ritesh"}), 200


@app.route("/api/presets", methods=["GET"])
def get_presets():
    return jsonify({"presets": PRESETS})


@app.route("/api/load-playlist", methods=["POST"])
def load_playlist():
    body = request.get_json() or {}
    raw_url = body.get("url", "").strip()

    if not raw_url:
        return jsonify({"error": "Please provide a playlist link from Spotify, Apple Music, or YouTube."}), 400

    platform = detect_platform(raw_url)
    logger.info(f"Detected platform: {platform.upper()} for URL: {raw_url}")

    try:
        if platform == "spotify":
            data = fetch_spotify_playlist(raw_url)
        elif platform == "apple":
            data = fetch_apple_music_playlist(raw_url)
        else:
            playlist_id, fetch_url = extract_youtube_url_and_id(raw_url)
            if not playlist_id:
                return jsonify({"error": "Could not identify a valid playlist ID from the link."}), 400

            force_refresh = body.get("force_refresh", False)
            if playlist_id in PLAYLIST_CACHE and len(PLAYLIST_CACHE[playlist_id].get("tracks", [])) <= 40:
                force_refresh = True

            data = fetch_youtube_playlist(playlist_id, fetch_url, max_items=500, force_refresh=force_refresh)

        if not data.get("tracks"):
            return jsonify({"error": "No playable tracks found in this playlist. Please ensure it's Public."}), 400

        return jsonify(data)
    except Exception as e:
        logger.error(f"Failed to load playlist: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/resolve-track", methods=["POST"])
def resolve_track():
    """Resolve an external Spotify or Apple Music song into a playable YouTube video ID."""
    body = request.get_json() or {}
    artist = body.get("artist", "").strip()
    title = body.get("title", "").strip()

    if not title:
        return jsonify({"error": "Song title is required"}), 400

    try:
        resolved = resolve_song_to_youtube(artist, title)
        return jsonify(resolved)
    except Exception as e:
        logger.error(f"Failed to resolve track '{title}': {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n=======================================================")
    print(f"🎵 BeatDrop - Universal Music Guesser Running!")
    print(f"👉 Engineered by Ritesh | Open: http://localhost:{port}")
    print(f"=======================================================\n")
    app.run(host="0.0.0.0", port=port, debug=True)

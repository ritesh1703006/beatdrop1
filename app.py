import os
import re
import json
import logging
import uuid
import time
import random
import threading
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
    resp = send_from_directory("static", "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


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


# ============================================================
# MULTIPLAYER ONLINE ROOM SYSTEM (Thread-Safe Single-Process)
# ============================================================

ROOMS = {}
ROOMS_LOCK = threading.Lock()


def cleanup_stale_rooms():
    """Remove rooms inactive for more than 3 hours."""
    now = time.time()
    with ROOMS_LOCK:
        stale = [rid for rid, r in ROOMS.items() if (now - r.get("updated_at", 0)) > 10800]
        for rid in stale:
            ROOMS.pop(rid, None)


def generate_room_code() -> str:
    """Generate a clean, memorable 5-character alphanumeric room code."""
    prefixes = ["DHH", "BEAT", "DROP", "WAVE", "JAM"]
    for _ in range(50):
        code = f"{random.choice(prefixes)}{random.randint(10, 99)}"
        if code not in ROOMS:
            return code
    return f"ROOM{random.randint(100, 999)}"


def normalize_room_code(code: str) -> str:
    if not code:
        return ""
    return re.sub(r"[^A-Za-z0-9]", "", code).upper()


DEFAULT_DHH_TRACKS = [
    {"id": "cW8VLC9nnTo", "title": "101", "artist": "Seedhe Maut", "rawTitle": "Seedhe Maut - 101", "duration": 180, "thumbnail": "https://i.ytimg.com/vi/cW8VLC9nnTo/hqdefault.jpg"},
    {"id": "GvX74K24m1I", "title": "Namastute", "artist": "Seedhe Maut", "rawTitle": "Seedhe Maut - Namastute", "duration": 190, "thumbnail": "https://i.ytimg.com/vi/GvX74K24m1I/hqdefault.jpg"},
    {"id": "pA_P2wL4m4Y", "title": "Say My Name", "artist": "KR$NA", "rawTitle": "KR$NA - Say My Name", "duration": 175, "thumbnail": "https://i.ytimg.com/vi/pA_P2wL4m4Y/hqdefault.jpg"},
    {"id": "dQw4w9WgXcQ", "title": "Kohinoor", "artist": "DIVINE", "rawTitle": "DIVINE - Kohinoor", "duration": 200, "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"},
    {"id": "kJQP7kiw5Fk", "title": "Afsaanay", "artist": "Young Stunners", "rawTitle": "Young Stunners - Afsaanay", "duration": 230, "thumbnail": "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg"},
    {"id": "9bZkp7q19f0", "title": "Gumaan", "artist": "Young Stunners", "rawTitle": "Young Stunners - Gumaan", "duration": 220, "thumbnail": "https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg"},
    {"id": "7wzR4g75w3k", "title": "Prarthana", "artist": "KR$NA", "rawTitle": "KR$NA - Prarthana", "duration": 185, "thumbnail": "https://i.ytimg.com/vi/7wzR4g75w3k/hqdefault.jpg"},
    {"id": "mE0F1jGv81o", "title": "Nanchaku", "artist": "Seedhe Maut ft. MC Stan", "rawTitle": "Seedhe Maut - Nanchaku", "duration": 210, "thumbnail": "https://i.ytimg.com/vi/mE0F1jGv81o/hqdefault.jpg"}
]


def load_tracks_for_room(raw_url: str):
    """Load playlist data given custom URL or preset."""
    if not raw_url:
        raw_url = PRESETS[0]["id"]

    try:
        platform = detect_platform(raw_url)
        if platform == "spotify":
            return fetch_spotify_playlist(raw_url)
        elif platform == "apple":
            return fetch_apple_music_playlist(raw_url)
        else:
            playlist_id, fetch_url = extract_youtube_url_and_id(raw_url)
            if not playlist_id:
                playlist_id = PRESETS[0]["id"]
                fetch_url = f"https://www.youtube.com/playlist?list={playlist_id}"
            return fetch_youtube_playlist(playlist_id, fetch_url, max_items=500)
    except Exception as e:
        logger.warning(f"Live playlist fetch failed ({e}). Using curated DHH fallback catalog.")
        return {
            "id": "fallback-dhh",
            "title": "👑 Desi Hip Hop (DHH) Anthems",
            "platform": "youtube",
            "platformBadge": "DHH Legends",
            "trackCount": len(DEFAULT_DHH_TRACKS),
            "tracks": list(DEFAULT_DHH_TRACKS)
        }


def pick_room_track(room: dict):
    """Randomly pick a track from room playlist and prepare YouTube stream."""
    tracks = room.get("tracks", [])
    if not tracks:
        return None

    used = set(room.get("used_track_ids", []))
    available = [t for t in tracks if t.get("id") not in used]
    if not available:
        used.clear()
        room["used_track_ids"] = []
        available = tracks

    selected = random.choice(available)
    room["used_track_ids"].append(selected.get("id"))

    vid = selected.get("id")
    # Resolve spotify/apple tracks to YouTube video id if needed
    if selected.get("platform") in ("spotify", "apple") or not vid or len(vid) != 11:
        try:
            resolved = resolve_song_to_youtube(selected.get("artist", ""), selected.get("title", ""))
            vid = resolved.get("videoId")
        except Exception as e:
            logger.warning(f"Could not resolve track: {e}")

    duration = selected.get("duration", 0) or 180
    start_sec = 0
    if duration > 45:
        start_sec = random.randint(15, min(int(duration * 0.6), duration - 25))

    return {
        "id": selected.get("id"),
        "videoId": vid,
        "title": selected.get("title"),
        "artist": selected.get("artist"),
        "rawTitle": selected.get("rawTitle", selected.get("title")),
        "thumbnail": selected.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "start_seconds": start_sec,
        "duration": duration
    }


def check_guess_match(guess: str, track: dict) -> bool:
    """Validate player guess against secret current track."""
    if not guess or not track:
        return False
    g = re.sub(r"[^\w\s]", "", guess.lower()).strip()
    title = re.sub(r"[^\w\s]", "", track.get("title", "").lower()).strip()
    artist = re.sub(r"[^\w\s]", "", track.get("artist", "").lower()).strip()
    raw = re.sub(r"[^\w\s]", "", track.get("rawTitle", "").lower()).strip()

    if not g:
        return False

    if g == title or title in g or g in title:
        if len(g) >= 3:
            return True
    combined = f"{title} {artist}"
    if g in combined or combined in g:
        if len(g) >= 3:
            return True
    combined_rev = f"{artist} {title}"
    if g in combined_rev or combined_rev in g:
        if len(g) >= 3:
            return True
    if g in raw or raw in g:
        if len(g) >= 4:
            return True
    return False


def sanitize_room(room_id: str, token: str = None) -> dict:
    """Return player-safe room state. Hides secret track title while in playing state."""
    r = ROOMS.get(room_id)
    if not r:
        return None

    now = time.time()
    host = r["players"]["host"]
    guest = r["players"]["guest"]

    host_connected = (now - host.get("last_seen", 0)) < 25 if host else False
    guest_connected = (now - guest.get("last_seen", 0)) < 25 if guest else False

    # Check buzzer countdown
    buzzer_info = None
    if r.get("buzzer"):
        expires_at = r["buzzer"].get("expires_at", 0)
        rem = max(0, int(expires_at - now))
        if rem <= 0 and r.get("status") == "playing":
            # Buzzer expired! Auto-clear buzzer to let other player buzz
            r["buzzer"] = None
        else:
            buzzer_info = {
                "player": r["buzzer"]["player"],
                "player_name": r["buzzer"]["player_name"],
                "seconds_left": rem
            }

    # Hide answer title/artist while playing
    safe_track = None
    if r.get("current_track"):
        ct = r["current_track"]
        if r["status"] == "playing":
            safe_track = {
                "videoId": ct.get("videoId"),
                "start_seconds": ct.get("start_seconds", 0),
                "duration": ct.get("duration", 16)
            }
        else:
            safe_track = ct

    # Autocomplete pool from playlist
    autocomplete_pool = []
    if r.get("tracks"):
        autocomplete_pool = [
            {"title": t.get("title"), "artist": t.get("artist")}
            for t in r["tracks"][:120]
        ]

    return {
        "id": r["id"],
        "status": r["status"],
        "round": r["round"],
        "total_rounds": r["total_rounds"],
        "playlist_name": r.get("playlist_name", "Curated Deck"),
        "playlist_url": r.get("playlist_url", ""),
        "current_track": safe_track,
        "buzzer": buzzer_info,
        "round_result": r.get("round_result"),
        "host": {
            "name": host["name"] if host else "Player 1",
            "score": host["score"] if host else 0,
            "connected": host_connected
        },
        "guest": {
            "name": guest["name"] if guest else "Waiting for Player 2...",
            "score": guest["score"] if guest else 0,
            "connected": guest_connected
        } if guest else None,
        "autocomplete_pool": autocomplete_pool
    }


@app.route("/api/room/create", methods=["POST"])
def room_create():
    cleanup_stale_rooms()
    body = request.get_json() or {}
    player_name = body.get("player_name", "").strip() or "Player 1"
    playlist_url = body.get("playlist_url", "").strip() or PRESETS[0]["id"]

    try:
        data = load_tracks_for_room(playlist_url)
    except Exception as e:
        logger.error(f"Error loading playlist for room: {e}")
        # Fallback to PRESETS[0]
        data = load_tracks_for_room(PRESETS[0]["id"])

    tracks = data.get("tracks", [])
    if not tracks:
        return jsonify({"error": "No tracks could be loaded for this room playlist."}), 400

    room_code = generate_room_code()
    host_token = str(uuid.uuid4())
    now = time.time()

    room_obj = {
        "id": room_code,
        "created_at": now,
        "updated_at": now,
        "status": "waiting",
        "playlist_name": data.get("title", "Desi Hip Hop Anthems"),
        "playlist_url": playlist_url,
        "tracks": tracks,
        "round": 0,
        "total_rounds": 5,
        "current_track": None,
        "used_track_ids": [],
        "players": {
            "host": {
                "token": host_token,
                "name": player_name[:20],
                "score": 0,
                "last_seen": now
            },
            "guest": None
        },
        "buzzer": None,
        "round_result": None,
        "history": []
    }

    with ROOMS_LOCK:
        ROOMS[room_code] = room_obj

    logger.info(f"Room created: {room_code} by {player_name}")
    return jsonify({
        "room_id": room_code,
        "token": host_token,
        "role": "host",
        "room": sanitize_room(room_code, host_token)
    })


@app.route("/api/room/join", methods=["POST"])
def room_join():
    cleanup_stale_rooms()
    body = request.get_json() or {}
    raw_code = body.get("room_id", "").strip()
    player_name = body.get("player_name", "").strip() or "Player 2"

    room_code = normalize_room_code(raw_code)
    if not room_code:
        return jsonify({"error": "Please provide a valid Room Code."}), 400

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": f"Room '{room_code}' not found. Please verify the code or link."}), 404

        now = time.time()
        guest = r["players"].get("guest")

        # Allow joining if no guest yet or previous guest disconnected for > 40s
        if guest and (now - guest.get("last_seen", 0)) < 40:
            return jsonify({"error": f"Room '{room_code}' already has 2 players."}), 400

        guest_token = str(uuid.uuid4())
        r["players"]["guest"] = {
            "token": guest_token,
            "name": player_name[:20],
            "score": 0,
            "last_seen": now
        }
        if r["status"] == "waiting":
            r["status"] = "ready"
        r["updated_at"] = now

    logger.info(f"Player {player_name} joined room {room_code}")
    return jsonify({
        "room_id": room_code,
        "token": guest_token,
        "role": "guest",
        "room": sanitize_room(room_code, guest_token)
    })


@app.route("/api/room/<room_id>", methods=["GET"])
def room_get(room_id: str):
    room_code = normalize_room_code(room_id)
    token = request.args.get("token", "").strip()

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404

        now = time.time()
        role = "spectator"
        host = r["players"].get("host")
        guest = r["players"].get("guest")

        if host and host.get("token") == token:
            host["last_seen"] = now
            role = "host"
        elif guest and guest.get("token") == token:
            guest["last_seen"] = now
            role = "guest"

        r["updated_at"] = now
        safe = sanitize_room(room_code, token)

    return jsonify({"role": role, "room": safe})


@app.route("/api/room/<room_id>/set-playlist", methods=["POST"])
def room_set_playlist(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()
    playlist_url = body.get("playlist_url", "").strip()

    if not playlist_url:
        return jsonify({"error": "Playlist URL is required."}), 400

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404
        if r["players"]["host"].get("token") != token:
            return jsonify({"error": "Only the host can change the room playlist."}), 403

    try:
        data = load_tracks_for_room(playlist_url)
    except Exception as e:
        return jsonify({"error": f"Failed to load playlist: {e}"}), 400

    tracks = data.get("tracks", [])
    if not tracks:
        return jsonify({"error": "No playable tracks in playlist."}), 400

    with ROOMS_LOCK:
        r["playlist_url"] = playlist_url
        r["playlist_name"] = data.get("title", "Curated Deck")
        r["tracks"] = tracks
        r["used_track_ids"] = []
        r["updated_at"] = time.time()
        safe = sanitize_room(room_code, token)

    return jsonify({"room": safe})


@app.route("/api/room/<room_id>/start", methods=["POST"])
def room_start(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404
        if r["players"]["host"].get("token") != token:
            return jsonify({"error": "Only the host can start the battle."}), 403

        track = pick_room_track(r)
        if not track:
            return jsonify({"error": "No tracks ready to play."}), 400

        r["round"] = 1
        r["total_rounds"] = int(body.get("total_rounds", 5))
        r["status"] = "playing"
        r["buzzer"] = None
        r["round_result"] = None
        r["current_track"] = track
        r["updated_at"] = time.time()

        safe = sanitize_room(room_code, token)

    logger.info(f"Battle started in room {room_code}. Round 1.")
    return jsonify({"room": safe})


@app.route("/api/room/<room_id>/buzz", methods=["POST"])
def room_buzz(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404

        if r["status"] != "playing":
            return jsonify({"error": "Audio round is not currently playing."}), 400

        role = None
        if r["players"]["host"] and r["players"]["host"].get("token") == token:
            role = "host"
        elif r["players"]["guest"] and r["players"]["guest"].get("token") == token:
            role = "guest"
        else:
            return jsonify({"error": "Unrecognized player token."}), 403

        now = time.time()
        # Check if buzzer is already locked
        if r.get("buzzer"):
            if r["buzzer"]["expires_at"] > now:
                return jsonify({
                    "error": f"Buzzer already locked by {r['buzzer']['player_name']}!",
                    "buzzer": r["buzzer"]
                }), 409

        # Lock buzzer to this player for 15 seconds
        player_name = r["players"][role]["name"]
        r["buzzer"] = {
            "player": role,
            "player_name": player_name,
            "timestamp": now,
            "expires_at": now + 15
        }
        r["updated_at"] = now
        safe = sanitize_room(room_code, token)

    logger.info(f"Player {player_name} ({role}) buzzed in room {room_code}")
    return jsonify({"success": True, "room": safe})


@app.route("/api/room/<room_id>/guess", methods=["POST"])
def room_guess(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()
    guess_text = body.get("guess", "").strip()

    if not guess_text:
        return jsonify({"error": "Guess cannot be empty."}), 400

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404

        role = None
        if r["players"]["host"] and r["players"]["host"].get("token") == token:
            role = "host"
        elif r["players"]["guest"] and r["players"]["guest"].get("token") == token:
            role = "guest"
        else:
            return jsonify({"error": "Unrecognized player."}), 403

        if r["status"] != "playing":
            return jsonify({"error": "Round is not currently active."}), 400

        current_track = r.get("current_track")
        if not current_track:
            return jsonify({"error": "No current song."}), 400

        # Check buzzer ownership
        buzzer = r.get("buzzer")
        if buzzer and buzzer.get("player") != role:
            return jsonify({"error": f"Buzzer is currently owned by {buzzer.get('player_name')}."}), 403

        player_name = r["players"][role]["name"]
        is_match = check_guess_match(guess_text, current_track)

        if is_match:
            # Correct guess!
            r["players"][role]["score"] += 1
            r["status"] = "revealed"
            r["buzzer"] = None
            r["round_result"] = {
                "winner": role,
                "winner_name": player_name,
                "correct": True,
                "song_title": current_track.get("title"),
                "artist_name": current_track.get("artist"),
                "thumbnail": current_track.get("thumbnail"),
                "videoId": current_track.get("videoId"),
                "message": f"🎉 {player_name} guessed it right!"
            }
            r["history"].append(r["round_result"])
            r["updated_at"] = time.time()
            safe = sanitize_room(room_code, token)
            return jsonify({"correct": True, "room": safe})
        else:
            # Incorrect guess: release buzzer so opponent can steal!
            r["buzzer"] = None
            r["updated_at"] = time.time()
            safe = sanitize_room(room_code, token)
            return jsonify({
                "correct": False,
                "message": f"❌ Incorrect! Buzzer opened for opponent to steal.",
                "room": safe
            })


@app.route("/api/room/<room_id>/skip", methods=["POST"])
def room_skip(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404

        current_track = r.get("current_track")
        if not current_track:
            return jsonify({"error": "No active track."}), 400

        r["status"] = "revealed"
        r["buzzer"] = None
        r["round_result"] = {
            "winner": None,
            "winner_name": "No one",
            "correct": False,
            "song_title": current_track.get("title"),
            "artist_name": current_track.get("artist"),
            "thumbnail": current_track.get("thumbnail"),
            "videoId": current_track.get("videoId"),
            "message": "⏭️ Track revealed (skipped)."
        }
        r["history"].append(r["round_result"])
        r["updated_at"] = time.time()
        safe = sanitize_room(room_code, token)

    return jsonify({"success": True, "room": safe})


@app.route("/api/room/<room_id>/next", methods=["POST"])
def room_next(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if not r:
            return jsonify({"error": "Room not found."}), 404

        if r["players"]["host"].get("token") != token:
            return jsonify({"error": "Only the host can advance to the next round."}), 403

        if r["round"] >= r["total_rounds"]:
            r["status"] = "finished"
            r["updated_at"] = time.time()
            safe = sanitize_room(room_code, token)
            return jsonify({"room": safe, "finished": True})

        track = pick_room_track(r)
        if not track:
            return jsonify({"error": "No further tracks available."}), 400

        r["round"] += 1
        r["status"] = "playing"
        r["buzzer"] = None
        r["round_result"] = None
        r["current_track"] = track
        r["updated_at"] = time.time()
        safe = sanitize_room(room_code, token)

    return jsonify({"room": safe, "finished": False})


@app.route("/api/room/<room_id>/leave", methods=["POST"])
def room_leave(room_id: str):
    room_code = normalize_room_code(room_id)
    body = request.get_json() or {}
    token = body.get("token", "").strip()

    with ROOMS_LOCK:
        r = ROOMS.get(room_code)
        if r:
            if r["players"]["host"] and r["players"]["host"].get("token") == token:
                ROOMS.pop(room_code, None)
                return jsonify({"left": True, "message": "Host left. Room closed."})
            elif r["players"]["guest"] and r["players"]["guest"].get("token") == token:
                r["players"]["guest"] = None
                r["status"] = "waiting"
                r["updated_at"] = time.time()
                return jsonify({"left": True, "message": "Guest left."})

    return jsonify({"left": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n=======================================================")
    print(f"🎵 BeatDrop - Universal Music Guesser Running!")
    print(f"👉 Engineered by Ritesh | Open: http://localhost:{port}")
    print(f"=======================================================\n")
    app.run(host="0.0.0.0", port=port, debug=True)

# ⚡ BeatDrop // Universal Music Heardle
**Engineered by Ritesh** for Music Heads & Desi Hip Hop (DHH) Fans worldwide.

Turn any playlist from **Spotify**, **Apple Music**, **YouTube Music**, or **YouTube** into an intense, sub-second music guessing game!

---

## 🎧 Supported Platforms
Paste playlist or album links directly from:
- 🟢 **Spotify** (`open.spotify.com/playlist/...` or `/album/...`)
- 🍎 **Apple Music** (`music.apple.com/.../playlist/...` or `/album/...`)
- 🔴 **YouTube Music** (`music.youtube.com/playlist?list=...`)
- ⚪ **YouTube** (`youtube.com/playlist?list=...`)

---

## 🎮 Game Progression & Rules

| Attempt | Audio Duration | Points | Rating |
| :---: | :---: | :---: | :--- |
| **Level 1** | **1.0 second** | **+1,000 pts** | ⚡ *Godlike ear! Recognized from the very first drum hit* |
| **Level 2** | **2.0 seconds** | **+800 pts** | 🔥 *Super sharp memory* |
| **Level 3** | **4.0 seconds** | **+600 pts** | ⚡ *Great ear* |
| **Level 4** | **7.0 seconds** | **+400 pts** | 👍 *Getting warmer* |
| **Level 5** | **11.0 seconds** | **+200 pts** | ⏳ *Down to the wire* |
| **Level 6** | **16.0 seconds** | **+100 pts** | 🆘 *Final clutch guess* |
| **Missed** | **Full Reveal** | **0 pts** | 🎵 *Plays full song with artwork & streaming link* |

---

## 🚀 Running Locally

1. Open your terminal:
   ```bash
   cd c:\Users\ritesh\Downloads\mail\ytmusic_heardle
   ```

2. Start the server:
   ```bash
   python app.py
   ```
   *(Or double-click `run.bat`)*

3. Open **`http://localhost:5000`** in your browser.

---

## ☁️ 100% Free Cloud Deployment (Render.com)

1. Push this project to your GitHub account:
   ```bash
   git init
   git add .
   git commit -m "BeatDrop universal release by Ritesh"
   git remote add origin https://github.com/YOUR_USERNAME/beatdrop.git
   git push -u origin main
   ```

2. Log into [Render.com](https://render.com) (free, no credit card needed).
3. Click **New +** -> **Web Service** -> Connect your GitHub repo.
4. Settings:
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
   - **Plan**: Select **Free**
5. Click **Deploy Web Service** — in 2 minutes your game will be live for everyone!

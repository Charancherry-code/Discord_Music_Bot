# Project Context: Shadow Music Bot

The handoff file for this project. Read it first when picking the work back up. It records what the bot is, the decisions made, what's done, what's waiting to be tested and what comes next.

Last updated: 31 Oct 2026, after Stage 2 was built.

---

## 1. What this is

A private, Jockie-style Discord music bot for one server (**Cherry 👾's server**). The goals, in order:

1. **The highest audio quality possible, with no lag, buffering or stutter.** This is the main goal.
2. **It follows the owner** between voice channels, but never starts music on its own.
3. **Only the owner and approved people** can control it. While the owner is in voice, only the owner can.
4. **Clean, optimized code** that doesn't crash.

**Hosting:** the owner's Ryzen 7 / 16 GB laptop. The owner handles the network (target 100 Mbps, ideally a LAN cable) and Discord settings (voice region **India**, channel bitrate **96 kbps**). It is **not** hosted on VisiHost or Oracle: YouTube blocks datacenter IPs and those plans are too small.

**Repo:** https://github.com/Charancherry-code/DIiscord-Music-Bot (git user `Charancherry-code`, `charancherry1129@gmail.com`).

---

## 2. Environment facts

- **OS:** Windows, PowerShell, **Node 26.13 LTS** at `C:\Program Files\nodejs`, Git at `C:\Program Files\Git`.
- **Bot application:** "Cherry setup#5786". Message Content Intent is on.
- **IDs:** `OWNER_ID=1277990737794830480`, `GUILD_ID=1552946310204620881`. Both are in `.env`.
- **The token is in `.env` and was shown in chat. Reset it in the Developer Portal and update `.env`.** `.env` is in `.gitignore`. Never commit it.
- **This dev PC's internet is slow:** 1.9 Mbps down, 1.7 up, about 92–107 ms ping, 0% loss (from `npm run nettest`).
- **The AI assistant's terminal is unreliable:** commands queue up and run minutes late, or not at all. Write output to log files and read those, or have the owner run commands.
- The bot is started hidden with `Start-Process` and writes to `bot.log` and `bot-err.log`. To stop it, use Task Manager → end **Node.js JavaScript Runtime**.
- **Only one copy can run:** `data/bot.lock` holds the running process ID.

---

## 3. Architecture

Node.js ESM, discord.js v14.27, @discordjs/voice 0.19.2 (DAVE encryption is built in, required by Discord since March 2026), yt-dlp (standalone binary in `bin/`, updates itself on start), ffmpeg-static.

| File | Role |
| --- | --- |
| `src/index.js` | Wiring, startup checks (ffmpeg, yt-dlp), single-instance lock, resume after restart, shutdown, IPv4/IPv6 timeout fix |
| `src/config.js` | Reads `.env` and validates it |
| `src/player.js` | `MusicSession`: queue, loop, playback, failure backoff, **next-song preload**, stutter detector |
| `src/audio.js` | Turns a track into an audio resource: disk cache first, buffering, Opus passthrough, ffmpeg encoding, process priority |
| `src/audiocache.js` | Disk cache of complete downloads (`.cache/audio`, LRU, `AUDIO_CACHE_MB`) |
| `src/ytdlp.js` | yt-dlp wrapper: search (YouTube Music first), flat lists, Mixes, streaming |
| `src/sources.js` | `cplay` input → tracks (YouTube, SoundCloud, Spotify, search) |
| `src/status.js` | "Listening to <song>" on the bot profile + song name as the voice channel status |
| `src/spotify.js` | Spotify links → track list, read from the public embed page, no API key |
| `src/autoplay.js` | Smart autoplay from YouTube Mix + YouTube Music radio, scored, stays in the same language; `songKey()`; `VIBES` for `cvibe` |
| `src/language.js` | Guesses a song's language from script, keywords, known labels/artists (channel + title) and Hindi/English common words |
| `src/resolver.js` | Cached search phrase → URL (`.cache/resolved.json`, capped at 5000 entries) |
| `src/voice.js` | Following the owner, joining for `cplay`, auto-pause when empty, leaving when idle or empty, reconnect |
| `src/commands.js` | `c`-prefix commands, permission rules, Now Playing buttons |
| `src/nowplaying.js` | Live Now Playing card, "D+" IDE style: breadcrumb, inline-code chips, `// next →`, ⚠/✖ diagnostics, "developed by cherry" footer. No code block, so it wraps cleanly everywhere. |
| `src/profiles.js` | Sound profiles (ffmpeg filter chains) |
| `src/library.js` | Shared playlists (creator or owner may replace/delete) and per-user liked songs; `trackKey()` (`yt:<id>` or `q:<songKey>`), `storedTrack()`, `toTracks()` |
| `src/stats.js` | Counts a play after 30 s heard (5 s ticks, paused time excluded); `summary(days)` for `ctop`/`cwrapped`, `recent()` for `chistory`; `mainArtist()` skips label channels |
| `src/permissions.js`, `src/store.js`, `src/format.js`, `src/logger.js` | Helpers |
| `scripts/setup-server.js` | One-time server layout tool. Already run; it never deletes channels. |
| `scripts/nettest.js` | `npm run nettest`: latency and bandwidth |
| `scripts/push-to-github.ps1` | Installs Git if needed, then commits and pushes |

**Saved data (`data/`):** `settings.json` (follow, soundProfile, volume, autoplay, linkChannels), `permissions.json`, `session.json` (queue and position for resume), `history.json` (2-day no-repeat), `library.json` (`playlists`, `liked` per user ID), `stats.json` (`songs` by key, `plays` = `[{k, at, s}]` oldest first, capped at 20,000; saved when a play is counted and on shutdown, never on every tick, because `JsonStore.save()` debounces and would never fire).

**Speed work (1 Nov):**
- `audiocache.js` caches raw yt-dlp output in `.cache/audio/<id>.bin`. It saves only when yt-dlp exits with code 0 and the in-memory copy is complete. Pruning is LRU by mtime (touched on every read), using `AUDIO_CACHE_MB`.
- `createTrackResource` checks the cache first and treats a hit like an in-memory reopen. It returns `origin` and `firstAudioMs`.
- `PREBUFFER_BYTES` is now 256 KB.
- `logger.js` also appends to `logs/bot-YYYY-MM-DD.log` (kept 7 days).
- `voice.js` samples `connection.ping.udp` every 10 s while playing. It warns above 250 ms and logs a 5-minute summary.
- Measured:
  - First song from download: 9.7 s, nearly all of it yt-dlp before the first byte.
  - Preloaded skip: 4 ms. Cache hit: 45 ms.
  - `yt-dlp.exe --version` alone takes 1.9 s, because the PyInstaller onefile build unpacks 23 MB on every launch. Extracting one song takes 7.6 s.
  - Possible next step: switch to the onedir build (`yt-dlp_win.zip`) to cut about 1.5 s from every yt-dlp run. A new `cplay` runs yt-dlp twice (search, then stream). Check that `-U` still works with that build first.

**Access flag `anytime: true`** on a command: approved users may use it while the owner is in voice (likes, lists, stats, `csave`). `cliked play` re-checks the normal rule in `#playSaved`. **`csleep`:** `session.sleepAt` is shown on the card as `☾ Nm`; when it fires: `stop()` + `voice.leave()` + a message in the channel. **`chelp`** is split into several embeds when it passes 3,900 characters.

---

## 4. Key decisions (don't undo without a reason)

- **yt-dlp, not play-dl:** play-dl is unmaintained. yt-dlp uses `--js-runtimes node:<node path>` to pass YouTube's checks.
- **Search YouTube Music first** for official studio audio, with normal YouTube as the fallback.
- **Opus passthrough** for the `pure` profile, so there's no re-encoding. Other profiles encode once with libopus (VBR, compression level 10, `-application audio`) at 160 kbps, or the channel bitrate if higher (max 384).
- **Don't use `demuxProbe` on yt-dlp streams.** It puts the bytes it read back at the end of a buffered stream and corrupts the song (the "EBML tag" error). `sniffOpus()` detects the format instead.
- **Start buffer:** about 6 s of audio (`PREBUFFER_BYTES = 128 KB`), then downloading continues ahead, up to 16 MB.
- **Preload:** the next song loads only after the current one has fully downloaded (or after 2 min), so the two downloads never compete.
- **Following never starts music.** It only keeps playing if music was already active (a channel switch, or a dropped connection).
- **Access rules:** owner always. Approved users (`cgrant`) only when the owner isn't in voice; otherwise "Busy with the owner". Short aliases from unapproved users are ignored silently.
- **Requested songs go before autoplay picks** (`autoplay: true`).
- **`playlist.txt` was removed completely (1 Nov) at the owner's request**: its 3 songs kept coming back when autoplay had nothing. Don't add a default playlist back. Old saved queues have their `isDefault` songs dropped on restore.
- **Status (`status.js`):** voice channel status via `PUT /channels/{id}/voice-status` (not in discord.js) and a "Listening to" activity. Updated only on song change/stop/move, debounced 1.5 s. Needs the "Set Voice Channel Status" permission; a 403 is logged once and ignored.
- **Spotify:** tracks keep Spotify's metadata. `query = "artist - title"` is resolved right before playing (`source: 'spotify'`).
- **Autoplay:** topped up while the last song plays, so the pick can preload. It retries no sooner than 60 s after a failed lookup. With autoplay off, the music stops at the end of the queue.
- **Autoplay language:** the most common detected language of the last 3 known songs (or the `cvibe` lock). Same-language picks first, unknown second, other languages never; if every Mix drifted, it searches "<language> hit songs". **No repeats for 2 days** (`NO_REPEAT_MS`): every played song (video ID and title key) goes into `data/history.json`; autoplay and `cvibe` never pick one within 48 h. Requested songs are never blocked. **No skip-learning:** the owner asked to remove it (it blocked good songs).
- **Autoplay sources (`#pick`):** for each of up to 3 seeds (current song, then recent), `RD<id>` (YouTube Mix) and `RDAMVM<id>` (YouTube Music radio) are fetched in parallel and interleaved (`fetchMix(id, 'mix'|'radio')`, ~5–9 s each, cached 30 min); then "<artist> songs"; then the language search. **Scoring (`#choose`, lower is better):** rank, −8 same language, +6 video-style title (`VIDEO_STYLE`), −3 Topic/"(Audio)", +5 artist from the last 2 songs; random among the best 3 (`PICK_FROM_TOP`). `songKey()` makes every upload of a song the same key ("Artist - Song", `"Kabira Full Song" Movie`, "Lyrical: …", "… Full Video Song Movie"). Tested offline on real Mix data: Tum Hi Ho radio 22–23 of 25 detected Hindi (rest unknown, none wrong), Blinding Lights 25/25 English.
- **Language detection (`language.js`):** script → keyword → known labels/artists (channel field, "Artist - " title prefix, and "| … |" title parts) → `vevo` = English → word heuristic (`HINDI_WORDS` ≥1 and no English words = hindi; `ENGLISH_WORDS` ≥2 and no Hindi words = english).
- **Buttons:** `deferUpdate()` runs in parallel with the action (fixes "Unknown interaction" on fast double skips); the card refresh waits for the ack.
- **Process priority:** above normal for the bot and ffmpeg.
- **Leaving voice:** if the owner leaves while music plays, the bot leaves and keeps the queue for **3 minutes** (`FORGET_AFTER_MS` in `voice.js`). If the owner rejoins in time, music continues from the same spot. If not, the queue is cleared. On restart, a saved queue that's more than 3 minutes old with nobody listening is dropped too.
- **`cseek` and `clyrics` were built, then removed at the owner's request (1 Nov). Don't add them back.** `reopen(seekSec)` still accepts a position (used internally).
- **Volume / profile = hot swap (`MusicSession.reopen`):** the old stream keeps playing while the new one opens, then `audio.play()` swaps them in one step (no Idle, no gap). Volume is an ffmpeg `volume=` filter right before the limiter (`buildFilters` in `profiles.js`), saved as `settings.volume`. A fully downloaded song is kept in memory (`memory` from `waitForAudio`, cap 24 MB), so reopen doesn't re-download. **`-ss` must stay BEFORE `-i`** in `transcode()`: measured 0.1 s vs 7.5 s to seek to 2:00, because with `-ss` after `-i` the filters process the skipped audio.
- **Link mode (`clink`):** per channel, saved in `settings.json` as `linkChannels`. It only triggers when the whole message is music links (`MUSIC_LINK_RE` in `commands.js`). Unapproved users are ignored silently.
- **`net.setDefaultAutoSelectFamilyAttemptTimeout(1000)`:** Node's default of 250 ms caused "fetch failed" on the slow network.

---

## 5. Status

### Done and confirmed working in Discord
- Login, following the owner between channels, leaving when the owner leaves
- `cplay`, the queue, Now Playing card buttons (pause, skip and loop confirmed in logs)
- Sound profiles: HiFi and Pure confirmed playing. Pure was fixed after the EBML bug.
- Resume after restart (the queue was restored)
- Region India: no voice errors since the change. Long sessions played with no `Stutter:` warnings.
- Server layout, small caps names, private VCs, archive (done with `setup-server.js`)

### Done in code, verified offline only
- **Stage 2** (31 Oct): Spotify track, album and playlist parsing worked (1, 10 and 50 tracks). YouTube Mix fetch worked (30 entries). All 18 files pass `node --check`.

---

## 6. ⏳ Pending tests (do these next)

The running bot was started **30 Oct 13:56**, so it is **old code**. Everything below needs a restart first: end Node.js in Task Manager, then `npm start`.

| # | Test | Expected | Status |
| --- | --- | --- | --- |
Tested 31 Oct 2026. **✅ log** = confirmed in `bot.log`; **✅ owner** = owner tested in Discord (these commands don't write to the log).

| # | Test | Expected | Status |
| --- | --- | --- | --- |
| 1 | Restart with the new code | Starts with no errors | ✅ log (login retry worked after a network drop) |
| 2 | Join voice | The bot joins **silently** | ✅ owner |
| 3 | Switch channels while music plays | Moves with you and keeps playing | ✅ owner |
| 4 | Press ⏭ on a preloaded song | The next song starts in about 1 s | ✅ log: **0.5 s** (19:30:21 → 19:30:22) |
| 5 | Skip twice quickly | The second skip loads normally, no crash | ✅ log: 8–13 s, no errors |
| 6 | Spotify track / playlist link in `cplay` | Added instantly, plays, card shows `⎇ spotify` | ✅ owner |
| 7 | Let the queue run out (autoplay on) | `Autoplay queued: …` while the last song plays, seamless change | ✅ log: 12 picks in a row, all `[hindi]` |
| 8 | Play a Telugu song, let autoplay run | Picks stay Telugu | ✅ owner |
| 9 | 🎲 button | Toggles autoplay | ✅ log |
| 10 | `cvibe telugu` | Starts a Telugu song, keeps going in Telugu | ✅ owner (log: "Vibe Undi [Telugu]") |
| 11 | ⏮ ⏸ 🔁 📜 ⏹ | Each works | ✅ log |
| 12 | `cping` | Mostly 🟢 | ✅ owner |
| 13 | `csound bass` / `hifi` mid-song | Applies within a few seconds | ✅ owner |
| 14 | An approved user while the owner is in voice | Gets "Busy with the owner" | ✅ owner |
| 15 | On the hosting laptop at about 100 Mbps | No `Stutter:` lines; first song in under 8 s | ⏳ not on the laptop yet |
| 16 | Task Manager while gaming | Bot roughly 300–400 MB RAM, about 1% CPU, no FPS drop | ⏳ not on the laptop yet |
| 17 | `clink` on, paste links, `clink` off | ON message, first plays, second queued, OFF message | ✅ owner |
| 18 | Paste a link with extra text in link mode | Ignored, no reply | ⏳ not tested |
| 19 | Leave voice mid-song, rejoin within 3 min | Continues the same song | ✅ owner |
| 20 | Leave voice, rejoin after 3+ min | Joins silently with an empty queue | ✅ owner |

Session stats from the log: 0 stutters, 0 failed songs, no errors besides the login retries.

**Stage 3 tests (pending):**

| # | Test | Expected | Status |
| --- | --- | --- | --- |
| 21 | `cvolume 50`, then `cvolume 130`, then `cvolume +10` quickly 3 times | Music never stops; changes within about 1 s; card shows a `🔊 N%` chip; one re-open in the log, not several | ⏳ |
| 22 | `csound bass` mid-song | Switches without stopping the music | ⏳ |
| 26 | Pause, then `cvolume 80` | Applies and stays paused | ⏳ |
| 27 | Play a song | Voice channel shows `🎵 Song · Artist`; bot profile shows "Listening to Song" | ⏳ |
| 28 | `cstop`, or leave voice | Both statuses clear | ⏳ |
| 29 | Let the queue run out with autoplay off | Music stops; One More Time / Tum Hi Ho never come back | ⏳ |

Also pending for the owner:
- [ ] Push Stage 2: `git add src README.md CONTEXT.md` → `git commit -m "Stage 2"` → `git push`
- [ ] Reset the bot token and update `.env`
- [ ] Remove **Manage Roles** from the bot now that the server setup is done (optional)

---

## 7. Roadmap

| Stage | Features | Status |
| --- | --- | --- |
| 1 | Playback, queue, card, permissions, follow, auto-pause, resume | ✅ |
| Sound | Profiles, YouTube Music search, `cping`, nettest | ✅ |
| 2 | Spotify, smart autoplay, `cvibe` | ✅ tested |
| 2+ | `clink`, 3-min queue expiry, same-language autoplay, 2-day no-repeat, D+ card, login retry | ✅ tested |
| 3 | `cvolume` (hot-swap, in-memory song) | ✅ built, ⏳ test in Discord. Effects, `cseek` and `clyrics` dropped at the owner's request. |
| 4 | Song name on the voice channel, "Listening to…" status | ✅ built, ⏳ test |
| 4 (rest) | `csave`/`cload`/`cplaylists`/`cdelpl` playlists, ❤️ liked songs (`clike`, `cliked`), `chistory`, `ctop`/`cwrapped` stats, `csleep` | ✅ built, offline tests pass (26/27; the failing one was the test's own data), ⏳ test in Discord |
| Extra | `start-bot.bat` / start on boot for the laptop; optional YouTube Premium cookies for 256 kbps AAC | ⬜ |

**Web player (future):** a built-in `node:http` server (no new dependencies) with a mobile-first page in the D+ style: cover, chips, big controls, search-to-play, queue editing, and live updates over Server-Sent Events. It calls the same `MusicSession` methods, so all the rules stay the same. Recommended setup: **Tailscale** for access from anywhere (never public) and a **secret link** sent by `cweb` in a DM, with a resettable key. Discord OAuth login, which would also let `cgrant` users in, can come later. Cloudflare Tunnel only with strong auth.

**Open-source release (after the bot is finished):** strip personal data (keep `CONTEXT.md` local, generalize or drop `setup-server.js`), MIT license, a disclaimer for YouTube/Spotify terms, a setup wizard and `start.bat`, a README with screenshots, a landing page on GitHub Pages (`docs/`), then share on r/selfhosted, r/discordapp, GitHub topics and Indian Discord communities.

**Possible ideas not started:** preloading 2 songs ahead on fast networks; showing load time on the card.

---

## 8. Related projects

- **`Desktop\SERVER-CORE-BOT`:** a separate bot with logs, moderation, auto-mod, welcome, self-roles, join-to-create VCs and `/setup`. Written but **never run or syntax-checked**. It needs its own new bot application with the Server Members and Message Content intents. Planned host: Oracle free tier.
- **Minecraft:** planned on Oracle Always Free (now 2 Arm cores and 12 GB since June 2026) with Paper + Geyser + Floodgate, so Bedrock players can join. The official Bedrock server has no Arm build.

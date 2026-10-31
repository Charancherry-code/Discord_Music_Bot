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
| `src/audio.js` | Turns a track into an audio resource: buffering, Opus passthrough, ffmpeg encoding, process priority |
| `src/ytdlp.js` | yt-dlp wrapper: search (YouTube Music first), flat lists, Mixes, streaming |
| `src/sources.js` | `cplay` input → tracks (YouTube, SoundCloud, Spotify, search); `playlist.txt` loader |
| `src/spotify.js` | Spotify links → track list, read from the public embed page, no API key |
| `src/autoplay.js` | Smart autoplay from YouTube Mix, stays in the same language; `VIBES` for `cvibe` |
| `src/language.js` | Guesses a song's language from script, keywords and known channels/artists |
| `src/resolver.js` | Cached search phrase → URL (`.cache/resolved.json`, capped at 5000 entries) |
| `src/voice.js` | Following the owner, joining for `cplay`, auto-pause when empty, leaving when idle or empty, reconnect |
| `src/commands.js` | `c`-prefix commands, permission rules, Now Playing buttons |
| `src/nowplaying.js` | Live Now Playing card: plain markdown, so it wraps well in narrow panels |
| `src/profiles.js` | Sound profiles (ffmpeg filter chains) |
| `src/permissions.js`, `src/store.js`, `src/format.js`, `src/logger.js` | Helpers |
| `scripts/setup-server.js` | One-time server layout tool. Already run; it never deletes channels. |
| `scripts/nettest.js` | `npm run nettest`: latency and bandwidth |
| `scripts/push-to-github.ps1` | Installs Git if needed, then commits and pushes |

**Saved data (`data/`):** `settings.json` (follow, soundProfile, autoplay), `permissions.json`, `session.json` (queue and position for resume).

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
- **Requested songs go before filler.** Filler means `playlist.txt` entries (`isDefault`) and autoplay picks (`autoplay`).
- **Spotify:** tracks keep Spotify's metadata. `query = "artist - title"` is resolved right before playing (`source: 'spotify'`).
- **Autoplay:** topped up while the last song plays, so the pick can preload. It retries no sooner than 60 s after a failed lookup. Off means `playlist.txt` as the fallback in the owner's channel.
- **Autoplay language:** the most common detected language of the last 3 known songs (or the `cvibe` lock). Same-language picks first, unknown second, other languages never; if every Mix drifted, it searches "<language> hit songs". **No skip-learning:** the owner asked to remove it (it blocked good songs).
- **Process priority:** above normal for the bot and ffmpeg.
- **Leaving voice:** if the owner leaves while music plays, the bot leaves and keeps the queue for **3 minutes** (`FORGET_AFTER_MS` in `voice.js`). If the owner rejoins in time, music continues from the same spot. If not, the queue is cleared. On restart, a saved queue that's more than 3 minutes old with nobody listening is dropped too.
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
| 1 | Restart with the new code | Starts with no errors. Check `bot-err.log`. | ⏳ |
| 2 | Join voice | The bot joins **silently** (no `playlist.txt loaded` in the log) | ⏳ |
| 3 | Switch channels while music plays | Moves with you and keeps playing | ⏳ |
| 4 | `cplay` 3 songs, wait about 30 s, press ⏭ | The next song starts in about 1 s (preloaded). Check the times between `Button "skip"` and `Now playing`. | ⏳ |
| 5 | Skip twice quickly | The second skip loads normally (3–15 s); no crash | ⏳ |
| 6 | Spotify track / album / playlist link in `cplay` | Added instantly, plays from YouTube Music, and the card shows Spotify's title | ⏳ |
| 7 | Let the queue run out (autoplay on) | `Autoplay queued: …` while the last song plays, then a seamless change | ⏳ |
| 8 | Play a Telugu song, let autoplay run 3–4 songs | Picks stay Telugu; log shows `Autoplay queued: … [telugu]` | ⏳ |
| 9 | 🎲 button and `cautoplay off` | Toggles; turning it off removes queued picks | ⏳ |
| 10 | `cvibe telugu` (and `cvibe` alone) | Starts a fitting song, then keeps going with similar ones; `cvibe` lists the moods | ⏳ |
| 11 | ⏮ previous, 🔀 shuffle, 📜 queue, ⏹ stop | Each works (never confirmed in the logs) | ⏳ |
| 12 | `cping` | Mostly 🟢 | ⏳ |
| 13 | `csound bass` / `vocal` mid-song | Applies within a few seconds from the same spot | ⏳ |
| 14 | An approved user (`cgrant`) while the owner is in voice | Gets "Busy with the owner" (allikhan0399 pressed buttons on 31 Oct; result unconfirmed) | ⏳ |
| 15 | On the hosting laptop at about 100 Mbps | No `Stutter:` lines; first song in under 8 s | ⏳ |
| 16 | Task Manager while gaming | Bot total roughly 300–400 MB RAM, about 1% CPU, no FPS drop | ⏳ |
| 17 | `clink`, then paste a YouTube link, then a Spotify link | "Link mode is ON"; first link plays, second is queued; `clink` again shows "Link mode is OFF" | ⏳ |
| 18 | Paste a link with extra text, or as an unapproved user, in link mode | Ignored, no reply | ⏳ |
| 19 | Leave voice mid-song, rejoin within 3 min | The bot follows and continues the same song from the same spot | ⏳ |
| 20 | Leave voice mid-song, rejoin after 3+ min | Log: "Owner didn't come back within 3 min; cleared the queue"; the bot joins silently with an empty queue | ⏳ |

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
| 2 | Spotify, smart autoplay, `cvibe` | ✅ built, ⏳ testing |
| 3 | Effects (slowed + reverb, nightcore, 8D, lofi), `cvolume`, `cseek`, synced `clyrics` (LRCLIB) | ⬜ next |
| 4 | `csave`/`cload` playlists, ❤️ liked songs, `chistory`, `ctop`/`cwrapped` stats, `csleep`, song name on the voice channel, "Listening to…" status | ⬜ |
| Extra | `start-bot.bat` / start on boot for the laptop; optional YouTube Premium cookies for 256 kbps AAC | ⬜ |

**Open-source release (after the bot is finished):** strip personal data (keep `CONTEXT.md` local, generalize or drop `setup-server.js`), MIT license, a disclaimer for YouTube/Spotify terms, a setup wizard and `start.bat`, a README with screenshots, a landing page on GitHub Pages (`docs/`), then share on r/selfhosted, r/discordapp, GitHub topics and Indian Discord communities.

**Possible ideas not started:** preloading 2 songs ahead on fast networks; showing load time on the card.

---

## 8. Related projects

- **`Desktop\SERVER-CORE-BOT`:** a separate bot with logs, moderation, auto-mod, welcome, self-roles, join-to-create VCs and `/setup`. Written but **never run or syntax-checked**. It needs its own new bot application with the Server Members and Message Content intents. Planned host: Oracle free tier.
- **Minecraft:** planned on Oracle Always Free (now 2 Arm cores and 12 GB since June 2026) with Paper + Geyser + Floodgate, so Bedrock players can join. The official Bedrock server has no Arm build.

# Shadow Music Bot

A private, Jockie-style music bot for one server. It follows you between voice channels, plays full-quality audio, and only you and the people you approve can control it.

**Status:** Stage 1 of 4 is done. That covers playback, the queue, Now Playing buttons, permissions, follow mode and resume after restart. Spotify, autoplay, effects, lyrics and stats come in later stages.

## Rules

| Situation | What the bot does |
| --- | --- |
| You join or switch voice channels (follow on) | It follows you. If the queue is empty, it plays `playlist.txt`. |
| You're in voice | Only you can control it. Everyone else gets "Busy with the owner". |
| You're not in voice | Users you approved can use `cplay` and it joins their channel. |
| You leave voice | It leaves too (if it was with you). The queue is kept. |
| The queue runs out while you're listening | It goes back to `playlist.txt`, re-reading the file. |
| Everyone leaves its channel | It pauses, then resumes when someone returns. After 5 minutes alone, it leaves. |
| Nothing has played for 5 minutes in someone else's channel | It leaves. |
| The host restarts the bot | It rejoins and continues the same song from the same spot. |

## Commands

Prefix is `c`. Aliases are in brackets.

| Command | What it does |
| --- | --- |
| `cplay <song / link>` [`cp`] | Play or queue a song name, YouTube or SoundCloud link, or playlist link. `cplay` with nothing after it resumes, or plays `playlist.txt`. |
| `csearch <song>` [`cfind`] | Top 5 results with pick buttons |
| `cskip` [`cs`, `cnext`] | Skip |
| `cskipto <n>` [`cst`, `cjump`] | Jump to song n in the queue |
| `cprevious` [`cprev`, `cback`] | Play the previous song again |
| `cpause`, `cresume` [`cunpause`] | Pause or resume |
| `cstop` | Stop and clear the queue |
| `cnp` [`cnowplaying`] | Repost the Now Playing card here |
| `cqueue [page]` [`cq`] | Queue with page buttons |
| `cremove <n>` [`crm`] | Remove a song |
| `cmove <from> <to>` [`cmv`] | Move a song |
| `cclear` | Clear Up Next |
| `cshuffle` [`csh`] | Shuffle Up Next |
| `cloop [off/song/queue]` [`crepeat`] | Set the loop mode. With nothing after it, cycles through the modes. |
| `csound [pure/hifi/bass/vocal]` [`cprofile`, `ceq`] | Pick the sound profile. It applies right away, from the same spot in the song. |
| `cping` [`clatency`, `cnet`] | Network check: Discord gateway, message round trip, voice ping and how long the last song took to start |
| `chelp` [`ccommands`] | List commands |
| **Owner only** | |
| `cgrant @user/@role` | Give access |
| `crevoke @user/@role` | Remove access |
| `cperms` [`caccess`] | Show who has access |
| `cfollow [on/off]` | Turn follow mode on or off |

People without access who type a short alias (like `cs`) are ignored silently, so normal chat doesn't trigger replies. Full command names get a "no permission" reply.

### Now Playing card

The card is one message that gets edited in place. Its buttons are ⏮ ⏯ ⏭ ⏹ / 🔁 🔀 📜, and the footer shows the sound profile and bitrate. The progress bar updates every 15 seconds. When the bot follows you and plays `playlist.txt`, the card goes in the voice channel's built-in text chat. Otherwise it goes where `cplay` was used.

## Setup

### 1. Discord Developer Portal

1. Go to https://discord.com/developers/applications, then open your app and go to **Bot**.
2. Copy the token (**Reset Token**).
3. Turn **off** **Public Bot**.
4. Turn **on** **Message Content Intent**. The bot won't log in without it.

### 2. Configure

Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `OWNER_ID` and `GUILD_ID`. To copy IDs, turn on Discord **Settings → Advanced → Developer Mode**, then right-click yourself or the server.

### 3. Run

Requires Node.js 22.12 or newer.

```bash
npm install
npm start
```

On first start, the bot prints an invite link if it isn't in your server yet. If you invited the first version, invite it again with the new link: it now needs Send Messages, Embed Links and Read Message History.

## playlist.txt

One entry per line. `#` starts a comment.

```text
Daft Punk - One More Time               <- searched on YouTube
https://www.youtube.com/watch?v=...     <- any link yt-dlp supports
music/my-song.mp3                       <- local file, relative to the project folder
```

Songs people ask for with `cplay` always go before the remaining `playlist.txt` songs.

## Saved data

Everything lives in `data/`: `permissions.json`, `settings.json` (follow mode) and `session.json` (queue for resume). Search results for `playlist.txt` are cached in `.cache/resolved.json`.

## Optional settings (.env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PREFIX` | `c` | Command prefix |
| `PLAYLIST_FILE` | `playlist.txt` | Default playlist |
| `SHUFFLE` | `false` | Shuffle `playlist.txt` each time it loads |
| `COOKIES_FILE` | none | YouTube cookies (see below) |
| `YTDLP_PATH` | `bin/yt-dlp` | Use your own yt-dlp |
| `YTDLP_AUTO_UPDATE` | `true` | Run `yt-dlp -U` on startup |
| `FFMPEG_PATH` | bundled | Use your own ffmpeg |
| `DATA_DIR` | `data` | Where saved data goes |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## If YouTube blocks the bot

The error looks like **"Sign in to confirm you're not a bot"**. To fix it:

1. In a private browser window, log in to YouTube with a **spare** Google account.
2. Export youtube.com cookies in Netscape format, for example with the "Get cookies.txt LOCALLY" extension.
3. Save the file as `cookies.txt` next to `package.json` and set `COOKIES_FILE=cookies.txt`.

Re-export the cookies when the error returns. SoundCloud links and local files aren't affected.

## Sound quality

### Sound profiles (`csound`)

| Profile | Sound |
| --- | --- |
| 🎧 `hifi` **(default)** | A little more bass (+3 dB around 90 Hz), crisper highs (+2 dB around 9 kHz), the same loudness for every song, and a limiter so it never distorts |
| 🔊 `bass` | Strong, punchy bass (+7 dB around 80 Hz) with low-mid mud trimmed, plus loudness and limiter |
| 🎤 `vocal` | Vocals brought forward (+3 dB around 3 kHz), great for Bollywood, plus loudness and limiter |
| 💎 `pure` | Original audio, untouched (Opus passthrough) |

Loudness is normalized to about −14 LUFS, the same target Spotify and YouTube use. Quiet old songs and loud new ones play at the same volume.

### How quality is handled

- **Better sources:** song names are searched on **YouTube Music** first. That gives the official studio track, not a music video with intros or dialogue. If nothing is found, it falls back to normal YouTube.
- **Encoding:** profiles are encoded as Opus at 160 kbps (YouTube's best source quality) or the channel bitrate if that's higher. It uses the encoder's best-quality, music-tuned settings.
- **Pure:** passes YouTube's Opus to Discord with no re-encoding at all.
- **Card footer:** shows the active profile and bitrate, e.g. `🎧 HiFi · Opus 160 kbps`.

### Set your voice channel bitrate (biggest impact)

Discord caps what listeners hear at the channel's bitrate.

1. Right-click the voice channel → **Edit Channel** → **Overview** → **Bitrate**.
2. Set it to **96 kbps**, the maximum without server boosts (the default is 64). Boost levels 1, 2 and 3 allow 128, 256 and 384 kbps.

### If ffmpeg doesn't work

On startup the bot tests ffmpeg with the real filters. If the test fails, the log says why. The bot then plays untouched audio, so music still works without the profiles. To fix it, run `npm rebuild ffmpeg-static`, or install ffmpeg and set `FFMPEG_PATH` in `.env`.

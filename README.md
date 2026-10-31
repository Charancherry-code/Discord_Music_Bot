# Shadow Music Bot

A private, Jockie-style music bot for one server. It follows you between voice channels, plays full-quality audio, and only you and the people you approve can control it.

**Status:** Stages 1–3 are done: playback, queue, buttons, permissions, follow mode, resume after restart, sound profiles, Spotify links, smart autoplay, vibe radio and volume. Saved playlists and stats come next.

## Spotify links

`cplay` accepts Spotify **track, album, playlist and artist** links (also `spotify.link` short links). No Spotify account or API key is needed.

- Spotify doesn't allow streaming its audio, so each song plays from **YouTube Music** by searching "artist - title". The card keeps Spotify's title, artist and length.
- The search happens right before each song plays (and is cached), so a 100-song playlist is added instantly.
- Spotify's public embed shows up to about 100 songs, so bigger playlists are cut there. Private playlists can't be read.

## Autoplay

When the last queued song starts playing, autoplay picks a similar song from **YouTube's Mix** for it and queues it, so it preloads and plays without a gap.

- **Never repeats a song within 2 days**, including other uploads of the same song. The history is saved in `data/history.json`, so it survives restarts. Songs you ask for with `cplay`, `clink` or `csearch` always play.
- Skips and compilations, jukeboxes, covers, slowed/8D edits and anything shorter than 90 s or longer than 10 min.
- **Stays in the same language.** It guesses each song's language (Telugu, Hindi, Tamil, Punjabi, Kannada, Malayalam, Bengali, Marathi, English) from its script, words like "Telugu" or "Bollywood", and well-known channels and artists. The last 3 songs decide. Picks in that language come first, songs it can't place come next, and songs clearly in another language are never picked. If a Mix has drifted away, it searches for songs in that language instead.
- `cvibe telugu` (and the other language vibes) locks autoplay to that language until someone requests a song.
- Songs people request always play before autoplay picks (marked 🎲 in `cqueue`).
- With loop on, autoplay waits. With autoplay off, the music stops when the queue runs out.

## Song name on the voice channel and profile

While a song plays, the bot shows it in two places, updated only when the song changes:
- **Voice channel status:** `🎵 Song · Artist` under the channel name in the sidebar. It clears when the music stops or the bot moves. The bot needs the **Set Voice Channel Status** permission (Server Settings → Roles → the bot's role); without it, this part is skipped and logged once.
- **Bot profile:** "Listening to *Song*".

## Rules

| Situation | What the bot does |
| --- | --- |
| You join or switch voice channels (follow on) | It follows you, silently. Music only continues if it was already playing. |
| You're in voice | Only you can control it. Everyone else gets "Busy with the owner". |
| You're not in voice | Users you approved can use `cplay` and it joins their channel. |
| You leave voice | It leaves too (if it was with you). The queue is kept. |
| The queue runs out | Autoplay adds similar songs; with autoplay off, the music stops. |
| Everyone leaves its channel | It pauses, then resumes when someone returns. After 5 minutes alone, it leaves. |
| Nothing has played for 5 minutes in someone else's channel | It leaves. |
| The host restarts the bot | It rejoins and continues the same song from the same spot. |

## Commands

Prefix is `c`. Aliases are in brackets.

| Command | What it does |
| --- | --- |
| `cplay <song / link>` [`cp`] | Play or queue a song name, YouTube or SoundCloud link, or playlist link. `cplay` with nothing after it resumes the queue. |
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
| `cvolume [0-150 / +10 / -10]` [`cvol`] | Set the volume (saved across restarts). Above 100% a limiter stops distortion. The change happens without stopping the music. |
| `clink` [`clinkmode`] | Toggle **link mode** in this channel. While it's on, a message that's only YouTube, Spotify or SoundCloud links (up to 10) plays them like `cplay`. Messages with other text are ignored, and so are people without access. The setting survives restarts. |
| `cautoplay [on/off]` [`cap`, `cauto`] | Keep playing similar songs when the queue runs out (on by default). The 🎲 button on the card toggles it too. |
| `cvibe <mood>` [`cradio`, `cmood`] | Endless radio: chill, romantic, sad, party, gym, punjabi, telugu, tamil, english, focus. `cvibe` alone lists them. |
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

The card is one message that gets edited in place. Its buttons are ⏮ ⏯ ⏭ ⏹ / 🔁 🔀 📜, and the footer shows the sound profile and bitrate. The progress bar updates every 15 seconds. The card goes in the channel where `cplay` was used.

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

## Saved data

Everything lives in `data/`: `permissions.json`, `settings.json` (follow mode, sound profile, volume, autoplay, link-mode channels), `session.json` (queue for resume) and `history.json` (the 2-day no-repeat list). Spotify song searches are cached in `.cache/resolved.json`.

## Optional settings (.env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PREFIX` | `c` | Command prefix |
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

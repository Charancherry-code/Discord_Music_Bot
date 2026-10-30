// One-time server layout tool. Renames, moves and creates channels and categories.
// It never deletes a channel: old channels go to a hidden ARCHIVE category so their chat history stays.
// The only thing it deletes is the old VOICE category, and only if it ends up empty.
//
//   npm run setup-server              -> dry run: prints the plan, changes nothing
//   npm run setup-server -- --apply   -> makes the changes
import { ChannelType, Client, Events, GatewayIntentBits, OverwriteType, PermissionFlagsBits as P } from 'discord.js';
import { config } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
// Small caps letters (Discord has no fonts; these Unicode letters look like one).
const SMALL_CAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ';
const toSmallCaps = (s) =>
  s.replace(/[a-z]/gi, (ch) => SMALL_CAPS[ch.toLowerCase().charCodeAt(0) - 97]);
const fromSmallCaps = (s) =>
  [...s].map((ch) => {
    const i = SMALL_CAPS.indexOf(ch);
    return i === -1 ? ch : String.fromCharCode(97 + i);
  }).join('');

// Matching ignores emojis, separators and small caps, so re-running the script finds renamed channels.
const key = (s) => fromSmallCaps(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');
const T = ChannelType.GuildText;
const V = ChannelType.GuildVoice;
const CAT = ChannelType.GuildCategory;

// Manage Channels, Manage Roles, View Channel, Send Messages, Embed Links, Read History, Connect, Speak
const INVITE_PERMISSIONS = '271666192';

const LAYOUT = [
  { name: '📢 INFO', match: ['info'], channels: [] }, // channels inside INFO are left as they are
  {
    name: '💬 CHAT',
    match: ['chat'],
    channels: [
      { type: T, name: '💬・general', match: ['general'] },
      { type: T, name: '📸・media', match: ['media'] },
      { type: T, name: '🤖・bot-cmds', match: ['botcmds'] },
      { type: V, name: '🔊 General', match: ['general'] },
      { type: V, name: '💤 AFK', match: ['afk'] },
    ],
  },
  {
    name: '🎵 MUSIC',
    match: ['music'],
    channels: [
      { type: T, name: '🎵・music-cmds', match: ['musiccmds'] },
      { type: T, name: '📃・music-playlist', match: ['musicplaylist'] },
      { type: V, name: '🎵 Music 1', match: ['music'] },
      { type: V, name: '🎵 Music 2' },
      { type: V, name: '🎵 Music 3' },
      { type: V, name: '🎵 Music 4' },
      { type: V, name: '🎬 Music Telugu' },
      { type: V, name: '🎤 Music Hindi' },
      { type: V, name: '🎸 Music English' },
      { type: V, name: '🔒 Private Music 1', private: true },
      { type: V, name: '🔒 Private Music 2', private: true },
    ],
  },
  {
    name: '🎮 GAMING',
    match: ['gaming'],
    channels: [
      { type: V, name: '⛏️ Minecraft', match: ['minecraft'] },
      { type: V, name: '🔥 Free Fire', match: ['freefire'] },
      { type: V, name: '🎮 Other Games', match: ['othergames'] },
    ],
  },
  {
    name: '🔒 PRIVATE',
    match: ['private'],
    private: true,
    channels: [
      { type: V, name: '🔒 Private VC 1' },
      { type: V, name: '🔒 Private VC 2' },
      { type: V, name: '🔒 Private VC 3' },
      { type: V, name: '🔒 Private VC 4' },
    ],
  },
  {
    name: '🛡 STAFF',
    match: ['staff'],
    channels: [
      { type: T, name: '🛡️・staff', match: ['staff'] },
      { type: T, name: '📋・mod-logs', match: ['modlogs'] },
    ],
  },
  {
    name: '📦 ARCHIVE',
    match: ['archive'],
    hidden: true,
    // Existing channels only: kept with their names, hidden, never created.
    channels: [
      { type: T, match: ['lfg'] },
      { type: T, match: ['minecraft'] },
      { type: T, match: ['freefire'] },
      { type: V, match: ['pubgmobile'] },
      { type: V, match: ['duo'] },
      { type: V, match: ['trio'] },
    ],
  },
];

// Apply small caps to every category and channel name in the layout.
// Archived channels have no name here, so they keep their old names.
for (const cat of LAYOUT) {
  cat.name = toSmallCaps(cat.name);
  for (const ch of cat.channels) if (ch.name) ch.name = toSmallCaps(ch.name);
}

let failures = 0;

/** Logs an action; runs it only with --apply. Errors are reported and skipped, never fatal. */
async function act(desc, fn, placeholder = null) {
  console.log(`${APPLY ? '▶' : '•'} ${desc}`);
  if (!APPLY) return placeholder;
  try {
    return await fn();
  } catch (err) {
    failures++;
    console.log(`   ✖ failed: ${err.message}`);
    return placeholder;
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(config.token);
await new Promise((resolve) => (client.isReady() ? resolve() : client.once(Events.ClientReady, resolve)));

const guild = client.guilds.cache.get(config.guildId);
if (!guild) {
  console.log(
    `The bot isn't in your server yet. Invite it first:\n` +
      `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=${INVITE_PERMISSIONS}&guild_id=${config.guildId}`,
  );
  await client.destroy();
  process.exit(1);
}

await guild.channels.fetch();
const me = guild.members.me ?? (await guild.members.fetchMe());
const needed = [P.ManageChannels, P.ManageRoles, P.ViewChannel, P.Connect, P.Speak];
if (!me.permissions.has(needed)) {
  console.log(
    'The bot needs Manage Channels and Manage Roles for this. Re-invite it with this link (it updates the permissions):\n' +
      `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=${INVITE_PERMISSIONS}&guild_id=${guild.id}`,
  );
  await client.destroy();
  process.exit(1);
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (nothing will change)'} in "${guild.name}"\n`);

const bitrate = guild.maximumBitrate;
const VOICE_ACCESS = [P.ViewChannel, P.Connect, P.Speak];

// ---------- VIP role and private permissions ----------

let vip = guild.roles.cache.find((r) => key(r.name) === 'vip');
if (!vip) vip = await act('CREATE role "🔑 VIP"', () => guild.roles.create({ name: '🔑 VIP', reason: 'Private VC access' }), { id: 'new:vip' });

let jockie = [];
try {
  const found = await guild.members.search({ query: 'Jockie', limit: 10 });
  jockie = [...found.values()].filter((m) => m.user.bot);
} catch {
  // Search isn't essential; Jockie can be added to private channels by hand.
}
console.log(`  Jockie bots found for private channels: ${jockie.map((m) => m.user.username).join(', ') || 'none'}`);

const privateOverwrites = [
  { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
  { id: vip.id, type: OverwriteType.Role, allow: VOICE_ACCESS },
  { id: me.id, type: OverwriteType.Member, allow: VOICE_ACCESS },
  { id: config.ownerId, type: OverwriteType.Member, allow: VOICE_ACCESS },
  ...jockie.map((m) => ({ id: m.id, type: OverwriteType.Member, allow: VOICE_ACCESS })),
];
const hiddenOverwrites = [
  { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
  { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel] },
];

const copyOverwrites = (cat) =>
  cat?.permissionOverwrites?.cache?.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })) ?? [];

// ---------- categories and channels ----------

const used = new Set();
const layoutCats = []; // [{ spec, cat, placed: [channels in order] }]

for (const spec of LAYOUT) {
  const catKeys = [...spec.match, key(spec.name)];
  let cat = guild.channels.cache.find((c) => c.type === CAT && !used.has(c.id) && catKeys.includes(key(c.name)));

  if (!cat) {
    const overwrites = spec.private ? privateOverwrites : spec.hidden ? hiddenOverwrites : undefined;
    cat = await act(
      `CREATE category "${spec.name}"${spec.private ? ' (VIP only)' : spec.hidden ? ' (hidden)' : ''}`,
      () => guild.channels.create({ name: spec.name, type: CAT, permissionOverwrites: overwrites }),
      { id: `new:${spec.name}`, name: spec.name },
    );
  } else {
    used.add(cat.id);
    if (cat.name !== spec.name) {
      const current = cat;
      await act(`RENAME category "${current.name}" → "${spec.name}"`, () => current.edit({ name: spec.name }));
    }
    if (spec.private || spec.hidden) {
      const current = cat;
      await act(`LOCK category "${spec.name}"`, () => current.permissionOverwrites.set(spec.private ? privateOverwrites : hiddenOverwrites));
    }
  }

  const placed = [];
  for (const ch of spec.channels) {
    const keys = [...(ch.match ?? []), ...(ch.name ? [key(ch.name)] : [])];
    const existing = guild.channels.cache.find((c) => c.type === ch.type && !used.has(c.id) && keys.includes(key(c.name)));
    const kind = ch.type === V ? 'voice' : 'text';
    const isPrivate = Boolean(ch.private || spec.private);

    if (!existing) {
      if (!ch.name) continue; // Archive entries are only moved, never created.
      const parent = cat;
      const created = await act(
        `CREATE ${kind} "${ch.name}" in ${spec.name}${isPrivate ? ' (VIP only)' : ''}`,
        () =>
          guild.channels.create({
            name: ch.name,
            type: ch.type,
            parent: parent.id,
            permissionOverwrites: isPrivate ? privateOverwrites : copyOverwrites(parent),
            ...(ch.type === V ? { bitrate } : {}),
          }),
        { id: `new:${ch.name}`, name: ch.name },
      );
      if (created?.id) used.add(created.id);
      placed.push(created);
      continue;
    }

    used.add(existing.id);
    const newName = ch.name ?? existing.name;
    const edit = {};
    const changes = [];
    if (existing.name !== newName) {
      edit.name = newName;
      changes.push(`rename → "${newName}"`);
    }
    if (existing.parentId !== cat.id) {
      edit.parent = cat.id;
      edit.lockPermissions = false; // keep the channel's own permissions (e.g. staff-only)
      changes.push(`move → ${spec.name}`);
    }
    if (ch.type === V && !spec.hidden && existing.bitrate !== bitrate) {
      edit.bitrate = bitrate;
      changes.push(`bitrate ${existing.bitrate / 1000} → ${bitrate / 1000} kbps`);
    }
    if (changes.length) await act(`EDIT ${kind} "${existing.name}": ${changes.join(', ')}`, () => existing.edit(edit));
    if (isPrivate) await act(`LOCK "${newName}" (VIP only)`, () => existing.permissionOverwrites.set(privateOverwrites));
    if (spec.hidden) {
      await act(`HIDE "${newName}" (chat history kept)`, async () => {
        await existing.permissionOverwrites.edit(me.id, { ViewChannel: true }, { type: OverwriteType.Member });
        await existing.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
      });
    }
    placed.push(existing);
  }
  layoutCats.push({ spec, cat, placed });
}

// ---------- old VOICE category ----------

const oldVoice = guild.channels.cache.find((c) => c.type === CAT && !used.has(c.id) && key(c.name) === 'voice');
if (oldVoice) {
  const left = guild.channels.cache.filter((c) => c.parentId === oldVoice.id && !used.has(c.id));
  if (left.size === 0) {
    await act(`DELETE empty category "${oldVoice.name}"`, () => oldVoice.delete('Emptied by layout cleanup'));
  } else {
    console.log(`• KEEP category "${oldVoice.name}": still has ${left.map((c) => `"${c.name}"`).join(', ')}`);
  }
}

// Channels outside INFO that the layout doesn't mention are left untouched.
const infoCat = layoutCats[0].cat;
const untouched = guild.channels.cache.filter(
  (c) => c.type !== CAT && !used.has(c.id) && c.parentId !== infoCat?.id && c.parentId !== oldVoice?.id,
);
if (untouched.size) console.log(`• NOT TOUCHED (not in the layout): ${untouched.map((c) => `"${c.name}"`).join(', ')}`);

// ---------- order ----------

if (!APPLY) {
  console.log('• REORDER categories and channels to match the layout');
} else {
  try {
    await guild.channels.fetch();
    const catIds = layoutCats.map((x) => x.cat?.id).filter((id) => id && guild.channels.cache.has(id));
    const otherCats = guild.channels.cache
      .filter((c) => c.type === CAT && !catIds.includes(c.id))
      .sort((a, b) => a.position - b.position)
      .map((c) => c.id);
    await guild.channels.setPositions([...catIds, ...otherCats].map((id, i) => ({ channel: id, position: i })));

    for (const { cat, placed } of layoutCats) {
      if (!cat || !guild.channels.cache.has(cat.id)) continue;
      const ordered = placed.map((c) => c?.id).filter((id) => id && guild.channels.cache.has(id));
      const extras = guild.channels.cache
        .filter((c) => c.parentId === cat.id && !ordered.includes(c.id))
        .sort((a, b) => a.position - b.position)
        .map((c) => c.id);
      const all = [...ordered, ...extras];
      if (all.length) await guild.channels.setPositions(all.map((id, i) => ({ channel: id, position: i })));
    }
    console.log('▶ REORDER done');
  } catch (err) {
    failures++;
    console.log(`   ✖ reorder failed: ${err.message} (drag channels by hand if needed)`);
  }
}

console.log(
  APPLY
    ? `\nDone${failures ? ` with ${failures} failed step(s), see ✖ above` : ''}. Give the 🔑 VIP role to friends who should get into the private channels.`
    : '\nNothing was changed. If the plan looks right, run:  npm run setup-server -- --apply',
);
await client.destroy();
process.exit(failures ? 1 : 0);

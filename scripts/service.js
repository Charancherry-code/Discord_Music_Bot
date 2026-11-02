// Run the bot in the background and start it with Windows.
//
//   npm run bot:install     start with Windows (Startup folder shortcut, no admin needed) and start now
//   npm run bot:uninstall   don't start with Windows any more, and stop it
//   npm run bot:start       start in the background (hidden, restarts itself if it crashes)
//   npm run bot:stop        stop cleanly (the queue and song position are saved)
//   npm run bot:restart     restart cleanly (e.g. after changing code or .env)
//   npm run bot:status      is it running?
//
// The bot starts when you sign in to Windows (not before), which is when the laptop has Wi-Fi.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SUPERVISOR = path.join(ROOT, 'scripts', 'supervisor.js');
const STARTUP = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const SHORTCUT = path.join(STARTUP, 'Shadow Music Bot.lnk');

function pidFrom(file) {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA, file), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err?.code === 'EPERM' ? Number(fs.readFileSync(path.join(DATA, file), 'utf8')) : null;
  }
}

const supervisorPid = () => pidFrom('supervisor.lock');
const botPid = () => pidFrom('bot.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (check()) return true;
  return check();
}

function send(command) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'supervisor.cmd'), command);
}

/** PowerShell with the values passed as environment variables, never pasted into the script. */
function powershell(script, env) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });
}

async function start() {
  if (supervisorPid()) return console.log(`Already running (supervisor ${supervisorPid()}, bot ${botPid() ?? 'starting'}).`);
  const direct = botPid();
  if (direct) {
    console.log(`The bot is already running on its own (process ${direct}), not under the supervisor. Stop it first (close its window or end it in Task Manager).`);
    process.exitCode = 1;
    return;
  }
  spawn(process.execPath, [SUPERVISOR, '--detach'], { cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true }).unref();
  const ok = await waitFor(() => botPid(), 15_000);
  console.log(ok ? `Started (bot process ${botPid()}). Logs: logs\\bot-<date>.log` : 'Starting… check logs\\supervisor.log if it does not come up.');
}

async function stop() {
  if (!supervisorPid()) {
    console.log(botPid() ? `Not under the supervisor; the bot (process ${botPid()}) was started another way.` : 'Not running.');
    return;
  }
  send('stop');
  const ok = await waitFor(() => !supervisorPid(), 25_000);
  console.log(ok ? 'Stopped. The queue was saved.' : 'Still stopping; check logs\\supervisor.log.');
}

async function restart() {
  if (!supervisorPid()) return start();
  const old = botPid();
  send('restart');
  const ok = await waitFor(() => botPid() && botPid() !== old, 30_000);
  console.log(ok ? `Restarted (bot process ${botPid()}).` : 'Restarting… check logs\\supervisor.log.');
}

function status() {
  const sup = supervisorPid();
  const bot = botPid();
  console.log(`Supervisor: ${sup ? `running (process ${sup})` : 'not running'}`);
  console.log(`Bot:        ${bot ? `running (process ${bot})` : 'not running'}`);
  console.log(`Starts with Windows: ${fs.existsSync(SHORTCUT) ? 'yes' : 'no'}`);
}

async function install() {
  if (process.platform !== 'win32') throw new Error('Start-with-Windows is Windows only. On Linux, use a systemd service running scripts/supervisor.js.');
  fs.mkdirSync(STARTUP, { recursive: true });
  powershell(
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SMB_LNK);' +
      '$s.TargetPath = $env:SMB_NODE;' +
      '$s.Arguments = \'"\' + $env:SMB_SUPERVISOR + \'" --detach\';' +
      '$s.WorkingDirectory = $env:SMB_ROOT;' +
      '$s.WindowStyle = 7;' + // minimized: the window closes again within a second
      "$s.Description = 'Shadow Music Bot';" +
      '$s.Save()',
    { SMB_LNK: SHORTCUT, SMB_NODE: process.execPath, SMB_SUPERVISOR: SUPERVISOR, SMB_ROOT: ROOT },
  );
  console.log(`Starts with Windows: added ${SHORTCUT}`);
  await start();
}

async function uninstall() {
  fs.rmSync(SHORTCUT, { force: true });
  console.log('Starts with Windows: removed.');
  await stop();
}

const commands = { start, stop, restart, status, install, uninstall };
const name = process.argv[2];
if (!commands[name]) {
  console.log(`Usage: node scripts/service.js <${Object.keys(commands).join(' | ')}>`);
  process.exitCode = 1;
} else {
  try {
    await commands[name]();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

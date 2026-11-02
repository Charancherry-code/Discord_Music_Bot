// Keeps the bot running: starts src/index.js, restarts it if it crashes or exits, with a growing
// pause if it keeps failing fast. Exit code 78 (bad token, bad .env, already running) is never
// restarted, since a restart can't fix it.
//
// Controlled by scripts/service.js (npm run bot:stop / bot:restart / bot:status), which writes a
// command to data/supervisor.cmd. Stopping asks the bot to shut down cleanly (it saves the queue
// and song position) before it's forced after 15 s.
//
// `--detach` (used by the Windows startup shortcut) starts a hidden copy and exits right away,
// so no console window stays open.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');
const LOCK = path.join(DATA, 'supervisor.lock');
const CMD = path.join(DATA, 'supervisor.cmd');
const BOT = path.join(ROOT, 'src', 'index.js');

const EXIT_FATAL = 78;
const STABLE_MS = 10 * 60_000; // running this long resets the restart backoff
const BACKOFF_SEC = [2, 5, 15, 30, 60];
const STOP_TIMEOUT_MS = 15_000;

if (process.argv.includes('--detach')) {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  process.exit(0);
}

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const logFile = fs.createWriteStream(path.join(LOGS, 'supervisor.log'), { flags: 'a' });
logFile.on('error', () => {});
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logFile.write(`${line}\n`);
};

// ---------- one supervisor at a time ----------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const other = Number(fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf8') : 0);
if (other && other !== process.pid && alive(other)) {
  log(`Supervisor already running (process ${other}); exiting.`);
  process.exit(0);
}
fs.writeFileSync(LOCK, String(process.pid));
fs.rmSync(CMD, { force: true });
process.on('exit', () => {
  try {
    if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK);
  } catch {
    // Already gone.
  }
});

// ---------- running the bot ----------

let child = null;
let failures = 0;
let stopping = false; // stop for good
let restarting = false; // stop, then start again right away
let retryTimer = null;

function start() {
  retryTimer = null;
  if (stopping) return;
  const startedAt = Date.now();
  // stdout is ignored: the bot writes its own log files (logs/bot-*.log). stderr is kept for
  // crashes that happen before the logger runs (syntax errors, a missing module).
  const crashLog = fs.openSync(path.join(LOGS, 'crash.log'), 'a');
  child = spawn(process.execPath, [BOT], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', crashLog, 'ipc'],
    windowsHide: true,
  });
  fs.closeSync(crashLog);
  log(`Bot started (process ${child.pid}).`);

  child.on('exit', (code, signal) => {
    child = null;
    const ranMs = Date.now() - startedAt;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (stopping) {
      log(`Bot stopped (${how}).`);
      process.exit(0);
    }
    if (restarting) {
      restarting = false;
      failures = 0;
      log(`Bot stopped for a restart (${how}).`);
      return start();
    }
    if (code === EXIT_FATAL) {
      log(`Bot exited with a problem a restart can't fix (${how}). See logs/bot-*.log. Not restarting.`);
      process.exit(1);
    }
    failures = ranMs >= STABLE_MS ? 1 : failures + 1;
    const wait = BACKOFF_SEC[Math.min(failures, BACKOFF_SEC.length) - 1];
    log(`Bot exited after ${Math.round(ranMs / 1000)} s (${how}). Restarting in ${wait} s.`);
    retryTimer = setTimeout(start, wait * 1000);
  });
}

/** Asks the bot to save and quit; forces it after STOP_TIMEOUT_MS. */
function stopChild() {
  if (!child) return false;
  const proc = child;
  if (proc.connected) proc.send('shutdown');
  else proc.kill();
  setTimeout(() => {
    if (child === proc) {
      log('Bot did not stop in time; forcing it.');
      proc.kill('SIGKILL');
    }
  }, STOP_TIMEOUT_MS).unref();
  return true;
}

function handle(command) {
  if (command === 'stop') {
    log('Stop requested.');
    stopping = true;
    clearTimeout(retryTimer);
    if (!stopChild()) process.exit(0);
  } else if (command === 'restart') {
    log('Restart requested.');
    clearTimeout(retryTimer);
    failures = 0;
    if (child) {
      restarting = true;
      stopChild();
    } else start();
  }
}

// Commands from scripts/service.js. Polling is used because fs.watch is unreliable on some Windows setups.
setInterval(() => {
  let command;
  try {
    command = fs.readFileSync(CMD, 'utf8').trim();
  } catch {
    return;
  }
  fs.rmSync(CMD, { force: true });
  handle(command);
}, 1_000);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => handle('stop'));

log(`Supervisor started (process ${process.pid}).`);
start();

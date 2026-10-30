const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level, args) {
  const threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(prefix, ...args);
}

export const log = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};

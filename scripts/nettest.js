// Quick network test: ping to Discord/YouTube and download/upload speed via Cloudflare.
//   npm run nettest
const time = async (fn) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

async function latency(url, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    try {
      samples.push(await time(() => fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(10_000) })));
    } catch {
      // count as lost
    }
  }
  if (!samples.length) return { ms: null, lost: runs };
  samples.sort((a, b) => a - b);
  return { ms: Math.round(samples[Math.floor(samples.length / 2)]), lost: runs - samples.length };
}

async function download(bytes = 10_000_000) {
  const ms = await time(async () => {
    const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { signal: AbortSignal.timeout(120_000) });
    await res.arrayBuffer();
  });
  return (bytes * 8) / (ms / 1000) / 1e6;
}

async function upload(bytes = 2_000_000) {
  const body = new Uint8Array(bytes);
  const ms = await time(() => fetch('https://speed.cloudflare.com/__up', { method: 'POST', body, signal: AbortSignal.timeout(120_000) }).then((r) => r.arrayBuffer()));
  return (bytes * 8) / (ms / 1000) / 1e6;
}

const rate = (v, good, ok, higherIsBetter) =>
  v == null ? '⚪' : higherIsBetter ? (v >= good ? '🟢' : v >= ok ? '🟡' : '🔴') : v <= good ? '🟢' : v <= ok ? '🟡' : '🔴';

const lines = [];
for (const [name, url] of [
  ['Discord', 'https://discord.com/api/v10/gateway'],
  ['YouTube', 'https://www.youtube.com/generate_204'],
]) {
  const r = await latency(url);
  lines.push(`${rate(r.ms, 150, 300, false)} ${name} latency: ${r.ms ?? 'n/a'} ms (lost ${r.lost}/5)`);
}
try {
  const d = await download();
  lines.push(`${rate(d, 10, 2, true)} Download: ${d.toFixed(1)} Mbps`);
} catch (err) {
  lines.push(`🔴 Download failed: ${err.message}`);
}
try {
  const u = await upload();
  lines.push(`${rate(u, 2, 0.5, true)} Upload: ${u.toFixed(1)} Mbps`);
} catch (err) {
  lines.push(`🔴 Upload failed: ${err.message}`);
}
console.log(lines.join('\n'));

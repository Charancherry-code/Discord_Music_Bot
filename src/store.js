// Tiny JSON file store: load once, edit in memory, save with a short debounce.
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';

export class JsonStore {
  #timer = null;

  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = { ...this.data, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`${path.basename(this.file)} is unreadable, using defaults: ${err.message}`);
    }
    return this.data;
  }

  save(delayMs = 1000) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush().catch((err) => log.warn(`Could not save ${path.basename(this.file)}: ${err.message}`));
    }, delayMs);
    this.#timer.unref();
  }

  async flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fs.rename(tmp, this.file);
  }
}

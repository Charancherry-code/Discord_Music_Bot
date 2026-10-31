// Turns search phrases (Spotify songs) into YouTube tracks once, then remembers
// them on disk so each phrase is only searched the first time it's played.
import { log } from './logger.js';
import { JsonStore } from './store.js';
import { searchTracks } from './ytdlp.js';

const MAX_ENTRIES = 5000;

export class Resolver {
  constructor(cacheFile) {
    this.store = new JsonStore(cacheFile, {});
  }

  async load() {
    await this.store.load();
    log.info(`Loaded ${Object.keys(this.store.data).length} cached search results.`);
  }

  async resolve(query, signal) {
    const key = query.toLowerCase();
    const hit = this.store.data[key];
    if (hit?.url) return hit;

    const [result] = await searchTracks(query, 1, signal);
    if (!result) throw new Error(`no results for "${query}"`);
    this.store.data[key] = result;
    // Big Spotify playlists add many entries; keep the file small by dropping the oldest.
    const keys = Object.keys(this.store.data);
    for (let n = 0; n < keys.length - MAX_ENTRIES; n++) delete this.store.data[keys[n]];
    this.store.save(2000);
    return result;
  }

  /** Drops a cached result, e.g. after the video turned out to be unavailable. */
  forget(query) {
    const key = query?.toLowerCase();
    if (key && key in this.store.data) {
      delete this.store.data[key];
      this.store.save(2000);
    }
  }

  flush() {
    return this.store.flush();
  }
}

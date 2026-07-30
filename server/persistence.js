import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Load persisted org stores from disk.
 * @param {string} path
 * @returns {Map<string, Record<string, object[]>> | null}
 */
export function loadPersistedStores(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return new Map(Object.entries(parsed));
  } catch (error) {
    console.warn(`Could not load persisted cards from ${path}: ${error.message}`);
    return null;
  }
}

/**
 * Debounced writer. Card traffic is bursty (a decision fans out into several
 * events), so writes are coalesced instead of hitting disk per event.
 * @param {string} path
 */
export function createPersister(path, { delayMs = 500 } = {}) {
  let timer = null;
  let stores = null;

  function flush() {
    timer = null;
    if (!stores) return;

    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(stores.entries()), null, 2));
      renameSync(tmp, path);
    } catch (error) {
      console.warn(`Could not persist cards to ${path}: ${error.message}`);
    }
  }

  return {
    schedule(orgStores) {
      stores = orgStores;
      if (!timer) {
        timer = setTimeout(flush, delayMs);
      }
    },
    flushNow(orgStores) {
      if (orgStores) stores = orgStores;
      if (timer) {
        clearTimeout(timer);
      }
      flush();
    },
  };
}

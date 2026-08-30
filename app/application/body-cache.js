// @ts-check

import {
  MAX_BODIES,
  bodyDirName,
  bodyFileName,
  parseBody,
  serializeBody,
} from "../cache/Cache.js";

// Message bodies that have already been fetched, so opening a message a second
// time draws it without asking the server again.
//
// `BodyCache.qml` keeps these as one file per message under one directory per
// account, and the reason it does is a Qt one: the QML store is a single JSON
// document re-serialised *in JavaScript on the GUI thread* whenever anything in
// it moves, so a thousand bodies inside it meant re-encoding megabytes to
// record that a list had scrolled. That reason does not carry over. gpui's
// `localStorage` is a native key/value store whose file is written on a
// background thread, and the only encoding this side pays for is the one record
// being written. So the bodies live beside the list cache, in the same store,
// reached the same way — see `list-cache.js` — rather than behind a new host
// module whose read would have to be asynchronous.
//
// That the read is *synchronous* is the point. `BodyCache.qml` answers late and
// races the network, because a FileView cannot be read on the thread that
// paints; here the controller can ask and be answered before it decides whether
// to fetch at all, which is what turns a cache that hides latency into a cache
// that removes a round trip.
//
// One thing does change with the substrate. In a directory a large file costs
// only its own bytes, so `MAX_BODIES` — a plain file count — is a real ceiling.
// Here every record shares one document, and a mailbox with a handful of
// enormous messages could grow it without ever reaching a thousand entries. So
// the count ceiling is kept, exactly as the QML has it, and a size ceiling is
// kept beside it; eviction is the QML's, least-recently-used.

const RECORD_PREFIX = "omamail.body.v1:";
const INDEX_PREFIX = "omamail.bodies.v1:";

// Measured in JSON characters rather than bytes. Mail is overwhelmingly ASCII
// and base64, so the two agree to within a few percent, and a ceiling that has
// to be exact is a ceiling in the wrong place.
//
// The numbers are the host's, not invented. `crates/shell/src/storage.rs` caps
// the whole store at 8 MiB (`MAX_STORE_BYTES`), one value at 1 MiB
// (`MAX_STORE_VALUE_BYTES`) and the key count at 4096 — and `set` *fails* past
// them rather than evicting. So the bodies take a deliberate slice of the store
// and leave the rest to everything else that lives there: accounts, settings,
// the list cache, window state. A cache that filled the store would not be a
// slow cache, it would be a client that could no longer save a setting.
export const MAX_STORE_CHARS = 4 * 1024 * 1024;

// One record, against the host's own per-value limit. A message bigger than
// this is not cached at all — refusing one body costs a refetch, and there is
// no arrangement of the rest of the cache that would make it fit.
export const MAX_RECORD_CHARS = 768 * 1024;

/** @param {string} accountId */
function directoryOf(accountId) {
  return bodyDirName(accountId);
}

/** @param {string} directory @param {string} name */
function recordKey(directory, name) {
  return RECORD_PREFIX + directory + "/" + name;
}

/** @param {string} directory */
function indexKey(directory) {
  return INDEX_PREFIX + directory;
}

/**
 * What eviction sorts on. `body-cache.sh` reads it off the files' mtimes; there
 * are no mtimes here, so each entry carries its own last use and its size, in
 * one small key that is rewritten on a hit instead of the record itself.
 * @param {Pick<Storage, "getItem">} storage @param {string} directory
 * @returns {Array<{name:string, at:number, chars:number}>}
 */
function readIndex(storage, directory) {
  try {
    const parsed = JSON.parse(storage.getItem(indexKey(directory)) ?? "null");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry) =>
          Array.isArray(entry) && typeof entry[0] === "string" && entry[0],
      )
      .map((entry) => ({
        name: String(entry[0]),
        at: Number(entry[1]) || 0,
        chars: Math.max(0, Math.floor(Number(entry[2]) || 0)),
      }));
  } catch (_error) {
    return [];
  }
}

/**
 * @param {Pick<Storage, "setItem">} storage @param {string} directory
 * @param {Array<{name:string, at:number, chars:number}>} entries
 */
function writeIndex(storage, directory, entries) {
  storage.setItem(
    indexKey(directory),
    JSON.stringify(entries.map((entry) => [entry.name, entry.at, entry.chars])),
  );
}

/**
 * Least-recently-used, newest first, until either ceiling is reached. Returns
 * what is kept and what has to go, because the caller has to delete the records
 * as well as forget them.
 * @param {Array<{name:string, at:number, chars:number}>} entries
 */
function evict(entries) {
  const newestFirst = entries.slice().sort((left, right) => right.at - left.at);
  const kept = [];
  const dropped = [];
  let chars = 0;
  for (const entry of newestFirst) {
    if (kept.length < MAX_BODIES && chars + entry.chars <= MAX_STORE_CHARS) {
      kept.push(entry);
      chars += entry.chars;
    } else dropped.push(entry);
  }
  return { kept, dropped };
}

/**
 * @param {Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>} storage
 * @param {{ now?: () => number }} [options]
 */
export function createBodyCache(storage, options = {}) {
  const clock = () =>
    typeof options.now === "function" ? Number(options.now()) : Date.now();
  const forget = (/** @type {string} */ key) => {
    // `removeItem` is optional on the storage a test hands in, the way
    // `list-cache.js` treats it. Overwriting is the honest fallback: a record
    // that cannot be deleted is at least no longer a body sitting in the store.
    if (typeof storage.removeItem === "function") storage.removeItem(key);
    else storage.setItem(key, "");
  };

  return {
    /**
     * The record, or null when this message has never been opened — which is
     * the only kind of miss there is. A body does not change once it has been
     * fetched, which is what makes a hit always correct and why nothing here
     * ages an entry out. A record written by an older version of this cache,
     * or one that has been truncated, does not parse and is a miss too.
     * @param {string} accountId @param {string} id
     */
    read(accountId, id) {
      const name = bodyFileName(id);
      if (!name) return null;
      try {
        return parseBody(
          storage.getItem(recordKey(directoryOf(accountId), name)) ?? "",
        );
      } catch (_error) {
        return null;
      }
    },

    /**
     * A hit is a use. Kept apart from `read` the way `BodyCache.qml` keeps
     * them, so the caller decides what counts as using a message rather than
     * every glance at the store moving it up the queue.
     * @param {string} accountId @param {string} id
     */
    touch(accountId, id) {
      const name = bodyFileName(id);
      if (!name) return;
      const directory = directoryOf(accountId);
      const entries = readIndex(storage, directory);
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry) return;
      entry.at = clock();
      try {
        writeIndex(storage, directory, entries);
      } catch (_error) {
        // A cache that cannot record a use is still a cache.
      }
    },

    /**
     * @param {string} accountId @param {string} id @param {any} record
     */
    put(accountId, id, record) {
      const name = bodyFileName(id);
      if (!name) return;
      const payload = serializeBody(record);
      // One message larger than the whole cache is allowed to keep is not
      // something to make room for: storing it would evict everything else to
      // hold a single message that the next open evicts again.
      if (payload.length > MAX_RECORD_CHARS) return;
      const directory = directoryOf(accountId);
      try {
        storage.setItem(recordKey(directory, name), payload);
        const entries = readIndex(storage, directory).filter(
          (entry) => entry.name !== name,
        );
        entries.push({ name, at: clock(), chars: payload.length });
        const { kept, dropped } = evict(entries);
        dropped.forEach((entry) => forget(recordKey(directory, entry.name)));
        writeIndex(storage, directory, kept);
      } catch (_error) {
        // A full or unwritable store must not stop a message from opening.
      }
    },

    /**
     * Everything this account ever cached. `MailAccount` clears the body cache
     * whenever it clears the store — signing out, and removing the account —
     * and these are message bodies, so leaving them behind would outlive the
     * account they belong to.
     * @param {string} accountId
     */
    clearAccount(accountId) {
      const directory = directoryOf(accountId);
      try {
        readIndex(storage, directory).forEach((entry) =>
          forget(recordKey(directory, entry.name)),
        );
        forget(indexKey(directory));
      } catch (_error) {
        // Nothing to do about a store that refuses; the next write prunes.
      }
    },
  };
}

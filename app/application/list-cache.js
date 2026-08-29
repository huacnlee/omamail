// @ts-check

const PREFIX = "omamail.list.v1:";

/** @param {string} accountId @param {string} query */
function keyFor(accountId, query) {
  return PREFIX + JSON.stringify([String(accountId), String(query)]);
}

/** @param {Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem" | "key" | "length">>} storage */
export function createListCache(storage) {
  return {
    /** @param {string} accountId @param {string} query */
    readList(accountId, query) {
      try {
        const value = JSON.parse(
          storage.getItem(keyFor(accountId, query)) ?? "null",
        );
        return Array.isArray(value) ? value : null;
      } catch (_error) {
        return null;
      }
    },
    /** @param {string} accountId @param {string} query @param {Array<any>} messages */
    writeList(accountId, query, messages) {
      storage.setItem(keyFor(accountId, query), JSON.stringify(messages));
    },
    /** @param {string} accountId */
    clearAccount(accountId) {
      const removeItem = storage.removeItem?.bind(storage);
      if (!removeItem) return;
      const prefix =
        PREFIX + JSON.stringify([String(accountId), ""]).slice(0, -2);
      const keys = [];
      for (let index = 0; index < Number(storage.length || 0); index += 1) {
        const key = storage.key?.(index);
        if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
      }
      keys.forEach((key) => removeItem(key));
    },
  };
}

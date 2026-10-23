// The player's ROM, kept in the extension's IndexedDB so it's chosen once.

const DB = 'showdown-bw2';
const STORE = 'files';
const KEY = 'rom';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = act(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function loadRom(): Promise<ArrayBuffer | null> {
  const rom = await run<ArrayBuffer | undefined>('readonly', (s) => s.get(KEY));
  return rom ?? null;
}

export async function saveRom(rom: ArrayBuffer): Promise<void> {
  await run('readwrite', (s) => s.put(rom, KEY));
}

export async function forgetRom(): Promise<void> {
  await run('readwrite', (s) => s.delete(KEY));
}

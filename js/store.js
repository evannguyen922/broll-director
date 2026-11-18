// Clips live only on this phone, in the browser's IndexedDB.
// Video is stored as an ArrayBuffer (Safari is more reliable with these than Blobs).

const DB_NAME = 'broll-director';
const DB_VERSION = 1;
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        const takes = d.createObjectStore('takes', { keyPath: 'id' });
        takes.createIndex('project', 'projectId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Saving was cancelled'));
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function saveTake(take) {
  const { blob, thumb, ...rest } = take;
  const record = {
    ...rest,
    video: await blob.arrayBuffer(),
    videoType: blob.type,
    thumb: thumb ? await thumb.arrayBuffer() : null,
  };
  await tx('takes', 'readwrite', (s) => s.put(record));
}

function hydrate(r) {
  return {
    ...r,
    blob: new Blob([r.video], { type: r.videoType }),
    thumb: r.thumb ? new Blob([r.thumb], { type: 'image/jpeg' }) : null,
  };
}

export async function listTakes(projectId) {
  const rows = await tx('takes', 'readonly', (s) => reqP(s.index('project').getAll(projectId)));
  return (rows || []).sort((a, b) => a.createdAt - b.createdAt).map(hydrate);
}

// Just the facts (no video bytes) – used for progress dots.
export async function listTakeInfo(projectId) {
  const rows = await tx('takes', 'readonly', (s) => reqP(s.index('project').getAll(projectId)));
  return (rows || []).map(({ video, thumb, ...r }) => r);
}

export function deleteTake(id) {
  return tx('takes', 'readwrite', (s) => s.delete(id));
}

export async function deleteProject(projectId) {
  const rows = await listTakeInfo(projectId);
  await tx('takes', 'readwrite', (s) => rows.forEach((r) => s.delete(r.id)));
}

export async function askToKeepStorage() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* fine */ }
}

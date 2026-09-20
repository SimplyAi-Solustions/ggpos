/**
 * The smallest key-value store the offline queue needs, over IndexedDB.
 *
 * Hand-written rather than pulled in: the queue keeps a handful of pending
 * actions under their client ids, so one object store and four operations
 * cover it. Every call falls back to memory when IndexedDB is missing or
 * refused (private browsing, a test runner, an iOS quirk), because a counter
 * that cannot open a database must still be able to take the sale in front
 * of it; it only loses the queue when the tab closes.
 */

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  entries<T>(): Promise<[string, T][]>
  clear(): Promise<void>
}

/** The fallback, and what the unit tests run against. */
export function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async entries<T>() {
      return [...map.entries()] as [string, T][]
    },
    async clear() {
      map.clear()
    },
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDatabase(name: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(storeName)) {
        open.result.createObjectStore(storeName)
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(new Error("The offline queue is open in another tab."))
  })
}

/**
 * IndexedDB when the browser has it, memory when it does not. The first
 * failure of any kind switches this store to memory for good rather than
 * retrying on every sale.
 */
export function openStore(name = "gg-vault", storeName = "queue"): KeyValueStore {
  let fallback: KeyValueStore | null = null
  let db: Promise<IDBDatabase> | null = null

  function memory(): KeyValueStore {
    if (!fallback) fallback = memoryStore()
    return fallback
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T | undefined> {
    if (fallback) return undefined
    if (typeof indexedDB === "undefined") {
      memory()
      return undefined
    }
    try {
      if (!db) db = openDatabase(name, storeName)
      const database = await db
      const tx = database.transaction(storeName, mode)
      return await request(run(tx.objectStore(storeName)))
    } catch {
      // One failure is enough: fall back for the rest of the session so the
      // queue never blocks a counter on a database that will not open.
      db = null
      memory()
      return undefined
    }
  }

  return {
    async get<T>(key: string) {
      const value = await withStore<T>("readonly", (store) => store.get(key) as IDBRequest<T>)
      if (fallback) return memory().get<T>(key)
      return value
    },
    async set(key, value) {
      await withStore("readwrite", (store) => store.put(value, key))
      if (fallback) await memory().set(key, value)
    },
    async remove(key) {
      await withStore("readwrite", (store) => store.delete(key))
      if (fallback) await memory().remove(key)
    },
    async entries<T>() {
      const keys = await withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys())
      if (fallback) return memory().entries<T>()
      const values = await withStore<T[]>("readonly", (store) => store.getAll() as IDBRequest<T[]>)
      if (fallback) return memory().entries<T>()
      return (keys ?? []).map(
        (key, index) => [String(key), (values ?? [])[index] as T] as [string, T]
      )
    },
    async clear() {
      await withStore("readwrite", (store) => store.clear())
      if (fallback) await memory().clear()
    },
  }
}

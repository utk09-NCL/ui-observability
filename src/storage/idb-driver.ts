// src/storage/idb-driver.ts
//
// Raw IndexedDB mechanics for the batch store: opening, request promises, and the
// createdAt-ordered reads. Everything above this file works in batches and ids.

import {
  INDEXEDDB_CREATED_AT_INDEX,
  INDEXEDDB_SCHEMA_VERSION,
  INDEXEDDB_STORE_NAME,
} from "../constants";
import type { LogBatch } from "../models/batch";

/**
 * Reads the failure off a request that has errored. A host whose request reports
 * no error gets a stand-in: rejecting with null makes the instanceof Error test
 * in save() false, and a full disk is then reported as an ordinary write failure.
 * @param request Request that fired onerror.
 * @returns The failure that stopped it.
 */
function failureOf(request: IDBRequest): Error {
  return request.error ?? new Error("the IndexedDB request failed");
}

/**
 * Resolves when an IndexedDB request succeeds and rejects with its error. The
 * request is read as IDBRequest<any>, so every caller names the type it expects.
 * @param request Request to await.
 * @returns The request result.
 */
function promisify<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result as T);
    };
    request.onerror = () => {
      reject(failureOf(request));
    };
  });
}

/** One IndexedDB database holding undelivered batches keyed by id. */
export class IdbDriver {
  /** Open in progress or completed, reused so one database is opened per driver. */
  private connection: Promise<IDBDatabase> | null = null;

  /**
   * @param name IndexedDB database name.
   */
  constructor(private readonly name: string) {}

  /**
   * Writes a batch, replacing any batch already stored under the same id.
   * @param batch Batch to persist.
   */
  async put(batch: LogBatch): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.put(batch));
  }

  /**
   * Reads the oldest batches by createdAt without removing them.
   * @param limit Maximum number of batches to return.
   * @returns Batches in ascending createdAt order.
   */
  async takeOldest(limit: number): Promise<LogBatch[]> {
    const store = await this.store("readonly");
    return promisify<LogBatch[]>(store.index(INDEXEDDB_CREATED_AT_INDEX).getAll(null, limit));
  }

  /**
   * Reads every batch created strictly before a cutoff.
   * @param cutoff Exclusive upper bound in epoch milliseconds.
   * @returns Batches older than the cutoff.
   */
  async takeBefore(cutoff: number): Promise<LogBatch[]> {
    const store = await this.store("readonly");
    const range = IDBKeyRange.upperBound(cutoff, true);
    return promisify<LogBatch[]>(store.index(INDEXEDDB_CREATED_AT_INDEX).getAll(range));
  }

  /**
   * Deletes one batch. An id that is not stored resolves without error.
   * @param id Batch identifier.
   */
  async delete(id: string): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.delete(id));
  }

  /**
   * Deletes several batches in one transaction, so a partial failure leaves none
   * of them deleted.
   * @param ids Batch identifiers.
   */
  async deleteMany(ids: string[]): Promise<void> {
    const store = await this.store("readwrite");
    await Promise.all(ids.map((id) => promisify(store.delete(id))));
  }

  /**
   * Rewrites the attempt count of a stored batch. An id that is not stored is
   * left alone: a batch already delivered and deleted must not be resurrected.
   * One transaction for the get and the put. Across two transactions, a prune in
   * another window deletes the batch between them, and the put restores it.
   * @param id Batch identifier.
   * @param attempts New absolute attempt count.
   */
  async bumpAttempts(id: string, attempts: number): Promise<void> {
    const store = await this.store("readwrite");
    const batch = await promisify<LogBatch | undefined>(store.get(id));
    if (batch === undefined) {
      return;
    }

    await promisify(store.put({ ...batch, attempts }));
  }

  /**
   * Counts stored batches.
   * @returns Total batch count.
   */
  async count(): Promise<number> {
    const store = await this.store("readonly");
    return promisify<number>(store.count());
  }

  /** Deletes every stored batch. */
  async clear(): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.clear());
  }

  /**
   * Opens the connection. A host that defines indexedDB but rejects open() fails
   * here, where the factory can select a different adapter.
   */
  async ready(): Promise<void> {
    await this.open();
  }

  /** Closes the connection, if one was ever opened. */
  async close(): Promise<void> {
    const connection = this.connection;
    if (connection === null) {
      return;
    }

    this.connection = null;
    const db = await connection;
    db.close();
  }

  /**
   * Opens the batch store in a fresh transaction. A transaction is only valid
   * until control returns to the event loop, so every call takes a new one.
   * @param mode Transaction mode.
   * @returns The batch object store.
   */
  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(INDEXEDDB_STORE_NAME, mode).objectStore(INDEXEDDB_STORE_NAME);
  }

  /**
   * Opens the database one time and gives the same connection to each later call.
   * A failed open is not kept: the next call opens again.
   * @returns The open database.
   */
  private open(): Promise<IDBDatabase> {
    const existing = this.connection;
    if (existing !== null) {
      return existing;
    }

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, INDEXEDDB_SCHEMA_VERSION);
      let abandoned = false;

      request.onupgradeneeded = () => {
        const db = request.result;
        // A database written by an earlier release already carries the store.
        // Creating it again throws ConstraintError and the upgrade aborts.
        if (!db.objectStoreNames.contains(INDEXEDDB_STORE_NAME)) {
          const store = db.createObjectStore(INDEXEDDB_STORE_NAME, { keyPath: "id" });
          store.createIndex(INDEXEDDB_CREATED_AT_INDEX, INDEXEDDB_CREATED_AT_INDEX);
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        if (abandoned) {
          // The blocked handler rejected already. No reference to this connection
          // remains, and an open connection blocks the next upgrade.
          db.close();
          return;
        }

        // Another window upgrades the schema. That upgrade blocks until this
        // connection closes.
        db.onversionchange = () => {
          db.close();
          this.connection = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        reject(failureOf(request));
      };
      request.onblocked = () => {
        // An older window holds the previous schema version. This open does not
        // settle until that window closes, and each storage call waits with it.
        abandoned = true;
        reject(new Error("another connection is blocking the IndexedDB upgrade"));
      };
    });

    this.connection = opening.catch((error: unknown) => {
      this.connection = null;
      throw error;
    });

    return this.connection;
  }
}

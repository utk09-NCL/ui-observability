// src/storage/idb-driver.ts
//
// This module holds the raw IndexedDB code for the batch store. It opens the database, wraps
// requests in promises and reads in createdAt order. Code above this file uses only batches
// and ids.

import {
  INDEXEDDB_CREATED_AT_INDEX,
  INDEXEDDB_SCHEMA_VERSION,
  INDEXEDDB_STORE_NAME,
} from "../constants";
import type { LogBatch } from "../models/batch";

/**
 * Returns the failure of a request that fired onerror. Some hosts report no
 * error on the request. The function then returns a replacement Error. A rejection with null
 * makes the instanceof Error test in save() false. save() then reports a full disk as an
 * ordinary write failure.
 * @param request Request that fired onerror.
 * @returns The failure that stopped it.
 */
function failureOf(request: IDBRequest): Error {
  return request.error ?? new Error("The IndexedDB request failed.");
}

/**
 * Resolves when an IndexedDB request succeeds. It rejects with the request
 * error. It reads the request as IDBRequest<any>. Each caller must name the type that it
 * expects.
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

/** This class wraps one IndexedDB database that holds undelivered batches by id. */
export class IdbDriver {
  /** This field holds the pending or completed open. The driver reuses it for one database. */
  private connection: Promise<IDBDatabase> | null = null;

  /**
   * @param name IndexedDB database name.
   */
  constructor(private readonly name: string) {}

  /**
   * Writes a batch. It replaces a stored batch with the same id.
   * @param batch Batch to persist.
   */
  async put(batch: LogBatch): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.put(batch));
  }

  /**
   * Reads the oldest batches by createdAt. It does not remove them.
   * @param limit Maximum number of batches to return.
   * @returns Batches in ascending createdAt order.
   */
  async takeOldest(limit: number): Promise<LogBatch[]> {
    const store = await this.store("readonly");
    return promisify<LogBatch[]>(store.index(INDEXEDDB_CREATED_AT_INDEX).getAll(null, limit));
  }

  /**
   * Reads each batch with a createdAt value before the cutoff.
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
   * Deletes several batches in one transaction. A partial failure deletes none of
   * them.
   * @param ids Batch identifiers.
   */
  async deleteMany(ids: string[]): Promise<void> {
    const store = await this.store("readwrite");
    await Promise.all(ids.map((id) => promisify(store.delete(id))));
  }

  /**
   * Sets the attempt count of a stored batch. It ignores an id that is not stored.
   * A batch that was delivered and deleted must not come back. The get and the put use one
   * transaction. With two transactions, a prune in another window can delete the batch
   * between them. The put then restores it.
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
   * Counts the stored batches.
   * @returns Total batch count.
   */
  async count(): Promise<number> {
    const store = await this.store("readonly");
    return promisify<number>(store.count());
  }

  /** This method deletes all stored batches. */
  async clear(): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.clear());
  }

  /**
   * Opens the connection. A host that defines indexedDB but rejects open() fails
   * here. The factory can then select a different adapter.
   */
  async ready(): Promise<void> {
    await this.open();
  }

  /** This method closes the connection when a connection exists. */
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
   * Opens the batch store in a new transaction. A transaction is valid only until
   * control returns to the event loop. Each call takes a new transaction.
   * @param mode Transaction mode.
   * @returns The batch object store.
   */
  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(INDEXEDDB_STORE_NAME, mode).objectStore(INDEXEDDB_STORE_NAME);
  }

  /**
   * Opens the database one time. It gives the same connection to each later call.
   * It does not keep a failed open. The next call then opens again.
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
        // A database from an earlier release already contains the store. A second create
        // throws ConstraintError and aborts the upgrade.
        if (!db.objectStoreNames.contains(INDEXEDDB_STORE_NAME)) {
          const store = db.createObjectStore(INDEXEDDB_STORE_NAME, { keyPath: "id" });
          store.createIndex(INDEXEDDB_CREATED_AT_INDEX, INDEXEDDB_CREATED_AT_INDEX);
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        if (abandoned) {
          // The blocked handler already rejected. No reference to this connection remains.
          // An open connection blocks the next upgrade.
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
        // An older window holds the previous schema version. This open does not settle
        // until that window closes. Each storage call waits for it.
        abandoned = true;
        reject(new Error("Another connection blocks the IndexedDB upgrade."));
      };
    });

    this.connection = opening.catch((error: unknown) => {
      this.connection = null;
      throw error;
    });

    return this.connection;
  }
}

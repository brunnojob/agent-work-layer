// Storage for desks. Implement DeskStore to back a desk with a database.
import { mkdir, readFile, readdir, rename, writeFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AwlError } from "./errors.ts";
import type { OrderRecord } from "./types.ts";

export interface DeskStore {
  /** Returns the record, or null when there is none. */
  read(id: string): Promise<OrderRecord | null>;
  /** Stores a new record. Throws ALREADY_EXISTS if the id is taken. */
  insert(record: OrderRecord): Promise<void>;
  /**
   * Replaces a record. `expectedSeq` is the last event seq the caller read; the store
   * throws CONFLICT if the stored record has moved on since (optimistic concurrency).
   */
  update(record: OrderRecord, expectedSeq: number): Promise<void>;
  /** Every stored record. */
  list(): Promise<OrderRecord[]>;
}

const lastSeq = (r: OrderRecord) => r.events.at(-1)?.seq ?? 0;
const clone = <T>(value: T): T => structuredClone(value);

/** Keeps records in memory. Useful for tests and single-process apps. */
export class MemoryStore implements DeskStore {
  #records = new Map<string, OrderRecord>();

  async read(id: string) {
    const r = this.#records.get(id);
    return r ? clone(r) : null;
  }

  async insert(record: OrderRecord) {
    if (this.#records.has(record.order.id)) throw new AwlError("ALREADY_EXISTS", `order "${record.order.id}" already exists`);
    this.#records.set(record.order.id, clone(record));
  }

  async update(record: OrderRecord, expectedSeq: number) {
    const current = this.#records.get(record.order.id);
    if (!current) throw new AwlError("NOT_FOUND", `no order "${record.order.id}"`);
    if (lastSeq(current) !== expectedSeq) throw new AwlError("CONFLICT", `order "${record.order.id}" changed since it was read`);
    this.#records.set(record.order.id, clone(record));
  }

  async list() {
    return [...this.#records.values()].map(clone);
  }
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * One JSON file per order in `<dir>/orders`. Several processes may share a folder.
 * Writes are atomic (write then rename); the CONFLICT check is best-effort across processes.
 */
export class FileStore implements DeskStore {
  readonly dir: string;
  #ready: Promise<unknown>;

  constructor(dir: string) {
    this.dir = join(dir, "orders");
    this.#ready = mkdir(this.dir, { recursive: true });
  }

  #path(id: string) {
    if (!SAFE_ID.test(id)) throw new AwlError("BAD_REQUEST", `order id "${id}" may only use letters, digits, ".", "_" and "-"`);
    return join(this.dir, `${id}.json`);
  }

  async #write(record: OrderRecord) {
    const file = this.#path(record.order.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      await rename(tmp, file);
    } finally {
      await unlink(tmp).catch((e) => { if (e.code !== "ENOENT") throw e; });
    }
  }

  async read(id: string): Promise<OrderRecord | null> {
    await this.#ready;
    try {
      return JSON.parse(await readFile(this.#path(id), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async insert(record: OrderRecord) {
    await this.#ready;
    const file = this.#path(record.order.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      try { await link(tmp, file); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new AwlError("ALREADY_EXISTS", `order "${record.order.id}" already exists`);
        throw e;
      }
    } finally {
      await unlink(tmp).catch((e) => { if (e.code !== "ENOENT") throw e; });
    }
  }

  async update(record: OrderRecord, expectedSeq: number) {
    const current = await this.read(record.order.id);
    if (!current) throw new AwlError("NOT_FOUND", `no order "${record.order.id}"`);
    if (lastSeq(current) !== expectedSeq) throw new AwlError("CONFLICT", `order "${record.order.id}" changed since it was read`);
    await this.#write(record);
  }

  async list() {
    await this.#ready;
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const records = await Promise.all(files.map((f) => this.read(f.slice(0, -5))));
    return records.filter((r): r is OrderRecord => r !== null);
  }
}

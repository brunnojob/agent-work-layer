import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore } from "../src/store.ts";
import type { OrderRecord } from "../src/types.ts";

test("two stores cannot both insert the same order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awl-race-"));
  try {
    const record = { order: { id: "order-1" }, events: [] } as unknown as OrderRecord;
    const results = await Promise.allSettled([new FileStore(dir).insert(record), new FileStore(dir).insert(record)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const failed = results.find(result => result.status === "rejected");
    assert.equal(failed?.status === "rejected" && failed.reason.code, "ALREADY_EXISTS");
    assert.deepEqual(await readdir(join(dir, "orders")), ["order-1.json"]);
    assert.equal((await new FileStore(dir).read("order-1"))?.order.id, "order-1");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

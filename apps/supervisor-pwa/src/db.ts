import { Dexie } from "dexie";
import type { Table } from "dexie";
export type OutboxEvent = { event_id: string; farm_id: string; payload: unknown; createdAt: string };
export class LedgerDB extends Dexie {
  outbox!: Table<OutboxEvent, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  constructor() {
    super("tea-farm-ledger");
    this.version(1).stores({ outbox: "event_id, farm_id", meta: "key" });
  }
}
export const db = new LedgerDB();

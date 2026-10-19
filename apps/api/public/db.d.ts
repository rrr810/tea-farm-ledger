import { Dexie } from "dexie";
import type { Table } from "dexie";
export type OutboxEvent = {
    event_id: string;
    farm_id: string;
    payload: unknown;
    createdAt: string;
    type: string;
};
export type LocalWorker = {
    worker_id: string;
    farm_id: string;
    full_name: string;
    phone_e164: string;
    status: string;
    verified: boolean;
    consent_at: string;
    consent_author: string;
};
export type EmploymentPeriodLocal = {
    id: string;
    worker_id: string;
    farm_id: string;
    start_date: string;
    end_date: string | null;
};
export type DailyEntryLocal = {
    id: string;
    date: string;
    worker_id: string;
    worker_name: string;
    kgUnits: number;
    present: boolean;
    isPluckingDay: boolean;
    reason?: string;
};
export declare class LedgerDB extends Dexie {
    outbox: Table<OutboxEvent, string>;
    workers: Table<LocalWorker, string>;
    employment: Table<EmploymentPeriodLocal, string>;
    daily: Table<DailyEntryLocal, string>;
    meta: Table<{
        key: string;
        value: unknown;
    }, string>;
    constructor();
}
export declare const db: LedgerDB;
export declare function todayEAT(): string;

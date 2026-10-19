"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.LedgerDB = void 0;
exports.todayEAT = todayEAT;
var dexie_1 = require("dexie");
var LedgerDB = /** @class */ (function (_super) {
    __extends(LedgerDB, _super);
    function LedgerDB() {
        var _this = _super.call(this, "tea-farm-ledger") || this;
        _this.version(2).stores({
            outbox: "event_id, farm_id",
            workers: "worker_id, farm_id",
            employment: "id, worker_id",
            daily: "id, date, worker_id",
            meta: "key",
        });
        return _this;
    }
    return LedgerDB;
}(dexie_1.Dexie));
exports.LedgerDB = LedgerDB;
exports.db = new LedgerDB();
function todayEAT() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

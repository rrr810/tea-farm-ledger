"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = App;
var jsx_runtime_1 = require("react/jsx-runtime");
var react_1 = require("react");
var db_js_1 = require("./db.js");
var core_1 = require("@tea-ledger/core");
function App() {
    var _this = this;
    var _a, _b;
    var _c = (0, react_1.useState)("daily"), tab = _c[0], setTab = _c[1];
    var _d = (0, react_1.useState)(0), pending = _d[0], setPending = _d[1];
    var _e = (0, react_1.useState)(null), lastSynced = _e[0], setLastSynced = _e[1];
    var _f = (0, react_1.useState)(navigator.onLine), online = _f[0], setOnline = _f[1];
    var _g = (0, react_1.useState)((_a = localStorage.getItem("farm_id")) !== null && _a !== void 0 ? _a : ""), farmId = _g[0], setFarmId = _g[1];
    var _h = (0, react_1.useState)([]), workers = _h[0], setWorkers = _h[1];
    var _j = (0, react_1.useState)((0, db_js_1.todayEAT)()), selectedDate = _j[0], setSelectedDate = _j[1];
    var _k = (0, react_1.useState)(true), isPluckingDay = _k[0], setIsPluckingDay = _k[1];
    var _l = (0, react_1.useState)(""), noPluckReason = _l[0], setNoPluckReason = _l[1];
    var _m = (0, react_1.useState)([]), daily = _m[0], setDaily = _m[1];
    var _o = (0, react_1.useState)(""), msg = _o[0], setMsg = _o[1];
    // forms
    var _p = (0, react_1.useState)(""), fullName = _p[0], setFullName = _p[1];
    var _q = (0, react_1.useState)(""), phone = _q[0], setPhone = _q[1];
    var _r = (0, react_1.useState)(false), consent = _r[0], setConsent = _r[1];
    var _s = (0, react_1.useState)(""), hireWorkerId = _s[0], setHireWorkerId = _s[1];
    var _t = (0, react_1.useState)((0, db_js_1.todayEAT)()), fireDate = _t[0], setFireDate = _t[1];
    var _u = (0, react_1.useState)(""), fireReason = _u[0], setFireReason = _u[1];
    (0, react_1.useEffect)(function () {
        var onO = function () { return setOnline(true); };
        var onF = function () { return setOnline(false); };
        window.addEventListener("online", onO);
        window.addEventListener("offline", onF);
        var id = setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        _a = setPending;
                        return [4 /*yield*/, db_js_1.db.outbox.count()];
                    case 1:
                        _a.apply(void 0, [_d.sent()]);
                        setLastSynced(localStorage.getItem("last_synced"));
                        _b = setWorkers;
                        return [4 /*yield*/, db_js_1.db.workers.toArray()];
                    case 2:
                        _b.apply(void 0, [_d.sent()]);
                        _c = setDaily;
                        return [4 /*yield*/, db_js_1.db.daily.where("date").equals(selectedDate).toArray()];
                    case 3:
                        _c.apply(void 0, [_d.sent()]);
                        return [2 /*return*/];
                }
            });
        }); }, 1000);
        return function () { window.removeEventListener("online", onO); window.removeEventListener("offline", onF); clearInterval(id); };
    }, [selectedDate]);
    function saveFarmId(v) {
        return __awaiter(this, void 0, void 0, function () {
            var res, data, _i, _a, w, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        setFarmId(v);
                        localStorage.setItem("farm_id", v);
                        if (!(v && online)) return [3 /*break*/, 9];
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 8, , 9]);
                        return [4 /*yield*/, fetch("/api/farms/".concat(v, "/workers"))];
                    case 2:
                        res = _c.sent();
                        if (!res.ok) return [3 /*break*/, 7];
                        return [4 /*yield*/, res.json()];
                    case 3:
                        data = _c.sent();
                        _i = 0, _a = data.workers;
                        _c.label = 4;
                    case 4:
                        if (!(_i < _a.length)) return [3 /*break*/, 7];
                        w = _a[_i];
                        return [4 /*yield*/, db_js_1.db.workers.put(w)];
                    case 5:
                        _c.sent();
                        _c.label = 6;
                    case 6:
                        _i++;
                        return [3 /*break*/, 4];
                    case 7: return [3 /*break*/, 9];
                    case 8:
                        _b = _c.sent();
                        return [3 /*break*/, 9];
                    case 9: return [2 /*return*/];
                }
            });
        });
    }
    function registerWorker() {
        return __awaiter(this, void 0, void 0, function () {
            var norm, worker_id, worker, event_id, ev, empId, empEv;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        norm = (0, core_1.normalizeKePhone)(phone);
                        if (!norm.ok) {
                            setMsg("Invalid phone: ".concat(norm.reason));
                            return [2 /*return*/];
                        }
                        if (!fullName.trim()) {
                            setMsg("Name required");
                            return [2 /*return*/];
                        }
                        if (!consent) {
                            setMsg("Consent checkbox required (Decision 18)");
                            return [2 /*return*/];
                        }
                        if (!farmId) {
                            setMsg("Set Farm ID first");
                            return [2 /*return*/];
                        }
                        worker_id = crypto.randomUUID();
                        worker = { worker_id: worker_id, farm_id: farmId, full_name: fullName.trim(), phone_e164: norm.e164, status: "active", verified: false, consent_at: new Date().toISOString(), consent_author: "supervisor" };
                        return [4 /*yield*/, db_js_1.db.workers.put(worker)];
                    case 1:
                        _c.sent();
                        event_id = crypto.randomUUID();
                        ev = { event_id: event_id, farm_id: farmId, device_id: (_a = localStorage.getItem("device_id")) !== null && _a !== void 0 ? _a : crypto.randomUUID(), author: "supervisor", event_type: "worker.registered", payload: { worker_id: worker_id, full_name: worker.full_name, phone_e164: worker.phone_e164, consent: true, consent_at: worker.consent_at, consent_author: worker.consent_author }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "worker.registered" })];
                    case 2:
                        _c.sent();
                        empId = crypto.randomUUID();
                        return [4 /*yield*/, db_js_1.db.employment.add({ id: empId, worker_id: worker_id, farm_id: farmId, start_date: selectedDate, end_date: null })];
                    case 3:
                        _c.sent();
                        empEv = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: (_b = localStorage.getItem("device_id")) !== null && _b !== void 0 ? _b : "", author: "supervisor", event_type: "employment.started", payload: { worker_id: worker_id, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: empEv.event_id, farm_id: farmId, payload: empEv, createdAt: new Date().toISOString(), type: "employment.started" })];
                    case 4:
                        _c.sent();
                        setMsg("Queued ".concat(worker.full_name, " \u2014 verification SMS will send when online. Worker can be logged even offline (Decision 1)."));
                        setFullName("");
                        setPhone("");
                        setConsent(false);
                        return [2 /*return*/];
                }
            });
        });
    }
    function fireWorker() {
        return __awaiter(this, void 0, void 0, function () {
            var period, ev;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!hireWorkerId) {
                            setMsg("Select worker");
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, db_js_1.db.employment.where("worker_id").equals(hireWorkerId).filter(function (p) { return p.end_date === null; }).first()];
                    case 1:
                        period = _b.sent();
                        if (!period) {
                            setMsg("No active period");
                            return [2 /*return*/];
                        }
                        if (fireDate < period.start_date) {
                            setMsg("End date cannot be before start (inclusive)");
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, db_js_1.db.employment.update(period.id, { end_date: fireDate })];
                    case 2:
                        _b.sent();
                        ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: (_a = localStorage.getItem("device_id")) !== null && _a !== void 0 ? _a : "", author: "supervisor", event_type: "employment.ended", payload: { worker_id: hireWorkerId, end_date: fireDate, reason: fireReason }, business_date: fireDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.ended" })];
                    case 3:
                        _b.sent();
                        return [4 /*yield*/, db_js_1.db.workers.update(hireWorkerId, { status: "inactive" })];
                    case 4:
                        _b.sent();
                        setMsg("Fired \u2014 period closed ".concat(period.start_date, " to ").concat(fireDate, " inclusive. Rehiring opens new period on same profile."));
                        return [2 /*return*/];
                }
            });
        });
    }
    function rehireWorker() {
        return __awaiter(this, void 0, void 0, function () {
            var periods, lastEnd, id, ev;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!hireWorkerId) {
                            setMsg("Select worker");
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, db_js_1.db.employment.where("worker_id").equals(hireWorkerId).toArray()];
                    case 1:
                        periods = _b.sent();
                        if (periods.some(function (p) { return p.end_date === null; })) {
                            setMsg("Already active — cannot rehire");
                            return [2 /*return*/];
                        }
                        lastEnd = periods.filter(function (p) { return p.end_date; }).sort(function (a, b) { return a.end_date.localeCompare(b.end_date); }).pop();
                        if (lastEnd && selectedDate <= lastEnd.end_date) {
                            setMsg("Start must be after ".concat(lastEnd.end_date, " inclusive"));
                            return [2 /*return*/];
                        }
                        id = crypto.randomUUID();
                        return [4 /*yield*/, db_js_1.db.employment.add({ id: id, worker_id: hireWorkerId, farm_id: farmId, start_date: selectedDate, end_date: null })];
                    case 2:
                        _b.sent();
                        return [4 /*yield*/, db_js_1.db.workers.update(hireWorkerId, { status: "active" })];
                    case 3:
                        _b.sent();
                        ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: (_a = localStorage.getItem("device_id")) !== null && _a !== void 0 ? _a : "", author: "supervisor", event_type: "employment.started", payload: { worker_id: hireWorkerId, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.started" })];
                    case 4:
                        _b.sent();
                        setMsg("Rehired ".concat(hireWorkerId, " from ").concat(selectedDate, " inclusive \u2014 history preserved."));
                        return [2 /*return*/];
                }
            });
        });
    }
    // Daily kg handling: active workers for selected date
    var activeWorkers = workers.filter(function (w) {
        // For demo, if no employment periods, consider active if worker status active
        return w.status === "active";
    });
    function setKgForWorker(worker, kgStr) {
        return __awaiter(this, void 0, void 0, function () {
            var kg, existing, kgUnits, id, entry, ev;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        kg = Number(kgStr);
                        if (!(kgStr === "")) return [3 /*break*/, 3];
                        existing = daily.find(function (d) { return d.worker_id === worker.worker_id; });
                        if (!existing) return [3 /*break*/, 2];
                        return [4 /*yield*/, db_js_1.db.daily.delete(existing.id)];
                    case 1:
                        _b.sent();
                        _b.label = 2;
                    case 2: return [2 /*return*/];
                    case 3:
                        if (isNaN(kg) || kg < 0) {
                            setMsg("Invalid kg");
                            return [2 /*return*/];
                        }
                        if (kg > 60) {
                            setMsg("Warning: implausible ".concat(kg, "kg > 60kg max"));
                        }
                        kgUnits = Math.round(kg * 10);
                        id = "".concat(selectedDate, "-").concat(worker.worker_id);
                        entry = { id: id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits: kgUnits, present: true, isPluckingDay: isPluckingDay };
                        return [4 /*yield*/, db_js_1.db.daily.put(entry)];
                    case 4:
                        _b.sent();
                        ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: (_a = localStorage.getItem("device_id")) !== null && _a !== void 0 ? _a : "", author: "supervisor", event_type: "pluck.logged", payload: { worker_id: worker.worker_id, kg_units: kgUnits, present: true }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "pluck.logged" })];
                    case 5:
                        _b.sent();
                        return [2 /*return*/];
                }
            });
        });
    }
    function setAbsent(worker, absent) {
        return __awaiter(this, void 0, void 0, function () {
            var id, ev, entries, _i, entries_1, e;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!absent) return [3 /*break*/, 3];
                        id = "".concat(selectedDate, "-").concat(worker.worker_id, "-absent");
                        return [4 /*yield*/, db_js_1.db.daily.put({ id: id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits: 0, present: false, isPluckingDay: isPluckingDay })];
                    case 1:
                        _a.sent();
                        ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "pluck.logged", payload: { worker_id: worker.worker_id, present: false, absent: true }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "pluck.logged" })];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 7];
                    case 3:
                        entries = daily.filter(function (d) { return d.worker_id === worker.worker_id; });
                        _i = 0, entries_1 = entries;
                        _a.label = 4;
                    case 4:
                        if (!(_i < entries_1.length)) return [3 /*break*/, 7];
                        e = entries_1[_i];
                        return [4 /*yield*/, db_js_1.db.daily.delete(e.id)];
                    case 5:
                        _a.sent();
                        _a.label = 6;
                    case 6:
                        _i++;
                        return [3 /*break*/, 4];
                    case 7: return [2 /*return*/];
                }
            });
        });
    }
    function confirmDay() {
        return __awaiter(this, void 0, void 0, function () {
            var ev_1, totalKgUnits, pickerCount, ev;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!isPluckingDay) return [3 /*break*/, 2];
                        ev_1 = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "day.plucking_set", payload: { date: selectedDate, is_plucking_day: false, reason: noPluckReason }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev_1.event_id, farm_id: farmId, payload: ev_1, createdAt: new Date().toISOString(), type: "day.plucking_set" })];
                    case 1:
                        _a.sent();
                        setMsg("No-plucking day queued \u2014 Owner will get SMS: \"TEA ".concat(selectedDate, ": No plucking today - ").concat(noPluckReason, "\""));
                        return [2 /*return*/];
                    case 2:
                        totalKgUnits = daily.filter(function (d) { return d.present; }).reduce(function (s, d) { return s + d.kgUnits; }, 0);
                        pickerCount = daily.filter(function (d) { return d.present; }).length;
                        ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "day.confirmed", payload: { date: selectedDate, totalKgUnits: totalKgUnits, pickerCount: pickerCount }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "day.confirmed" })];
                    case 3:
                        _a.sent();
                        setMsg("Confirmed ".concat(selectedDate, ": ").concat(totalKgUnits / 10, "kg ").concat(pickerCount, " pickers \u2014 Owner daily SMS will send when synced."));
                        return [2 /*return*/];
                }
            });
        });
    }
    function submitSaturday() {
        return __awaiter(this, void 0, void 0, function () {
            var ev;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "week.submitted", payload: {}, business_date: selectedDate, client_timestamp: new Date().toISOString() };
                        return [4 /*yield*/, db_js_1.db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "week.submitted" })];
                    case 1:
                        _a.sent();
                        setMsg("Final Saturday submitted for ".concat(selectedDate, " \u2014 if offline it shows \u201Cpending upload\u201D. Server will lock week and reminder at 14:30 says \u201CSaturday entry not received by server, please connect to sync.\u201D"));
                        return [2 /*return*/];
                }
            });
        });
    }
    function syncNow() {
        return __awaiter(this, void 0, void 0, function () {
            var all, events, res, _a, data, _i, all_1, o, e_1;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, db_js_1.db.outbox.toArray()];
                    case 1:
                        all = _b.sent();
                        if (!all.length) {
                            setMsg("Nothing to sync");
                            return [2 /*return*/];
                        }
                        _b.label = 2;
                    case 2:
                        _b.trys.push([2, 11, , 12]);
                        events = all.map(function (o) { return o.payload; });
                        return [4 /*yield*/, fetch("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: events }) })];
                    case 3:
                        res = _b.sent();
                        if (!!res.ok) return [3 /*break*/, 5];
                        _a = Error.bind;
                        return [4 /*yield*/, res.text()];
                    case 4: throw new (_a.apply(Error, [void 0, _b.sent()]))();
                    case 5: return [4 /*yield*/, res.json()];
                    case 6:
                        data = _b.sent();
                        _i = 0, all_1 = all;
                        _b.label = 7;
                    case 7:
                        if (!(_i < all_1.length)) return [3 /*break*/, 10];
                        o = all_1[_i];
                        return [4 /*yield*/, db_js_1.db.outbox.delete(o.event_id)];
                    case 8:
                        _b.sent();
                        _b.label = 9;
                    case 9:
                        _i++;
                        return [3 /*break*/, 7];
                    case 10:
                        localStorage.setItem("last_synced", new Date().toISOString());
                        setMsg("Sync ok \u2014 accepted ".concat(data.accepted, ", dups ").concat(data.duplicates, ", flagged ").concat(data.flaggedAsCorrection, " (locked week \u2192 next-week adjustment), conflicts ").concat(data.conflicts));
                        return [3 /*break*/, 12];
                    case 11:
                        e_1 = _b.sent();
                        setMsg("Sync failed: ".concat(String(e_1), " \u2014 will retry. Late events for locked week are stored as correction requests."));
                        return [3 /*break*/, 12];
                    case 12: return [2 /*return*/];
                }
            });
        });
    }
    var totalKgUnits = daily.filter(function (d) { return d.present; }).reduce(function (s, d) { return s + d.kgUnits; }, 0);
    var totalKes = (0, core_1.calculateWorkerWeekPayKes)(daily.filter(function (d) { return d.present; }).map(function (d) { return ({ kgUnits: d.kgUnits, rateCentsPerKg: 900 }); }));
    return ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("header", { style: { background: "#1B5E20", color: "white", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [(0, jsx_runtime_1.jsx)("h1", { style: { margin: 0, fontSize: 18 }, children: "Tea Ledger \u2014 Supervisor" }), (0, jsx_runtime_1.jsxs)("span", { style: { fontSize: 12 }, children: [online ? "Online" : "Offline", " \u00B7 Farm: ", (0, jsx_runtime_1.jsx)("input", { value: farmId, onChange: function (e) { return saveFarmId(e.target.value); }, placeholder: "UUID", style: { width: 180, fontSize: 12, padding: 4 } })] })] }), (0, jsx_runtime_1.jsxs)("div", { style: { background: "#FFF9C4", border: "1px solid #FBC02D", padding: 8, margin: 12, borderRadius: 8, fontSize: 13 }, children: ["DEMO DATA \u2014 ", online ? "connected" : "offline, will sync when online", " \u00B7 ", (0, jsx_runtime_1.jsxs)("strong", { style: { color: "#FF6F00" }, children: ["Pending sync: ", pending] }), " ", lastSynced ? "\u00B7 Last synced ".concat(new Date(lastSynced).toLocaleString()) : "", " ", pending > 0 && (0, jsx_runtime_1.jsx)("em", { children: " \u00B7 \u201Cpending upload\u201D if Saturday not yet synced" })] }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 8, margin: 12 }, children: [(0, jsx_runtime_1.jsx)("button", { onClick: function () { return setTab("workers"); }, style: { flex: 1, background: tab === "workers" ? "#2E7D32" : "white", color: tab === "workers" ? "white" : "#2E7D32", border: "2px solid #2E7D32" }, children: "1. Hire/Fire Workers" }), (0, jsx_runtime_1.jsx)("button", { onClick: function () { return setTab("daily"); }, style: { flex: 1, background: tab === "daily" ? "#2E7D32" : "white", color: tab === "daily" ? "white" : "#2E7D32", border: "2px solid #2E7D32" }, children: "2. Daily kg per worker" })] }), tab === "workers" && ((0, jsx_runtime_1.jsxs)("div", { style: { margin: 12 }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16, marginBottom: 12 }, children: [(0, jsx_runtime_1.jsx)("h2", { style: { marginTop: 0 }, children: "Register new worker (offline OK, verification later)" }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" }, children: [(0, jsx_runtime_1.jsx)("input", { placeholder: "Full name e.g. Kiptoo", value: fullName, onChange: function (e) { return setFullName(e.target.value); }, style: { flex: 1, padding: 12, fontSize: 16, borderRadius: 10, border: "2px solid #9E9E9E" } }), (0, jsx_runtime_1.jsx)("input", { placeholder: "Phone 07... or +254...", value: phone, onChange: function (e) { return setPhone(e.target.value); }, style: { flex: 1, padding: 12, fontSize: 16, borderRadius: 10, border: "2px solid #9E9E9E" } })] }), (0, jsx_runtime_1.jsxs)("label", { style: { display: "flex", gap: 8, marginTop: 12, fontSize: 14 }, children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: consent, onChange: function (e) { return setConsent(e.target.checked); } }), " I confirm worker agreed to SMS receipts and storage of name/number (Decision 18) \u2014 checkbox with timestamp/author"] }), (0, jsx_runtime_1.jsx)("button", { onClick: registerWorker, style: { marginTop: 12, background: "#2E7D32", color: "white", padding: "14px 18px", borderRadius: 12, border: 0, minHeight: 52, fontSize: 16 }, children: "Add worker \u2014 large button" }), (0, jsx_runtime_1.jsx)("p", { style: { fontSize: 12, color: "#555" }, children: "Number reuse allowed only after previous holder inactive + re-verification + Admin notified (Decision 17). Inclusive dates." })] }), (0, jsx_runtime_1.jsxs)("div", { style: { background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16, marginBottom: 12 }, children: [(0, jsx_runtime_1.jsxs)("h3", { children: ["Active workers (", workers.length, ") \u2014 tap to hire/fire"] }), workers.length === 0 && (0, jsx_runtime_1.jsx)("p", { style: { fontSize: 13, color: "#777" }, children: "No workers yet \u2014 register Kiptoo above, then log his kg in Daily tab." }), workers.map(function (w) { return ((0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #E0E0E0", borderRadius: 10, padding: 10, marginBottom: 8 }, children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("strong", { children: w.full_name }), " \u00B7 ", w.phone_e164, " \u00B7 ", w.status, " \u00B7 ", w.verified ? "verified" : "unverified — warning only, no receipt SMS until verified (Decision 3)"] }), (0, jsx_runtime_1.jsx)("button", { onClick: function () { return setHireWorkerId(w.worker_id); }, style: { background: hireWorkerId === w.worker_id ? "#FF6F00" : "white", color: hireWorkerId === w.worker_id ? "white" : "#2E7D32", border: "2px solid #2E7D32", padding: 8, borderRadius: 8 }, children: "Select" })] }, w.worker_id)); }), hireWorkerId && ((0, jsx_runtime_1.jsxs)("div", { style: { marginTop: 12, borderTop: "1px solid #EEE", paddingTop: 12 }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { fontSize: 13 }, children: ["Selected: ", (_b = workers.find(function (w) { return w.worker_id === hireWorkerId; })) === null || _b === void 0 ? void 0 : _b.full_name, " \u2014 inclusive employment periods"] }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }, children: [(0, jsx_runtime_1.jsx)("input", { type: "date", value: fireDate, onChange: function (e) { return setFireDate(e.target.value); }, style: { padding: 8 } }), (0, jsx_runtime_1.jsx)("input", { placeholder: "Reason e.g. quit", value: fireReason, onChange: function (e) { return setFireReason(e.target.value); }, style: { flex: 1, padding: 8 } }), (0, jsx_runtime_1.jsxs)("button", { onClick: fireWorker, style: { background: "#C62828", color: "white", padding: 10, borderRadius: 8, border: 0 }, children: ["Fire \u2014 close period ", fireDate, " inclusive"] }), (0, jsx_runtime_1.jsxs)("button", { onClick: rehireWorker, style: { background: "#2E7D32", color: "white", padding: 10, borderRadius: 8, border: 0 }, children: ["Rehire from ", selectedDate, " inclusive"] })] })] }))] })] })), tab === "daily" && ((0, jsx_runtime_1.jsxs)("div", { style: { margin: 12 }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16, marginBottom: 12 }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }, children: [(0, jsx_runtime_1.jsxs)("label", { children: ["Date: ", (0, jsx_runtime_1.jsx)("input", { type: "date", value: selectedDate, onChange: function (e) { return setSelectedDate(e.target.value); }, style: { padding: 8, fontSize: 16 } })] }), (0, jsx_runtime_1.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: !isPluckingDay, onChange: function (e) { return setIsPluckingDay(!e.target.checked); } }), " No plucking today"] }), !isPluckingDay && (0, jsx_runtime_1.jsx)("input", { placeholder: "Reason e.g. no ready leaf", value: noPluckReason, onChange: function (e) { return setNoPluckReason(e.target.value); }, style: { flex: 1, padding: 8 } })] }), !isPluckingDay && (0, jsx_runtime_1.jsxs)("p", { style: { fontSize: 12, color: "#555" }, children: ["Owner will get SMS: \u201CTEA ", selectedDate, ": No plucking today - ", noPluckReason || "...", "\u201D \u2014 not counted as absence"] }), isPluckingDay && activeWorkers.length === 0 && (0, jsx_runtime_1.jsxs)("p", { style: { color: "#C62828" }, children: ["No active workers \u2014 register in Workers tab first. Employment inclusive check: start \u2264 ", selectedDate, " \u2264 end"] })] }), isPluckingDay && activeWorkers.map(function (w) {
                        var entry = daily.find(function (d) { return d.worker_id === w.worker_id; });
                        var kgDisplay = entry && entry.present ? String(entry.kgUnits / 10) : "";
                        var isAbsent = daily.some(function (d) { return d.worker_id === w.worker_id && !d.present; });
                        return ((0, jsx_runtime_1.jsxs)("div", { style: { background: "white", border: "2px solid #9CCC65", borderRadius: 12, padding: 12, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { fontWeight: 700, flex: 1 }, children: [w.full_name, (0, jsx_runtime_1.jsxs)("div", { style: { fontWeight: 400, fontSize: 12, color: "#555" }, children: [w.phone_e164, " \u00B7 tap to enter kg"] })] }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [(0, jsx_runtime_1.jsxs)("label", { style: { fontSize: 12 }, children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: isAbsent, onChange: function (e) { return setAbsent(w, e.target.checked); } }), " Absent (A)"] }), (0, jsx_runtime_1.jsx)("input", { inputMode: "numeric", placeholder: "kg e.g. 40", value: kgDisplay, onChange: function (e) { return setKgForWorker(w, e.target.value); }, style: { width: 110, padding: 12, fontSize: 18, border: "2px solid #1B5E20", borderRadius: 10, background: "#FFFDE7" }, disabled: isAbsent }), (0, jsx_runtime_1.jsx)("span", { style: { fontSize: 12, color: "#1B5E20" }, children: entry && entry.present ? "= KES ".concat(Math.round(entry.kgUnits / 10 * 9), " (rate 9)") : "" })] })] }, w.worker_id));
                    }), (0, jsx_runtime_1.jsxs)("div", { style: { background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16 }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { fontWeight: 700 }, children: ["Total: ", totalKgUnits / 10, "kg \u00B7 ", activeWorkers.length, " workers \u00B7 ", daily.filter(function (d) { return d.present; }).length, " pickers today \u00B7 Est total KES ", totalKes, " (auto calculates per date rate)"] }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }, children: [(0, jsx_runtime_1.jsx)("button", { onClick: confirmDay, style: { background: "#2E7D32", color: "white", padding: 14, borderRadius: 12, border: 0, minHeight: 52, flex: 1 }, children: "Confirm day" }), (0, jsx_runtime_1.jsx)("button", { onClick: submitSaturday, style: { background: "#FF6F00", color: "white", padding: 14, borderRadius: 12, border: 0, minHeight: 52, flex: 1 }, children: "Submit FINAL Saturday \u2014 locks week Mon-Sat Africa/Nairobi" })] }), (0, jsx_runtime_1.jsx)("p", { style: { fontSize: 12, color: "#555" }, children: msg || "Tip: With airplane ON you can register Kiptoo, log 40kg, confirm — verification completes after reconnecting (Decision 1). Daily SMS to Owner = highest kg first +N more, weekly receipt tokens kg/A/NP fit 2 segments." }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [(0, jsx_runtime_1.jsxs)("button", { onClick: syncNow, style: { background: "#FF6F00", color: "white", padding: 14, borderRadius: 12, border: 0, minHeight: 52, flex: 1 }, children: ["Sync now (", pending, ") \u2014 relative /api, no localhost"] }), (0, jsx_runtime_1.jsx)("button", { onClick: function () { localStorage.clear(); indexedDB.deleteDatabase("tea-farm-ledger"); location.reload(); }, style: { background: "white", color: "#C62828", border: "2px solid #C62828", padding: 14, borderRadius: 12, minHeight: 52 }, children: "Clear demo" })] })] })] }))] }));
}

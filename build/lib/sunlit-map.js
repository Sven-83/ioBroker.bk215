"use strict";
/**
 * Turns cloud responses into flat values for ioBroker states. Pure functions,
 * tolerant of missing fields (the API is undocumented and differs between
 * firmware/app versions): a value that is not there becomes null.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.num = num;
exports.batteries = batteries;
exports.solarFromBattery = solarFromBattery;
exports.liveValues = liveValues;
exports.buckets = buckets;
exports.periodTotals = periodTotals;
exports.dayCurve = dayCurve;
exports.batteryEta = batteryEta;
function num(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
        return v;
    }
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
        return Number(v);
    }
    return null;
}
function obj(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
/** First string among the values, else the fallback */
function str(fallback, ...values) {
    for (const v of values) {
        if (typeof v === "string" && v) {
            return v;
        }
    }
    return fallback;
}
/**
 * First number found under any of the keys
 *
 * @param o
 * @param keys
 */
function pick(o, ...keys) {
    for (const k of keys) {
        const n = num(o[k]);
        if (n !== null) {
            return n;
        }
    }
    return null;
}
/**
 * Battery devices of the device list (type ENERGY_STORAGE_BATTERY)
 *
 * @param devices
 */
function batteries(devices) {
    return devices.filter((d) => str("", d.deviceType) === "ENERGY_STORAGE_BATTERY");
}
/**
 * PV power into the battery: MPPT 1/2 of the head unit plus MPPT of extension modules
 *
 * @param stats
 */
function solarFromBattery(stats) {
    let sum = 0;
    let seen = false;
    for (const [k, v] of Object.entries(stats)) {
        if (/^battery\d*Mppt\d+InPower$/i.test(k)) {
            const n = num(v);
            if (n !== null) {
                sum += n;
                seen = true;
            }
        }
    }
    return seen ? sum : null;
}
/**
 * @param index   content of /v1.5/space/index
 * @param battery merged device-list entry + device statistics of the battery (or {})
 */
function liveValues(index, battery) {
    const b = obj(index.battery);
    const inv = obj(index.inverter);
    const meter = obj(index.eleMeter);
    const today = obj(index.today);
    const chargeW = pick(b, "inputPower") ?? pick(battery, "inputPowerTotal", "inputPower");
    const dischargeW = pick(b, "outputPower") ?? pick(battery, "outputPowerTotal", "outputPower");
    const batteryW = chargeW === null && dischargeW === null
        ? null
        : (chargeW ?? 0) - (dischargeW ?? 0);
    return {
        soc: pick(b, "batteryLevel") ?? pick(battery, "batterySoc", "batteryLevel"),
        batteryChargeW: chargeW,
        batteryDischargeW: dischargeW,
        batteryW,
        solarW: solarFromBattery(battery),
        inverterW: pick(inv, "currentPower"),
        meterW: pick(meter, "totalAcPower"),
        homeW: pick(today, "homePower"),
        chargeRemainingMin: pick(b, "chargingRemaining") ?? pick(battery, "chargeRemaining"),
        dischargeRemainingMin: pick(b, "dischargingRemaining") ?? pick(battery, "dischargeRemaining"),
        todaySolarKwh: pick(today, "yield"),
        todayEarning: pick(obj(today.earning), "earnings", "amount") ?? pick(today, "earning"),
        currency: str("EUR", today.currency, obj(today.earning).currency),
        batteryModules: pick(b, "batteryCount") ?? pick(battery, "deviceCount"),
        batteryStatus: str("", b.deviceStatus, battery.status),
        batteryFault: b.fault === true || battery.fault === true,
    };
}
/**
 * Numeric fields of a list item, the key as number
 *
 * @param item
 */
function bucket(item) {
    const o = obj(item);
    const key = num(o.key);
    if (key === null) {
        return null;
    }
    const out = { key };
    for (const [k, v] of Object.entries(o)) {
        const n = num(v);
        if (k !== "key" && n !== null) {
            out[k] = n;
        }
    }
    return out;
}
/**
 * One list per period from dynamic/energy and dynamic/earning: per bucket key
 * the energy distribution plus generation, earnings and charging energy.
 *
 * @param energy
 * @param earning
 */
function buckets(energy, earning) {
    const byKey = new Map();
    const merge = (list, rename) => {
        if (!Array.isArray(list)) {
            return;
        }
        for (const it of list) {
            const b = bucket(it);
            if (!b) {
                continue;
            }
            const cur = byKey.get(b.key) ?? { key: b.key };
            for (const [k, v] of Object.entries(b)) {
                if (k !== "key") {
                    cur[rename?.[k] ?? k] = v;
                }
            }
            byKey.set(b.key, cur);
        }
    };
    merge(energy.energyDistributions);
    merge(earning.powerEarningsList, {
        totalPowerGeneration: "generation",
        totalEarnings: "earnings",
    });
    merge(earning.chargingEnergyList);
    return [...byKey.values()].sort((a, b) => a.key - b.key);
}
/**
 * Totals of a period: yield, consumption, self-use and self-sufficiency (0..1)
 *
 * @param energy
 * @param earning
 */
function periodTotals(energy, earning) {
    return {
        yieldKwh: pick(energy, "totalYield") ?? pick(earning, "totalPowerGeneration"),
        consumptionKwh: pick(energy, "totalConsumption"),
        fromPvKwh: pick(energy, "totalEnergyFromPv"),
        selfUseRate: pick(energy, "totalSelfUseRate"),
        selfSufficiencyRate: pick(energy, "selfSufficiencyRate"),
        earnings: pick(obj(earning.totalEarnings), "earnings", "amount") ??
            pick(earning, "totalEarnings"),
    };
}
/**
 * Intraday curve from dynamic/power and (optional) batteryIO, joined on the time key
 *
 * @param power
 * @param batteryIo
 */
function dayCurve(power, batteryIo) {
    const byT = new Map();
    const list = Array.isArray(power.powerList) ? power.powerList : [];
    for (const it of list) {
        const o = obj(it);
        const t = typeof o.key === "string" ? o.key : null;
        if (t) {
            byT.set(t, { t, solarW: num(o.power), homeW: num(o.homePower) });
        }
    }
    const io = Array.isArray(batteryIo)
        ? batteryIo
        : Array.isArray(obj(batteryIo).list)
            ? obj(batteryIo).list
            : [];
    for (const it of io) {
        const o = obj(it);
        const t = typeof o.key === "string" ? o.key : null;
        if (!t) {
            continue;
        }
        const p = byT.get(t) ?? { t, solarW: null, homeW: null };
        p.batteryInW = num(o.batteryInputPower);
        p.batteryOutW = num(o.batteryOutputPower);
        byT.set(t, p);
    }
    return [...byT.values()].sort((a, b) => a.t.localeCompare(b.t));
}
/**
 * When the battery will be full or empty, as epoch ms (null when it neither
 * charges nor discharges noticeably). Prefers the minutes the cloud reports;
 * otherwise estimates from SoC, capacity and current power.
 *
 * @param v
 * @param capacityKwh
 * @param minSoc
 * @param now
 */
function batteryEta(v, capacityKwh, minSoc, now) {
    const w = v.batteryW ?? 0;
    const res = { fullAt: null, emptyAt: null };
    if (w > 20) {
        const min = v.chargeRemainingMin !== null && v.chargeRemainingMin > 0
            ? v.chargeRemainingMin
            : v.soc !== null && capacityKwh > 0
                ? (((100 - v.soc) / 100) * capacityKwh * 1000 * 60) / w
                : null;
        res.fullAt = min !== null && min < 48 * 60 ? now + min * 60_000 : null;
    }
    else if (w < -20) {
        const min = v.dischargeRemainingMin !== null && v.dischargeRemainingMin > 0
            ? v.dischargeRemainingMin
            : v.soc !== null && capacityKwh > 0
                ? (((v.soc - minSoc) / 100) * capacityKwh * 1000 * 60) / -w
                : null;
        res.emptyAt =
            min !== null && min > 0 && min < 48 * 60 ? now + min * 60_000 : null;
    }
    return res;
}

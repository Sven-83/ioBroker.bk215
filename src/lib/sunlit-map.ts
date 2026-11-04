/**
 * Turns cloud responses into flat values for ioBroker states. Pure functions,
 * tolerant of missing fields (the API is undocumented and differs between
 * firmware/app versions): a value that is not there becomes null.
 */

type Json = Record<string, unknown>;

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

/**
 * First string among the values, else the fallback
 *
 * @param fallback
 * @param values
 */
function str(fallback: string, ...values: unknown[]): string {
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
function pick(o: Json, ...keys: string[]): number | null {
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== null) {
      return n;
    }
  }
  return null;
}

export interface LiveValues {
  soc: number | null;
  /** power into the battery (charging), W */
  batteryChargeW: number | null;
  /** power out of the battery (discharging), W */
  batteryDischargeW: number | null;
  /** + charging / - discharging, W */
  batteryW: number | null;
  solarW: number | null;
  inverterW: number | null;
  /** grid power seen by the meter linked in the app (+ import / - export), W */
  meterW: number | null;
  homeW: number | null;
  chargeRemainingMin: number | null;
  dischargeRemainingMin: number | null;
  /** grid energy from the meter linked in the app, kWh */
  gridBuyTodayKwh: number | null;
  gridRetTodayKwh: number | null;
  gridBuyTotalKwh: number | null;
  gridRetTotalKwh: number | null;
  todaySolarKwh: number | null;
  todayEarning: number | null;
  currency: string;
  batteryModules: number | null;
  batteryStatus: string;
  batteryFault: boolean;
}

/**
 * Battery devices of the device list (type ENERGY_STORAGE_BATTERY)
 *
 * @param devices
 */
export function batteries(devices: Json[]): Json[] {
  return devices.filter(
    (d) => str("", d.deviceType) === "ENERGY_STORAGE_BATTERY",
  );
}

/**
 * PV power into the battery: MPPT 1/2 of the head unit plus MPPT of extension modules
 *
 * @param stats
 */
export function solarFromBattery(stats: Json): number | null {
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

export interface Mppt {
  /** e.g. "batteryMppt1Data" (head unit) or "battery2MpptData" (module 2) */
  id: string;
  /** name given in the app */
  name: string;
  w: number | null;
  v: number | null;
  a: number | null;
}

/**
 * The solar inputs one by one, with the names given in the app
 *
 * @param stats
 */
export function mpptList(stats: Json): Mppt[] {
  const out: Mppt[] = [];
  for (const [k, v] of Object.entries(stats)) {
    if (!/^battery\d*Mppt\d*Data$/i.test(k) || !v || typeof v !== "object") {
      continue;
    }
    const o = v as Json;
    out.push({
      id: k,
      name: str(k, o.mpptName),
      w: num(o.batteryMpptInPower),
      v: num(o.batteryMpptInVol),
      a: num(o.batteryMpptInCur),
    });
  }
  // head unit first, then the modules in order
  const rank = (id: string): number => {
    const m = /^battery(\d*)Mppt(\d*)Data$/i.exec(id);
    return m ? (m[1] ? Number(m[1]) * 10 : 0) + (Number(m[2]) || 0) : 999;
  };
  return out.sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Charge level of every battery: the main unit's own pack (batterySoc, name "BK215") first,
 * then the extension modules (battery1Soc … battery7Soc, name "B215 n"), present ones only
 *
 * @param stats
 */
export function moduleSocs(
  stats: Json,
): { module: number; name: string; soc: number }[] {
  const out: { module: number; name: string; soc: number }[] = [];
  const main = num(stats.batterySoc);
  if (main !== null) {
    out.push({ module: 1, name: "BK215", soc: main });
  }
  for (let i = 1; i <= 7; i++) {
    const soc = num(stats[`battery${i}Soc`]);
    if (soc !== null) {
      out.push({ module: out.length + 1, name: `B215 ${i}`, soc });
    }
  }
  return out;
}

/**
 * Charge limits set in the app (device list entry, batteryChargingBoxDto):
 * minSoc = discharge limit (batPackParam.allowMinSoc, else evDodMinSoc), maxSoc = charge limit (chgDodMaxSoc)
 *
 * @param battery merged device-list entry of the battery
 */
export function socLimits(battery: Json): {
  minSoc: number | null;
  maxSoc: number | null;
} {
  const box = obj(battery.batteryChargingBoxDto);
  return {
    minSoc:
      pick(obj(box.batPackParam), "allowMinSoc") ?? pick(box, "evDodMinSoc"),
    maxSoc: pick(box, "chgDodMaxSoc"),
  };
}

/**
 * Device list as returned by /v1.2/device/list: a page object ({content: [...]})
 * or, in older answers, the array itself.
 *
 * @param answer
 */
export function deviceArray(answer: unknown): Json[] {
  if (Array.isArray(answer)) {
    return answer.filter((x) => x && typeof x === "object") as Json[];
  }
  const c = obj(answer).content;
  return Array.isArray(c)
    ? (c.filter((x) => x && typeof x === "object") as Json[])
    : [];
}

/**
 * The cloud reports the remaining time in hours (35.8 = 35 h 49 min)
 *
 * @param h
 */
function hoursToMin(h: number | null): number | null {
  return h === null ? null : Math.round(h * 60);
}

/**
 * @param index   content of /v1.5/space/index
 * @param battery merged device-list entry + device statistics of the battery (or {})
 * @param meter   device-list entry of the grid meter (or {})
 * @param meterDevice
 */
export function liveValues(
  index: Json,
  battery: Json,
  meterDevice: Json = {},
): LiveValues {
  const b = obj(index.battery);
  const inv = obj(index.inverter);
  const meter = obj(index.eleMeter);
  const today = obj(index.today);

  const chargeW =
    pick(b, "inputPower") ?? pick(battery, "inputPowerTotal", "inputPower");
  const dischargeW =
    pick(b, "outputPower") ?? pick(battery, "outputPowerTotal", "outputPower");
  const batteryW =
    chargeW === null && dischargeW === null
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
    chargeRemainingMin: hoursToMin(
      pick(b, "chargingRemaining") ?? pick(battery, "chargeRemaining"),
    ),
    dischargeRemainingMin: hoursToMin(
      pick(b, "dischargingRemaining") ?? pick(battery, "dischargeRemaining"),
    ),
    gridBuyTodayKwh: pick(meterDevice, "dailyBuyEnergy"),
    gridRetTodayKwh: pick(meterDevice, "dailyRetEnergy"),
    gridBuyTotalKwh: pick(meterDevice, "totalBuyEnergy"),
    gridRetTotalKwh: pick(meterDevice, "totalRetEnergy"),
    todaySolarKwh: pick(today, "yield"),
    todayEarning:
      pick(obj(today.earning), "earnings", "amount") ?? pick(today, "earning"),
    currency: str("EUR", today.currency, obj(today.earning).currency),
    batteryModules: pick(b, "batteryCount") ?? pick(battery, "deviceCount"),
    batteryStatus: str("", b.deviceStatus, battery.status),
    batteryFault: b.fault === true || battery.fault === true,
  };
}

export interface Bucket {
  /** day of month, month of year or year, depending on the request */
  key: number;
  [field: string]: number;
}

/**
 * Numeric fields of a list item, the key as number
 *
 * @param item
 */
function bucket(item: unknown): Bucket | null {
  const o = obj(item);
  const key = num(o.key);
  if (key === null) {
    return null;
  }
  const out: Bucket = { key };
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
export function buckets(energy: Json, earning: Json): Bucket[] {
  const byKey = new Map<number, Bucket>();
  const merge = (list: unknown, rename?: Record<string, string>): void => {
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
export function periodTotals(
  energy: Json,
  earning: Json,
): Record<string, number | null> {
  return {
    yieldKwh:
      pick(energy, "totalYield") ?? pick(earning, "totalPowerGeneration"),
    consumptionKwh: pick(energy, "totalConsumption"),
    fromPvKwh: pick(energy, "totalEnergyFromPv"),
    selfUseRate: pick(energy, "totalSelfUseRate"),
    selfSufficiencyRate: pick(energy, "selfSufficiencyRate"),
    earnings:
      pick(obj(earning.totalEarnings), "earnings", "amount") ??
      pick(earning, "totalEarnings"),
  };
}

export interface CurvePoint {
  /** "HH:MM" */
  t: string;
  solarW: number | null;
  homeW: number | null;
  batteryInW?: number | null;
  batteryOutW?: number | null;
}

/**
 * Intraday curve from dynamic/power and (optional) batteryIO, joined on the time key
 *
 * @param power
 * @param batteryIo
 */
export function dayCurve(power: Json, batteryIo: unknown): CurvePoint[] {
  const byT = new Map<string, CurvePoint>();
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
      ? (obj(batteryIo).list as unknown[])
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
export function batteryEta(
  v: Pick<
    LiveValues,
    "soc" | "batteryW" | "chargeRemainingMin" | "dischargeRemainingMin"
  >,
  capacityKwh: number,
  minSoc: number,
  now: number,
): { fullAt: number | null; emptyAt: number | null } {
  const w = v.batteryW ?? 0;
  const res = { fullAt: null as number | null, emptyAt: null as number | null };
  if (w > 20) {
    const min =
      v.chargeRemainingMin !== null && v.chargeRemainingMin > 0
        ? v.chargeRemainingMin
        : v.soc !== null && capacityKwh > 0
          ? (((100 - v.soc) / 100) * capacityKwh * 1000 * 60) / w
          : null;
    res.fullAt = min !== null && min < 48 * 60 ? now + min * 60_000 : null;
  } else if (w < -20) {
    const min =
      v.dischargeRemainingMin !== null && v.dischargeRemainingMin > 0
        ? v.dischargeRemainingMin
        : v.soc !== null && capacityKwh > 0
          ? (((v.soc - minSoc) / 100) * capacityKwh * 1000 * 60) / -w
          : null;
    res.emptyAt =
      min !== null && min > 0 && min < 48 * 60 ? now + min * 60_000 : null;
  }
  return res;
}

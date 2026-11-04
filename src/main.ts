/*
 * BK215 / SunEnergyXT adapter for ioBroker — cloud reader.
 *
 * Reads battery, solar, inverter and energy statistics from the SunEnergyXT
 * (formerly Sunlit Solar) cloud with the app login. Read-only: the adapter
 * never changes anything on the battery, the app stays in charge (no local
 * mode needed).
 *
 * Two loops:
 *   - live  (default 60 s):  space index + battery statistics → live.*
 *   - stats (default 15 min): energy/earning per year, month, day, intraday curve → stats.*, today.*
 */

import * as utils from "@iobroker/adapter-core";

import { redact, redactJson } from "./lib/redact";
import { CloudAuthError, SunlitCloud } from "./lib/sunlit-cloud";
import {
  batteries,
  batteryEta,
  deviceArray,
  buckets,
  dayCurve,
  liveValues,
  num,
  periodTotals,
} from "./lib/sunlit-map";

interface AdapterConfig {
  cloudEmail: string;
  cloudPassword: string;
  familyId: number;
  pollLiveS: number;
  pollStatsMin: number;
  batteryCapacityKwh: number;
  minSoc: number;
}

/** capacity of one BK215 / B215 module */
const MODULE_KWH = 2.15;
const MAX_BACKOFF_MS = 10 * 60_000;
const SENSITIVE = [
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "password",
  "authorization",
  "Authorization",
  "account",
  "email",
  "mobile",
  "phone",
];

type Json = Record<string, unknown>;

interface StateDef {
  name: string;
  type: ioBroker.CommonType;
  role: string;
  unit?: string;
}

const STATES: Record<string, StateDef> = {
  "info.lastSync": {
    name: "Last successful cloud read",
    type: "number",
    role: "value.time",
  },
  "info.lastError": { name: "Last cloud error", type: "string", role: "text" },
  "info.familyId": { name: "Space / family id", type: "number", role: "value" },
  "live.soc": {
    name: "Battery level",
    type: "number",
    role: "value.battery",
    unit: "%",
  },
  "live.batteryW": {
    name: "Battery power (+ charging / - discharging)",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.batteryChargeW": {
    name: "Battery charging power",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.batteryDischargeW": {
    name: "Battery discharging power",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.solarW": {
    name: "Solar power (MPPT inputs)",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.inverterW": {
    name: "Inverter output",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.meterW": {
    name: "Grid power from the meter in the app (+ import / - export)",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.homeW": {
    name: "Home consumption",
    type: "number",
    role: "value.power",
    unit: "W",
  },
  "live.chargeRemainingMin": {
    name: "Minutes until full (cloud)",
    type: "number",
    role: "value",
    unit: "min",
  },
  "live.dischargeRemainingMin": {
    name: "Minutes until empty (cloud)",
    type: "number",
    role: "value",
    unit: "min",
  },
  "live.fullAt": {
    name: "Expected full at",
    type: "number",
    role: "value.time",
  },
  "live.emptyAt": {
    name: "Expected empty at",
    type: "number",
    role: "value.time",
  },
  "live.batteryModules": {
    name: "Battery modules",
    type: "number",
    role: "value",
  },
  "live.batteryStatus": {
    name: "Battery status",
    type: "string",
    role: "text",
  },
  "live.batteryFault": {
    name: "Battery fault",
    type: "boolean",
    role: "indicator.maintenance",
  },
  "live.capacityKwh": {
    name: "Battery capacity used for estimates",
    type: "number",
    role: "value",
    unit: "kWh",
  },
  "today.gridBuyKwh": {
    name: "Grid import today (meter in the app)",
    type: "number",
    role: "value.energy.consumed",
    unit: "kWh",
  },
  "today.gridRetKwh": {
    name: "Grid export today (meter in the app)",
    type: "number",
    role: "value.energy.produced",
    unit: "kWh",
  },
  "total.gridBuyKwh": {
    name: "Grid import total (meter in the app)",
    type: "number",
    role: "value.energy.consumed",
    unit: "kWh",
  },
  "total.gridRetKwh": {
    name: "Grid export total (meter in the app)",
    type: "number",
    role: "value.energy.produced",
    unit: "kWh",
  },
  "today.solarKwh": {
    name: "Solar yield today",
    type: "number",
    role: "value.energy",
    unit: "kWh",
  },
  "today.earning": { name: "Earnings today", type: "number", role: "value" },
  "today.currency": { name: "Currency", type: "string", role: "text" },
  "today.curve": {
    name: "Intraday curve [{t, solarW, homeW, batteryInW, batteryOutW}]",
    type: "string",
    role: "json",
  },
  "stats.total": {
    name: "Lifetime totals {yieldKwh, earnings, ...}",
    type: "string",
    role: "json",
  },
  "stats.years": {
    name: "Per year [{key: year, ...}]",
    type: "string",
    role: "json",
  },
  "stats.yearTotals": {
    name: "Totals all time {yieldKwh, consumptionKwh, selfUseRate, ...}",
    type: "string",
    role: "json",
  },
  "stats.months": {
    name: "This year per month [{key: month, ...}]",
    type: "string",
    role: "json",
  },
  "stats.monthTotals": {
    name: "This year totals",
    type: "string",
    role: "json",
  },
  "stats.days": {
    name: "This month per day [{key: day, ...}]",
    type: "string",
    role: "json",
  },
  "stats.dayTotals": {
    name: "This month totals",
    type: "string",
    role: "json",
  },
  "stats.daysPrev": {
    name: "Previous month per day (for the week Mon–Sun)",
    type: "string",
    role: "json",
  },
  "stats.updated": {
    name: "Statistics read at",
    type: "number",
    role: "value.time",
  },
  "raw.families": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.devices": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.index": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.batteryStats": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.energyMonth": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.earningMonth": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.dayPower": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
  "raw.batteryIo": {
    name: "Raw cloud answer (redacted)",
    type: "string",
    role: "json",
  },
};

class Bk215Adapter extends utils.Adapter {
  private cloud: SunlitCloud | null = null;
  private familyId = 0;
  private batteryIds: number[] = [];
  private capacityKwh = 0;
  private liveTimer: ioBroker.Timeout | undefined;
  private statsTimer: ioBroker.Timeout | undefined;
  private liveFails = 0;
  private statsFails = 0;
  private lastErrorLogged = "";

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "bk215" });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  private get cfg(): AdapterConfig {
    return this.config as unknown as AdapterConfig;
  }

  private async onReady(): Promise<void> {
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.createStates();
    await this.setStateAsync("info.lastError", { val: "", ack: true });

    const { cloudEmail, cloudPassword } = this.cfg;
    if (!cloudEmail || !cloudPassword) {
      this.log.error(
        "Sunlit-Cloud: E-Mail und Passwort in den Adapter-Einstellungen eintragen",
      );
      return;
    }
    this.cloud = new SunlitCloud({
      email: cloudEmail.trim(),
      password: cloudPassword,
      logger: { debug: (m) => this.log.debug(`[cloud] ${m}`) },
    });
    this.scheduleLive(0);
    this.scheduleStats(5_000);
  }

  private async createStates(): Promise<void> {
    for (const ch of ["live", "today", "total", "stats", "raw"]) {
      await this.setObjectNotExistsAsync(ch, {
        type: "channel",
        common: { name: ch },
        native: {},
      });
    }
    for (const [id, d] of Object.entries(STATES)) {
      await this.setObjectNotExistsAsync(id, {
        type: "state",
        common: {
          name: d.name,
          type: d.type,
          role: d.role,
          unit: d.unit,
          read: true,
          write: false,
        },
        native: {},
      });
    }
  }

  // ---------------------------------------------------------------- scheduling

  private interval(seconds: number, min: number, fallback: number): number {
    const s = Number(seconds);
    return Math.max(min, Number.isFinite(s) && s > 0 ? s : fallback) * 1000;
  }

  private scheduleLive(ms: number): void {
    this.liveTimer = this.setTimeout(() => void this.liveTick(), ms);
  }

  private scheduleStats(ms: number): void {
    this.statsTimer = this.setTimeout(() => void this.statsTick(), ms);
  }

  private backoff(base: number, fails: number): number {
    return Math.min(base * 2 ** Math.max(0, fails - 1), MAX_BACKOFF_MS);
  }

  private async liveTick(): Promise<void> {
    const base = this.interval(this.cfg.pollLiveS, 30, 60);
    try {
      await this.readLive();
      this.liveFails = 0;
      this.scheduleLive(base);
    } catch (e) {
      this.liveFails++;
      await this.fail(e);
      this.scheduleLive(this.backoff(base, this.liveFails));
    }
  }

  private async statsTick(): Promise<void> {
    const base = this.interval(this.cfg.pollStatsMin * 60, 5 * 60, 15 * 60);
    try {
      await this.readStats();
      this.statsFails = 0;
      this.scheduleStats(base);
    } catch (e) {
      this.statsFails++;
      await this.fail(e);
      this.scheduleStats(this.backoff(base, this.statsFails));
    }
  }

  private async fail(e: unknown): Promise<void> {
    const msg = (e as Error).message || String(e);
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.lastError", { val: msg, ack: true });
    // one warning per kind of problem, the repeats on debug
    if (msg !== this.lastErrorLogged) {
      this.log.warn(`Sunlit-Cloud: ${msg}`);
      this.lastErrorLogged = msg;
    } else {
      this.log.debug(`Sunlit-Cloud: ${msg}`);
    }
    if (e instanceof CloudAuthError) {
      this.cloud?.logout();
    }
  }

  private async ok(): Promise<void> {
    await this.setStateAsync("info.connection", { val: true, ack: true });
    await this.setStateAsync("info.lastSync", { val: Date.now(), ack: true });
    if (this.lastErrorLogged) {
      this.log.info("Sunlit-Cloud: wieder erreichbar");
      this.lastErrorLogged = "";
      await this.setStateAsync("info.lastError", { val: "", ack: true });
    }
  }

  // ---------------------------------------------------------------- reading

  private async raw(id: string, v: unknown): Promise<void> {
    await this.setStateAsync(`raw.${id}`, {
      val: redactJson(v, SENSITIVE),
      ack: true,
    });
  }

  /** Space id and batteries, once (again after a restart) */
  private async ensureSetup(): Promise<void> {
    if (this.familyId) {
      return;
    }
    const cloud = this.cloud!;
    const families = await cloud.families();
    await this.raw("families", families);
    const wanted = Number(this.cfg.familyId) || 0;
    const ids = (Array.isArray(families) ? families : [])
      .map((f) => num(f.id) ?? num(f.familyId) ?? num(f.spaceId))
      .filter((n): n is number => n !== null);
    const id = wanted && ids.includes(wanted) ? wanted : ids[0];
    if (!id) {
      throw new Error("Keine Anlage (family) im Konto gefunden");
    }
    if (ids.length > 1 && !wanted) {
      this.log.info(
        `Mehrere Anlagen im Konto (${ids.join(", ")}), nehme ${id}; in den Einstellungen wählbar`,
      );
    }
    const devices = deviceArray(await cloud.deviceList(id));
    this.batteryIds = batteries(devices)
      .map((d) => num(d.deviceId))
      .filter((n): n is number => n !== null);
    this.familyId = id;
    await this.setStateAsync("info.familyId", { val: id, ack: true });
    this.log.info(
      `Sunlit-Cloud verbunden: Anlage ${id}, ${this.batteryIds.length} Akku(s)`,
    );
  }

  private async readLive(): Promise<void> {
    await this.ensureSetup();
    const cloud = this.cloud!;
    const index = await cloud.spaceIndex(this.familyId);
    await this.raw("index", index);

    // the device list carries the meter's energy counters and the battery's own fields
    const listAnswer = await cloud.deviceList(this.familyId);
    await this.raw("devices", listAnswer);
    const devices = deviceArray(listAnswer);
    const batteryDevice = batteries(devices)[0] ?? {};
    const meterDevice =
      devices.find((d) =>
        /METER/i.test(typeof d.deviceType === "string" ? d.deviceType : ""),
      ) ?? {};

    let battery: Json = { ...batteryDevice };
    if (this.batteryIds.length) {
      const stats = await cloud.deviceStatistics(this.batteryIds[0]);
      await this.raw("batteryStats", stats);
      battery = { ...batteryDevice, ...(stats ?? {}) };
    }
    const v = liveValues(index ?? {}, battery, meterDevice);
    const modules = v.batteryModules ?? 1;
    const cfgCap = Number(this.cfg.batteryCapacityKwh);
    this.capacityKwh = cfgCap > 0 ? cfgCap : modules * MODULE_KWH;
    const eta = batteryEta(
      v,
      this.capacityKwh,
      Number(this.cfg.minSoc) || 0,
      Date.now(),
    );

    const set = (
      id: string,
      val: ioBroker.StateValue | null,
    ): Promise<unknown> => this.setStateAsync(id, { val, ack: true });
    await Promise.all([
      set("live.soc", v.soc),
      set("live.batteryW", v.batteryW),
      set("live.batteryChargeW", v.batteryChargeW),
      set("live.batteryDischargeW", v.batteryDischargeW),
      set("live.solarW", v.solarW),
      set("live.inverterW", v.inverterW),
      set("live.meterW", v.meterW),
      set("live.homeW", v.homeW),
      set("live.chargeRemainingMin", v.chargeRemainingMin),
      set("live.dischargeRemainingMin", v.dischargeRemainingMin),
      set("live.fullAt", eta.fullAt),
      set("live.emptyAt", eta.emptyAt),
      set("live.batteryModules", v.batteryModules),
      set("live.batteryStatus", v.batteryStatus),
      set("live.batteryFault", v.batteryFault),
      set("live.capacityKwh", this.capacityKwh),
      set("today.gridBuyKwh", v.gridBuyTodayKwh),
      set("today.gridRetKwh", v.gridRetTodayKwh),
      set("total.gridBuyKwh", v.gridBuyTotalKwh),
      set("total.gridRetKwh", v.gridRetTotalKwh),
      set("today.solarKwh", v.todaySolarKwh),
      set("today.earning", v.todayEarning),
      set("today.currency", v.currency),
    ]);
    await this.ok();
  }

  private async readStats(): Promise<void> {
    await this.ensureSetup();
    const cloud = this.cloud!;
    const id = this.familyId;
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const prev = new Date(y, m - 2, 1);

    // one after the other: gentle on the cloud
    const total = await cloud.staticStatistics(id);
    const eAll = await cloud.energy(id);
    const gAll = await cloud.earning(id);
    const eYear = await cloud.energy(id, y);
    const gYear = await cloud.earning(id, y);
    const eMonth = await cloud.energy(id, y, m);
    const gMonth = await cloud.earning(id, y, m);
    const ePrev = await cloud.energy(
      id,
      prev.getFullYear(),
      prev.getMonth() + 1,
    );
    const gPrev = await cloud.earning(
      id,
      prev.getFullYear(),
      prev.getMonth() + 1,
    );
    const power = await cloud.dayPower(id, now);
    const io = this.batteryIds.length
      ? await cloud.batteryIo(this.batteryIds[0], now)
      : [];

    await this.raw("energyMonth", eMonth);
    await this.raw("earningMonth", gMonth);
    await this.raw("dayPower", power);
    await this.raw("batteryIo", io);

    const js = (v: unknown): string => JSON.stringify(v);
    const o = (v: unknown): Json =>
      v && typeof v === "object" ? (v as Json) : {};
    await Promise.all([
      this.setStateAsync("stats.total", { val: js(redact(total)), ack: true }),
      this.setStateAsync("stats.years", {
        val: js(buckets(o(eAll), o(gAll))),
        ack: true,
      }),
      this.setStateAsync("stats.yearTotals", {
        val: js(periodTotals(o(eAll), o(gAll))),
        ack: true,
      }),
      this.setStateAsync("stats.months", {
        val: js(buckets(o(eYear), o(gYear))),
        ack: true,
      }),
      this.setStateAsync("stats.monthTotals", {
        val: js(periodTotals(o(eYear), o(gYear))),
        ack: true,
      }),
      this.setStateAsync("stats.days", {
        val: js(buckets(o(eMonth), o(gMonth))),
        ack: true,
      }),
      this.setStateAsync("stats.dayTotals", {
        val: js(periodTotals(o(eMonth), o(gMonth))),
        ack: true,
      }),
      this.setStateAsync("stats.daysPrev", {
        val: js(buckets(o(ePrev), o(gPrev))),
        ack: true,
      }),
      this.setStateAsync("today.curve", {
        val: js(dayCurve(o(power), io)),
        ack: true,
      }),
      this.setStateAsync("stats.updated", { val: Date.now(), ack: true }),
    ]);
    await this.ok();
  }

  private onUnload(callback: () => void): void {
    try {
      if (this.liveTimer) {
        this.clearTimeout(this.liveTimer);
      }
      if (this.statsTimer) {
        this.clearTimeout(this.statsTimer);
      }
      void this.setState("info.connection", { val: false, ack: true });
    } finally {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (
    options: Partial<utils.AdapterOptions> | undefined,
  ): Bk215Adapter => new Bk215Adapter(options);
} else {
  (() => new Bk215Adapter())();
}

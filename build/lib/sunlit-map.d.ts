/**
 * Turns cloud responses into flat values for ioBroker states. Pure functions,
 * tolerant of missing fields (the API is undocumented and differs between
 * firmware/app versions): a value that is not there becomes null.
 */
type Json = Record<string, unknown>;
export declare function num(v: unknown): number | null;
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
export declare function batteries(devices: Json[]): Json[];
/**
 * PV power into the battery: MPPT 1/2 of the head unit plus MPPT of extension modules
 *
 * @param stats
 */
export declare function solarFromBattery(stats: Json): number | null;
/**
 * @param index   content of /v1.5/space/index
 * @param battery merged device-list entry + device statistics of the battery (or {})
 */
export declare function liveValues(index: Json, battery: Json): LiveValues;
export interface Bucket {
    /** day of month, month of year or year, depending on the request */
    key: number;
    [field: string]: number;
}
/**
 * One list per period from dynamic/energy and dynamic/earning: per bucket key
 * the energy distribution plus generation, earnings and charging energy.
 *
 * @param energy
 * @param earning
 */
export declare function buckets(energy: Json, earning: Json): Bucket[];
/**
 * Totals of a period: yield, consumption, self-use and self-sufficiency (0..1)
 *
 * @param energy
 * @param earning
 */
export declare function periodTotals(energy: Json, earning: Json): Record<string, number | null>;
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
export declare function dayCurve(power: Json, batteryIo: unknown): CurvePoint[];
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
export declare function batteryEta(v: Pick<LiveValues, "soc" | "batteryW" | "chargeRemainingMin" | "dischargeRemainingMin">, capacityKwh: number, minSoc: number, now: number): {
    fullAt: number | null;
    emptyAt: number | null;
};
export {};

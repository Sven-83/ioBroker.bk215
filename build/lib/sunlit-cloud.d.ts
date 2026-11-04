/**
 * Read-only client for the SunEnergyXT (formerly Sunlit Solar) cloud, the
 * backend of the official app. The API is undocumented; endpoints and field
 * names follow the community integration cedricziel/ha-sunlit (openapi.yaml).
 *
 * Only reading calls are implemented on purpose: this adapter never changes
 * the battery, the app keeps full control.
 */
export declare const API_BASE_URL = "https://api.sunenergyxt.com/rest";
export declare class CloudAuthError extends Error {
    constructor(message: string);
}
export declare class CloudApiError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export interface CloudLogger {
    debug(m: string): void;
}
/** The part of the WHATWG fetch API the client needs (Node 18+ has it built in). */
export type FetchFn = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<{
    status: number;
    text(): Promise<string>;
}>;
export interface SunlitCloudOptions {
    email: string;
    password: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchFn?: FetchFn;
    logger?: CloudLogger;
    userAgent?: string;
}
type Json = Record<string, unknown>;
export declare class SunlitCloud {
    private token;
    private readonly email;
    private readonly password;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly fetchFn;
    private readonly logger;
    private readonly userAgent;
    constructor(o: SunlitCloudOptions);
    hasToken(): boolean;
    /** Forget the token, the next request logs in again. */
    logout(): void;
    login(): Promise<void>;
    families(): Promise<Json[]>;
    deviceList(familyId: number): Promise<Json[]>;
    deviceStatistics(deviceId: number): Promise<Json>;
    spaceIndex(spaceId: number): Promise<Json>;
    spaceSoc(spaceId: number): Promise<Json>;
    /**
     * Lifetime yield and earnings
     *
     * @param spaceId
     */
    staticStatistics(spaceId: number): Promise<Json>;
    /**
     * Energy distribution: no year = per year, year = per month, year+month = per day
     *
     * @param spaceId
     * @param year
     * @param month
     */
    energy(spaceId: number, year?: number, month?: number): Promise<Json>;
    /**
     * Generation and earnings, same buckets as {@link energy}
     *
     * @param spaceId
     * @param year
     * @param month
     */
    earning(spaceId: number, year?: number, month?: number): Promise<Json>;
    /**
     * Intraday generation (and home) power, samples about every 2 minutes
     *
     * @param spaceId
     * @param d
     */
    dayPower(spaceId: number, d: Date): Promise<Json>;
    /**
     * Intraday battery input/output power of one battery
     *
     * @param deviceId
     * @param d
     */
    batteryIo(deviceId: number, d: Date): Promise<unknown>;
    private period;
    /**
     * Authenticated call; logs in when needed and once more after a rejected token
     *
     * @param method
     * @param path
     * @param body
     */
    private call;
    private raw;
}
export {};

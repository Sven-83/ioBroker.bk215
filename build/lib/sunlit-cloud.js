"use strict";
/**
 * Read-only client for the SunEnergyXT (formerly Sunlit Solar) cloud, the
 * backend of the official app. The API is undocumented; endpoints and field
 * names follow the community integration cedricziel/ha-sunlit (openapi.yaml).
 *
 * Only reading calls are implemented on purpose: this adapter never changes
 * the battery, the app keeps full control.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SunlitCloud = exports.CloudApiError = exports.CloudAuthError = exports.API_BASE_URL = void 0;
exports.API_BASE_URL = "https://api.sunenergyxt.com/rest";
class CloudAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "CloudAuthError";
    }
}
exports.CloudAuthError = CloudAuthError;
class CloudApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "CloudApiError";
    }
}
exports.CloudApiError = CloudApiError;
function messageText(m) {
    if (typeof m === "string") {
        return m;
    }
    if (m && typeof m === "object") {
        const o = m;
        const v = o.de ?? o.en ?? Object.values(o)[0];
        return typeof v === "string" ? v : JSON.stringify(m);
    }
    return "unknown error";
}
const pad2 = (n) => String(n).padStart(2, "0");
class SunlitCloud {
    token = null;
    email;
    password;
    baseUrl;
    timeoutMs;
    fetchFn;
    logger;
    userAgent;
    constructor(o) {
        if (!o.email || !o.password) {
            throw new CloudAuthError("E-Mail und Passwort für die Sunlit-Cloud fehlen");
        }
        this.email = o.email;
        this.password = o.password;
        this.baseUrl = o.baseUrl ?? exports.API_BASE_URL;
        this.timeoutMs = o.timeoutMs ?? 15_000;
        this.fetchFn = o.fetchFn ?? globalThis.fetch;
        this.logger = o.logger ?? { debug: () => undefined };
        this.userAgent = o.userAgent ?? "ioBroker.bk215";
    }
    hasToken() {
        return this.token !== null;
    }
    /** Forget the token, the next request logs in again. */
    logout() {
        this.token = null;
    }
    async login() {
        const content = await this.raw("POST", "/user/login", { account: this.email, password: this.password }, false);
        const t = content?.access_token;
        if (typeof t !== "string" || !t) {
            throw new CloudAuthError("Login ohne Token");
        }
        this.token = t;
        this.logger.debug("cloud login ok");
    }
    // ---------------------------------------------------------------- reading calls
    families() {
        return this.call("GET", "/family/list");
    }
    deviceList(familyId) {
        return this.call("POST", "/v1.2/device/list", {
            familyId,
            deviceType: "ALL",
        });
    }
    deviceStatistics(deviceId) {
        return this.call("POST", "/v1.1/statistics/static/device", {
            deviceId,
        });
    }
    spaceIndex(spaceId) {
        return this.call("POST", "/v1.5/space/index", { spaceId });
    }
    spaceSoc(spaceId) {
        return this.call("POST", "/v1.1/space/soc", { spaceId });
    }
    /**
     * Lifetime yield and earnings
     *
     * @param spaceId
     */
    staticStatistics(spaceId) {
        return this.call("POST", "/v1.1/space/statistics/static", {
            spaceId,
        });
    }
    /**
     * Energy distribution: no year = per year, year = per month, year+month = per day
     *
     * @param spaceId
     * @param year
     * @param month
     */
    energy(spaceId, year, month) {
        return this.call("POST", "/v1.1/space/statistics/dynamic/energy", this.period(spaceId, year, month));
    }
    /**
     * Generation and earnings, same buckets as {@link energy}
     *
     * @param spaceId
     * @param year
     * @param month
     */
    earning(spaceId, year, month) {
        return this.call("POST", "/v1.1/space/statistics/dynamic/earning", this.period(spaceId, year, month));
    }
    /**
     * Intraday generation (and home) power, samples about every 2 minutes
     *
     * @param spaceId
     * @param d
     */
    dayPower(spaceId, d) {
        return this.call("POST", "/v1.1/space/statistics/dynamic/power", {
            spaceId,
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
        });
    }
    /**
     * Intraday battery input/output power of one battery
     *
     * @param deviceId
     * @param d
     */
    batteryIo(deviceId, d) {
        return this.call("POST", "/v1.3/statistics/instantPower/batteryIO", {
            deviceId,
            year: String(d.getFullYear()),
            month: pad2(d.getMonth() + 1),
            day: pad2(d.getDate()),
        });
    }
    // ---------------------------------------------------------------- transport
    period(spaceId, year, month) {
        const b = { spaceId };
        if (year !== undefined) {
            b.year = year;
            if (month !== undefined) {
                b.month = month;
            }
        }
        return b;
    }
    /**
     * Authenticated call; logs in when needed and once more after a rejected token
     *
     * @param method
     * @param path
     * @param body
     */
    async call(method, path, body) {
        if (!this.token) {
            await this.login();
        }
        try {
            return await this.raw(method, path, body, true);
        }
        catch (e) {
            if (e instanceof CloudAuthError) {
                this.token = null;
                await this.login();
                return this.raw(method, path, body, true);
            }
            throw e;
        }
    }
    async raw(method, path, body, auth) {
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (auth && this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        let res;
        try {
            res = await this.fetchFn(this.baseUrl + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: ctrl.signal,
            });
        }
        catch (e) {
            throw new CloudApiError(ctrl.signal.aborted
                ? `Zeitüberschreitung nach ${this.timeoutMs} ms bei ${path}`
                : `Verbindung fehlgeschlagen bei ${path}: ${e.message}`);
        }
        finally {
            clearTimeout(timer);
        }
        if (res.status === 401 || res.status === 403) {
            throw new CloudAuthError(`Anmeldung abgelehnt (HTTP ${res.status})`);
        }
        const text = await res.text();
        if (res.status >= 400) {
            throw new CloudApiError(`HTTP ${res.status} bei ${path}`, res.status);
        }
        let env;
        try {
            env = JSON.parse(text);
        }
        catch {
            throw new CloudApiError(`Keine JSON-Antwort bei ${path}`);
        }
        if (env.code !== undefined && env.code !== 0) {
            const msg = messageText(env.message);
            // the API answers expired tokens with an envelope code, not always with HTTP 401
            if (/token|login|auth|unauthori/i.test(msg)) {
                throw new CloudAuthError(msg);
            }
            throw new CloudApiError(`${path}: ${msg} (code ${env.code})`);
        }
        return env.content;
    }
}
exports.SunlitCloud = SunlitCloud;

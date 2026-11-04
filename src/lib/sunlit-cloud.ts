/**
 * Read-only client for the SunEnergyXT (formerly Sunlit Solar) cloud, the
 * backend of the official app. The API is undocumented; endpoints and field
 * names follow the community integration cedricziel/ha-sunlit (openapi.yaml).
 *
 * Only reading calls are implemented on purpose: this adapter never changes
 * the battery, the app keeps full control.
 */

export const API_BASE_URL = "https://api.sunenergyxt.com/rest";

export class CloudAuthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CloudAuthError";
  }
}

export class CloudApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export interface CloudLogger {
  debug(m: string): void;
}

/** The part of the WHATWG fetch API the client needs (Node 18+ has it built in). */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface SunlitCloudOptions {
  email: string;
  password: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  logger?: CloudLogger;
  userAgent?: string;
}

interface Envelope<T> {
  code?: number;
  message?: unknown;
  content?: T;
}

type Json = Record<string, unknown>;

function messageText(m: unknown): string {
  if (typeof m === "string") {
    return m;
  }
  if (m && typeof m === "object") {
    const o = m as Record<string, unknown>;
    const v = o.de ?? o.en ?? Object.values(o)[0];
    return typeof v === "string" ? v : JSON.stringify(m);
  }
  return "unknown error";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export class SunlitCloud {
  private token: string | null = null;
  private readonly email: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly logger: CloudLogger;
  private readonly userAgent: string;

  public constructor(o: SunlitCloudOptions) {
    if (!o.email || !o.password) {
      throw new CloudAuthError(
        "E-Mail und Passwort für die Sunlit-Cloud fehlen",
      );
    }
    this.email = o.email;
    this.password = o.password;
    this.baseUrl = o.baseUrl ?? API_BASE_URL;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.fetchFn = o.fetchFn ?? globalThis.fetch;
    this.logger = o.logger ?? { debug: () => undefined };
    this.userAgent = o.userAgent ?? "ioBroker.bk215";
  }

  public hasToken(): boolean {
    return this.token !== null;
  }

  /** Forget the token, the next request logs in again. */
  public logout(): void {
    this.token = null;
  }

  public async login(): Promise<void> {
    const content = await this.raw<Json>(
      "POST",
      "/user/login",
      { account: this.email, password: this.password },
      false,
    );
    const t = content?.access_token;
    if (typeof t !== "string" || !t) {
      throw new CloudAuthError("Login ohne Token");
    }
    this.token = t;
    this.logger.debug("cloud login ok");
  }

  // ---------------------------------------------------------------- reading calls

  public families(): Promise<Json[]> {
    return this.call<Json[]>("GET", "/family/list");
  }

  public deviceList(familyId: number): Promise<Json[]> {
    return this.call<Json[]>("POST", "/v1.2/device/list", {
      familyId,
      deviceType: "ALL",
    });
  }

  public deviceStatistics(deviceId: number): Promise<Json> {
    return this.call<Json>("POST", "/v1.1/statistics/static/device", {
      deviceId,
    });
  }

  public spaceIndex(spaceId: number): Promise<Json> {
    return this.call<Json>("POST", "/v1.5/space/index", { spaceId });
  }

  public spaceSoc(spaceId: number): Promise<Json> {
    return this.call<Json>("POST", "/v1.1/space/soc", { spaceId });
  }

  /**
   * Lifetime yield and earnings
   *
   * @param spaceId
   */
  public staticStatistics(spaceId: number): Promise<Json> {
    return this.call<Json>("POST", "/v1.1/space/statistics/static", {
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
  public energy(spaceId: number, year?: number, month?: number): Promise<Json> {
    return this.call<Json>(
      "POST",
      "/v1.1/space/statistics/dynamic/energy",
      this.period(spaceId, year, month),
    );
  }

  /**
   * Generation and earnings, same buckets as {@link energy}
   *
   * @param spaceId
   * @param year
   * @param month
   */
  public earning(
    spaceId: number,
    year?: number,
    month?: number,
  ): Promise<Json> {
    return this.call<Json>(
      "POST",
      "/v1.1/space/statistics/dynamic/earning",
      this.period(spaceId, year, month),
    );
  }

  /**
   * Intraday generation (and home) power, samples about every 2 minutes
   *
   * @param spaceId
   * @param d
   */
  public dayPower(spaceId: number, d: Date): Promise<Json> {
    return this.call<Json>("POST", "/v1.1/space/statistics/dynamic/power", {
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
  public batteryIo(deviceId: number, d: Date): Promise<unknown> {
    return this.call<unknown>(
      "POST",
      "/v1.3/statistics/instantPower/batteryIO",
      {
        deviceId,
        year: String(d.getFullYear()),
        month: pad2(d.getMonth() + 1),
        day: pad2(d.getDate()),
      },
    );
  }

  // ---------------------------------------------------------------- transport

  private period(spaceId: number, year?: number, month?: number): Json {
    const b: Json = { spaceId };
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
  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.token) {
      await this.login();
    }
    try {
      return await this.raw<T>(method, path, body, true);
    } catch (e) {
      if (e instanceof CloudAuthError) {
        this.token = null;
        await this.login();
        return this.raw<T>(method, path, body, true);
      }
      throw e;
    }
  }

  private async raw<T>(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };
    if (auth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new CloudApiError(
        ctrl.signal.aborted
          ? `Zeitüberschreitung nach ${this.timeoutMs} ms bei ${path}`
          : `Verbindung fehlgeschlagen bei ${path}: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new CloudAuthError(`Anmeldung abgelehnt (HTTP ${res.status})`);
    }
    const text = await res.text();
    if (res.status >= 400) {
      throw new CloudApiError(`HTTP ${res.status} bei ${path}`, res.status);
    }
    let env: Envelope<T>;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
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
    return env.content as T;
  }
}

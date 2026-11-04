import { expect } from "chai";

import {
  CloudApiError,
  CloudAuthError,
  SunlitCloud,
  type FetchFn,
} from "../../src/lib/sunlit-cloud";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * fake cloud: answers from a list of handlers, records every call
 *
 * @param handler
 */
function fakeFetch(handler: (c: Call) => { status?: number; body: unknown }): {
  fetchFn: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn: FetchFn = (url, init) => {
    const c: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const r = handler(c);
    return Promise.resolve({
      status: r.status ?? 200,
      text: () => Promise.resolve(JSON.stringify(r.body)),
    });
  };
  return { fetchFn, calls };
}

const ok = (content: unknown): { body: unknown } => ({
  body: { code: 0, content },
});

describe("SunlitCloud", () => {
  it("refuses to start without credentials", () => {
    expect(() => new SunlitCloud({ email: "", password: "x" })).to.throw(
      CloudAuthError,
    );
  });

  it("logs in once and sends the bearer token", async () => {
    const { fetchFn, calls } = fakeFetch((c) =>
      c.url.endsWith("/user/login")
        ? ok({ access_token: "T1" })
        : ok([{ id: 7 }]),
    );
    const cloud = new SunlitCloud({ email: "a@b.de", password: "pw", fetchFn });
    expect(await cloud.families()).to.deep.equal([{ id: 7 }]);
    await cloud.families();
    expect(calls.map((c) => c.url.replace(/.*\/rest/, ""))).to.deep.equal([
      "/user/login",
      "/family/list",
      "/family/list",
    ]);
    expect(calls[0].body).to.deep.equal({ account: "a@b.de", password: "pw" });
    expect(calls[0].headers.Authorization).to.equal(undefined);
    expect(calls[1].headers.Authorization).to.equal("Bearer T1");
  });

  it("logs in again once when the token is rejected", async () => {
    let tokens = 0;
    let rejected = false;
    const { fetchFn, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/user/login")) {
        tokens++;
        return ok({ access_token: `T${tokens}` });
      }
      if (!rejected) {
        rejected = true;
        return { status: 401, body: {} };
      }
      return ok({ spaceId: 7 });
    });
    const cloud = new SunlitCloud({ email: "a", password: "b", fetchFn });
    expect(await cloud.spaceIndex(7)).to.deep.equal({ spaceId: 7 });
    expect(tokens).to.equal(2);
    expect(calls[calls.length - 1].headers.Authorization).to.equal("Bearer T2");
  });

  it("treats a token message in the envelope as an auth error", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch((c) => {
      if (c.url.endsWith("/user/login")) {
        return ok({ access_token: "T" });
      }
      n++;
      return n === 1
        ? { body: { code: 401001, message: { en: "token expired" } } }
        : ok({ ok: true });
    });
    const cloud = new SunlitCloud({ email: "a", password: "b", fetchFn });
    expect(await cloud.spaceSoc(1)).to.deep.equal({ ok: true });
  });

  it("reports API errors with the message text", async () => {
    const { fetchFn } = fakeFetch((c) =>
      c.url.endsWith("/user/login")
        ? ok({ access_token: "T" })
        : { body: { code: 400000, message: { de: "Parameter falsch" } } },
    );
    const cloud = new SunlitCloud({ email: "a", password: "b", fetchFn });
    try {
      await cloud.energy(1, 2026);
      expect.fail("should throw");
    } catch (e) {
      expect(e).to.be.instanceOf(CloudApiError);
      expect((e as Error).message).to.contain("Parameter falsch");
    }
  });

  it("sends the period parameters as documented", async () => {
    const { fetchFn, calls } = fakeFetch((c) =>
      c.url.endsWith("/user/login") ? ok({ access_token: "T" }) : ok({}),
    );
    const cloud = new SunlitCloud({ email: "a", password: "b", fetchFn });
    await cloud.energy(5);
    await cloud.energy(5, 2026);
    await cloud.earning(5, 2026, 11);
    await cloud.dayPower(5, new Date(2026, 10, 4));
    await cloud.batteryIo(9, new Date(2026, 10, 4));
    const bodies = calls.slice(1).map((c) => c.body);
    expect(bodies).to.deep.equal([
      { spaceId: 5 },
      { spaceId: 5, year: 2026 },
      { spaceId: 5, year: 2026, month: 11 },
      { spaceId: 5, year: 2026, month: 11, day: 4 },
      { deviceId: 9, year: "2026", month: "11", day: "04" },
    ]);
  });

  it("fails cleanly when the login answer has no token", async () => {
    const { fetchFn } = fakeFetch(() => ok({}));
    const cloud = new SunlitCloud({ email: "a", password: "b", fetchFn });
    try {
      await cloud.families();
      expect.fail("should throw");
    } catch (e) {
      expect(e).to.be.instanceOf(CloudAuthError);
    }
  });
});

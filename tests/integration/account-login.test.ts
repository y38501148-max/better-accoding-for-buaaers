import { randomUUID } from "node:crypto";
import { it, expect, vi, afterEach } from "vitest";
import { AccountSession } from "../../src/auth/session";
import { ORIGIN } from "../../src/model";
import { ContestAdapter } from "../../src/accoding/adapters";
import { contest } from "../fixtures/synthetic";
const syntheticPassword = randomUUID();
afterEach(() => vi.unstubAllGlobals());
it.each(
  (["ensure", "restore"] as const).flatMap((check) =>
    ["", " \n\t", JSON.stringify({ id: "0" })].map((expiredBody) => ({
      check,
      expiredBody,
    })),
  ),
)(
  "recovers an expired cookie with $check and anonymous body $expiredBody, then imports and restores",
  async ({ check, expiredBody }) => {
    const values = new Map<string, string>([
      [
        "accoding.credentials",
        JSON.stringify({
          username: "synthetic@example.test",
          password: syntheticPassword,
        }),
      ],
    ]);
    const secrets = {
      get: async (key: string) => values.get(key),
      store: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    };
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(new URL(url).origin).toBe(ORIGIN);
        if (url.endsWith("/user/login") && init.method === "POST") {
          posts++;
          const body = new URLSearchParams(String(init.body));
          expect(body.get("_csrf")).toBe("synthetic-csrf");
          expect(body.get("username")).toBe("synthetic@example.test");
          expect(body.get("password")).toBe(syntheticPassword);
          return new Response("ok", {
            headers: {
              "set-cookie":
                "session=new-synthetic-session; Path=/; Secure; HttpOnly",
            },
          });
        }
        if (url.endsWith("/user/login"))
          return new Response(
            '<form action="/user/login"><input name="_csrf" value="synthetic-csrf"><input name="password"></form>',
          );
        if (url.endsWith("/api/users/me")) {
          const cookie = (init.headers as Record<string, string>).Cookie;
          return new Response(
            cookie.includes("new-synthetic-session")
              ? JSON.stringify({ id: "7" })
              : expiredBody,
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/api/contests/7")) {
          expect((init.headers as Record<string, string>).Cookie).toContain(
            "new-synthetic-session",
          );
          return new Response(JSON.stringify(contest));
        }
        throw Error("Unexpected synthetic request");
      }),
    );
    const session = new AccountSession(secrets);
    await session.client.jar.setCookie(
      "session=expired-synthetic-session; Path=/; Secure; HttpOnly",
      ORIGIN,
    );
    values.set(
      "accoding.session",
      JSON.stringify(await session.client.jar.serialize()),
    );
    expect((await session[check]())?.id).toBe("7");
    expect(posts).toBe(1);
    expect(await new ContestAdapter(session.client).fetch("7")).toHaveLength(2);
    const restored = new AccountSession(secrets);
    expect((await restored.restore())?.id).toBe("7");
    expect(posts).toBe(1);
    await restored.logout();
    expect(values.size).toBe(0);
  },
);

it("returns to manual authentication when an empty identity response has no saved credentials", async () => {
  const transport = vi.fn(async () => new Response(""));
  vi.stubGlobal("fetch", transport);
  const values = new Map<string, string>();
  const session = new AccountSession({
    get: async (key) => values.get(key),
    store: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  });
  expect(await session.ensure()).toBeUndefined();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(session.user).toBeUndefined();
});

it.each([
  { status: 200, body: "<html>Maintenance</html>", kind: "protocol" },
  { status: 403, body: "Forbidden", kind: "forbidden" },
])(
  "does not send a saved password for $kind failures",
  async ({ status, body, kind }) => {
    const transport = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", transport);
    const raw = JSON.stringify({
      username: "synthetic@example.test",
      password: syntheticPassword,
    });
    const secrets = {
      get: vi.fn(async () => raw),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const session = new AccountSession(secrets);
    await expect(session.ensure()).rejects.toMatchObject({ kind });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(secrets.get).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  },
);

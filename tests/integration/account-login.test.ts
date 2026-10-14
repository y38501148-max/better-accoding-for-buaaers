import { randomUUID } from "node:crypto";
import { it, expect, vi, afterEach } from "vitest";
import { AccountSession } from "../../src/auth/session";
import { ORIGIN } from "../../src/model";
const syntheticPassword = randomUUID();
afterEach(() => vi.unstubAllGlobals());
it("recovers an expired cookie using the real login/CSRF protocol and persists the replacement session", async () => {
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
          JSON.stringify(
            cookie.includes("new-synthetic-session")
              ? { id: "7" }
              : { id: "0" },
          ),
        );
      }
      throw Error("Unexpected synthetic request");
    }),
  );
  const session = new AccountSession(secrets);
  expect((await session.ensure())?.id).toBe("7");
  expect(posts).toBe(1);
  const restored = new AccountSession(secrets);
  expect((await restored.restore())?.id).toBe("7");
  expect(posts).toBe(1);
  await restored.logout();
  expect(values.size).toBe(0);
});

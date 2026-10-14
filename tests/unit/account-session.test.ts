import { randomUUID } from "node:crypto";
import { it, expect, vi } from "vitest";
import { AccountSession } from "../../src/auth/session";
import { AccodingClient, ApiError } from "../../src/accoding/client";

const syntheticPassword = randomUUID();
const credentials = {
  username: "synthetic@example.test",
  password: syntheticPassword,
};
const keys = {
  credentials: "accoding.credentials",
  session: "accoding.session",
};
const authError = () => new ApiError("auth", "expired");
function fixture() {
  const values = new Map<string, string>();
  const secrets = {
    get: vi.fn(async (key: string) => values.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  const candidate = { client: new AccodingClient(), user: { id: "7" } };
  const backend = {
    login: vi.fn(async (_username: string, _password: string) => candidate),
    currentUser: vi.fn(async (_client: AccodingClient) => candidate.user),
  };
  const changed = vi.fn();
  const session = new AccountSession(secrets, changed, backend);
  return { values, secrets, candidate, backend, changed, session };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("saves credentials only through SecretStorage after successful remembered login", async () => {
  const { session, values, backend } = fixture();
  await session.signIn(credentials, true);
  expect(backend.login).toHaveBeenCalledWith(
    credentials.username,
    credentials.password,
  );
  expect(JSON.parse(values.get(keys.credentials)!)).toEqual(credentials);
  expect(values.has(keys.session)).toBe(true);
  expect(session.user?.id).toBe("7");
});
it("session-only login removes previously remembered credentials", async () => {
  const { session, values } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  await session.signIn(credentials, false);
  expect(values.has(keys.credentials)).toBe(false);
  expect(values.has(keys.session)).toBe(true);
});
it("failed manual login does not save a mistyped password", async () => {
  const { session, values, backend } = fixture();
  backend.login.mockRejectedValue(authError());
  await expect(session.signIn(credentials, true)).rejects.toMatchObject({
    kind: "auth",
  });
  expect(values.size).toBe(0);
});
it("restores a valid cookie without sending the saved password", async () => {
  const { session, values, backend, candidate } = fixture();
  values.set(
    keys.session,
    JSON.stringify(await candidate.client.jar.serialize()),
  );
  values.set(keys.credentials, JSON.stringify(credentials));
  expect((await session.restore())?.id).toBe("7");
  expect(backend.login).not.toHaveBeenCalled();
});
it.each([undefined, "broken", "valid"])(
  "auto logs in at startup with %s cookie",
  async (cookie) => {
    const { session, values, backend, candidate } = fixture();
    if (cookie)
      values.set(
        keys.session,
        cookie === "valid"
          ? JSON.stringify(await candidate.client.jar.serialize())
          : cookie,
      );
    values.set(keys.credentials, JSON.stringify(credentials));
    backend.currentUser.mockRejectedValue(authError());
    expect((await session.restore())?.id).toBe("7");
    expect(backend.login).toHaveBeenCalledTimes(1);
    expect(session.client).toBe(candidate.client);
    expect(JSON.parse(values.get(keys.session)!)).toHaveProperty("cookies");
  },
);
it("shares one automatic login across concurrent expired-session checks", async () => {
  const { session, values, backend } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  backend.currentUser.mockRejectedValue(authError());
  const users = await Promise.all([
    session.ensure(),
    session.ensure(),
    session.ensure(),
  ]);
  expect(users.map((u) => u?.id)).toEqual(["7", "7", "7"]);
  expect(backend.currentUser).toHaveBeenCalledTimes(1);
  expect(backend.login).toHaveBeenCalledTimes(1);
});
it("stops trying a rejected saved password until manual login replaces it", async () => {
  const { session, values, backend } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  backend.currentUser.mockRejectedValue(authError());
  backend.login.mockRejectedValueOnce(authError());
  expect(await session.ensure()).toBeUndefined();
  expect(await session.ensure()).toBeUndefined();
  expect(backend.login).toHaveBeenCalledTimes(1);
  await session.signIn({ ...credentials, password: randomUUID() }, true);
  expect((await session.ensure())?.id).toBe("7");
  expect(backend.login).toHaveBeenCalledTimes(3);
});
it("keeps saved credentials after a network failure and omits backend error details", async () => {
  const { session, values, backend, candidate } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  backend.currentUser.mockRejectedValue(authError());
  backend.login.mockRejectedValueOnce(Error(credentials.password));
  await expect(session.ensure()).rejects.toThrow("自动登录暂时失败");
  expect(JSON.parse(values.get(keys.credentials)!)).toEqual(credentials);
  expect(await session.ensure()).toEqual(candidate.user);
});
it("does not try passwords when the cookie check fails due to network", async () => {
  const { session, values, backend } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  backend.currentUser.mockRejectedValue(new ApiError("network", "offline"));
  await expect(session.ensure()).rejects.toMatchObject({ kind: "network" });
  expect(backend.login).not.toHaveBeenCalled();
  expect(values.has(keys.credentials)).toBe(true);
});
it("clears both secrets and rejects a late automatic login after logout", async () => {
  const { session, values, backend, candidate } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  backend.currentUser.mockRejectedValue(authError());
  const gate = deferred<typeof candidate>();
  const started = deferred<void>();
  backend.login.mockImplementation(async () => {
    started.resolve();
    return gate.promise;
  });
  const login = session.ensure();
  const rejected = expect(login).rejects.toThrow("登录操作已取消");
  await started.promise;
  await session.logout();
  gate.resolve(candidate);
  await rejected;
  expect(session.user).toBeUndefined();
  expect(values.size).toBe(0);
  expect(session.client).not.toBe(candidate.client);
});
it("does not let a late manual login undo logout", async () => {
  const { session, values, backend, candidate } = fixture();
  const gate = deferred<typeof candidate>();
  backend.login.mockReturnValue(gate.promise);
  const pending = session.signIn(credentials, true);
  const rejected = expect(pending).rejects.toThrow("登录操作已取消");
  await session.logout();
  gate.resolve(candidate);
  await rejected;
  expect(session.user).toBeUndefined();
  expect(values.size).toBe(0);
});
it("logout waits for in-flight secret writes before deleting saved data", async () => {
  const { session, values, secrets } = fixture();
  const gate = deferred<void>(),
    started = deferred<void>();
  secrets.store.mockImplementationOnce(async (key, value) => {
    started.resolve();
    await gate.promise;
    values.set(key, value);
  });
  const pending = session.signIn(credentials, true);
  const rejected = expect(pending).rejects.toThrow("登录操作已取消");
  await started.promise;
  const logout = session.logout();
  gate.resolve();
  await Promise.all([rejected, logout]);
  expect(values.size).toBe(0);
  expect(session.user).toBeUndefined();
});
it("discards damaged saved credentials without leaking their content", async () => {
  const { session, values, backend } = fixture();
  values.set(keys.credentials, "invalid synthetic secret");
  expect(await session.restore()).toBeUndefined();
  expect(values.has(keys.credentials)).toBe(false);
  expect(backend.login).not.toHaveBeenCalled();
});

it("keeps a restored cookie after offline startup and reuses it when online", async () => {
  const { session, values, backend, candidate } = fixture();
  await candidate.client.jar.setCookie(
    "session=synthetic; Path=/; Secure",
    "https://accoding.buaa.edu.cn",
  );
  const serialized = JSON.stringify(await candidate.client.jar.serialize());
  values.set(keys.session, serialized);
  backend.currentUser.mockRejectedValueOnce(new ApiError("network", "offline"));
  await expect(session.restore()).rejects.toMatchObject({ kind: "network" });
  expect(values.get(keys.session)).toBe(serialized);
  expect(
    await session.client.jar.getCookieString("https://accoding.buaa.edu.cn"),
  ).toContain("session=synthetic");
  expect((await session.ensure())?.id).toBe("7");
  expect(backend.login).not.toHaveBeenCalled();
});

it("does not publish a late login after extension disposal", async () => {
  const { session, values, backend, candidate } = fixture();
  values.set(keys.credentials, JSON.stringify(credentials));
  const gate = deferred<typeof candidate>(),
    started = deferred<void>();
  backend.login.mockImplementation(async () => {
    started.resolve();
    return gate.promise;
  });
  const pending = session.restore();
  const rejected = expect(pending).rejects.toThrow("登录操作已取消");
  await started.promise;
  session.dispose();
  gate.resolve(candidate);
  await rejected;
  expect(session.user).toBeUndefined();
  expect(values.has(keys.session)).toBe(false);
  expect(values.has(keys.credentials)).toBe(true);
});

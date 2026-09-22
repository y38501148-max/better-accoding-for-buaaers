import { expect, it, vi } from "vitest";
import { AccodingClient } from "../../src/accoding/client";
import { fetchContestForImport } from "../../src/accoding/import";
import { ADMIN_ORIGIN, ORIGIN } from "../../src/model";
import { contest } from "../fixtures/synthetic";
const json = (data: unknown) => new Response(JSON.stringify(data));
it("uses admin read permission without requiring contest edit privileges", async () => {
  const seen: string[] = [];
  const client = new AccodingClient(undefined, async (url, init) => {
    seen.push(url);
    expect(init.method).toBe("GET");
    if (url === `${ADMIN_ORIGIN}/api/users/me`) {
      expect((init.headers as Record<string, string>).Cookie).toContain(
        "sid=synthetic",
      );
      return new Response(JSON.stringify({ id: 5 }), {
        headers: { "set-cookie": "sid=admin-updated; Path=/; Secure" },
      });
    }
    return json(contest);
  });
  await client.jar.setCookie("sid=synthetic; Path=/; Secure", ORIGIN);
  const problems = await fetchContestForImport(client, "7");
  expect(seen).toEqual([
    `${ADMIN_ORIGIN}/api/users/me`,
    `${ADMIN_ORIGIN}/api/contests/7`,
  ]);
  expect(problems.map((p) => p.target)).toEqual([
    { kind: "contest", contestId: "7", problemId: "11", contestOrder: 0 },
    { kind: "contest", contestId: "7", problemId: "22", contestOrder: 1 },
  ]);
  expect(problems[0].statement.baseUrl).toBe(
    `${ADMIN_ORIGIN}/contest-ng/index.html`,
  );
  expect(await client.jar.getCookieString(ORIGIN)).toBe("sid=synthetic");
});
it.each([
  "forbidden",
  "unauthorized",
  "login",
  "wrong-contest",
  "unavailable",
  "rate-limited",
  "broken-body",
])("falls back to student when admin contest read is %s", async (scenario) => {
  const seen: string[] = [];
  const client = new AccodingClient(undefined, async (url) => {
    seen.push(url);
    if (url.startsWith(ORIGIN + "/")) return json(contest);
    if (url.endsWith("/api/users/me")) return json({ id: 5 });
    if (url.endsWith("/user/login"))
      return new Response('<form><input name="password"></form>');
    switch (scenario) {
      case "forbidden":
        return new Response("", { status: 403 });
      case "unauthorized":
        return new Response("", { status: 401 });
      case "login":
        return new Response(null, {
          status: 302,
          headers: { location: "/user/login" },
        });
      case "wrong-contest":
        return json({ ...contest, id: 8 });
      case "rate-limited":
        return new Response("", {
          status: 429,
          headers: { "retry-after": "30" },
        });
      case "broken-body":
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error("broken stream"));
            },
          }),
        );
      default:
        throw new Error("port unreachable");
    }
  });
  const problems = await fetchContestForImport(client, "7");
  expect(problems).toHaveLength(2);
  expect(seen.at(-1)).toBe(`${ORIGIN}/api/contests/7`);
  expect(
    seen.filter((u) => u === `${ADMIN_ORIGIN}/api/contests/7`),
  ).toHaveLength(1);
  expect(problems[0].statement.baseUrl).toBe(`${ORIGIN}/contest-ng/index.html`);
});
it("does not treat anonymous admin access as authenticated permission", async () => {
  const seen: string[] = [];
  const client = new AccodingClient(undefined, async (url) => {
    seen.push(url);
    return json(url.endsWith("/api/users/me") ? { id: 0 } : contest);
  });
  await fetchContestForImport(client, "7");
  expect(seen).toEqual([
    `${ADMIN_ORIGIN}/api/users/me`,
    `${ORIGIN}/api/contests/7`,
  ]);
});
it("preserves student access errors when both origins deny permission", async () => {
  const seen: string[] = [];
  const client = new AccodingClient(undefined, async (url) => {
    seen.push(url);
    if (url.endsWith("/api/users/me")) return json({ id: 5 });
    return new Response("", { status: 403 });
  });
  await expect(fetchContestForImport(client, "7")).rejects.toMatchObject({
    kind: "forbidden",
  });
  expect(seen).toEqual([
    `${ADMIN_ORIGIN}/api/users/me`,
    `${ADMIN_ORIGIN}/api/contests/7`,
    `${ORIGIN}/api/contests/7`,
  ]);
});
it("never sends admin POST or follows redirects to a different port", async () => {
  const transport = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: `${ORIGIN}/next` },
      }),
  );
  const admin = new AccodingClient(undefined, transport).adminReader();
  await expect(
    admin.request("/anything", { method: "POST" }),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(transport).not.toHaveBeenCalled();
  await expect(admin.request("/anything")).rejects.toMatchObject({
    kind: "protocol",
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("logout cancels the admin probe without falling back into another session", async () => {
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    begin();
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Error("aborted")), {
        once: true,
      });
    });
  });
  const client = new AccodingClient(undefined, transport);
  const pending = fetchContestForImport(client, "7");
  await started;
  client.cancel();
  await expect(pending).rejects.toThrow("取消");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("does not reuse permission from a different contest", async () => {
  const seen: string[] = [];
  const client = new AccodingClient(undefined, async (url) => {
    seen.push(url);
    if (url.endsWith("/api/users/me")) return json({ id: 5 });
    if (url === `${ADMIN_ORIGIN}/api/contests/8`)
      return new Response("", { status: 403 });
    return json({ ...contest, id: url.endsWith("/8") ? 8 : 7 });
  });
  await fetchContestForImport(client, "7");
  await fetchContestForImport(client, "8");
  expect(seen).toContain(`${ADMIN_ORIGIN}/api/contests/8`);
  expect(seen).toContain(`${ORIGIN}/api/contests/8`);
});

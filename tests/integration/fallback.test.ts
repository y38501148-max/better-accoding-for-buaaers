import { it, expect, vi } from "vitest";
vi.setConfig({ testTimeout: 20000 });
import { AccodingClient } from "../../src/accoding/client";
import { sendSubmission } from "../../src/submissions/send";
import { contest, problemPage } from "../fixtures/synthetic";
import { ADMIN_ORIGIN, ORIGIN } from "../../src/model";
const target = {
  kind: "contest",
  contestId: "7",
  problemId: "11",
  contestOrder: 0,
} as const;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
function setup(
  options: {
    end?: string;
    start?: string;
    hidden?: boolean;
    adminDenied?: boolean;
    studentDenied?: boolean;
    postFails?: boolean;
    postDenied?: boolean;
    flips?: boolean;
    contestDenied?: boolean;
    adminBroken?: boolean;
  } = {},
) {
  const posts: { url: string; body: string }[] = [];
  const reads: string[] = [];
  let contestReads = 0;
  const client = new AccodingClient(undefined, async (url, init) => {
    const u = new URL(url),
      p = u.pathname,
      admin = u.origin === ADMIN_ORIGIN;
    if (init.method === "POST") {
      posts.push({ url, body: String(init.body) });
      if (options.postFails) throw Error("connection lost");
      if (options.postDenied) return new Response("denied", { status: 403 });
      return json({ id: 99, result: "WT", problem_id: 11, creator_id: 5 });
    }
    reads.push(url);
    if (p === "/api/contests/7") {
      if (options.contestDenied) return new Response("denied", { status: 403 });
      contestReads++;
      return json({
        ...contest,
        problems: options.hidden ? [] : contest.problems,
        start_time: options.start,
        end_time:
          options.flips && contestReads > 1
            ? "2000-01-01T00:00:00Z"
            : options.end,
      });
    }
    if (p === "/problem/11/index") {
      if (admin ? options.adminDenied : options.studentDenied)
        return new Response("denied", { status: 403 });
      if (admin && options.adminBroken)
        return new Response(
          problemPage.replace(
            'action="./submit"',
            'action="/problem/22/submit"',
          ),
        );
      return new Response(
        admin
          ? problemPage
              .replace("<form action=", '<form method="post" action=')
              .replace('<input name="_csrf" value="SYNTHETIC-CSRF">', "")
          : problemPage,
      );
    }
    if (p === "/api/users/me") return json({ id: 5 });
    if (p === "/problem/11/submission") return new Response("<html></html>");
    throw Error(`Unexpected path ${url}`);
  });
  const language = vi.fn(async () => "c");
  const sending = vi.fn(async () => {});
  return { client, posts, reads, hooks: { language, sending } };
}
it.each([
  { start: "2999-01-01T00:00:00Z" },
  { hidden: true },
  { end: "2000-01-01T00:00:00Z" },
  { contestDenied: true },
])(
  "uses admin problem submission for unavailable contest route %j",
  async (options) => {
    const { client, posts, hooks } = setup(options);
    const result = await sendSubmission(client, target, "int main(){}", hooks);
    expect(posts.map((p) => p.url)).toEqual([
      `${ADMIN_ORIGIN}/problem/11/submit`,
    ]);
    expect(new URLSearchParams(posts[0].body).has("_csrf")).toBe(false);
    expect(hooks.language).toHaveBeenCalledWith(
      expect.objectContaining({
        languages: ["c"],
        target: { kind: "problemset", problemId: "11", service: "admin" },
      }),
      true,
    );
    expect(hooks.sending).toHaveBeenCalledWith(
      { kind: "problemset", problemId: "11", service: "admin" },
      "c",
    );
    expect(result?.target).toEqual({
      kind: "problemset",
      problemId: "11",
      service: "admin",
    });
  },
);
it("falls back from hidden contest through denied admin to student problemset in order", async () => {
  const { client, posts, reads, hooks } = setup({
    hidden: true,
    adminDenied: true,
  });
  await sendSubmission(client, target, "code", hooks);
  expect(posts.map((p) => p.url)).toEqual([`${ORIGIN}/problem/11/submit`]);
  expect(reads.indexOf(`${ORIGIN}/api/contests/7`)).toBeLessThan(
    reads.indexOf(`${ADMIN_ORIGIN}/problem/11/index`),
  );
  expect(reads.indexOf(`${ADMIN_ORIGIN}/problem/11/index`)).toBeLessThan(
    reads.indexOf(`${ORIGIN}/problem/11/index`),
  );
});
it.each([undefined, "invalid", "2000-01-01T00:00:00", "2999-01-01T00:00:00Z"])(
  "keeps active or ambiguous end metadata on contest route (%s)",
  async (end) => {
    const { client, posts, reads, hooks } = setup({ end });
    expect(
      (await sendSubmission(client, target, "code", hooks))?.target.kind,
    ).toBe("contest");
    expect(posts.map((p) => p.url)).toEqual([
      `${ORIGIN}/api/contests/7/submissions`,
    ]);
    expect(reads.some((u) => u.startsWith(ADMIN_ORIGIN))).toBe(false);
  },
);
it("handles ending during language selection before POST", async () => {
  const { client, posts, hooks } = setup({
    end: "2999-01-01T00:00:00Z",
    flips: true,
  });
  await sendSubmission(client, target, "code", hooks);
  expect(posts.map((p) => p.url)).toEqual([
    `${ADMIN_ORIGIN}/problem/11/submit`,
  ]);
  expect(hooks.sending).toHaveBeenCalledTimes(1);
});
it("does not send or repeatedly probe when all routes deny access", async () => {
  const { client, posts, reads, hooks } = setup({
    hidden: true,
    adminDenied: true,
    studentDenied: true,
  });
  await expect(
    sendSubmission(client, target, "code", hooks),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(posts).toEqual([]);
  expect(reads.filter((u) => u.endsWith("/problem/11/index"))).toHaveLength(2);
});
it.each([
  { postFails: true },
  { hidden: true, postFails: true },
  { hidden: true, adminDenied: true, postFails: true },
  { postDenied: true },
  { hidden: true, postDenied: true },
])(
  "never sends another POST after an uncertain or rejected send %j",
  async (options) => {
    const { client, posts, hooks } = setup(options);
    await expect(
      sendSubmission(client, target, "code", hooks),
    ).rejects.toThrow();
    expect(posts).toHaveLength(1);
    expect(hooks.sending).toHaveBeenCalledTimes(1);
  },
);
it("refuses an admin form pointing to a different problem", async () => {
  const { client, posts, hooks } = setup({ hidden: true, adminBroken: true });
  await expect(
    sendSubmission(client, target, "code", hooks),
  ).rejects.toMatchObject({ kind: "protocol" });
  expect(posts).toEqual([]);
});
it("cancels before POST without falling through when language selection is dismissed", async () => {
  const { client, posts, reads, hooks } = setup({ hidden: true });
  expect(
    await sendSubmission(client, target, "code", {
      ...hooks,
      language: async () => undefined,
    }),
  ).toBeUndefined();
  expect(posts).toEqual([]);
  expect(reads).not.toContain(`${ORIGIN}/problem/11/index`);
});

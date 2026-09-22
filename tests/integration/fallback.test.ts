import { it, expect, vi } from "vitest";
import { AccodingClient } from "../../src/accoding/client";
import { sendSubmission } from "../../src/submissions/send";
import { contest, problemPage } from "../fixtures/synthetic";
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
    denied?: boolean;
    postFails?: boolean;
    flips?: boolean;
    contestDenied?: boolean;
  } = {},
) {
  const posts: { path: string; body: string }[] = [];
  let reads = 0;
  const client = new AccodingClient(undefined, async (url, init) => {
    const p = new URL(url).pathname;
    if (init.method === "POST") {
      posts.push({ path: p, body: String(init.body) });
      if (options.postFails) throw Error("connection lost");
      return json({ id: 99, result: "WT", problem_id: 11, creator_id: 5 });
    }
    if (p === "/api/contests/7") {
      if (options.contestDenied) return new Response("denied", { status: 403 });
      reads++;
      return json({
        ...contest,
        end_time:
          options.flips && reads > 1 ? "2000-01-01T00:00:00Z" : options.end,
      });
    }
    if (p === "/problem/11/index")
      return options.denied
        ? new Response("denied", { status: 403 })
        : new Response(problemPage);
    if (p === "/api/users/me") return json({ id: 5 });
    if (p === "/problem/11/submission") return new Response("<html></html>");
    throw Error(`Unexpected path ${p}`);
  });
  const language = vi.fn(async () => "c");
  const sending = vi.fn(async () => {});
  return { client, posts, hooks: { language, sending } };
}
it("sends only to the exact global problem ID after an ended contest, using actual problemset languages", async () => {
  const { client, posts, hooks } = setup({ end: "2000-01-01T00:00:00Z" });
  const result = await sendSubmission(client, target, "int main(){}", hooks);
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe("/problem/11/submit");
  expect(new URLSearchParams(posts[0].body).get("code")).toBe("int main(){}");
  expect(hooks.language.mock.calls[0]).toMatchObject([
    { languages: ["c"], target: { kind: "problemset", problemId: "11" } },
    true,
  ]);
  expect(hooks.sending).toHaveBeenCalledWith(
    { kind: "problemset", problemId: "11" },
    "c",
  );
  expect(result?.target.kind).toBe("problemset");
});
it.each([undefined, "invalid", "2000-01-01T00:00:00", "2999-01-01T00:00:00Z"])(
  "keeps active or uncertain end metadata on the contest route (%s)",
  async (end) => {
    const { client, posts, hooks } = setup({ end });
    const result = await sendSubmission(client, target, "code", hooks);
    expect(posts.map((p) => p.path)).toEqual(["/api/contests/7/submissions"]);
    expect(result?.target.kind).toBe("contest");
  },
);
it("handles ending during language selection before either POST is sent", async () => {
  const { client, posts, hooks } = setup({
    end: "2999-01-01T00:00:00Z",
    flips: true,
  });
  await sendSubmission(client, target, "code", hooks);
  expect(posts.map((p) => p.path)).toEqual(["/problem/11/submit"]);
  expect(hooks.sending).toHaveBeenCalledTimes(1);
  expect(hooks.language).toHaveBeenLastCalledWith(
    expect.objectContaining({ languages: ["c"] }),
    true,
  );
});
it("requires public problem access even when contest metadata is readable", async () => {
  const { client, posts, hooks } = setup({
    end: "2000-01-01T00:00:00Z",
    denied: true,
  });
  await expect(
    sendSubmission(client, target, "code", hooks),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(posts).toEqual([]);
  expect(hooks.sending).not.toHaveBeenCalled();
});
it("does not turn a contest permission error into a fallback", async () => {
  const { client, posts, hooks } = setup({ contestDenied: true });
  await expect(
    sendSubmission(client, target, "code", hooks),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect(posts).toEqual([]);
});
it.each(["2999-01-01T00:00:00Z", "2000-01-01T00:00:00Z"])(
  "never retries either route after an uncertain POST (%s)",
  async (end) => {
    const { client, posts, hooks } = setup({ end, postFails: true });
    await expect(
      sendSubmission(client, target, "code", hooks),
    ).rejects.toMatchObject({ kind: "unknown" });
    expect(posts).toHaveLength(1);
    expect(hooks.sending).toHaveBeenCalledTimes(1);
  },
);
it("cancels before POST if language selection is dismissed", async () => {
  const { client, posts, hooks } = setup({ end: "2000-01-01T00:00:00Z" });
  expect(
    await sendSubmission(client, target, "code", {
      ...hooks,
      language: async () => undefined,
    }),
  ).toBeUndefined();
  expect(posts).toEqual([]);
});

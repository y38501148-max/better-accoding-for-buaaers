import { it, expect, vi } from "vitest";
import { AccodingClient } from "../../src/accoding/client";
import {
  ContestAdapter,
  ProblemsetAdapter,
  currentUser,
} from "../../src/accoding/adapters";
import { contest, problemPage } from "../fixtures/synthetic";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
it("retains cookies across same origin redirects", async () => {
  const seen: string[] = [];
  const c = new AccodingClient(undefined, async (url, init) => {
    seen.push(String((init.headers as Record<string, string>).Cookie));
    return seen.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location: "/next",
            "set-cookie": "session=synthetic; Path=/; Secure; HttpOnly",
          },
        })
      : json({ ok: true });
  });
  await c.request("/start");
  expect(seen[1]).toContain("session=synthetic");
});
it("never sends credentials cross origin", async () => {
  const transport = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/" },
      }),
  );
  await expect(
    new AccodingClient(undefined, transport).request("/start"),
  ).rejects.toThrow("跨域");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("never retries uncertain POST", async () => {
  const transport = vi.fn(async () => {
    throw new Error("lost");
  });
  await expect(
    new AccodingClient(undefined, transport).request("/submit", {
      method: "POST",
      body: "code=synthetic",
    }),
  ).rejects.toMatchObject({ kind: "unknown" });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("does not accept login HTML or anonymous user as success", async () => {
  await expect(
    currentUser(
      new AccodingClient(
        undefined,
        async () => new Response('<form><input name="password"></form>'),
      ),
    ),
  ).rejects.toThrow();
  await expect(
    currentUser(new AccodingClient(undefined, async () => json({ id: 0 }))),
  ).rejects.toThrow();
});
it("uses fresh sorted zero based order and exact server language", async () => {
  let submitted: unknown;
  const c = new AccodingClient(undefined, async (_u, init) => {
    if (init.method === "POST") {
      submitted = JSON.parse(String(init.body));
      return json({ id: 99, result: "WT", problem_id: 22 });
    }
    return json(contest);
  });
  const target = {
    kind: "contest",
    contestId: "7",
    problemId: "22",
    contestOrder: 0,
  } as const;
  const sub = await new ContestAdapter(c).submit(target, "int main(){}", "c++");
  expect(submitted).toEqual({ code: "int main(){}", lang: "c++", order: 1 });
  expect(sub.target).toMatchObject({ contestOrder: 1 });
});
it("refuses languages no longer allowed before POST", async () => {
  const transport = vi.fn(async () => json(contest));
  await expect(
    new ContestAdapter(new AccodingClient(undefined, transport)).submit(
      { kind: "contest", contestId: "7", problemId: "11", contestOrder: 0 },
      "code",
      "python",
    ),
  ).rejects.toThrow("语言");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("problemset sends only validated form fields", async () => {
  let posted = "";
  const c = new AccodingClient(undefined, async (_u, init) => {
    if (_u.endsWith("/api/users/me")) return json({ id: 5 });
    if (_u.endsWith("/submission")) return new Response("<html></html>");
    if (init.method === "POST") {
      posted = String(init.body);
      return json({ id: 9, result: "JG", problem_id: 0 });
    }
    return new Response(problemPage);
  });
  const s = await new ProblemsetAdapter(c).submit(
    { kind: "problemset", problemId: "0" },
    "a+b\n",
    "c",
  );
  expect(Object.fromEntries(new URLSearchParams(posted))).toEqual({
    _csrf: "SYNTHETIC-CSRF",
    code: "a+b\n",
    lang: "c",
  });
  expect(s.target.kind).toBe("problemset");
});
it("preserves unknown remote status and source specific result query", async () => {
  let url = "";
  const c = new AccodingClient(undefined, async (u) => {
    url = u;
    return json([{ id: 9, result: "NEW_STATUS", problem_id: 0, score: 37 }]);
  });
  const s = await new ProblemsetAdapter(c).get(
    { kind: "problemset", problemId: "0" },
    "9",
  );
  expect(url).toContain("/submission/getSubmissionApi?");
  expect(s.result).toBe("NEW_STATUS");
  expect(s.score).toBe("37");
});

it("locates a problemset list redirect only after owner, language and exact source verification", async () => {
  const code = "int main(void){return 0;}\n";
  let sent = false;
  const target = { kind: "problemset", problemId: "0" } as const;
  const c = new AccodingClient(undefined, async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/users/me") return json({ id: 5 });
    if (u.pathname === "/problem/0/index") return new Response(problemPage);
    if (init.method === "POST") {
      sent = true;
      return new Response(null, {
        status: 302,
        headers: { location: "/problem/0/submission" },
      });
    }
    if (u.pathname === "/problem/0/submission")
      return new Response(
        sent ? '<a href="/submission/99">99</a>' : "<html></html>",
      );
    if (u.pathname === "/submission/getSubmissionApi")
      return json([
        { id: 99, result: "WT", problem_id: 0, creator_id: 5, lang: "c" },
      ]);
    if (u.pathname === "/submission/99")
      return new Response(
        `<pre><code>/* \n Author: Synthetic\n Result: WT\tSubmission_id: 99\n Problem_id: 0\n*/\n\n${code}</code></pre>`,
      );
    throw Error("Unexpected URL");
  });
  expect((await new ProblemsetAdapter(c).submit(target, code, "c")).id).toBe(
    "99",
  );
});

it("does not infer success from the newest row with different code", async () => {
  let sent = false;
  const c = new AccodingClient(undefined, async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/users/me") return json({ id: 5 });
    if (u.pathname === "/problem/0/index") return new Response(problemPage);
    if (init.method === "POST") {
      sent = true;
      return new Response(null, {
        status: 302,
        headers: { location: "/problem/0/submission" },
      });
    }
    if (u.pathname === "/problem/0/submission")
      return new Response(sent ? '<a href="/submission/99">99</a>' : "");
    if (u.pathname === "/submission/getSubmissionApi")
      return json([
        { id: 99, result: "AC", problem_id: 0, creator_id: 5, lang: "c" },
      ]);
    return new Response("<pre><code>unrelated code</code></pre>");
  });
  await expect(
    new ProblemsetAdapter(c).submit(
      { kind: "problemset", problemId: "0" },
      "mine",
      "c",
    ),
  ).rejects.toMatchObject({ kind: "unknown" });
});

it("logout cancellation cannot retry against a fresh session", async () => {
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
  const c = new AccodingClient(undefined, transport);
  const pending = c.request("/read");
  await started;
  c.cancel();
  await expect(pending).rejects.toThrow("取消");
  expect(transport).toHaveBeenCalledTimes(1);
});

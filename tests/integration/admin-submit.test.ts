import { expect, it } from "vitest";
import { AccodingClient } from "../../src/accoding/client";
import {
  ProblemsetAdapter,
  parseProblemPage,
  encodeSubmissionCode,
} from "../../src/accoding/adapters";
import { ADMIN_ORIGIN, ORIGIN, bindingId } from "../../src/model";
import { problemPage } from "../fixtures/synthetic";
const page = problemPage
  .replace("<form action=", '<form method="post" action=')
  .replace('<input name="_csrf" value="SYNTHETIC-CSRF">', "");
const encodingScript =
  '<script>function encrypt(str, key) { if (str.includes("print") || str.includes("length")) {} } function check(){ const key = 10; }</script>';
const target = {
  kind: "problemset",
  problemId: "0",
  service: "admin",
} as const;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
it("permits a verified CSRF-less admin form while still requiring student CSRF", () => {
  expect(
    parseProblemPage(page, `${ADMIN_ORIGIN}/problem/0/index`, "0", ADMIN_ORIGIN)
      .problem.target,
  ).toEqual(target);
  expect(() =>
    parseProblemPage(page, `${ORIGIN}/problem/0/index`, "0"),
  ).toThrow("表单");
  expect(() =>
    parseProblemPage(page, `${ADMIN_ORIGIN}/problem/0/index`, "0"),
  ).toThrow();
  expect(bindingId(target)).not.toBe(
    bindingId({ kind: "problemset", problemId: "0" }),
  );
});
it("mirrors admin form transport encoding without changing the original code or non-ASCII characters", async () => {
  const code = 'int main(){printf("你好\\n");return 0;}\n';
  let body = "";
  const client = new AccodingClient(undefined, async (url, init) => {
    expect(new URL(url).origin).toBe(ADMIN_ORIGIN);
    if (init.method === "POST") {
      body = String(init.body);
      return json({ id: 99, result: "WT", problem_id: 0 });
    }
    if (url.endsWith("/api/users/me")) return json({ id: 5 });
    if (url.endsWith("/submission")) return new Response("<html></html>");
    return new Response(page + encodingScript);
  }).adminSubmitter("0");
  const result = await new ProblemsetAdapter(client).submit(target, code, "c");
  const fields = new URLSearchParams(body),
    encoded = fields.get("code")!;
  expect(fields.has("_csrf")).toBe(false);
  expect(encoded).not.toBe(code);
  expect(
    encoded
      .split("")
      .map((c) =>
        c.charCodeAt(0) <= 127
          ? String.fromCharCode((c.charCodeAt(0) + 118) % 128)
          : c,
      )
      .join(""),
  ).toBe(code);
  expect(encoded).toContain("你好");
  expect(encodeSubmissionCode('puts("hello");', true)).toBe('puts("hello");');
  expect(encodeSubmissionCode(code, false)).toBe(code);
  expect(result.target).toEqual(target);
});
it("polls admin results on port 4000 and rejects accidentally using the student client", async () => {
  let queried = "";
  const client = new AccodingClient(undefined, async (url) => {
    queried = url;
    return json([{ id: 99, result: "AC", problem_id: 0, creator_id: 5 }]);
  });
  await expect(new ProblemsetAdapter(client).get(target, "99")).rejects.toThrow(
    "端口",
  );
  expect(
    (await new ProblemsetAdapter(client.adminReader()).get(target, "99"))
      .result,
  ).toBe("AC");
  expect(queried === `${ADMIN_ORIGIN}/submission/getSubmissionApi`).toBe(true);
});

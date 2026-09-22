import { expect, it } from "vitest";
import { AccodingClient } from "../../src/accoding/client";
import { ProblemsetAdapter } from "../../src/accoding/adapters";
import { hash } from "../../src/model";

const code = "/* my comment */\nint main() { return 0; }\n";
const target = {
  kind: "problemset",
  problemId: "1",
  service: "admin",
} as const;
const attempt = {
  createdAt: "2026-09-22T10:00:00.000Z",
  sourceHash: hash(code),
  language: "c",
};
const record = {
  id: 99,
  result: "AC",
  creator_id: 5,
  problem_id: 1,
  lang: "c",
  created_at: "2026-09-22T10:00:02.000Z",
};
function adapter(records = [record], source = code) {
  return new ProblemsetAdapter(
    new AccodingClient(undefined, async (url, init) => {
      if (url.endsWith("/submission/getSubmissionApi")) {
        expect(init.method).toBe("POST");
        return new Response(JSON.stringify(records), {
          headers: { "content-type": "application/json" },
        });
      }
      expect(init.method).not.toBe("POST");
      if (url.endsWith("/problem/1/submission"))
        return new Response(
          `<table>${records.map((r) => `<tr><td id="submission_id${r.id}">${r.id}</td><td><a href="/user/5/index">owner</a></td></tr>`).join("")}</table>`,
        );
      const id = url.split("/").pop();
      return new Response(
        `<pre><code>/*\n Submission_id: ${id}\n Problem: 1\n*/\n\n${source}</code></pre>`,
      );
    }).adminReader(),
  );
}
it("recovers an unknown admin submission from its timestamp and exact source fingerprint", async () => {
  expect(await adapter().recoverAttempt(target, "5", attempt)).toMatchObject({
    id: "99",
    result: "AC",
    createdAt: record.created_at,
  });
});
it("does not attach an old result or different source to a new attempt", async () => {
  expect(
    await adapter([
      { ...record, created_at: "2026-09-21T10:00:00Z" },
    ]).recoverAttempt(target, "5", attempt),
  ).toBeUndefined();
  expect(
    await adapter([record], "int main(){}\n").recoverAttempt(
      target,
      "5",
      attempt,
    ),
  ).toBeUndefined();
});
it("leaves concurrent identical submissions unresolved instead of guessing an ID", async () => {
  expect(
    await adapter([record, { ...record, id: 100 }]).recoverAttempt(
      target,
      "5",
      attempt,
    ),
  ).toBeUndefined();
});
it("matches original CRLF source after the website normalizes line endings", async () => {
  expect(
    await adapter().recoverAttempt(target, "5", {
      ...attempt,
      sourceHash: hash(code.replace(/\n/g, "\r\n")),
    }),
  ).toMatchObject({ id: "99" });
});

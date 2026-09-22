import { it, expect } from "vitest";
import { submissionSource } from "../../src/accoding/adapters";
it("accepts both observed headers and checks complete IDs without stripping the submitted code", () => {
  const code = "/* user comment */\nint main() { return 0; }\n";
  for (const key of ["Problem", "Problem_id"]) {
    const html = `<pre><code>/* \nSubmission_id: 99\n${key}: 11\n*/\n\n${code}</code></pre>`;
    expect(submissionSource(html, "99", "11")).toBe(code);
    expect(submissionSource(html, "9", "11")).toBeUndefined();
    expect(submissionSource(html, "99", "1")).toBeUndefined();
  }
  expect(
    submissionSource("<pre><code>int main(){}</code></pre>", "99", "11"),
  ).toBeUndefined();
});

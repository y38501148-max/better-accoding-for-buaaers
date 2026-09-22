import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
let out =
  "# Third-party notices\n\nThis project is independently implemented under MIT. No CPH source code is included.\n\nProduction dependencies and their notices are listed below.\n";
for (const [dir, pkg] of Object.entries(lock.packages)) {
  if (!dir || pkg.dev) continue;
  let meta;
  try {
    meta = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  out += `\n## ${meta.name} ${meta.version}\n\nLicense: ${JSON.stringify(meta.license ?? "SEE LICENSE")}\n`;
  let license;
  for (const f of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE-MIT.txt",
    "license",
    "license.md",
  ]) {
    try {
      license = await readFile(path.join(dir, f), "utf8");
      break;
    } catch {
      /* Try another conventional filename. */
    }
  }
  if (!license && meta.name === "boolbase")
    license = await readFile("docs/licenses/boolbase-LICENSE", "utf8");
  if (!license && meta.name === "launder") {
    out +=
      "\nThe package declares MIT and credits Apostrophe Technologies, Inc. It does not include a separate license file. The parent project MIT notice is reproduced below.\n";
    license = await readFile("docs/licenses/apostrophe-LICENSE.md", "utf8");
  }
  if (!license) throw Error(`Missing license for ${meta.name}`);
  out +=
    "\n```text\n" +
    license
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim() +
    "\n```\n";
}
await writeFile("THIRD_PARTY_NOTICES.md", out);
console.log("Generated production dependency notices.");

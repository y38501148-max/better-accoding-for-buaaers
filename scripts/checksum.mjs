import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = (await readdir("release"))
  .filter((f) => f.endsWith(".vsix"))
  .sort();
if (!files.length) throw new Error("No VSIX files found.");
await writeFile(
  "release/SHA256SUMS",
  (
    await Promise.all(
      files.map(
        async (f) =>
          `${createHash("sha256")
            .update(await readFile("release/" + f))
            .digest("hex")}  ${f}`,
      ),
    )
  ).join("\n") + "\n",
);
console.log(`Wrote checksums for ${files.length} package(s).`);

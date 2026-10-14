import { it, expect } from "vitest";
import { bindingSchema } from "../../src/workspace/schema";
import {
  defaultSourceFiles,
  localSourceChoices,
  managedSourceFiles,
} from "../../src/workspace/sources";
import { problem } from "../fixtures/synthetic";

it("offers both local languages independently of OJ restrictions and preserves a custom binding", () => {
  const binding = bindingSchema.parse({
    schemaVersion: 2,
    bindingId: "problem-0",
    problem: { ...problem, languages: ["c"] },
    sourceFile: "solutions/custom.cc",
    fetchedAt: new Date().toISOString(),
    revision: 0,
    cases: [],
    tombstones: [],
  });
  expect(localSourceChoices(binding)).toEqual([
    {
      label: "C++",
      description: "solutions/custom.cc",
      sourceFile: "solutions/custom.cc",
    },
    {
      label: "C",
      description: "problems/0/main.c",
      sourceFile: "problems/0/main.c",
    },
  ]);
  expect(managedSourceFiles(binding)).toEqual([
    "problems/0/main.c",
    "problems/0/main.cpp",
    "solutions/custom.cc",
  ]);
  expect(
    defaultSourceFiles({
      kind: "contest",
      contestId: "7",
      problemId: "3",
      contestOrder: 0,
    }),
  ).toEqual({
    c: "contests/7/3/main.c",
    cpp: "contests/7/3/main.cpp",
  });
});

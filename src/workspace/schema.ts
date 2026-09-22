import { z } from "zod";
import { caseSchema, targetSchema } from "../model";
export const problemSchema = z.object({
  target: targetSchema,
  title: z.string(),
  label: z.string(),
  statement: z.object({
    format: z.enum(["html", "markdown"]),
    content: z.string(),
    baseUrl: z.string(),
    images: z.record(z.string()).optional(),
  }),
  languages: z.array(z.string()),
  samples: z.array(
    z.object({ key: z.string(), input: z.string(), expected: z.string() }),
  ),
  warnings: z.array(z.string()),
  timeLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
  special: z.boolean(),
});
export const bindingSchema = z.object({
  schemaVersion: z.literal(2),
  bindingId: z.string().regex(/^(problem-\d+|contest-\d+-\d+)$/),
  problem: problemSchema,
  sourceFile: z.string(),
  selectedSubmissionLanguage: z.string().optional(),
  fetchedAt: z.string(),
  revision: z.number().int().nonnegative(),
  cases: z.array(caseSchema),
  tombstones: z.array(z.string()),
  deletedCases: z.array(caseSchema).optional(),
  fileHashes: z.record(z.string()).optional(),
});

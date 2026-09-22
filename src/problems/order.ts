import type { Problem, Binding } from "../model";

export function contestLabel(order: number): string {
  let n = order + 1;
  let label = "";
  do {
    n--;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  } while (n > 0);
  return label;
}
export function problemLabel(
  problem: Pick<Problem, "target" | "label">,
): string {
  return problem.target.kind === "contest"
    ? contestLabel(problem.target.contestOrder)
    : problem.label;
}
export function compareBindings(a: Binding, b: Binding): number {
  const left = a.problem.target,
    right = b.problem.target;
  const numeric = (x: string, y: string) =>
    BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
  if (left.kind !== right.kind) return left.kind === "contest" ? -1 : 1;
  if (left.kind === "contest" && right.kind === "contest")
    return (
      numeric(left.contestId, right.contestId) ||
      left.contestOrder - right.contestOrder ||
      numeric(left.problemId, right.problemId)
    );
  return numeric(left.problemId, right.problemId);
}

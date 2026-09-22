import { idSchema, type Problem, type ContestSnapshot } from "../model";
import { ContestAdapter, currentUser } from "./adapters";
import { AccodingClient, ApiError } from "./client";

/** Recheck the exact contest on import/sync without a role toggle or permission
 * cache. Submissions continue using the student client and original IDs. */
export async function fetchContestSnapshotForImport(
  student: AccodingClient,
  id: string,
  report?: (message: string) => void,
): Promise<ContestSnapshot> {
  id = idSchema.parse(id);
  const admin = student.adminReader();
  const probe = { retries: 0, timeoutMs: 4000 };
  try {
    // Authenticate, then let the contest API enforce this account's read access.
    // An edit-form check would exclude assistants with only read permission.
    await currentUser(admin, probe);
    const problems = await new ContestAdapter(admin).snapshot(id, probe);
    report?.(`比赛 #${id}：已使用 4000 管理端读取题目。`);
    return problems;
  } catch (e) {
    // Cancellation must not start a fallback request with a fresh login session.
    if (!(e instanceof ApiError)) throw e;
    report?.(`比赛 #${id}：管理端不可用（${e.kind}），使用学生端。`);
  }
  return new ContestAdapter(student).snapshot(id);
}

export async function fetchContestForImport(
  student: AccodingClient,
  id: string,
  report?: (message: string) => void,
): Promise<Problem[]> {
  return (await fetchContestSnapshotForImport(student, id, report)).problems;
}

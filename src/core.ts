import { changedFiles, resolveBase, resolveRepository } from "./git.js";
import { markdownReport } from "./report.js";
import type { ReviewRequest } from "./types.js";
import { runValidations } from "./validation.js";

export async function reviewRepository(request: ReviewRequest): Promise<string> {
  const repository = await resolveRepository(request.repositoryPath);
  const base = await resolveBase(repository.root, request.baseRef);
  const files = await changedFiles(repository.root, base.mergeBase);
  const validations = await runValidations(request.validationCommands ?? [], repository.root);
  return markdownReport({
    repositoryPath: repository.root,
    changedFiles: files,
    validationResults: validations,
  });
}

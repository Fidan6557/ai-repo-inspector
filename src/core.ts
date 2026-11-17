import { changedFiles, resolveBase, resolveRepository } from "./git.js";
import { DEFAULT_LIMITS, SCHEMA_VERSION, type ReviewResult, type ValidationResult } from "./schema.js";
import type { ReviewRequest } from "./types.js";
import { runValidations } from "./validation.js";

/**
 * Shared review orchestration. Adapters (CLI, MCP) only translate their input
 * into a ReviewRequest and render the returned ReviewResult; they must not add
 * behaviour of their own.
 */
export async function reviewRepository(request: ReviewRequest): Promise<ReviewResult> {
  const limits = { ...DEFAULT_LIMITS, ...request.limits };
  const repository = await resolveRepository(request.repositoryPath);
  const base = await resolveBase(repository.root, request.baseRef);
  const allFiles = await changedFiles(repository.root, base.mergeBase);

  const rawValidations = await runValidations(request.validationCommands ?? [], repository.root);
  const validations: ValidationResult[] = rawValidations.map((result) => {
    const { text, truncated } = truncateMiddle(result.output, limits.maxOutputChars);
    return { command: result.command, status: result.status, output: text, outputTruncated: truncated };
  });

  const byStatus: Record<string, number> = {};
  for (const file of allFiles) byStatus[file.status] = (byStatus[file.status] ?? 0) + 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    summary: summarize(allFiles.length, base.ref, base.mergeBase, validations),
    repository,
    base,
    changedFiles: allFiles.slice(0, limits.maxFiles),
    totals: { changedFiles: allFiles.length, byStatus },
    truncated: { changedFiles: allFiles.length > limits.maxFiles },
    limits,
    validations,
  };
}

function summarize(fileCount: number, baseRef: string, mergeBase: string, validations: ValidationResult[]): string {
  const files = `${fileCount} changed file${fileCount === 1 ? "" : "s"} compared with ${baseRef} (merge-base ${mergeBase.slice(0, 12)})`;
  if (validations.length === 0) return `${files}; no validation commands were run.`;
  const failed = validations.filter((v) => v.status !== "passed").length;
  return `${files}; validations: ${validations.length - failed} passed, ${failed} failed.`;
}

/** Keeps the head and tail of long output; failures usually show up at the end. */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars * 0.25);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

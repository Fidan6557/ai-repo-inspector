import { z } from "zod";

/**
 * The single result contract shared by every interface. The CLI's
 * `--format json` output and the MCP tool's `structuredContent` are both
 * instances of ReviewResultSchema.
 */
export const SCHEMA_VERSION = 1 as const;

export type Limits = {
  /** Maximum number of changed files included in a result. */
  maxFiles: number;
  /** Maximum characters of output kept per validation command. */
  maxOutputChars: number;
  /** Per-command timeout for validation commands. */
  validationTimeoutMs: number;
};

export const DEFAULT_LIMITS: Limits = { maxFiles: 200, maxOutputChars: 8000, validationTimeoutMs: 300_000 };

export const ChangeStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "unmerged",
  "untracked",
]);

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: ChangeStatusSchema,
  previousPath: z.string().optional(),
});

export const ValidationResultSchema = z.object({
  command: z.string(),
  status: z.enum(["passed", "failed", "timed_out", "error"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int(),
  output: z.string().describe("Combined stdout/stderr; head and tail kept when long."),
  outputTruncated: z.boolean(),
});

export const ReviewResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  summary: z.string().describe("One-line human-readable summary of the review."),
  repository: z.object({
    root: z.string().describe("Absolute path of the repository's top-level directory."),
    head: z.string().describe("Commit SHA of HEAD."),
    branch: z.string().nullable().describe("Current branch, or null when HEAD is detached."),
  }),
  base: z.object({
    ref: z.string().describe("Base ref the changes are compared against."),
    resolvedFrom: z.enum(["argument", "origin/HEAD", "main", "master"]),
    commit: z.string(),
    mergeBase: z.string().describe("Merge-base of the base ref and HEAD; changes are relative to this commit."),
  }),
  changedFiles: z.array(ChangedFileSchema).describe("Changed files, sorted by path, capped at limits.maxFiles."),
  totals: z.object({
    changedFiles: z.number().int().describe("Total changed files before any cap was applied."),
    byStatus: z.record(z.number().int()),
  }),
  truncated: z.object({
    changedFiles: z.boolean().describe("True when changedFiles was cut to limits.maxFiles."),
  }),
  limits: z.object({
    maxFiles: z.number().int(),
    maxOutputChars: z.number().int(),
    validationTimeoutMs: z.number().int(),
  }),
  validations: z.array(ValidationResultSchema),
});

export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;
export type ChangedFile = z.infer<typeof ChangedFileSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

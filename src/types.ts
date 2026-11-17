import type { Limits } from "./schema.js";

export type { ChangedFile, ChangeStatus, ReviewResult, ValidationResult } from "./schema.js";

export type ReviewRequest = {
  repositoryPath: string;
  baseRef?: string;
  validationCommands?: string[];
  limits?: Partial<Limits>;
};

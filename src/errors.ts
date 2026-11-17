export type InspectorErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_REPOSITORY"
  | "INVALID_BASE_REF"
  | "BASE_REF_NOT_FOUND"
  | "GIT_FAILED";

/**
 * An expected, user-correctable failure. Both adapters render it the same way:
 * the CLI prints `error[CODE]: message` and exits 2; MCP returns it as an
 * `isError` tool result.
 */
export class InspectorError extends Error {
  constructor(
    readonly code: InspectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InspectorError";
  }

  format(): string {
    return `error[${this.code}]: ${this.message}`;
  }
}

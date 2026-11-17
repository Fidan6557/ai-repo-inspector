import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reviewRepository } from "./core.js";
import { InspectorError } from "./errors.js";
import { PathPolicy } from "./path-policy.js";
import { renderMarkdown } from "./report.js";
import { ReviewResultSchema } from "./schema.js";

const MAX_ERROR_CHARS = 2000;

// strict(): unknown arguments (for example the old `validationCommands` or a
// misspelled `repoPath`) are rejected instead of silently dropped, so a caller
// can never believe a command ran when it did not.
export const ReviewToolInputSchema = z
  .object({
    repo_path: z
      .string()
      .min(1)
      .describe("Absolute path to the Git repository (or a directory inside it) to inspect."),
    base_ref: z
      .string()
      .min(1)
      .optional()
      .describe("Branch, tag or commit to compare against. Defaults to origin/HEAD, then main, then master."),
  })
  .strict();

function describeTool(policy: PathPolicy): string {
  return [
    "Read-only review of a local Git repository.",
    "Lists every file that differs between the working tree and the merge-base of HEAD with a base ref",
    "(committed, staged, unstaged and untracked), with a summary line first and the list capped at 200 files.",
    "Returns Markdown text plus the same data as structured JSON.",
    "It never runs commands and never writes files; run validations with the inspector CLI instead.",
    policy.restricted ? `Only repositories inside these directories may be inspected: ${policy.roots.join(", ")}.` : "",
  ]
    .join(" ")
    .trim();
}

export type McpServerOptions = {
  /** Operator-configured repository scope. Defaults to unrestricted. */
  policy?: PathPolicy;
};

export const SERVER_USAGE = `Usage: inspector-mcp [--allowed-root <dir>]...

Starts the read-only repository inspector MCP server on stdio.

Options:
  --allowed-root <dir>  Only allow repositories inside <dir>. Repeatable.
                        Without it, any absolute path the user can read
                        may be inspected.
  -h, --help            Show this help.`;

/** Parses the server's own command line (set by the operator in the MCP client config). */
export function parseServerArgs(argv: string[]): { help: boolean; policy: PathPolicy } {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "allowed-root": { type: "string", multiple: true }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new InspectorError("INVALID_ARGUMENTS", (error as Error).message);
  }
  const roots = values["allowed-root"] ?? [];
  return { help: values.help ?? false, policy: roots.length > 0 ? PathPolicy.fromRoots(roots) : PathPolicy.unrestricted() };
}

/**
 * MCP adapter. It exposes only read-only git inspection: the caller is an AI
 * agent whose arguments may be influenced by untrusted repository content, so
 * no command execution or file writes are reachable from here, and the
 * operator can confine it to allowed roots.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const policy = options.policy ?? PathPolicy.unrestricted();
  const server = new McpServer({ name: "repository-inspector", version: "2.0.0" });

  server.registerTool(
    "review_repository",
    {
      title: "Review repository changes",
      description: describeTool(policy),
      inputSchema: ReviewToolInputSchema,
      outputSchema: ReviewResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repo_path, base_ref }) => {
      try {
        const repositoryPath = policy.resolveRequestedPath(repo_path);
        const result = await reviewRepository(
          { repositoryPath, baseRef: base_ref },
          { authorizeRepository: (root) => policy.authorizeRepository(root) },
        );
        return {
          content: [{ type: "text", text: renderMarkdown(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const message =
          error instanceof InspectorError
            ? error.format()
            : `error[INTERNAL]: ${error instanceof Error ? error.message : String(error)}`;
        return { isError: true, content: [{ type: "text", text: message.slice(0, MAX_ERROR_CHARS) }] };
      }
    },
  );

  return server;
}

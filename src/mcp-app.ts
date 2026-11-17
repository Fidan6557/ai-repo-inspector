import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { reviewRepository } from "./core.js";
import { InspectorError } from "./errors.js";
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

const DESCRIPTION = [
  "Read-only review of a local Git repository.",
  "Lists every file that differs between the working tree and the merge-base of HEAD with a base ref",
  "(committed, staged, unstaged and untracked), with a summary line first and the list capped at 200 files.",
  "Returns Markdown text plus the same data as structured JSON.",
  "It never runs commands and never writes files; run validations with the inspector CLI instead.",
].join(" ");

/**
 * MCP adapter. It exposes only read-only git inspection: the caller is an AI
 * agent whose arguments may be influenced by untrusted repository content, so
 * no command execution or file writes are reachable from here.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "repository-inspector", version: "2.0.0" });

  server.registerTool(
    "review_repository",
    {
      title: "Review repository changes",
      description: DESCRIPTION,
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
        if (!path.isAbsolute(repo_path)) {
          // The server's working directory is chosen by the MCP client and is
          // unknown to the agent, so relative paths would be ambiguous.
          throw new InspectorError("INVALID_REPOSITORY", `repo_path must be an absolute path, got: ${repo_path}`);
        }
        const result = await reviewRepository({ repositoryPath: repo_path, baseRef: base_ref });
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

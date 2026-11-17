import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { InspectorError } from "./errors.js";
import { gitCommonDir } from "./git.js";

/** True when `target` is `root` itself or somewhere beneath it. */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  // path.relative returns an absolute path across Windows drives, and a path
  // starting with ".." when target is outside root. A sibling such as
  // "/allowed-evil" is outside "/allowed" (no string-prefix matching).
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function canonical(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Restricts which repositories the MCP adapter may inspect. Roots are set by
 * the operator when the server starts (never by the MCP caller) and are
 * canonicalized once with realpath, so symlinks, junctions, `..` segments and
 * Windows short names cannot be used to step outside them.
 */
export class PathPolicy {
  private constructor(readonly roots: readonly string[]) {}

  /** No roots: any absolute path is accepted (still read-only). */
  static unrestricted(): PathPolicy {
    return new PathPolicy([]);
  }

  /** Fails closed: every root must exist and be a directory. */
  static fromRoots(roots: readonly string[]): PathPolicy {
    const resolved = roots.map((root) => {
      const real = canonical(path.resolve(root));
      if (!real || !statSync(real).isDirectory()) {
        throw new InspectorError("INVALID_ARGUMENTS", `Allowed root does not exist or is not a directory: ${root}`);
      }
      return real;
    });
    return new PathPolicy([...new Set(resolved)]);
  }

  get restricted(): boolean {
    return this.roots.length > 0;
  }

  private assertWithinRoots(target: string, what: string): void {
    if (this.restricted && !this.roots.some((root) => isWithin(root, target))) {
      throw new InspectorError(
        "PATH_NOT_ALLOWED",
        `${what} is outside the allowed roots (${this.roots.join(", ")}): ${target}`,
      );
    }
  }

  /**
   * Validates a caller-supplied path and returns its canonical form.
   * The lexical check runs before anything touches the filesystem, so callers
   * cannot probe for the existence of paths outside the roots.
   */
  resolveRequestedPath(requested: string): string {
    if (!path.isAbsolute(requested)) {
      // The server's working directory is chosen by the MCP client and is
      // unknown to the agent, so relative paths would be ambiguous.
      throw new InspectorError("INVALID_REPOSITORY", `repo_path must be an absolute path, got: ${requested}`);
    }
    const lexical = path.resolve(requested);
    this.assertWithinRoots(lexical, "repo_path");

    const real = canonical(lexical);
    if (!real) {
      throw new InspectorError("INVALID_REPOSITORY", `Repository path does not exist: ${lexical}`);
    }
    // A symlink or junction inside a root may point outside it.
    this.assertWithinRoots(real, "repo_path (after resolving links)");
    return real;
  }

  /**
   * Re-checks what git actually resolved: the work-tree top level (a
   * subdirectory inside a root may belong to a repository above it) and the
   * git directory (a `.git` file can redirect to an object store elsewhere,
   * whose history would otherwise leak file names).
   */
  async authorizeRepository(root: string): Promise<void> {
    if (!this.restricted) return;
    this.assertWithinRoots(canonical(root) ?? root, "Repository root");
    const commonDir = await gitCommonDir(root);
    this.assertWithinRoots(canonical(commonDir) ?? commonDir, "Repository git directory");
  }
}

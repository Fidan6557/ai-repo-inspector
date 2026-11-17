import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const buildConfig = JSON.parse(readFileSync("tsconfig.build.json", "utf8"));

describe("packaging", () => {
  it("builds src/ directly into dist/ so bin paths resolve", () => {
    expect(buildConfig.compilerOptions.rootDir).toBe("src");
    expect(buildConfig.compilerOptions.outDir).toBe("dist");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
  });

  it("points every bin entry at a file that the build emits", () => {
    const bins = Object.values(pkg.bin as Record<string, string>);
    expect(bins.length).toBeGreaterThan(0);
    for (const bin of bins) {
      const match = /^\.\/dist\/(.+)\.js$/.exec(bin);
      expect(match, `${bin} must live directly under ./dist`).not.toBeNull();
      expect(existsSync(`src/${match![1]}.ts`), `src/${match![1]}.ts`).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_PARTIAL_CONTENT_BYTES,
  PROMPT_PARTIAL_ROOT,
  PromptPartialBundleError,
  collectPromptPartialPaths,
  resolvePromptPartialsFromBundle,
} from "./prompt-partials.js";

function configuration(...includes: unknown[]) {
  return {
    triggers: [
      null,
      { steps: [null, { prompt: [null, {}, ...includes.map((include) => ({ include }))] }] },
    ],
  };
}

async function bundleResult(
  config: unknown,
  files: { path: string; content: string }[],
): Promise<unknown> {
  try {
    return [...(await resolvePromptPartialsFromBundle({ configuration: config, files }))];
  } catch (error) {
    if (!(error instanceof PromptPartialBundleError)) throw error;
    return error.issues;
  }
}

describe("prompt partial bundle characterization", () => {
  it("ignores non-prompt nodes and deduplicates normalized paths in encounter order", () => {
    expect(collectPromptPartialPaths(null)).toEqual([]);
    expect(collectPromptPartialPaths(configuration("b.md", "a\\c.md", "b.md"))).toEqual([
      `${PROMPT_PARTIAL_ROOT}/b.md`,
      `${PROMPT_PARTIAL_ROOT}/a/c.md`,
    ]);
    expect(() => collectPromptPartialPaths(configuration(42))).toThrow(
      /include path must be a string/,
    );
  });

  it("resolves with the first reference order and hashes UTF-8 content", async () => {
    const result = await bundleResult(configuration("b.md", "a.md"), [
      { path: "a.md", content: "" },
      { path: "b.md", content: "abc" },
    ]);
    expect(result).toEqual([
      [
        `${PROMPT_PARTIAL_ROOT}/b.md`,
        {
          path: `${PROMPT_PARTIAL_ROOT}/b.md`,
          content: "abc",
          contentHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
      ],
      [
        `${PROMPT_PARTIAL_ROOT}/a.md`,
        {
          path: `${PROMPT_PARTIAL_ROOT}/a.md`,
          content: "",
          contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
    ]);
  });

  it("orders byte, unsafe path, duplicate, missing and unreferenced issues", async () => {
    const root = PROMPT_PARTIAL_ROOT;
    expect(
      await bundleResult(configuration("z.md", "m.md"), [
        { path: "../x", content: "x".repeat(MAX_PROMPT_PARTIAL_CONTENT_BYTES + 1) },
        { path: "b.md", content: "" },
        { path: "%62.md", content: "" },
        { path: "a.md", content: "" },
      ]),
    ).toEqual([
      {
        path: ["partials", 0, "content"],
        message: `content exceeds the ${MAX_PROMPT_PARTIAL_CONTENT_BYTES}-byte limit`,
      },
      {
        path: ["partials", 0, "path"],
        message: "invalid prompt partial: path must not contain empty, '.' or '..' segments: ../x",
      },
      {
        path: ["partials", 2, "path"],
        message: `duplicate partial path after normalization: ${root}/b.md`,
      },
      {
        path: ["partials", `${root}/m.md`],
        message: `partial file is required by the configuration but was not supplied: ${root}/m.md`,
      },
      {
        path: ["partials", `${root}/z.md`],
        message: `partial file is required by the configuration but was not supplied: ${root}/z.md`,
      },
      {
        path: ["partials", 3, "path"],
        message: `partial file is not referenced by the configuration: ${root}/a.md`,
      },
      {
        path: ["partials", 1, "path"],
        message: `partial file is not referenced by the configuration: ${root}/b.md`,
      },
    ]);
    expect(await bundleResult(configuration(42), [])).toEqual([
      { path: ["yaml"], message: "invalid prompt partial: include path must be a string" },
    ]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { releaseNotes } from "./release-notes.mjs";

test("groups the subjects and renders user text literally", () => {
  assert.equal(
    releaseNotes(["fix: repair", "merge topic", "feat(ui): add", "fix!: remove @name"]),
    [
      "## feat",
      "",
      "- feat(ui): add",
      "",
      "## fix",
      "",
      "- fix: repair",
      "- fix!: remove \\@name",
      "",
      "## other",
      "",
      "- merge topic",
      "",
    ].join("\n"),
  );
});

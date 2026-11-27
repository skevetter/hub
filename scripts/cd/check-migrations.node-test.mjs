import assert from "node:assert/strict";
import test from "node:test";
import { needsRollbackReview } from "./check-migrations.mjs";

test("flags destructive migration SQL", () => {
  for (const sql of [
    "DROP TABLE foo;",
    'ALTER TABLE foo RENAME COLUMN "x" TO "y";',
    "ALTER TABLE foo ALTER COLUMN x TYPE integer;",
    "ALTER TABLE foo ALTER COLUMN x SET NOT NULL;",
    "UPDATE foo SET x = 'value';",
    "DELETE FROM foo WHERE x IS NULL;",
  ]) {
    assert.equal(needsRollbackReview(sql), true, sql);
  }
});

test("accepts additive migrations and referential action clauses", () => {
  assert.equal(
    needsRollbackReview(`
    -- DROP a table later
    CREATE TABLE "new" (id int, parent int REFERENCES old(id) ON UPDATE CASCADE ON DELETE CASCADE);
    ALTER TABLE old ADD COLUMN label text;
  `),
    false,
  );
});

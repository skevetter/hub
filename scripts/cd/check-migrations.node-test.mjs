import assert from "node:assert/strict";
import test from "node:test";
import { needsRollbackReview } from "./check-migrations.mjs";

test("flags destructive migration SQL", () => {
  for (const sql of [
    "DROP TABLE foo;",
    "DROP INDEX foo;",
    'TRUNCATE "foo";',
    'ALTER TABLE foo RENAME COLUMN "x" TO "y";',
    'ALTER TABLE foo ALTER COLUMN "old value" TYPE integer;',
    "ALTER TABLE foo ALTER COLUMN x SET NOT NULL;",
    "ALTER TABLE foo ADD COLUMN x int NOT NULL;",
    "ALTER TABLE foo ADD x int NOT NULL, ADD y int DEFAULT 0;",
    "CREATE UNIQUE INDEX CONCURRENTLY idx ON public.foo (id);",
    "ALTER TABLE foo ADD CONSTRAINT idx UNIQUE (id);",
    "ALTER TYPE foo ADD VALUE 'new';",
    "INSERT INTO foo (x) VALUES (1);",
    "UPDATE foo SET x = 'value';",
    'UPDATE "my schema"."a table" SET x = 1;',
    "DELETE FROM foo WHERE x IS NULL;",
  ]) {
    assert.equal(needsRollbackReview(sql), true, sql);
  }
});

test("does not exempt existing tables when editing their original migration", () => {
  const sql = 'CREATE TABLE "existing" (id int); CREATE UNIQUE INDEX idx ON "existing" (id);';
  const known = new Set([JSON.stringify(["existing"])]);
  assert.equal(needsRollbackReview(sql, new Set(), known), true);
});

test("accepts additive migrations and referential action clauses", () => {
  assert.equal(
    needsRollbackReview(`
    -- DROP a table later
    CREATE TABLE "new" (id int, parent int REFERENCES old(id) ON UPDATE CASCADE ON DELETE CASCADE);
    CREATE UNIQUE INDEX idx ON "new" (id);
    ALTER TABLE "new" ADD CONSTRAINT constraint_id UNIQUE (id);
    ALTER TABLE old ADD COLUMN label text;
    ALTER TABLE old ADD COLUMN enabled bool NOT NULL DEFAULT false;
  `),
    false,
  );
});

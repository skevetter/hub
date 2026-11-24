import { createDatabase } from "../pg.js";
import { postgresDatabaseRuntime } from "../runtime/index.js";
import type { DatabaseRuntimeBundle, PostgresPoolOptions } from "../runtime/index.js";
import type { Database } from "../types.js";

const testRuntimes = new WeakMap<Database, DatabaseRuntimeBundle>();

export async function createPostgresTestRuntime(
  connectionString: string,
  poolOptions?: PostgresPoolOptions,
) {
  const bundle = await postgresDatabaseRuntime(connectionString, poolOptions);
  try {
    await bundle.runtime.migrate();
    return { ...bundle, database: createDatabase(bundle.runtime, bundle.locks) };
  } catch (error) {
    await bundle.runtime.close().catch(() => undefined);
    throw error;
  }
}

export async function createPostgresTestDatabase(
  connectionString: string,
  poolOptions?: PostgresPoolOptions,
) {
  const composed = await createPostgresTestRuntime(connectionString, poolOptions);
  testRuntimes.set(composed.database, composed);
  return composed.database;
}

export { createPostgresTestDatabase as createDatabase };

export async function createPostgresQueryRuntime(connectionString: string) {
  return (await postgresDatabaseRuntime(connectionString)).runtime;
}

export { createPostgresQueryRuntime as createPostgresPool };

export function testDatabaseRuntime(database: Database) {
  const bundle = testRuntimes.get(database);
  if (bundle === undefined) throw new Error("database was not created by the test runtime");
  return bundle.runtime;
}

export function testDatabaseLocks(database: Database) {
  const bundle = testRuntimes.get(database);
  if (bundle === undefined) throw new Error("database was not created by the test runtime");
  return bundle.locks;
}

import { randomUUID } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPostgresQueryRuntime, createPostgresTestRuntime } from "./runtime.js";

const migratedTemplates = new WeakMap<StartedPostgreSqlContainer, Promise<string>>();

export function isolatedPostgresDatabase(adminUrl: string) {
  const name = `hub_test_${randomUUID().replaceAll("-", "")}`;
  return {
    name,
    url: databaseUrl(adminUrl, name),
    async drop() {
      const admin = await createPostgresQueryRuntime(adminUrl);
      try {
        await admin.query(`drop database if exists "${name}"`);
      } finally {
        await admin.close();
      }
    },
  };
}

// Cloning a migrated template takes about 45 ms. Running every migration on a fresh database takes
// about 400 ms on an idle machine and several seconds when parallel suites load it.
export async function clonedPostgresDatabase(postgres: StartedPostgreSqlContainer) {
  const adminUrl = postgres.getConnectionUri();
  const template = await migratedTemplate(postgres);
  const isolated = isolatedPostgresDatabase(adminUrl);
  const admin = await createPostgresQueryRuntime(adminUrl);
  try {
    await admin.query(`create database "${isolated.name}" template "${template}"`);
  } finally {
    await admin.close();
  }
  return isolated;
}

function migratedTemplate(postgres: StartedPostgreSqlContainer): Promise<string> {
  const existing = migratedTemplates.get(postgres);
  if (existing !== undefined) return existing;
  const created = createMigratedTemplate(postgres.getConnectionUri()).catch((error: unknown) => {
    // A transient setup failure fails one test; the next test retries instead of reusing it.
    migratedTemplates.delete(postgres);
    throw error;
  });
  migratedTemplates.set(postgres, created);
  return created;
}

async function createMigratedTemplate(adminUrl: string): Promise<string> {
  const name = `hub_template_${randomUUID().replaceAll("-", "")}`;
  const { runtime } = await createPostgresTestRuntime(databaseUrl(adminUrl, name));
  await runtime.close();
  return name;
}

function databaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

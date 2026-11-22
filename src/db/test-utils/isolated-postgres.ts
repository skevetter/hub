import { randomUUID } from "node:crypto";
import { createPostgresQueryRuntime } from "./runtime.js";

export function isolatedPostgresDatabase(adminUrl: string) {
  const name = `hub_test_${randomUUID().replaceAll("-", "")}`;
  const database = new URL(adminUrl);
  database.pathname = `/${name}`;
  return {
    url: database.toString(),
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

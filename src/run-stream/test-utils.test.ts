import { expect, it } from "vitest";
import { StreamReader } from "./test-utils.js";

it.each([
  ["", "Stream frame is missing for status"],
  ["event: status\nid: 1\n\n", "Stream event data is missing for status"],
])("reports an incomplete stream event for %j", async (body, message) => {
  const reader = new StreamReader(new Response(body));
  await expect(reader.event("status")).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof Error && error.constructor === Error && error.message === message,
  );
});

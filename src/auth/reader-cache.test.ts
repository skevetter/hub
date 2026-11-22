import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import type { AccountState } from "./organization-contract.js";
import { resetQueriesOnReaderChange } from "./reader-cache.js";

const accountKey = ["account", undefined] as const;
const invitationKey = ["account", "invitation"] as const;
const tenantKey = ["tenant", "acme"] as const;
const triggersKey = ["triggers", "acme"] as const;
const signedOut: AccountState = { status: "signedOut", registration: "open" };

function reader(id: string): AccountState {
  return {
    status: "passwordChangeRequired",
    account: { id, name: id, email: `${id}@example.com` },
  };
}

test("keeps tenant queries on a successful refetch for the same reader", async () => {
  const client = new QueryClient();
  resetQueriesOnReaderChange(client);
  client.setQueryData(accountKey, reader("alice"));
  client.setQueryData(tenantKey, "Acme");
  const account = await client.fetchQuery({ queryKey: accountKey, queryFn: () => reader("alice") });

  expect(account).toEqual(reader("alice"));
  expect(client.getQueryData(tenantKey)).toBe("Acme");
});

test.each([
  ["sign-out", reader("alice"), signedOut],
  ["sign-in", signedOut, reader("bob")],
  ["direct switch", reader("alice"), reader("bob")],
] as const)("drops non-account queries on %s", (_label, before, after) => {
  const client = new QueryClient();
  resetQueriesOnReaderChange(client);
  client.setQueryData(accountKey, before);
  client.setQueryData(invitationKey, before);
  client.setQueryData(tenantKey, "Acme");
  client.setQueryData(triggersKey, ["review"]);

  client.setQueryData(invitationKey, after);

  expect(client.getQueryData(tenantKey)).toBeUndefined();
  expect(client.getQueryData(triggersKey)).toBeUndefined();
  expect(client.getQueryData(accountKey)).toEqual(before);
  expect(client.getQueryData(invitationKey)).toEqual(after);
});

test("cancels an in-flight read when the reader changes", async () => {
  const client = new QueryClient();
  resetQueriesOnReaderChange(client);
  client.setQueryData(accountKey, reader("alice"));
  let signal: AbortSignal | undefined;
  const read = client.fetchQuery({
    queryKey: tenantKey,
    queryFn: (context) => {
      signal = context.signal;
      return new Promise(() => {});
    },
  });
  const cancelled = expect(read).rejects.toThrow("CancelledError");
  client.setQueryData(accountKey, signedOut);

  expect(signal?.aborted).toBe(true);
  await cancelled;
  expect(client.getQueryState(tenantKey)).toBeUndefined();
});

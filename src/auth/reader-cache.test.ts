import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import type { AccountState } from "./organization-contract.js";

const accountKey = ["account", undefined] as const;
const invitationKey = ["account", "invitation"] as const;
const tenantKey = ["tenant", "acme"] as const;
const triggersKey = ["triggers", "acme"] as const;
const signedOut: AccountState = { status: "signedOut", registration: "open" };

beforeEach(() => vi.resetModules());

async function setup() {
  const { leaveReader, readerChange, resetQueriesOnReaderChange } =
    await import("./reader-cache.js");
  const client = new QueryClient();
  const reload = vi.fn(() => {
    expect(readerChange.getSnapshot()).toBe(true);
    expect(client.getQueryState(tenantKey)).toBeUndefined();
  });
  resetQueriesOnReaderChange(client, { reload });
  return { client, leaveReader, readerChange, reload };
}

function reader(id: string): AccountState {
  return {
    status: "passwordChangeRequired",
    account: { id, name: id, email: `${id}@example.com` },
  };
}

test("keeps tenant queries on a successful refetch for the same reader", async () => {
  const { client, readerChange, reload } = await setup();
  client.setQueryData(accountKey, reader("alice"));
  client.setQueryData(tenantKey, "Acme");
  const account = await client.fetchQuery({ queryKey: accountKey, queryFn: () => reader("alice") });

  expect(account).toEqual(reader("alice"));
  expect(client.getQueryData(tenantKey)).toBe("Acme");
  expect(readerChange.getSnapshot()).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

test.each([
  ["sign-out", reader("alice"), signedOut],
  ["sign-in", signedOut, reader("bob")],
  ["direct switch", reader("alice"), reader("bob")],
] as const)("drops non-account queries and reloads once on %s", async (_label, before, after) => {
  const { client, reload } = await setup();
  client.setQueryData(accountKey, before);
  client.setQueryData(invitationKey, before);
  client.setQueryData(tenantKey, "Acme");
  client.setQueryData(triggersKey, ["review"]);

  client.setQueryData(invitationKey, after);
  client.setQueryData(invitationKey, before);
  client.setQueryData(invitationKey, after);

  expect(reload).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(tenantKey)).toBeUndefined();
  expect(client.getQueryData(triggersKey)).toBeUndefined();
  expect(client.getQueryData(accountKey)).toEqual(before);
  expect(client.getQueryData(invitationKey)).toEqual(after);
});

test("cancels an in-flight read when the reader changes", async () => {
  const { client, reload } = await setup();
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
  expect(reload).toHaveBeenCalledTimes(1);
  expect(client.getQueryState(tenantKey)).toBeUndefined();
});

test("fails closed on malformed account data after the first valid read", async () => {
  const { client, reload } = await setup();
  client.setQueryData(accountKey, { status: "active" });
  expect(reload).not.toHaveBeenCalled();
  client.setQueryData(accountKey, reader("alice"));
  client.setQueryData(tenantKey, "Acme");

  client.setQueryData(accountKey, { status: "active" });

  expect(reload).toHaveBeenCalledTimes(1);
});

test("keeps the page and cached queries when a known reader's account refetch fails", async () => {
  const { client, readerChange, reload } = await setup();
  client.setQueryData(accountKey, reader("alice"));
  client.setQueryData(tenantKey, "Acme");
  const error = new Error("Account read failed");

  await expect(
    client.fetchQuery({ queryKey: accountKey, queryFn: () => Promise.reject(error) }),
  ).rejects.toBe(error);

  expect(client.getQueryState(accountKey)?.status).toBe("error");
  expect(client.getQueryData(accountKey)).toEqual(reader("alice"));
  expect(client.getQueryData(tenantKey)).toBe("Acme");
  expect(readerChange.getSnapshot()).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

test("sign-out reloads without waiting for an account read", async () => {
  const { client, leaveReader, readerChange, reload } = await setup();
  client.setQueryData(accountKey, reader("alice"));
  client.setQueryData(tenantKey, "Acme");
  const onChange = vi.fn(() => {
    expect(readerChange.getSnapshot()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
  const unsubscribe = readerChange.subscribe(onChange);
  leaveReader(client);
  leaveReader(client);
  unsubscribe();

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(accountKey)).toEqual(reader("alice"));
});

import { expect, it, vi } from "vitest";

const { retrieve, update, trace } = vi.hoisted(() => {
  const calls: unknown[] = [];
  return {
    trace: calls,
    retrieve: vi.fn<(id: string) => Promise<object>>(),
    update: async (id: string, params: unknown) => {
      calls.push(["update", id, params]);
    },
  };
});

vi.mock("stripe", () => ({
  default: class {
    subscriptions = {
      retrieve: async (id: string) => {
        trace.push(["retrieve", id]);
        return retrieve(id);
      },
      update,
    };
  },
}));

const item = { id: "item", price: { id: "price" }, current_period_end: 100, quantity: 3 };
const subscription = {
  id: "subscription",
  customer: { id: "customer" },
  metadata: { organizationId: "org" },
  items: { data: [item] },
  status: "active",
  cancel_at_period_end: false,
};

async function fixture() {
  trace.length = 0;
  const { createStripeBillingClient } = await import("./stripe-client.js");
  return createStripeBillingClient("example");
}

it("retrieves the first item before updating plan or seat quantity", async () => {
  const client = await fixture();
  retrieve.mockResolvedValueOnce(subscription).mockResolvedValueOnce(subscription);
  await client.changeSubscriptionPrice({ subscriptionId: "subscription", priceId: "new" });
  await client.reportSeatQuantity({ subscriptionId: "subscription", quantity: 4 });
  expect(trace).toEqual([
    ["retrieve", "subscription"],
    [
      "update",
      "subscription",
      { items: [{ id: "item", price: "new" }], proration_behavior: "create_prorations" },
    ],
    ["retrieve", "subscription"],
    [
      "update",
      "subscription",
      { items: [{ id: "item", quantity: 4 }], proration_behavior: "create_prorations" },
    ],
  ]);
});

it("keeps the distinct missing-item errors without attempting an update", async () => {
  const client = await fixture();
  const missing = { ...subscription, items: { data: [] } };
  retrieve.mockResolvedValueOnce(missing).mockResolvedValueOnce(missing);
  await expect(
    client.changeSubscriptionPrice({ subscriptionId: "subscription", priceId: "new" }),
  ).rejects.toThrow("subscription subscription has no item to change");
  await expect(
    client.reportSeatQuantity({ subscriptionId: "subscription", quantity: 4 }),
  ).rejects.toThrow("subscription subscription has no item to report seats on");
  expect(trace).toEqual([
    ["retrieve", "subscription"],
    ["retrieve", "subscription"],
  ]);
});

it("maps both customer representations and preserves missing metadata and item results", async () => {
  const client = await fixture();
  retrieve
    .mockResolvedValueOnce(subscription)
    .mockResolvedValueOnce({
      ...subscription,
      customer: "customer",
      items: { data: [{ ...item, quantity: undefined }] },
    })
    .mockResolvedValueOnce({ ...subscription, metadata: {} })
    .mockResolvedValueOnce({ ...subscription, items: { data: [] } });
  const expected = {
    id: "subscription",
    customerId: "customer",
    organizationId: "org",
    priceId: "price",
    quantity: 3,
    status: "active",
    currentPeriodEnd: new Date(100000),
    cancelAtPeriodEnd: false,
  };
  expect(JSON.stringify(await client.getSubscription("subscription"))).toBe(
    JSON.stringify(expected),
  );
  expect(JSON.stringify(await client.getSubscription("subscription"))).toBe(
    JSON.stringify({ ...expected, quantity: 1 }),
  );
  expect(await client.getSubscription("subscription")).toBe(undefined);
  expect(await client.getSubscription("subscription")).toBe(undefined);
});

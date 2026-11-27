import { describe, it, expect } from "vitest";
import { appViewer, linearAgentFixture } from "./test-utils/agent.js";

const graphql = "https://api.linear.app/graphql";

function viewerRequest(accessToken: string) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query: "query PaseoAgentViewer {}", variables: {} }),
  };
}

describe("Linear agent transport fixture", () => {
  it("records GraphQL calls, returns configured viewers and delegates other operations", async () => {
    const fixture = linearAgentFixture((operation, call) => ({ operation, vars: call.variables }));
    const { fetch } = fixture.options;
    const request = viewerRequest(fixture.a.accessToken);
    const viewer = appViewer(fixture.a);
    const defaultViewer = await fetch(graphql, request);
    expect(await defaultViewer.json()).toEqual({ data: { viewer } });

    const overridden = { ...viewer, active: false };
    fixture.setViewer(overridden);
    const next = await fetch(graphql, request);
    expect(await next.json()).toEqual({ data: { viewer: overridden } });
    const response = await fetch(graphql, {
      ...request,
      redirect: "error",
      body: JSON.stringify({ query: "mutation Other {}", variables: { name: "value" } }),
    });
    expect(await response.json()).toEqual({ operation: "Other", vars: { name: "value" } });
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls.at(-1)?.redirect).toBe("error");
  });

  it("uses updated scopes for subsequent refreshes and keeps connection lookup order", async () => {
    const fixture = linearAgentFixture();
    await fixture.options.connectionForLinearOrganization(fixture.b.linearOrganizationId);
    await fixture.options.connectionForLinearOrganization("missing");
    expect(fixture.lookups).toEqual([fixture.b.linearOrganizationId, "missing"]);
    fixture.setRefreshScopes(["read"]);
    expect(
      await fixture.options.connectionClient.refresh(fixture.a.refreshToken ?? ""),
    ).toMatchObject({
      scopes: ["read"],
    });
    expect(fixture.refreshTokens).toEqual([fixture.a.refreshToken]);
    const request = {
      ...viewerRequest(fixture.a.accessToken),
      body: '{"query":"query Other {}","variables":{}}',
    };
    await expect(fixture.options.fetch(graphql, request)).rejects.toThrow(
      "Unexpected GraphQL operation",
    );
  });
});

import { createHash } from "node:crypto";

export function bearerWebhookDeliveryId(
  organizationId: string,
  projectId: string,
  triggerName: string,
  deliveryKey: string,
): string {
  return (
    "public-manual-" +
    createHash("sha256")
      .update(JSON.stringify([organizationId, projectId, triggerName, deliveryKey]))
      .digest("base64url")
  );
}

export function signedWebhookDeliveryId(
  organizationId: string,
  credentialId: string,
  bodyDigest: string,
): string {
  return (
    "public-signature-" +
    createHash("sha256")
      .update(JSON.stringify([organizationId, credentialId, bodyDigest]))
      .digest("hex")
  );
}

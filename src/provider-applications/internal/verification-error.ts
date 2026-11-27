/**
 * Which credential the provider actually objected to. Collapsing "this secret is wrong" into
 * "these credentials are wrong" sends the operator back to the portal to re-copy every field,
 * and collapsing "this belongs to a different app" into either one sends them looking for a
 * typo that is not there.
 */
export type ProviderVerificationSubject =
  | "appToken"
  | "botToken"
  | "clientSecret"
  | "privateKey"
  | "identityMismatch";

export class ProviderVerificationError extends Error {
  constructor(
    readonly reason:
      | "credentialsRejected"
      | "permissionMissing"
      | "rateLimited"
      | "network"
      | "timeout"
      | "upstreamUnavailable"
      | "invalidResponse",
    readonly safeStatus?: number,
    options?: ErrorOptions & { subject?: ProviderVerificationSubject },
  ) {
    super(reason, options);
    this.name = "ProviderVerificationError";
    this.subject = options?.subject;
  }

  readonly subject: ProviderVerificationSubject | undefined;
}

/**
 * Appends the correlation ID, after the copy that is actually useful and with the one instruction
 * that makes it worth reading. A bare identifier at the end of a sentence tells the reader
 * nothing about what they are supposed to do with it.
 *
 * Pure so browser bundles can phrase a reference the same way the server does.
 */
export function withReference(message: string, requestId: string): string {
  return `${message} If it happens again, quote reference ${requestId} when reporting it.`;
}

const SAFE_ROUTE_MESSAGES = new Set(["Organization unavailable."]);
const REFERENCE_PATTERN =
  /quote reference ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) when reporting it\./iu;

export function isSafeRouteMessage(message: string): boolean {
  return SAFE_ROUTE_MESSAGES.has(message);
}

export function referenceIn(message: string): string | undefined {
  return REFERENCE_PATTERN.exec(message)?.[1];
}

/** The only text a failed route may show a reader: an allowed message, or a generic one. */
export function publicRouteMessage(message: string, reference: string | undefined): string {
  if (isSafeRouteMessage(message)) return message;
  const generic = "The page could not be loaded.";
  return reference === undefined ? generic : withReference(generic, reference);
}

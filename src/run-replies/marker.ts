const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function linearRunReplyMarker(commentId: string): string {
  return `Paseo reply ${commentId}`;
}

export function hasLinearRunReplyMarker(body: string, commentId: string): boolean {
  if (!UUID_V4.test(commentId)) return false;
  const marker = linearRunReplyMarker(commentId);
  return body.split("\n").some((line) => line.trim() === marker);
}

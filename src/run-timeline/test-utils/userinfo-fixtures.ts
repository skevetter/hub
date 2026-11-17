export const USERINFO_SCHEMES = [
  "mongodb",
  "postgres",
  "redis",
  "amqp",
  "ftp",
  "mongodb+srv",
  "http",
  "https",
] as const;

export const USERINFO_WHITESPACE = [
  { name: "space", separator: " ", split: false },
  { name: "tab", separator: "\t", split: false },
  { name: "LF", separator: "\n", split: false },
  { name: "CR-only", separator: "\r", split: false },
  { name: "mixed whitespace", separator: " \t\n\r ", split: false },
  { name: "percent-encoded whitespace", separator: "%20%09%0A%0D", split: false },
  { name: "split tab delimiters", separator: "\t", split: true },
  { name: "split LF delimiters", separator: "\n", split: true },
  { name: "split CR delimiters", separator: "\r", split: true },
  { name: "split mixed delimiters", separator: "\t\n\r", split: true },
] as const;

export function userinfoWhitespaceCase(
  scheme: string,
  variant: (typeof USERINFO_WHITESPACE)[number],
) {
  const secret = variant.name === "LF" ? "98765432" : ["aB3d", "Ef8h", "Q2"].join("");
  const { separator, split } = variant;
  const prefix = split
    ? `${scheme.slice(0, 2)}${separator}${scheme.slice(2)}:${separator}/${separator}/`
    : `${scheme}://`;
  return {
    name: `${scheme} ${variant.name}`,
    value: `${prefix}admin:${secret}${separator}@host/db`,
    secret,
  };
}

export const USERINFO_WHITESPACE_CASES = USERINFO_SCHEMES.flatMap((scheme) =>
  USERINFO_WHITESPACE.map((variant) => userinfoWhitespaceCase(scheme, variant)),
);

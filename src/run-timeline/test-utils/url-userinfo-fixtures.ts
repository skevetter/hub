export const URL_USERINFO_SCHEMES = [
  "http",
  "https",
  "ftp",
  "ws",
  "wss",
  "mongodb",
  "postgres",
] as const;

export const URL_USERINFO_SECRET = ["Zq8m", "Pw2X", "vN7k", "Lr4T"].join("");

const CREDENTIALS = [
  { name: "password", value: `admin:${URL_USERINFO_SECRET}` },
  { name: "username only", value: URL_USERINFO_SECRET },
  { name: "password only", value: `:${URL_USERINFO_SECRET}` },
] as const;

function encodeSeparators(value: string) {
  return value.replaceAll("/", "%2F").replaceAll("\\", "%5C");
}

const VARIANTS: {
  name: string;
  prefix: (value: string) => string;
  suffix?: string;
  scheme?: (value: string) => string;
}[] = [
  { name: "raw", prefix: (value: string) => value },
  ...[
    { name: "space", value: " " },
    { name: "tab", value: "\t" },
    { name: "CR", value: "\r" },
    { name: "LF", value: "\n" },
  ].flatMap(({ name, value }) => [
    { name: `${name} prefix`, prefix: (separators: string) => value + separators },
    {
      name: `${name} between separators`,
      prefix: (separators: string) => separators.split("").join(value),
    },
  ]),
  { name: "encoded separators", prefix: encodeSeparators },
  {
    name: "encoded authority separator",
    prefix: (value: string) =>
      value.startsWith("//") ? `//${encodeSeparators(value.slice(2))}` : encodeSeparators(value),
  },
  {
    name: "encoded whitespace",
    prefix: (value: string) => value,
    suffix: "%20%09%0D%0A",
  },
  {
    name: "mixed userinfo whitespace",
    prefix: (value: string) => value,
    suffix: " \t\r\n",
  },
  {
    name: "split scheme controls",
    prefix: (value: string) => value,
    scheme: (value: string) => `${value.slice(0, 2)}\t\r\n${value.slice(2)}`,
  },
];

function maskSeparators(separatorLength: number, mask: number): string {
  let separators = "";
  for (let index = 0; index < separatorLength; index++)
    separators += mask & (1 << index) ? "\\" : "/";
  return separators;
}

function userinfoCandidates() {
  const prefixes: {
    scheme: (typeof URL_USERINFO_SCHEMES)[number];
    separatorLength: number;
    mask: number;
    separators: string;
  }[] = [];
  for (const scheme of URL_USERINFO_SCHEMES) {
    for (let separatorLength = 0; separatorLength <= 4; separatorLength++) {
      for (let mask = 0; mask < 2 ** separatorLength; mask++) {
        const separators = maskSeparators(separatorLength, mask);
        prefixes.push({ scheme, separatorLength, mask, separators });
      }
    }
  }
  return prefixes.flatMap(({ scheme, separatorLength, mask, separators }) =>
    CREDENTIALS.flatMap((credential, credentialIndex) =>
      (credentialIndex === 0 ? VARIANTS : VARIANTS.slice(0, 1)).map((variant) => ({
        name: `${scheme} length ${separatorLength} mix ${mask} ${variant.name} ${credential.name}`,
        scheme,
        separatorLength,
        separators,
        variant: variant.name,
        credential: credential.name,
        secret: URL_USERINFO_SECRET,
        value: `${variant.scheme?.(scheme) ?? scheme}:${variant.prefix(separators)}${credential.value}${variant.suffix ?? ""}@host/db`,
      })),
    ),
  );
}

export const URL_USERINFO_CANDIDATES = userinfoCandidates();

export function hasParsedUserinfo(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

export const URL_USERINFO_CASES = URL_USERINFO_CANDIDATES.filter(({ value }) =>
  hasParsedUserinfo(value),
);

function storageCase(scheme: string, separators: string, variant = "raw") {
  const sample = URL_USERINFO_CASES.find(
    (candidate) =>
      candidate.scheme === scheme &&
      candidate.separators === separators &&
      candidate.variant === variant &&
      candidate.credential === "password",
  );
  if (!sample) throw new Error("Differential storage sample has no parsed userinfo");
  return sample;
}

export const URL_USERINFO_STORAGE_CASES = [
  ...["", "/", "\\", "/\\", "///", "////", "\\/\\/"].map((separators) =>
    storageCase("https", separators),
  ),
  storageCase("http", "\\"),
  storageCase("ftp", "/"),
  storageCase("ws", "/"),
  storageCase("wss", "\\/"),
  storageCase("mongodb", "//"),
  storageCase("postgres", "//"),
  storageCase("https", "/\\", "tab between separators"),
  storageCase("https", "//", "tab prefix"),
  storageCase("https", "//", "CR prefix"),
  storageCase("https", "//", "LF prefix"),
  storageCase("https", "//\\", "encoded authority separator"),
  storageCase("postgres", "//", "encoded whitespace"),
  storageCase("https", "//", "mixed userinfo whitespace"),
  storageCase("https", "//", "split scheme controls"),
];

export const BENIGN_URL_CASES = ["https", "ftp", "ws", "postgres"].map((scheme) => ({
  name: `${scheme} credential-free URL`,
  value: `${scheme}://host/useful/path?item=ordinary#section`,
  useful: `${scheme}://host/useful/path`,
}));

import { BellIcon, TerminalIcon, ClockIcon, WebhookIcon } from "lucide-react";

/**
 * Brand marks for the connection providers. Lucide dropped brand icons, and a generic
 * message or repository icon reads as "some integration" rather than "Discord" or
 * "GitHub" — a provider card is exactly where the mark carries the meaning. "manual"
 * is not a brand, so it gets a plain lucide glyph instead of a drawn mark.
 */
export function ProviderGlyph({
  provider,
  source,
}: {
  provider:
    | "github"
    | "discord"
    | "slack"
    | "linear"
    | "manual"
    | "schedule"
    | "github_notification";
  source?: string;
}) {
  if (source === "webhook.received") {
    return <WebhookIcon className="size-4.5" aria-hidden="true" />;
  }
  if (provider === "schedule") return <ClockIcon className="size-4.5" aria-hidden="true" />;
  if (provider === "github_notification") {
    return <BellIcon className="size-4.5" aria-hidden="true" />;
  }
  if (provider === "github") return <GitHubMark />;
  if (provider === "discord") return <DiscordMark />;
  if (provider === "slack") return <SlackMark />;
  if (provider === "linear") return <LinearMark />;
  return <TerminalIcon className="size-4.5" aria-hidden="true" />;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4.5" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function DiscordMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4.5" fill="currentColor" aria-hidden="true">
      <path d="M13.55 3.11A13.2 13.2 0 0 0 10.29 2.1a.05.05 0 0 0-.05.02c-.14.25-.3.58-.41.84a12.2 12.2 0 0 0-3.66 0A8.4 8.4 0 0 0 5.75 2.12.05.05 0 0 0 5.7 2.1c-1.14.2-2.23.54-3.25 1.01a.05.05 0 0 0-.02.02C.36 6.28-.22 9.36.07 12.4c0 .01.01.03.02.03 1.37 1.01 2.7 1.62 4 2.03a.05.05 0 0 0 .06-.02c.31-.42.58-.87.82-1.34a.05.05 0 0 0-.03-.07 8.7 8.7 0 0 1-1.25-.6.05.05 0 0 1 0-.09l.25-.19a.05.05 0 0 1 .05 0 9.3 9.3 0 0 0 7.94 0 .05.05 0 0 1 .05 0l.25.2a.05.05 0 0 1 0 .08c-.4.24-.82.44-1.25.6a.05.05 0 0 0-.03.07c.24.47.52.92.82 1.34a.05.05 0 0 0 .06.02 13.2 13.2 0 0 0 4-2.03.05.05 0 0 0 .02-.03c.35-3.52-.57-6.57-2.4-9.28a.04.04 0 0 0-.02-.02ZM5.35 10.55c-.79 0-1.44-.72-1.44-1.6 0-.89.64-1.61 1.44-1.61.8 0 1.45.73 1.44 1.6 0 .89-.64 1.61-1.44 1.61Zm5.31 0c-.79 0-1.44-.72-1.44-1.6 0-.89.63-1.61 1.44-1.61.8 0 1.45.73 1.44 1.6 0 .89-.63 1.61-1.44 1.61Z" />
    </svg>
  );
}

function SlackMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4.5" fill="currentColor" aria-hidden="true">
      <path d="M3.38 9.88A1.69 1.69 0 1 1 1.69 8.2h1.69v1.69Zm.85 0a1.69 1.69 0 1 1 3.38 0v4.23a1.69 1.69 0 1 1-3.38 0V9.88Zm1.69-6.76a1.69 1.69 0 1 1 1.69-1.69v1.69H5.92Zm0 .85a1.69 1.69 0 1 1 0 3.38H1.69a1.69 1.69 0 1 1 0-3.38h4.23Zm6.76 1.69a1.69 1.69 0 1 1 1.69 1.69h-1.69V5.66Zm-.85 0a1.69 1.69 0 1 1-3.38 0V1.43a1.69 1.69 0 1 1 3.38 0v4.23Zm-1.69 6.76a1.69 1.69 0 1 1-1.69 1.69v-1.69h1.69Zm0-.85a1.69 1.69 0 1 1 0-3.38h4.23a1.69 1.69 0 1 1 0 3.38h-4.23Z" />
    </svg>
  );
}

/** Linear's logomark as published at linear.app/brand, unaltered. Only the fill follows the theme's ink, as the other marks do. */
function LinearMark() {
  return (
    <svg viewBox="0 0 100 100" className="size-4.5" fill="currentColor" aria-hidden="true">
      <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z" />
    </svg>
  );
}

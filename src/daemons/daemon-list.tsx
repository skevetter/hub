import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import {
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Card } from "../components/app/card.js";
import { CopyField } from "../components/app/copy-field.js";
import { DeviceCard } from "../components/app/device-card.js";
import { EmptyState } from "../components/app/empty-state.js";
import type { SummaryRow } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import { deviceStatus, type DeviceProfileName } from "./device-details.js";
import type { BrowserDaemon } from "./functions.js";
import { daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "./handoff.js";

const DAEMON_DOCS_URL = "https://paseo.sh/docs/hub/daemons";

interface DeviceProfiles {
  names: readonly DeviceProfileName[];
  message: string | null;
}

interface DeviceProviders {
  labels: readonly string[];
  message: string | null;
  onRetry?: () => Promise<void>;
}

export function DaemonResults({
  hasDaemons,
  onClear,
  children = [],
}: {
  hasDaemons: boolean;
  onClear: () => void;
  children?: readonly ReactNode[];
}) {
  if (!hasDaemons)
    return (
      <EmptyState
        title="No daemons connected"
        description="A daemon is the Paseo process that runs agents on your machine. Connect the machine where your code lives so Hub can run your automations there."
      >
        <ConnectDaemonHint />
      </EmptyState>
    );

  if (children.length === 0)
    return (
      <EmptyState title="No daemons match">
        <Button type="button" variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      </EmptyState>
    );

  return (
    <ul role="list" aria-label="Daemons" className="grid min-w-0 gap-3">
      {children}
    </ul>
  );
}

function ConnectDaemonHint() {
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  return (
    <>
      {origin === undefined ? null : (
        <CopyField label="Command" value={daemonLoginCommand(origin)} />
      )}
      <Button asChild variant="outline" size="sm">
        <a href={DAEMON_DOCS_URL} target="_blank" rel="noreferrer">
          <BookOpen aria-hidden="true" />
          How to connect a daemon
        </a>
      </Button>
    </>
  );
}

/** The way to add a machine stays on the page after the first one has connected. */
export function ConnectAnotherDaemon() {
  return (
    <Card
      title="Connect another daemon"
      description="Run this on the machine you want to add, then approve it in the browser."
    >
      <div className="grid max-w-sm gap-3">
        <ConnectDaemonHint />
      </div>
    </Card>
  );
}

export function DaemonDevice({
  daemon,
  organizationSlug,
  providers,
  profiles,
  actions,
}: {
  daemon: BrowserDaemon;
  organizationSlug: string;
  providers?: DeviceProviders | undefined;
  profiles?: DeviceProfiles | undefined;
  actions?: ReactNode;
}) {
  const status = deviceStatus(daemon);
  const details = useMemo(() => {
    const rows: SummaryRow[] = [
      { label: "Providers", value: <ProviderNames status={status} providers={providers} /> },
    ];
    if (profiles !== undefined) {
      rows.push({
        label: "Session profiles",
        value: <ProfileNames organizationSlug={organizationSlug} profiles={profiles} />,
      });
    }
    rows.push({ label: "Permissions", value: <DaemonPermissions daemon={daemon} /> });
    return rows;
  }, [daemon, organizationSlug, profiles, providers, status]);

  return (
    <li className="min-w-0">
      <DeviceCard
        name={daemon.slug}
        id={daemon.id}
        status={status}
        lastSeenAt={daemon.lastSeenAt}
        details={details}
        actions={actions}
      />
    </li>
  );
}

function ProviderNames({
  status,
  providers,
}: {
  status: ReturnType<typeof deviceStatus>;
  providers: DeviceProviders | undefined;
}) {
  const line = useRef<HTMLDivElement>(null);
  const [announceRetry, setAnnounceRetry] = useState(false);
  const retry = status === "connected" ? providers?.onRetry : undefined;
  const requestRetry = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const target = line.current;
      if (retry === undefined || target === null) return;
      if (document.activeElement === event.currentTarget) target.focus();
      setAnnounceRetry(true);
      void retry().then(() => {
        if (document.activeElement !== target) return undefined;
        const controls = target
          .closest("li")
          ?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]");
        const next = Array.from(controls ?? []).find((control) => !target.contains(control));
        next?.focus();
        return undefined;
      });
    },
    [retry],
  );

  const value = providerValue(status, providers);
  return (
    <div
      ref={line}
      role="group"
      aria-label="Providers"
      aria-live={announceRetry ? "polite" : undefined}
      tabIndex={-1}
    >
      {retry === undefined ? (
        value
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {value}
          <Button type="button" variant="outline" size="xs" onClick={requestRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function providerValue(
  status: ReturnType<typeof deviceStatus>,
  providers: DeviceProviders | undefined,
) {
  if (status === "revoked") return <Quiet>Provider information is unavailable.</Quiet>;
  if (status === "offline")
    return <Quiet>Providers are available when this daemon connects.</Quiet>;
  if (providers === undefined) return <Quiet>Loading providers...</Quiet>;
  if (providers.labels.length > 0) return providers.labels.join(", ");
  return <Quiet>{providers.message ?? "No providers available."}</Quiet>;
}

function ProfileNames({
  profiles,
  organizationSlug,
}: {
  profiles: DeviceProfiles;
  organizationSlug: string;
}) {
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  if (profiles.message !== null) return <Quiet>{profiles.message}</Quiet>;
  if (profiles.names.length === 0) return <Quiet>No profiles use this daemon.</Quiet>;

  return profiles.names.map(({ id, name }, index) => (
    <Fragment key={id}>
      {index === 0 ? null : ", "}
      <Link
        to="/o/$organizationSlug/sessions/profiles"
        params={params}
        className="text-link underline underline-offset-2"
      >
        {name}
      </Link>
    </Fragment>
  ));
}

function DaemonPermissions({ daemon }: { daemon: BrowserDaemon }) {
  if (daemon.status === "revoked") return <Quiet>Daemon credential revoked.</Quiet>;
  if (daemon.permissions.includes("hub.execute")) return "Can run Hub automations";
  return (
    <div className="grid min-w-0 gap-2">
      <p>Connected only: Hub cannot start agents here</p>
      <CopyField
        label="Grant command"
        copyLabel="Copy grant command"
        value={GRANT_EXECUTE_COMMAND}
        prose
      />
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, vi } from "vitest";

const follow = vi.hoisted(() => ({ props: [] as { version: number }[] }));

vi.mock("./follow-bottom.js", () => ({
  FollowBottom: ({ version, children }: { version: number; children: React.ReactNode }) => {
    follow.props.push({ version });
    return <div data-follow-version={version}>{children}</div>;
  },
}));

import {
  orderTranscript,
  Transcript,
  TranscriptSkeleton,
  type TranscriptItem,
} from "./transcript.js";

const MESSAGES: readonly TranscriptItem[] = [
  {
    id: "i1",
    kind: "human",
    author: "Ada",
    text: "queued while busy",
    status: "queued",
    seq: null,
  },
  { id: "i2", kind: "assistant", text: "second reply", truncated: false, seq: 4 },
  { id: "i3", kind: "human", author: "Ada", text: "first question", status: "delivered", seq: 1 },
  { id: "i4", kind: "tool", name: "read_file", status: "completed", seq: 2 },
  {
    id: "i5",
    kind: "human",
    author: "Grace",
    text: "could not send",
    status: "not_sent",
    seq: null,
  },
  { id: "i6", kind: "assistant", text: "first reply", truncated: false, seq: 3 },
];

function render(items: readonly TranscriptItem[], extra: { working?: boolean } = {}): string {
  return renderToStaticMarkup(<Transcript items={items} version={items.length} {...extra} />);
}

describe("transcript order", () => {
  it("places hub messages at their daemon anchor and unsent ones last", () => {
    const order = orderTranscript(MESSAGES).map((item) =>
      item.kind === "human" || item.kind === "assistant" ? item.text : item.kind,
    );
    assert.deepEqual(order, [
      "first question",
      "tool",
      "first reply",
      "second reply",
      "queued while busy",
      "could not send",
    ]);

    const markup = render(MESSAGES);
    assert.ok(markup.indexOf("first question") < markup.indexOf("second reply"));
    assert.ok(markup.indexOf("second reply") < markup.indexOf("queued while busy"));
    assert.ok(markup.indexOf("queued while busy") < markup.indexOf("could not send"));
  });

  it("does not mutate the list it was given", () => {
    const before = MESSAGES.map((item) => item.kind).join();
    orderTranscript(MESSAGES);
    assert.equal(MESSAGES.map((item) => item.kind).join(), before);
  });
});

describe("transcript entries", () => {
  it("names the delivery state of every human message", () => {
    const markup = render(MESSAGES);
    assert.match(markup, /Delivered/u);
    assert.match(markup, /Queued/u);
    assert.match(markup, /Not sent/u);
    const unknown = render([
      { id: "i7", kind: "human", author: "Ada", text: "hm", status: "unknown", seq: null },
    ]);
    assert.match(unknown, /Delivery unknown/u);
  });

  it("shows a tool as its name and status and nothing else", () => {
    const markup = render([
      { id: "i8", kind: "tool", name: "read_file", status: "completed", seq: 1 },
    ]);
    assert.match(markup, /read_file/u);
    assert.match(markup, /Completed/u);
  });

  it("tells people from the agent by alignment and shows a tool as one quiet line", () => {
    const markup = render(MESSAGES);
    assert.match(markup, /data-entry="human" class="[^"]*justify-items-end/u);
    assert.match(markup, /data-entry="assistant" class="[^"]*justify-items-start/u);
    const tool = markup.match(/<p data-entry="tool"[^>]*>.*?<\/p>/u)?.[0] ?? "";
    assert.match(tool, /Completed/u);
    assert.doesNotMatch(tool, /rounded-sm/u);
  });

  it("shows a boundary note for a gap or an offline daemon", () => {
    const markup = render([{ id: "i9", kind: "boundary", label: "Daemon offline", seq: 1 }]);
    assert.match(markup, /Daemon offline/u);
  });

  it("says a message expired instead of showing its body", () => {
    const markup = render([
      { id: "i10", kind: "human", author: "Ada", text: null, status: "delivered", seq: 1 },
    ]);
    assert.match(markup, /Message expired/u);
  });

  it("marks cut assistant text", () => {
    const markup = render([
      { id: "i11", kind: "assistant", text: "partial", truncated: true, seq: 1 },
    ]);
    assert.match(markup, /Reply cut short/u);
  });

  it("keeps long unbroken strings inside a 390 px column", () => {
    const long = "x".repeat(400);
    const markup = render([
      { id: "i12", kind: "assistant", text: long, truncated: false, seq: 1 },
      {
        id: "i13",
        kind: "human",
        author: "a".repeat(120),
        text: long,
        status: "delivered",
        seq: 2,
      },
      { id: "i14", kind: "tool", name: "t".repeat(64), status: "running", seq: 3 },
    ]);
    assert.match(markup, /overflow-wrap:anywhere/u);
    assert.match(markup, /min-w-0/u);
    assert.doesNotMatch(markup, /whitespace-nowrap[^"]*"[^>]*>x{50}/u);
  });
});

describe("transcript states", () => {
  it("shows an empty state when there is nothing yet", () => {
    const markup = render([]);
    assert.match(markup, /No messages yet/u);
  });

  it("shows a Working indicator only while the agent works", () => {
    assert.match(render(MESSAGES, { working: true }), /Working/u);
    assert.doesNotMatch(render(MESSAGES), /Working/u);
  });

  it("announces through one polite region and never through the entries", () => {
    const markup = renderToStaticMarkup(
      <Transcript items={MESSAGES} version={1} announcement="Message delivered" />,
    );
    assert.equal(markup.match(/aria-live="polite"/gu)?.length, 1);
    assert.match(markup, /Message delivered/u);
  });

  it("keeps the reader's scroll position when they scrolled up", () => {
    follow.props.length = 0;
    render(MESSAGES);
    render([...MESSAGES, { id: "i15", kind: "assistant", text: "more", truncated: false, seq: 9 }]);
    // Following the bottom, and leaving a scrolled-up reader alone, is FollowBottom's job
    // keyed on `version`; the transcript must hand it a version that moves with the list.
    assert.deepEqual(
      follow.props.map((entry) => entry.version),
      [MESSAGES.length, MESSAGES.length + 1],
    );
  });

  it("draws a skeleton in the transcript's own box", () => {
    assert.match(renderToStaticMarkup(<TranscriptSkeleton />), /animate-pulse/u);
  });
});

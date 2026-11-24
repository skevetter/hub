import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageAlert } from "./page-alert.js";

describe("PageAlert", () => {
  it("opens with a heavy rule and a square mark in the tone's ink", () => {
    const attention = renderToStaticMarkup(<PageAlert title="Slack needs authorization" />);
    expect(attention).toContain("border-t-2 border-foreground");
    expect(attention).toContain("bg-attention");
    const neutral = renderToStaticMarkup(<PageAlert tone="neutral" title="Session closed" />);
    expect(neutral).toContain("bg-off-text");
    expect(neutral).not.toContain("bg-attention");
  });

  it("keeps the slots the page tests and helpers read", () => {
    const action = createElement("a", { href: "/x" }, "Go");
    const html = renderToStaticMarkup(
      <PageAlert title="Title" action={action}>
        <p>Message</p>
      </PageAlert>,
    );
    expect(html).toContain('data-slot="alert"');
    expect(html).toMatch(/data-slot="alert-title"[^>]*>Title</u);
    expect(html).toMatch(/data-slot="alert-description"[\s\S]*<p>Message<\/p>/u);
    expect(html).toMatch(/data-slot="alert-action"[^>]*><a href="\/x">Go<\/a>/u);
  });

  it("announces only when asked", () => {
    expect(renderToStaticMarkup(<PageAlert title="A" />)).not.toMatch(/role=|aria-live/u);
    expect(renderToStaticMarkup(<PageAlert role="alert" title="A" />)).toContain('role="alert"');
    expect(renderToStaticMarkup(<PageAlert role="status" title="A" />)).toContain('role="status"');
  });

  it("leaves out the title, description and action it was not given", () => {
    const html = renderToStaticMarkup(<PageAlert />);
    expect(html).not.toMatch(/alert-title|alert-description|alert-action/u);
  });
});

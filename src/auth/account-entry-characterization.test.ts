import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AccountState } from "./organization-contract.js";

function render(element: ReactElement): string {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  return renderToStaticMarkup(
    jsx(RouterContextProvider, {
      router,
      children: createElement(QueryClientProvider, { client: new QueryClient() }, element),
    }),
  );
}

function isComponent(value: unknown): boolean {
  return typeof value === "function";
}

async function load(name: string): Promise<unknown> {
  return import(`./${name}.tsx`);
}

describe("account entry forms", () => {
  it("shows the corresponding sign-in actions for each registration policy", async () => {
    interface Props {
      account: Extract<AccountState, { status: "signedOut" }>;
    }
    const { AccountEntry } = z
      .object({ AccountEntry: z.custom<ComponentType<Props>>(isComponent) })
      .parse(await load("account-entry"));
    for (const [registration, message] of [
      ["open", "No account yet?"],
      ["invite_only", "Accounts are created by invitation."],
      ["disabled", "Paseo Hub isn&#x27;t accepting new accounts."],
    ] as const) {
      const html = render(
        createElement(AccountEntry, { account: { status: "signedOut", registration } }),
      );
      expect(html).toContain("Sign in to Paseo Hub");
      expect(html).toContain("Forgot password?");
      expect(html).toContain(message);
    }
    const html = render(
      createElement(AccountEntry, {
        account: {
          status: "signedOut",
          registration: "disabled",
          invitation: {
            id: "invitation-id",
            organization: { id: "org", name: "Fixture organization" },
            inviterName: "Fixture inviter",
            role: "member",
            expiresAt: "2099-01-01T00:00:00Z",
            email: "member@example.invalid",
          },
        },
      }),
    );
    expect(html).toContain("Join Fixture organization");
    expect(html).toContain("This invitation is bound to the invited email address.");
    expect(html).toContain("member@example.invalid");
    expect(html).not.toContain("Forgot password?");
  });

  it("preserves login field modes, defaults, and read-only invitation addresses", async () => {
    interface Props {
      mode: "signIn" | "signUp";
      busy: boolean;
      onSubmit: () => void;
      emailValue?: string;
      emailReadOnly?: boolean;
    }
    const { LoginForm } = z
      .object({ LoginForm: z.custom<ComponentType<Props>>(isComponent) })
      .parse(await load("login-form"));
    const shared = { onSubmit() {}, busy: true };
    const signIn = render(createElement(LoginForm, { ...shared, mode: "signIn" }));
    expect(signIn).toContain('autoComplete="current-password"');
    expect(signIn).toContain('aria-busy="true"');
    expect(signIn).not.toContain('name="name"');
    const emailValue = "member@example.invalid";
    const signUp = render(createElement(LoginForm, { ...shared, mode: "signUp", emailValue }));
    expect(signUp).toContain('name="name"');
    expect(signUp).toContain('autoComplete="new-password"');
    expect(signUp).toContain(`value="${emailValue}"`);
    expect(signUp).not.toContain("readOnly");
    const invited = render(
      createElement(LoginForm, { ...shared, mode: "signUp", emailValue, emailReadOnly: true }),
    );
    expect(invited).toContain('readOnly=""');
  });

  it("shows the recovery request and only accepts a reset form with a valid callback shape", async () => {
    const entries = z.object({
      ForgotPasswordEntry: z.custom<ComponentType<{ onBack: () => void }>>(isComponent),
      PasswordResetEntry:
        z.custom<ComponentType<{ token?: string; callbackError?: string }>>(isComponent),
    });
    const { ForgotPasswordEntry, PasswordResetEntry } = entries.parse(
      await load("account-recovery"),
    );
    const forgot = render(createElement(ForgotPasswordEntry, { onBack() {} }));
    expect(forgot).toContain("Send reset link");
    expect(forgot).toContain('name="email"');
    for (const props of [{}, { token: "token", callbackError: "" }]) {
      const invalid = render(createElement(PasswordResetEntry, props));
      expect(invalid).toContain("Reset link invalid or expired");
      expect(invalid).not.toContain('name="newPassword"');
    }
    const valid = render(createElement(PasswordResetEntry, { token: "" }));
    expect(valid).toContain("Save new password");
    expect(valid).toContain('name="confirmPassword"');
  });

  it("shows the temporary-password change form", async () => {
    interface Props {
      account: { id: string; name: string; email: string };
    }
    const { PasswordChangeEntry } = z
      .object({
        PasswordChangeEntry: z.custom<ComponentType<Props>>(isComponent),
      })
      .parse(await load("password-change"));
    const html = render(
      createElement(PasswordChangeEntry, {
        account: { id: "account", name: "Member", email: "member@example.invalid" },
      }),
    );
    expect(html).toContain("Signed in as member@example.invalid");
    expect(html).toContain('name="currentPassword"');
    expect(html).toContain('name="newPassword"');
    expect(html).toContain('name="confirmPassword"');
  });
});

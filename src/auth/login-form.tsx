import type { SyntheticEvent } from "react";

import { AuthForm } from "../components/app/auth-form.js";
import { FormField } from "../components/app/form-field.js";

export function LoginForm({
  mode,
  busy,
  onSubmit,
  emailValue,
  emailReadOnly = false,
}: {
  mode: "signIn" | "signUp";
  busy: boolean;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  emailValue?: string;
  emailReadOnly?: boolean;
}) {
  const prefix = mode === "signIn" ? "sign-in" : "sign-up";
  const action = mode === "signIn" ? "Sign in" : "Create account";
  const emailProps = loginEmailProps(emailValue, emailReadOnly);
  return (
    <AuthForm label={action} busy={busy} submitLabel={action} onSubmit={onSubmit}>
      {mode === "signUp" && (
        <FormField
          kind="text"
          label="Name"
          name="name"
          id={`${prefix}-name`}
          autoComplete="name"
          required
        />
      )}
      <FormField
        label="Email"
        name="email"
        id={`${prefix}-email`}
        kind="email"
        autoComplete="email"
        {...emailProps}
        required
      />
      <FormField
        label="Password"
        name="password"
        id={`${prefix}-password`}
        kind="password"
        autoComplete={mode === "signIn" ? "current-password" : "new-password"}
        minLength={12}
        required
      />
    </AuthForm>
  );
}

function loginEmailProps(emailValue: string | undefined, emailReadOnly: boolean) {
  const emailProps: {
    value?: string;
    defaultValue?: string;
    readOnly?: boolean;
  } = {};
  if (emailValue !== undefined) {
    if (emailReadOnly) {
      emailProps.value = emailValue;
      emailProps.readOnly = true;
    } else {
      emailProps.defaultValue = emailValue;
    }
  }
  return emailProps;
}

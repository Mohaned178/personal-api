import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AuthResult, signIn, signUp } from "@/lib/auth";

const MIN_PASSWORD = 8;

interface AuthFormProps {
  title: string;
  description: string;
  mode: "signin" | "signup";
  submitLabel: string;
  footer?: ReactNode;
}

/** One form for login, signup and first-run setup. Validates locally, then calls the API. */
export function AuthForm({ title, description, mode, submitLabel, footer }: AuthFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email || !password || (mode === "signup" && !name)) {
      setError("Fill in every field.");
      return;
    }
    if (mode === "signup" && password.length < MIN_PASSWORD) {
      setError(`Use a password of at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const result: AuthResult =
      mode === "signin" ? await signIn(email, password) : await signUp(name, email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // A session that expired leaves its cache behind; the account signing in now must not see it.
    queryClient.clear();
    await navigate({ to: "/" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} noValidate className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {mode === "signup" && (
          <label htmlFor="name" className="flex flex-col gap-1 text-sm font-medium">
            Name
            <Input id="name" name="name" type="text" autoComplete="name" />
          </label>
        )}
        <label htmlFor="email" className="flex flex-col gap-1 text-sm font-medium">
          Email
          <Input id="email" name="email" type="email" autoComplete="email" />
        </label>
        <label htmlFor="password" className="flex flex-col gap-1 text-sm font-medium">
          Password
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        {footer}
      </form>
    </main>
  );
}

import { Link } from "@tanstack/react-router";
import { AuthForm } from "@/routes/auth-form";

/** `redirect` is already checked by `safeRedirect` (the routes' `validateSearch`). */
type RedirectProps = { redirect?: string | undefined };
const searchOf = (redirect: string | undefined) => (redirect === undefined ? {} : { redirect });

export function LoginPage({ signupOpen, redirect }: { signupOpen: boolean } & RedirectProps) {
  return (
    <AuthForm
      redirectTo={redirect}
      mode="signin"
      title="Sign in"
      description="Sign in to your Personal API."
      submitLabel="Sign in"
      footer={
        signupOpen ? (
          <Link
            to="/signup"
            search={searchOf(redirect)}
            className="text-sm text-muted-foreground underline"
          >
            Sign up
          </Link>
        ) : undefined
      }
    />
  );
}

export function SignupPage({ redirect }: RedirectProps) {
  return (
    <AuthForm
      redirectTo={redirect}
      mode="signup"
      title="Create an account"
      description="Sign up for this Personal API."
      submitLabel="Create account"
      footer={
        <Link
          to="/login"
          search={searchOf(redirect)}
          className="text-sm text-muted-foreground underline"
        >
          Back to sign in
        </Link>
      }
    />
  );
}

export function SetupPage({ redirect }: RedirectProps) {
  return (
    <AuthForm
      redirectTo={redirect}
      mode="signup"
      title="Welcome"
      description="Create the first account to set up your Personal API."
      submitLabel="Create account"
    />
  );
}

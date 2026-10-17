import { Link } from "@tanstack/react-router";
import { AuthForm } from "@/routes/auth-form";

export function LoginPage({ signupOpen }: { signupOpen: boolean }) {
  return (
    <AuthForm
      mode="signin"
      title="Sign in"
      description="Sign in to your Personal API."
      submitLabel="Sign in"
      footer={
        signupOpen ? (
          <Link to="/signup" className="text-sm text-muted-foreground underline">
            Sign up
          </Link>
        ) : undefined
      }
    />
  );
}

export function SignupPage() {
  return (
    <AuthForm
      mode="signup"
      title="Create an account"
      description="Sign up for this Personal API."
      submitLabel="Create account"
      footer={
        <Link to="/login" className="text-sm text-muted-foreground underline">
          Back to sign in
        </Link>
      }
    />
  );
}

export function SetupPage() {
  return (
    <AuthForm
      mode="signup"
      title="Welcome"
      description="Create the first account to set up your Personal API."
      submitLabel="Create account"
    />
  );
}

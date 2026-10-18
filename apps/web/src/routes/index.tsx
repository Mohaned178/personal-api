import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth";

export function IndexPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function onSignOut() {
    await signOut();
    // Drop every cached query so the next user on this browser never sees the last one's data.
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Personal API</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Your Data. Your Endpoints. Your Rules.
        </p>
      </div>
      <Link to="/events" className="text-sm underline">
        Events
      </Link>
      <Link to="/health" className="text-sm underline">
        Health
      </Link>
      <Link to="/integrations" className="text-sm underline">
        Integrations
      </Link>
      <Link to="/rules" className="text-sm underline">
        Rules
      </Link>
      <Button variant="outline" onClick={onSignOut}>
        Sign out
      </Button>
    </main>
  );
}

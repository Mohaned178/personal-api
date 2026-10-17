import { Button } from "@/components/ui/button";

export function IndexPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Personal API</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Your Data. Your Endpoints. Your Rules.
        </p>
      </div>
      <Button>Sign in coming soon</Button>
    </main>
  );
}

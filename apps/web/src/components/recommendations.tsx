import { globMatches } from "@personal-api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/activity";
import {
  applyRecommendation,
  getRecommendations,
  hourLabel,
  type Recommendation,
  readDismissed,
  recommendationKey,
  saveDismissed,
} from "@/lib/recommendations";

const minutes = (m: number) => formatDuration(m * 60_000);

function describe(r: Recommendation): { title: string; text: string; apply: string | null } {
  if (r.kind === "limit_plan") {
    return {
      title: `Cut back on ${r.domain}`,
      text: `You average ${minutes(r.averageMinutes)} a day here. Step down one week at a time: ${r.steps.map(minutes).join(" → ")}.`,
      apply: `Set a ${minutes(r.steps[0] as number)} limit`,
    };
  }
  if (r.kind === "limit_step") {
    return {
      title: `Tighten your limit on ${r.pattern}`,
      text: `You stayed under ${minutes(r.currentMinutes)} all week. Lower it to ${minutes(r.nextMinutes)}?`,
      apply: `Lower to ${minutes(r.nextMinutes)}`,
    };
  }
  return {
    title: `${r.domain} late at night`,
    text: `${r.sharePercent}% of your time here is between ${hourLabel(r.fromHour)} and ${hourLabel(r.toHour)}. Consider keeping it for the daytime.`,
    apply: `Block ${hourLabel(r.fromHour)} to ${hourLabel(r.toHour)}`,
  };
}

function matches(r: Recommendation, domain: string): boolean {
  return r.kind === "limit_step" ? globMatches(r.pattern, domain) : r.domain === domain;
}

function Card({ r, onDismiss }: { r: Recommendation; onDismiss: () => void }) {
  const queryClient = useQueryClient();
  const apply = useMutation({
    mutationFn: () => applyRecommendation(r),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const { title, text, apply: applyLabel } = describe(r);
  return (
    <li className="flex flex-col gap-2 rounded-md border p-4" data-testid="recommendation">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{text}</p>
      {apply.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not apply this. Check your limits and try again.
        </p>
      )}
      <div className="flex gap-2">
        {applyLabel && (
          <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending}>
            {applyLabel}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}

/** Suggestions from the user's own last 4 weeks; with `domain`, only the ones about that site. Nothing while loading or on error. */
export function Recommendations({ domain }: { domain?: string }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const query = useQuery({
    queryKey: ["recommendations"],
    queryFn: getRecommendations,
    retry: false,
  });
  const shown = (query.data ?? []).filter(
    (r) =>
      !dismissed.includes(recommendationKey(r)) && (domain === undefined || matches(r, domain)),
  );
  if (shown.length === 0) return null;

  function dismiss(r: Recommendation) {
    const next = [...dismissed, recommendationKey(r)];
    setDismissed(next);
    saveDismissed(next);
  }

  return (
    <section aria-labelledby="recommendations-heading" className="flex flex-col gap-2">
      <h2 id="recommendations-heading" className="text-sm font-medium">
        Suggestions
      </h2>
      <ul className="flex flex-col gap-2">
        {shown.map((r) => (
          <Card key={recommendationKey(r)} r={r} onDismiss={() => dismiss(r)} />
        ))}
      </ul>
    </section>
  );
}

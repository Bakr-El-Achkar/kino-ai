import type { Activity } from "@/lib/kino/activity";

export function ActivityIndicator({ activity }: { activity: Activity }) {
  return <div className="chat-working" role="status" aria-live="polite" aria-atomic="true">
    <span className="activity-icon" aria-hidden="true">
      {activity.kind === "browser" || activity.kind === "reading" ? "\u25ce" : activity.kind === "confirmation" ? "!" : "\u2022"}
    </span>
    <span>{activity.label}</span>
  </div>;
}

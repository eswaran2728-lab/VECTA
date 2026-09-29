import Link from "next/link";
import { assignmentKey, type RoleAssignmentContext } from "@/lib/dashboard/context";

/**
 * Shown when a profile holds MORE THAN ONE active Phase 3 role assignment.
 * Requires an explicit choice -- assignments are never silently merged or
 * auto-picked into one combined scope.
 */
export function ContextSelector({ assignments }: { assignments: RoleAssignmentContext[] }) {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">Choose a dashboard context</h1>
        <p className="font-mono text-xs text-muted-foreground">
          You hold more than one active role assignment. Pick which one to view — each has its own scope and data.
        </p>
      </header>
      <div className="grid gap-2">
        {assignments.map((a) => (
          <Link
            key={assignmentKey(a)}
            href={`/dashboard?context=${encodeURIComponent(assignmentKey(a))}`}
            className="card p-4 hover:bg-card/40 flex items-center justify-between"
          >
            <div>
              <p className="font-semibold text-sm">{a.roleCode}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {[a.aocCode, a.operatingEntityCode, a.departmentCode, a.unitCode, a.hubCode, a.stationCode, a.teamName]
                  .filter(Boolean)
                  .join(" · ") || "Unscoped"}
              </p>
            </div>
            <span className="font-mono text-xs text-primary">View →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

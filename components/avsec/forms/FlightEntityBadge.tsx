"use client";

import { classifyFlightNumber, describeFlightClassification } from "@/lib/avsec/flight-classification";

/** Shows the operating entity detected from the flight number. Display only: the database derives and stores the real classification. */
export function FlightEntityBadge({ flight }: { flight: string | null | undefined }) {
  const c = classifyFlightNumber(flight);
  if (c.status === "missing") return null;
  const ok = c.status === "classified";
  return (
    <p
      className={`font-mono text-[11px] ${ok ? "text-success" : "text-warning"}`}
      role="status"
      data-flight-entity={c.entityCode ?? "unclassified"}
    >
      {describeFlightClassification(c)}
    </p>
  );
}

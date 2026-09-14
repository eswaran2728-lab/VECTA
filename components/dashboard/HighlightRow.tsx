"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { TableRow } from "@/components/icms/ui/table";

/** Table-row variant of HighlightTarget — a "Needs Your Action" panel link
 * (?highlight=<id>) scrolls straight to this row and rings it. */
export function HighlightRow({
  id,
  highlightId,
  className,
  children,
}: {
  id: string;
  highlightId: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  const isHighlighted = highlightId === id;

  useEffect(() => {
    if (isHighlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isHighlighted]);

  return (
    <TableRow
      ref={ref}
      className={(className ?? "") + (isHighlighted ? " outline outline-2 outline-amber-500 -outline-offset-2" : "")}
    >
      {children}
    </TableRow>
  );
}

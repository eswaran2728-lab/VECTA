"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Wraps a list row so a "Needs Your Action" panel link (?highlight=<id>) can
 * scroll straight to it and mark it visually, for record types that have no
 * dedicated detail page — approvals happen inline in a filtered list.
 */
export function HighlightTarget({
  id,
  highlightId,
  className,
  as = "div",
  children,
}: {
  id: string;
  highlightId: string | undefined;
  className?: string;
  as?: "div" | "tr";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement & HTMLTableRowElement>(null);
  const isHighlighted = highlightId === id;

  useEffect(() => {
    if (isHighlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isHighlighted]);

  const highlightClass = isHighlighted
    ? as === "tr"
      ? " outline outline-2 outline-amber-500 -outline-offset-2"
      : " ring-2 ring-amber-500 ring-offset-2 ring-offset-background rounded-lg"
    : "";

  const Tag = as;
  return (
    <Tag ref={ref} className={className + highlightClass}>
      {children}
    </Tag>
  );
}

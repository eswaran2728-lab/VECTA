import clsx, { type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function newId() {
  return crypto.randomUUID();
}

/** Two-letter avatar initials for the header/profile badge. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const [first, second] = parts;
  if (!first) return "··";
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first[0]! + second[0]!).toUpperCase();
}

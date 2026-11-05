/**
 * Filters of the Team Submission History (DSE and SO). Pure so every URL parameter is validated in one tested place; the database function
 * list_team_submissions_secure() applies the same limits and is the authority on scope (the caller's own station and team only).
 */
export const TEAM_HISTORY_TYPES = ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "makeup", "breakup"] as const;
export type TeamHistoryType = (typeof TEAM_HISTORY_TYPES)[number];
export const TEAM_HISTORY_PAGE_SIZE = 25;

export interface TeamHistoryFilters {
  type: TeamHistoryType | null;
  from: string | null;
  to: string | null;
  entity: "MAA" | "AAX" | null;
  search: string | null;
  flight: string | null;
  ack: "acknowledged" | "pending" | null;
  page: number;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

const isoDate = (v: string | undefined): string | null => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? null : v;
};

export function parseTeamHistoryFilters(params: Params): TeamHistoryFilters {
  const type = one(params.type)?.toLowerCase();
  const entity = one(params.entity)?.toUpperCase();
  const ack = one(params.ack)?.toLowerCase();
  let from = isoDate(one(params.from));
  let to = isoDate(one(params.to));
  if (from && to && from > to) [from, to] = [to, from];
  const pageRaw = Number.parseInt(one(params.page) ?? "1", 10);
  const clean = (v: string | undefined, max: number) => (v ? v.replace(/[%_\\]/g, " ").slice(0, max).trim() || null : null);
  return {
    type: (TEAM_HISTORY_TYPES as readonly string[]).includes(type ?? "") ? (type as TeamHistoryType) : null,
    from,
    to,
    entity: entity === "MAA" || entity === "AAX" ? entity : null,
    search: clean(one(params.q), 60),
    flight: clean(one(params.flight), 12),
    ack: ack === "acknowledged" || ack === "pending" ? ack : null,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1,
  };
}

/** The RPC arguments for one page. */
export function teamHistoryRpcArgs(f: TeamHistoryFilters): Record<string, unknown> {
  return {
    p_limit: TEAM_HISTORY_PAGE_SIZE,
    p_offset: (f.page - 1) * TEAM_HISTORY_PAGE_SIZE,
    p_type: f.type,
    p_from: f.from,
    p_to: f.to,
    p_entity: f.entity,
    p_search: f.search,
    p_flight: f.flight,
    p_ack: f.ack,
  };
}

/** A URL for the same filters on another page (or with one filter changed), omitting every default. */
export function teamHistoryHref(f: TeamHistoryFilters, change: Partial<TeamHistoryFilters> = {}): string {
  const m = { ...f, ...change };
  const q = new URLSearchParams();
  if (m.type) q.set("type", m.type);
  if (m.from) q.set("from", m.from);
  if (m.to) q.set("to", m.to);
  if (m.entity) q.set("entity", m.entity);
  if (m.search) q.set("q", m.search);
  if (m.flight) q.set("flight", m.flight);
  if (m.ack) q.set("ack", m.ack);
  if (m.page > 1) q.set("page", String(m.page));
  const s = q.toString();
  return s ? `/avsec/history/team?${s}` : "/avsec/history/team";
}

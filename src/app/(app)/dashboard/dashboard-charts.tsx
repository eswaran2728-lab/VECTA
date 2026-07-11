"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { INCIDENT_TYPE_LABELS } from "@/lib/constants";
import { minutesBetween } from "@/lib/utils";
import type { Direction, IncidentType } from "@/lib/database.types";

const PIE_COLORS = ["#dc2626", "#ea580c", "#d97706", "#7c3aed", "#0891b2", "#64748b"];
const OUT_COLOR = "#2563eb";
const IN_COLOR = "#16a34a";

interface PartTime {
  completed_at: string;
}

export interface DashTx {
  created_at: string;
  completed_at: string | null;
  status: string;
  direction: Direction;
  part_a: PartTime | PartTime[] | null;
  part_b: PartTime | PartTime[] | null;
  part_c: PartTime | PartTime[] | null;
  part_d: PartTime | PartTime[] | null;
}

interface DashboardChartsProps {
  transactions: DashTx[];
  incidents: { incident_type: IncidentType; created_at: string }[];
}

function partTime(p: PartTime | PartTime[] | null): string | null {
  if (!p) return null;
  return Array.isArray(p) ? (p[0]?.completed_at ?? null) : p.completed_at;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function DashboardCharts({ transactions, incidents }: DashboardChartsProps) {
  // Daily movements, stacked outbound vs inbound (last 14 days).
  const daily = useMemo(() => {
    const days: { date: string; label: string; Outbound: number; Inbound: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      days.push({
        date: d.toDateString(),
        label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        Outbound: 0,
        Inbound: 0,
      });
    }
    const index = new Map(days.map((d, i) => [d.date, i]));
    for (const t of transactions) {
      const c = index.get(new Date(t.created_at).toDateString());
      if (c !== undefined) {
        if (t.direction === "OUTBOUND") days[c].Outbound += 1;
        else days[c].Inbound += 1;
      }
    }
    return days;
  }, [transactions]);

  // Average dwell time per checkpoint segment, per direction (minutes).
  const dwell = useMemo(() => {
    const seg = {
      out_ab: [] as number[],
      out_bc: [] as number[],
      out_cd: [] as number[],
      in_ac: [] as number[],
      in_cb: [] as number[],
    };
    for (const t of transactions) {
      const a = partTime(t.part_a);
      const b = partTime(t.part_b);
      const c = partTime(t.part_c);
      const d = partTime(t.part_d);
      if (t.direction === "OUTBOUND") {
        const ab = minutesBetween(a, b);
        const bc = minutesBetween(b, c);
        const cd = minutesBetween(c, d);
        if (ab !== null && ab >= 0) seg.out_ab.push(ab);
        if (bc !== null && bc >= 0) seg.out_bc.push(bc);
        if (cd !== null && cd >= 0) seg.out_cd.push(cd);
      } else {
        const ac = minutesBetween(a, c);
        const cb = minutesBetween(c, b);
        if (ac !== null && ac >= 0) seg.in_ac.push(ac);
        if (cb !== null && cb >= 0) seg.in_cb.push(cb);
      }
    }
    return [
      { segment: "A → B", Outbound: avg(seg.out_ab), Inbound: null },
      { segment: "B → C", Outbound: avg(seg.out_bc), Inbound: null },
      { segment: "C → D", Outbound: avg(seg.out_cd), Inbound: null },
      { segment: "A → C", Outbound: null, Inbound: avg(seg.in_ac) },
      { segment: "C → B", Outbound: null, Inbound: avg(seg.in_cb) },
    ];
  }, [transactions]);

  const byType = useMemo(() => {
    const counts = new Map<IncidentType, number>();
    for (const i of incidents) {
      counts.set(i.incident_type, (counts.get(i.incident_type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([type, count]) => ({
      name: INCIDENT_TYPE_LABELS[type],
      value: count,
    }));
  }, [incidents]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Daily Movements — outbound vs inbound (14 days)</CardTitle>
        </CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: -24 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
              <XAxis dataKey="label" fontSize={11} tickLine={false} />
              <YAxis fontSize={11} allowDecimals={false} tickLine={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Outbound" stackId="d" fill={OUT_COLOR} />
              <Bar dataKey="Inbound" stackId="d" fill={IN_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Incidents by Type (30 days)</CardTitle>
        </CardHeader>
        <CardContent className="h-64">
          {byType.length === 0 ? (
            <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No incidents reported.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={byType} dataKey="value" nameKey="name" outerRadius={80} label>
                  {byType.map((entry, i) => (
                    <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">
            Average Checkpoint Dwell Time (minutes, last 30 days)
          </CardTitle>
        </CardHeader>
        <CardContent className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dwell} margin={{ top: 4, right: 8, bottom: 0, left: -24 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
              <XAxis dataKey="segment" fontSize={11} tickLine={false} />
              <YAxis fontSize={11} allowDecimals={false} tickLine={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Outbound" fill={OUT_COLOR} radius={[4, 4, 0, 0]} />
              <Bar dataKey="Inbound" fill={IN_COLOR} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { INCIDENT_TYPE_LABELS } from "@/lib/constants";
import type { Incident, IncidentType, Transaction } from "@/lib/database.types";

const PIE_COLORS = ["#dc2626", "#ea580c", "#d97706", "#7c3aed", "#64748b"];

interface DashboardChartsProps {
  transactions: Pick<Transaction, "created_at" | "completed_at" | "status">[];
  incidents: Pick<Incident, "incident_type" | "created_at">[];
}

export function DashboardCharts({ transactions, incidents }: DashboardChartsProps) {
  const daily = useMemo(() => {
    const days: { date: string; label: string; created: number; completed: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      days.push({
        date: d.toDateString(),
        label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        created: 0,
        completed: 0,
      });
    }
    const index = new Map(days.map((d, i) => [d.date, i]));
    for (const t of transactions) {
      const c = index.get(new Date(t.created_at).toDateString());
      if (c !== undefined) days[c].created += 1;
      if (t.completed_at) {
        const f = index.get(new Date(t.completed_at).toDateString());
        if (f !== undefined) days[f].completed += 1;
      }
    }
    return days;
  }, [transactions]);

  const monthly = useMemo(() => {
    const weeks: { label: string; total: number }[] = [];
    for (let w = 3; w >= 0; w--) {
      const start = new Date();
      start.setDate(start.getDate() - w * 7 - 6);
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setDate(end.getDate() - w * 7);
      end.setHours(23, 59, 59, 999);
      const total = transactions.filter((t) => {
        const c = new Date(t.created_at);
        return c >= start && c <= end;
      }).length;
      weeks.push({
        label: `${start.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`,
        total,
      });
    }
    return weeks;
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
          <CardTitle className="text-base">Daily Movements (last 14 days)</CardTitle>
        </CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: -24 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
              <XAxis dataKey="label" fontSize={11} tickLine={false} />
              <YAxis fontSize={11} allowDecimals={false} tickLine={false} />
              <Tooltip />
              <Line type="monotone" dataKey="created" name="Created" stroke="#2563eb" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="completed" name="Completed" stroke="#059669" strokeWidth={2} dot={false} />
            </LineChart>
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
          <CardTitle className="text-base">Weekly Volume (last 4 weeks)</CardTitle>
        </CardHeader>
        <CardContent className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top: 4, right: 8, bottom: 0, left: -24 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
              <XAxis dataKey="label" fontSize={11} tickLine={false} />
              <YAxis fontSize={11} allowDecimals={false} tickLine={false} />
              <Tooltip />
              <Bar dataKey="total" name="Transactions" fill="#2563eb" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

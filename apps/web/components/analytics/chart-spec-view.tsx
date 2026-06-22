"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";
import type { ChartSpec } from "@peopleos/schemas";

/**
 * ChartSpecView — renders a model-returned `ChartSpec` (Module 5e "Ask your
 * data"). The AI never generates SQL or raw data; it picks a chart `type`
 * (BAR | LINE | PIE) and supplies a labelled `series` derived ONLY from the
 * metrics snapshot it was given. This component just visualises that spec with
 * Recharts — no data shaping beyond mapping the frozen `{ label, value }` series.
 */

// A small categorical palette for PIE slices / multi-series cues.
const PALETTE = [
  "hsl(221 83% 53%)",
  "hsl(142 71% 45%)",
  "hsl(43 96% 56%)",
  "hsl(0 72% 51%)",
  "hsl(262 83% 58%)",
  "hsl(199 89% 48%)",
  "hsl(24 95% 53%)",
  "hsl(330 81% 60%)",
];

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--card))",
} as const;

export function ChartSpecView({
  chart,
  className,
}: {
  chart: ChartSpec;
  className?: string;
}) {
  // Recharts wants a `name` key for axis/legend labels.
  const data = chart.series.map((s) => ({ name: s.label, value: s.value }));

  if (data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No series to chart.</p>
    );
  }

  return (
    <figure className={cn("space-y-1", className)}>
      <figcaption className="text-xs font-medium text-foreground">
        {chart.title}
      </figcaption>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart.type === "PIE" ? (
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label={{ fontSize: 11 }}
              >
                {data.map((entry, i) => (
                  <Cell key={`${entry.name}-${i}`} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          ) : chart.type === "LINE" ? (
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <Tooltip contentStyle={tooltipStyle} />
              <Line
                type="monotone"
                dataKey="value"
                stroke={PALETTE[0]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))" }}
                contentStyle={tooltipStyle}
              />
              <Bar dataKey="value" radius={3} maxBarSize={48}>
                {data.map((entry, i) => (
                  <Cell key={`${entry.name}-${i}`} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

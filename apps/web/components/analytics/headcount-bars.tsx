"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";
import type { HeadcountBucket } from "@peopleos/schemas";

/**
 * HeadcountBars — a Recharts bar chart over `HeadcountBucket[]` (Module 5b
 * workforce composition: headcount by department / location / level / employment
 * type). Counts come straight from the API-computed `WorkforceComposition`.
 *
 * `orientation="horizontal"` (the default) reads best for many long category
 * labels (departments, locations); `"vertical"` suits short ordered buckets
 * (levels, employment types).
 */

const BAR_COLOR = "hsl(221 83% 53%)"; // matches the Tailwind primary blue family

export function HeadcountBars({
  data,
  orientation = "horizontal",
  className,
}: {
  data: HeadcountBucket[];
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  // Recharts "layout" is the inverse of how a reader describes the bars: a
  // horizontal bar reading (category on the Y axis) is layout="vertical".
  const layout = orientation === "horizontal" ? "vertical" : "horizontal";
  const height = orientation === "horizontal" ? Math.max(120, data.length * 34) : 240;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout={layout}
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            horizontal={orientation === "vertical"}
            vertical={orientation === "horizontal"}
          />
          {layout === "vertical" ? (
            <>
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <YAxis
                type="category"
                dataKey="key"
                width={110}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
            </>
          ) : (
            <>
              <XAxis
                type="category"
                dataKey="key"
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
                interval={0}
                angle={-20}
                textAnchor="end"
                height={48}
              />
              <YAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
            </>
          )}
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--card))",
            }}
          />
          <Bar dataKey="count" radius={3} maxBarSize={40}>
            {data.map((entry) => (
              <Cell key={entry.key} fill={BAR_COLOR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

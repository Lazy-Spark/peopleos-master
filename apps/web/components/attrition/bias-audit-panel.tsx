"use client";

import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api";
import type {
  AttritionBiasAuditRequest,
  AttritionBiasAuditResponse,
  DisparityReport,
} from "@peopleos/schemas";

/**
 * BiasAuditPanel — the monthly tier-distribution disparity audit (spec Module 7
 * ethics: "disparity in score distribution across demographic groups → flag if
 * > 10% disproportionate flagging rate"). It reuses the Module 1 disparity engine
 * via `api.attritionBiasAudit`.
 *
 * PeopleOS deliberately does NOT store protected attributes, so the demographic
 * mapping (employeeId → group) is supplied per-audit by the org and is never
 * persisted. The HRBP pastes a small JSON/CSV-style mapping; the API joins it
 * with current scores, runs the disparity statistics, and returns the
 * `DisparityReport` (selection-rate parity, the EEOC 4/5ths ratio, and the
 * >10pp disproportionate flag) plus any `unmatched` employees with no score.
 */
export function BiasAuditPanel({ className }: { className?: string }) {
  const [raw, setRaw] = React.useState("");
  const [parseError, setParseError] = React.useState<string | null>(null);

  const audit = useMutation<
    AttritionBiasAuditResponse,
    Error,
    AttritionBiasAuditRequest
  >({
    mutationFn: (input) => api.attritionBiasAudit(input),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setParseError(null);
    const demographics = parseMapping(raw);
    if (!demographics) {
      setParseError(
        "Could not parse the mapping. Use one `employeeId,group` per line, or a JSON array of { employeeId, group }.",
      );
      return;
    }
    if (demographics.length === 0) {
      setParseError("Provide at least one employeeId → group mapping.");
      return;
    }
    audit.mutate({ demographics });
  };

  return (
    <div className={cn("space-y-4 rounded-lg border bg-card p-4", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Bias audit (monthly)</h3>
        <p className="text-xs text-muted-foreground">
          Checks whether CRITICAL/HIGH flagging rates differ across demographic
          groups. PeopleOS never stores protected attributes — paste an
          org-supplied <code>employeeId → group</code> mapping (one per line, or a
          JSON array). It is used for this audit only and is not persisted.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-2">
        <label htmlFor="bias-mapping" className="sr-only">
          Demographic mapping
        </label>
        <textarea
          id="bias-mapping"
          rows={5}
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          placeholder={
            "00000000-0000-0000-0000-000000000001,Group A\n00000000-0000-0000-0000-000000000002,Group B"
          }
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!raw.trim() || audit.isPending}>
            {audit.isPending ? "Running audit…" : "Run bias audit"}
          </Button>
          {parseError ? (
            <span className="text-xs text-destructive">{parseError}</span>
          ) : null}
          {audit.isError ? (
            <span className="text-xs text-destructive">
              {audit.error instanceof ApiClientError
                ? `${audit.error.code}: ${audit.error.message}`
                : audit.error.message}
            </span>
          ) : null}
        </div>
      </form>

      {audit.data ? (
        <BiasAuditResult result={audit.data} />
      ) : null}
    </div>
  );
}

function BiasAuditResult({ result }: { result: AttritionBiasAuditResponse }) {
  const { report } = result;
  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <AuditFlag
          label="Disproportionate flagging (>10pp)"
          active={report.disproportionateFlag}
        />
        <AuditFlag
          label="4/5ths rule violation"
          active={report.fourFifthsViolation}
        />
        <span className="text-xs text-muted-foreground">
          Adverse-impact ratio:{" "}
          <span className="font-medium tabular-nums text-foreground">
            {report.adverseImpactRatio === null
              ? "—"
              : report.adverseImpactRatio.toFixed(2)}
          </span>
        </span>
      </div>

      <DisparityTable report={report} />

      {result.unmatched.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {result.unmatched.length} employee
          {result.unmatched.length === 1 ? "" : "s"} in the mapping had no current
          score and {result.unmatched.length === 1 ? "was" : "were"} excluded from
          this audit.
        </p>
      ) : null}
    </div>
  );
}

function DisparityTable({ report }: { report: DisparityReport }) {
  if (report.groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No groups in the audit — none of the mapped employees had a current score.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Group</th>
            <th className="px-3 py-2 text-right font-medium">n</th>
            <th className="px-3 py-2 text-right font-medium">Flagged</th>
            <th className="px-3 py-2 text-right font-medium">Flag rate</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {report.groups.map((g) => {
            const isReference = g.group === report.referenceGroup;
            return (
              <tr key={g.group} className={isReference ? "bg-emerald-600/5" : ""}>
                <td className="px-3 py-2 font-medium">
                  {g.group}
                  {isReference ? (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-emerald-700">
                      reference
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{g.n}</td>
                <td className="px-3 py-2 text-right tabular-nums">{g.selected}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {Math.round(g.selectionRate * 100)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditFlag({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        active
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-emerald-600/40 bg-emerald-600/10 text-emerald-700",
      )}
    >
      <span aria-hidden>{active ? "⚠" : "✓"}</span>
      {label}
      {active ? "" : ": none"}
    </span>
  );
}

/**
 * Parse the org-supplied mapping. Accepts either a JSON array of
 * { employeeId, group } or one `employeeId,group` (or `employeeId\tgroup`) per
 * line. Returns null when the input can't be interpreted at all.
 */
function parseMapping(
  raw: string,
): AttritionBiasAuditRequest["demographics"] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // JSON array form.
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return null;
      const out: AttritionBiasAuditRequest["demographics"] = [];
      for (const row of parsed) {
        if (
          typeof row === "object" &&
          row !== null &&
          typeof (row as Record<string, unknown>).employeeId === "string" &&
          typeof (row as Record<string, unknown>).group === "string"
        ) {
          const employeeId = (row as Record<string, string>).employeeId.trim();
          const group = (row as Record<string, string>).group.trim();
          if (employeeId && group) out.push({ employeeId, group });
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  // Line-delimited `employeeId,group` (comma or tab) form.
  const out: AttritionBiasAuditRequest["demographics"] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const cells = line.split(/[,\t]/).map((c) => c.trim());
    if (cells.length < 2) continue;
    const [employeeId, group] = cells;
    if (employeeId && group) out.push({ employeeId, group });
  }
  return out;
}

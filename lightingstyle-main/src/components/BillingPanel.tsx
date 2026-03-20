import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_FUNCTIONS_URL } from "@/config/publicEnv";
import { getUsageSummary, type TokenUsageSummary } from "@/lib/tokenTracker";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildEdgeRequestHeaders, getEdgeAuthTroubleshootingMessage } from "@/lib/edgeAuth";

interface BillingSnapshot {
  id: string;
  range_days: number;
  range_start: string | null;
  range_end: string | null;
  currency: string;
  total_cost: number;
  prompt_count: number;
  input_tokens: number;
  output_tokens: number;
  avg_cost_per_prompt: number;
  status: string;
  error_message: string | null;
  updated_at: string;
}

const EMPTY: TokenUsageSummary = { totalPrompts: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 };
const BILLING_REFRESH_TIMEOUT_MS = 20_000;
const BILLING_AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
const BILLING_SNAPSHOT_POLL_MS = 1_500;
const BILLING_SNAPSHOT_POLL_WINDOW_MS = 45_000;

function fmtCurrency(n: number, c: string): string {
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: c || "AUD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
  } catch { return `$${n.toFixed(4)}`; }
}

function formatSixHourAsOf(d: string): string {
  const ts = new Date(d);
  if (Number.isNaN(ts.getTime())) return "unknown";
  const sixHourAnchor = new Date(ts);
  sixHourAnchor.setMinutes(0, 0, 0);
  sixHourAnchor.setHours(Math.floor(sixHourAnchor.getHours() / 6) * 6);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(sixHourAnchor);
}

export function BillingPanel() {
  const [snap, setSnap] = useState<BillingSnapshot | null>(null);
  const [billingOk, setBillingOk] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [billingErr, setBillingErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsageSummary>(EMPTY);
  const [loading, setLoading] = useState(true);

  const fetchSnap = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("billing_snapshots" as never)
        .select("*")
        .eq("range_days" as never, 30 as never)
        .order("updated_at" as never, { ascending: false } as never)
        .limit(1)
        .maybeSingle();
      if (error) {
        setBillingOk(false);
        return null;
      }
      if (data) setSnap(data as unknown as BillingSnapshot);
      setBillingOk(true);
      return (data as unknown as BillingSnapshot | null) ?? null;
    } catch {
      setBillingOk(false);
      return null;
    }
  }, []);

  const refreshUsage = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try { setUsage(await getUsageSummary(30)); } finally { if (isInitial) setLoading(false); }
  }, []);

  useEffect(() => {
    fetchSnap().then(() => {});
    refreshUsage(true);
  }, [fetchSnap, refreshUsage]);

  useEffect(() => {
    if (!billingOk) return;
    const ch = supabase
      .channel("billing-snap")
      .on("postgres_changes" as never, { event: "*", schema: "public", table: "billing_snapshots" } as never, () => fetchSnap())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchSnap, billingOk]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setBillingErr(null);
    try {
      const previousSnapshotTime = snap?.updated_at ? new Date(snap.updated_at).getTime() : 0;

      if (billingOk) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), BILLING_REFRESH_TIMEOUT_MS);
        let refreshTimedOut = false;
        try {
          const headers = await buildEdgeRequestHeaders({ "Content-Type": "application/json" });
          const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/billing-snapshot`, {
            method: "POST",
            headers,
            body: JSON.stringify({ range_days: 30 }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const e = await res.json().catch(() => ({ error: "Unknown" }));
            const raw = e.error || `HTTP ${res.status}`;
            const edgeAuthHint = getEdgeAuthTroubleshootingMessage(String(raw));
            throw new Error(edgeAuthHint || raw);
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            refreshTimedOut = true;
          } else {
            throw err;
          }
        } finally {
          clearTimeout(timeoutId);
        }

        if (refreshTimedOut) {
          const deadline = Date.now() + BILLING_SNAPSHOT_POLL_WINDOW_MS;
          let snapshotUpdated = false;

          while (Date.now() < deadline && !snapshotUpdated) {
            await new Promise((resolve) => setTimeout(resolve, BILLING_SNAPSHOT_POLL_MS));
            const latest = await fetchSnap();
            const latestTime = latest?.updated_at ? new Date(latest.updated_at).getTime() : 0;
            if (latestTime > previousSnapshotTime) {
              snapshotUpdated = true;
            }
          }

          if (!snapshotUpdated) {
            setBillingErr("Billing refresh is still processing in the background — showing the latest cached snapshot.");
          }
        } else {
          await fetchSnap();
        }
      }
      await refreshUsage(false);
    } catch (err) {
      setBillingErr(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (refreshing) return;
      void handleRefresh();
    }, BILLING_AUTO_REFRESH_INTERVAL_MS);

    return () => clearInterval(iv);
  }, [handleRefresh, refreshing]);

  const hasBilling = billingOk && snap && snap.status === "success";
  const currency = snap?.currency || "AUD";

  // Keep prompt/token counters aligned to billing snapshot cadence when billing is available.
  const prompts = hasBilling ? (snap.prompt_count ?? 0) : usage.totalPrompts;
  const input = hasBilling ? (snap.input_tokens ?? 0) : usage.totalInputTokens;
  const output = hasBilling ? (snap.output_tokens ?? 0) : usage.totalOutputTokens;
  const totalTokens = hasBilling ? (input + output) : usage.totalTokens;
  const avgCostPerPrompt = hasBilling
    ? (snap.avg_cost_per_prompt ?? (prompts > 0 ? snap.total_cost / prompts : 0))
    : 0;

  return (
    <div className="space-y-4">
      {/* Status line */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground">
          {hasBilling
            ? <>Official costs from <strong>Google Cloud Billing</strong> • <strong>{currency}</strong> • Auto-refreshes on server schedule</>
            : <>Token usage from Google's <code className="text-xs bg-muted px-1 rounded">usageMetadata</code>. Set up billing-snapshot for official AUD costs.</>
          }
        </p>
        {hasBilling && (
          <div className="flex items-center gap-2 text-xs shrink-0">
            {snap.status === "error" ? (
              <span className="flex items-center gap-1 text-destructive"><AlertCircle className="h-3 w-3" /> Failed</span>
            ) : (
              <span className="flex items-center gap-1 text-success"><CheckCircle2 className="h-3 w-3" /> Synced</span>
            )}
            <span className="text-muted-foreground">•</span>
            <span className="flex items-center gap-1 text-muted-foreground"><Clock className="h-3 w-3" /> Correct as of {formatSixHourAsOf(snap.updated_at)}</span>
          </div>
        )}
      </div>

      {/* Error */}
      {billingErr && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {billingErr}
        </div>
      )}

      {/* ── All metrics ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Total Cost */}
        <div className={cn(
          "rounded-lg border p-3 sm:p-4 text-center min-w-0",
          hasBilling ? "border-primary/30 bg-primary/5" : "border-border opacity-40"
        )}>
          <p className="text-lg sm:text-2xl font-bold text-foreground truncate">
            {hasBilling ? fmtCurrency(snap.total_cost, currency) : "—"}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">Total Cost (30d)</p>
        </div>

        {/* Avg Cost / Prompt */}
        <div className={cn(
          "rounded-lg border p-3 sm:p-4 text-center min-w-0",
          hasBilling ? "border-border" : "border-border opacity-40"
        )}>
          <p className="text-lg sm:text-2xl font-bold text-foreground truncate">
            {hasBilling && prompts > 0 ? fmtCurrency(avgCostPerPrompt, currency) : "—"}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">Avg Cost / Prompt</p>
        </div>

        {/* Prompts */}
        <div className="rounded-lg border border-border p-3 sm:p-4 text-center min-w-0">
          <p className="text-lg sm:text-2xl font-bold text-foreground truncate">{loading ? "…" : prompts.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Prompts</p>
        </div>

        {/* Input Tokens */}
        <div className="rounded-lg border border-border p-3 sm:p-4 text-center min-w-0">
          <p className="text-lg sm:text-2xl font-bold text-foreground truncate">{loading ? "…" : input.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Input Tokens</p>
        </div>

        {/* Output Tokens */}
        <div className="rounded-lg border border-border p-3 sm:p-4 text-center min-w-0">
          <p className="text-lg sm:text-2xl font-bold text-foreground truncate">{loading ? "…" : output.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Output Tokens</p>
        </div>

        {/* Total Tokens (30d) */}
        <div className="rounded-lg border border-border p-3 sm:p-4 text-center min-w-0">
          <p className="text-lg sm:text-2xl font-bold text-foreground truncate">{loading ? "…" : totalTokens.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Total Tokens (30d)</p>
        </div>
      </div>

      {/* Date range */}
      {hasBilling && snap.range_start && snap.range_end && (
        <p className="text-xs text-muted-foreground">Billing period: {snap.range_start} → {snap.range_end}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="text-xs">
          <RefreshCw className={cn("h-3 w-3 mr-1", refreshing && "animate-spin")} />
          {refreshing ? "Syncing…" : "Refresh"}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Prompt and token metrics are shown as a rolling last 30 days (from the latest 6-hour billing snapshot when synced).
        </p>
      </div>
    </div>
  );
}

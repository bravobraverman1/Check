import { useState, useEffect, useCallback } from "react";
import { getUsageSummary, clearUsageData, type TokenUsageSummary } from "@/lib/tokenTracker";
import { Button } from "@/components/ui/button";
import { Trash2, RefreshCw } from "lucide-react";

const EMPTY: TokenUsageSummary = {
  totalPrompts: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
};

export function TokenUsagePanel() {
  const [summary, setSummary] = useState<TokenUsageSummary>(EMPTY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await getUsageSummary(0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleClear = async () => {
    await clearUsageData();
    await refresh();
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Token usage tracked from Google's <code>usageMetadata</code>. For actual costs, check{" "}
        <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener noreferrer" className="underline text-primary">
          Google Cloud Billing
        </a>.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{loading ? "…" : summary.totalPrompts}</p>
          <p className="text-xs text-muted-foreground mt-1">Total Prompts</p>
        </div>
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{loading ? "…" : summary.totalInputTokens.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground mt-1">Input Tokens</p>
        </div>
        <div className="rounded-lg border border-border p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{loading ? "…" : summary.totalOutputTokens.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground mt-1">Output Tokens</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground flex-1">
          Total tokens (all time): <span className="font-medium text-foreground">{summary.totalTokens.toLocaleString()}</span>
        </p>
        <Button type="button" variant="outline" size="sm" onClick={refresh} className="text-xs" disabled={loading}>
          <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleClear} className="text-xs">
          <Trash2 className="h-3 w-3 mr-1" /> Clear History
        </Button>
      </div>
    </div>
  );
}

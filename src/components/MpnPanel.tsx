import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Hash, User, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { invokeGoogleSheetsFunction } from "@/lib/supabaseGoogleSheets";
import type { GoogleSheetsAction } from "@/lib/googleSheetsActions";
import { config, getSheetTabName } from "@/config";

function getTabNamesPayload() {
  return { EVENTS: getSheetTabName("SHEET_EVENTS") };
}

interface MpnResponse {
  success: boolean;
  nextMpn?: number;
  reservedMpn?: number;
  status?: string;
  eranMsg?: string;
  eranValue?: number;
  error?: string;
}

type MpnPanelMode = "manager" | "set-next";

interface MpnPanelProps {
  mode?: MpnPanelMode;
}

export function MpnPanel({ mode = "manager" }: MpnPanelProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState<string | null>(null);
  const [nextMpn, setNextMpn] = useState<number | null>(null);
  const [nextMpnDraft, setNextMpnDraft] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [eranMsg, setEranMsg] = useState<string>("");
  const [eranValue, setEranValue] = useState<number | null>(null);

  const callMpnAction = useCallback(async (action: GoogleSheetsAction, extra?: Record<string, unknown>) => {
    setLoading(action);
    try {
      const { data, error } = await invokeGoogleSheetsFunction<MpnResponse>({
        action,
        tabNames: getTabNamesPayload(),
        ...extra,
      });
      if (error) {
        toast({ variant: "destructive", title: "MPN Error", description: error.message });
        return null;
      }
      if (data && !data.success) {
        toast({ variant: "destructive", title: "MPN Error", description: data.error || "Unknown error" });
        return null;
      }
      return data;
    } catch (err) {
      toast({ variant: "destructive", title: "MPN Error", description: err instanceof Error ? err.message : "Failed" });
      return null;
    } finally {
      setLoading(null);
    }
  }, [toast]);

  const handlePeek = useCallback(async () => {
    const data = await callMpnAction("mpn-peek");
    if (data) {
      setNextMpn(data.nextMpn ?? null);
      setNextMpnDraft(data.nextMpn !== undefined && data.nextMpn !== null ? String(data.nextMpn) : "");
      setStatus(data.status || "");
      setEranMsg(data.eranMsg || "");
      setEranValue(data.eranValue ?? null);
    }
  }, [callMpnAction]);

  const handleEran = useCallback(async () => {
    const data = await callMpnAction("mpn-eran");
    if (data) {
      setNextMpn(data.nextMpn ?? null);
      setStatus(data.status || "");
      setEranMsg(data.eranMsg || "");
      setEranValue(data.eranValue ?? null);
      toast({ title: "MPN Reserved for Eran", description: `MPN ${data.reservedMpn} reserved` });
    }
  }, [callMpnAction, toast]);

  const handleSetNextMpn = useCallback(async () => {
    const trimmed = nextMpnDraft.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0 || !/^\d+$/.test(trimmed)) {
      toast({ variant: "destructive", title: "Invalid MPN", description: "Enter a positive whole number." });
      return;
    }

    const data = await callMpnAction("mpn-set-next", { nextMpn: parsed });
    if (data) {
      setNextMpn(data.nextMpn ?? null);
      setNextMpnDraft(data.nextMpn !== undefined && data.nextMpn !== null ? String(data.nextMpn) : trimmed);
      setStatus(data.status || "");
      toast({ title: "Next MPN Updated", description: `Next MPN is now ${data.nextMpn}.` });
    }
  }, [callMpnAction, nextMpnDraft, toast]);

  // Auto-refresh on mount
  useEffect(() => {
    handlePeek();
  }, [handlePeek]);

  const isLoading = loading !== null;
  const isManagerMode = mode === "manager";
  const isSetNextMode = mode === "set-next";

  return (
    <div className="space-y-4">
      {isManagerMode && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            View and manage the next available MPN number from the Events sheet.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={handlePeek} disabled={isLoading}>
            {loading === "mpn-peek" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}

      {isManagerMode && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Hash className="h-3 w-3" />
              Next MPN
            </span>
            <div className="text-3xl font-bold tabular-nums text-foreground">
              {nextMpn !== null ? nextMpn : "—"}
            </div>
            {status && (
              <p className="text-[10px] text-muted-foreground break-words leading-tight">{status}</p>
            )}
          </div>

          <div className="rounded-lg border border-border bg-accent/20 p-4 space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <User className="h-3 w-3" />
              Eran MPN
            </span>
            <div className="text-3xl font-bold tabular-nums text-foreground">
              {eranValue !== null ? eranValue : "—"}
            </div>
            {eranMsg && (
              <p className="text-[10px] font-medium text-muted-foreground break-words leading-tight">{eranMsg}</p>
            )}
          </div>
        </div>
      )}

      {isSetNextMode && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="space-y-1">
            <Label htmlFor="next-mpn-input">Set Next / Starting MPN</Label>
            <p className="text-xs text-muted-foreground">
              Safe admin override. This can only move the sequence to an unused number above already-consumed MPNs.
            </p>
          </div>
          <div className="flex gap-3">
            <Input
              id="next-mpn-input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={nextMpnDraft}
              onChange={(event) => setNextMpnDraft(event.target.value.replace(/[^\d]/g, ""))}
              placeholder={nextMpn !== null ? String(nextMpn) : "Enter next MPN"}
              disabled={isLoading}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleSetNextMpn}
              disabled={isLoading || !nextMpnDraft.trim()}
            >
              {loading === "mpn-set-next" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Set Next MPN
            </Button>
          </div>
        </div>
      )}

      {isManagerMode && (
        <Button
          type="button"
          variant="destructive"
          className="w-full"
          onClick={handleEran}
          disabled={isLoading}
        >
          {loading === "mpn-eran" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <User className="h-4 w-4 mr-2" />}
          Get New MPN (Eran)
        </Button>
      )}

      {isSetNextMode && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={handlePeek} disabled={isLoading}>
            {loading === "mpn-peek" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}

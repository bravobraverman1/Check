import { NavLink } from "react-router-dom";
import { ClipboardList, FlaskConical, PackageSearch, Settings, RefreshCw, Lamp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { syncGoogleSheetQueries } from "@/lib/querySync";

const tabs = [
{ to: "/", label: "Form", icon: ClipboardList, end: true as boolean | undefined },
{ to: "/test", label: "Test", icon: FlaskConical, end: undefined },
{ to: "/product-options", label: "Product Options", icon: PackageSearch, end: undefined },
{ to: "/admin", label: "Admin", icon: Settings, end: undefined }];


interface AppLayoutProps {
  children: React.ReactNode;
}

const AUTO_SYNC_INTERVAL_MS = 5 * 60_000; // background auto-sync every 5 minutes while visible
const FOCUS_SYNC_THROTTLE_MS = 60_000;

export function AppLayout({ children }: AppLayoutProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const isLovablePreview =
    typeof window !== "undefined" && /(^|\.)lovable\.(dev|app)$/.test(window.location.hostname);

  const autoSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSyncInFlightRef = useRef(false);
  const lastAutoSyncAtRef = useRef(0);

  const doSync = useCallback(async (silent = false, includeDock = false) => {
    await syncGoogleSheetQueries(queryClient, { includeDock });
    if (!silent) {
      toast({ title: "Synced", description: "All data refreshed from Google Sheets." });
    }
  }, [queryClient, toast]);

  // Automatic background sync
  useEffect(() => {
    const runBackgroundSync = () => {
      if (document.visibilityState !== "visible") return;
      if (autoSyncInFlightRef.current) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      autoSyncInFlightRef.current = true;
      lastAutoSyncAtRef.current = Date.now();
      doSync(true).catch(() => {
        // silent background sync — don't show errors
      }).finally(() => {
        autoSyncInFlightRef.current = false;
      });
    };

    autoSyncRef.current = setInterval(() => {
      runBackgroundSync();
    }, AUTO_SYNC_INTERVAL_MS);

    const handleVisibilityOrFocus = () => {
      const now = Date.now();
      if (now - lastAutoSyncAtRef.current < FOCUS_SYNC_THROTTLE_MS) return;
      runBackgroundSync();
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      if (autoSyncRef.current) clearInterval(autoSyncRef.current);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [doSync]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await doSync(false, true);
    } catch {
      toast({ variant: "destructive", title: "Sync failed", description: "Could not refresh data." });
    } finally {
      setSyncing(false);
    }
  };



  const renderTab = (tab: (typeof tabs)[number]) =>
  <NavLink
    key={tab.to}
    to={tab.to}
    end={tab.end}
    className={({ isActive }) =>
    cn(
      "flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full transition-colors whitespace-nowrap",
      isActive ?
      "bg-primary text-primary-foreground shadow-sm" :
      "text-muted-foreground hover:bg-accent hover:text-foreground"
    )
    }>

      <tab.icon className="h-4 w-4" />
      {tab.label}
    </NavLink>;


  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border sticky top-0 z-40">
        <div className="w-full mx-auto px-6 flex items-center gap-6 h-14">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center">
              <Lamp className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-base font-bold text-foreground tracking-tight">
              Lighting<span className="text-primary">Style</span>
            </span>
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto">
            {tabs.slice(0, -1).map(renderTab)}
            <button
              onClick={handleSync}
              disabled={syncing}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full transition-colors whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground",
                syncing && "opacity-50 cursor-not-allowed"
              )}>
              <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
              Google Sync
            </button>
            {tabs.slice(-1).map(renderTab)}
          </nav>
        </div>
      </header>

      <main className="w-full px-6 py-8">{children}</main>

      <footer className="border-t border-border bg-card mt-8">
        <div className="w-full px-6 py-3 text-center">
          <p className="text-xs text-muted-foreground">
            Use each tab for its workflow • Fields marked with * are required where applicable
          </p>
          {isLovablePreview && (
            <p className="text-xs text-muted-foreground/80 mt-1">
              Lovable preview can lag behind GitHub and edge-function deploys. If this screen says it is previewing the last
              saved version, use Lovable Sync/Refresh or Publish to pull the latest app state.
            </p>
          )}
        </div>
      </footer>
    </div>);
}

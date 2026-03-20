import { Suspense, lazy, useEffect, useRef, type ComponentType } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider, keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import { PdfFilesProvider } from "@/context/PdfFilesContext";
import { CompareAiProvider } from "@/context/CompareAiContext";
import { onConfigChange } from "@/lib/configSync";
import { DEFAULT_SHEET_TABS, setSheetTabName, setConfigValue } from "@/config";
import { updateGeminiConfig } from "@/lib/geminiConfig";
import { setAiCollisionTuningConfig } from "@/lib/aiCollisionTuningConfig";
import { setTestCsvCompareIgnoredColumns } from "@/lib/testCsvCompareConfig";
import { syncGoogleSheetQueries } from "@/lib/querySync";
import { initGlobalSettings } from "@/lib/globalSettings";
import { useToast } from "@/hooks/use-toast";
import { submitProduct } from "@/lib/api";
import { isDuplicateTitleSubmitError } from "@/lib/duplicateTitleGuard";
import { checkDockRowStatus, persistGlobalPendingDockSubmit, removeGlobalPendingDockSubmit } from "@/lib/supabaseGoogleSheets";
import { persistPendingDockSubmit, removePendingDockSubmit } from "@/lib/loadingDockPending";
import {
  listPendingSubmitRecoveries,
  markPendingSubmitRecoveryAttempt,
  markPendingSubmitRecoveryWarned,
  PENDING_SUBMIT_RECOVERY_FIRST_RETRY_DELAY_MS,
  PENDING_SUBMIT_RECOVERY_MAX_ATTEMPTS,
  PENDING_SUBMIT_RECOVERY_RETRY_INTERVAL_MS,
  PENDING_SUBMIT_RECOVERY_WARN_AFTER_MS,
  removePendingSubmitRecovery,
} from "@/lib/pendingSubmitRecovery";
import Index from "./pages/Index";

const CHUNK_RETRY_PREFIX = "chunk-retry-v1:";

function createChunkFallback(pageLabel: string) {
  return function ChunkFallbackPage() {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        Failed to load <span className="font-medium text-foreground">{pageLabel}</span>. Please refresh and try again.
      </div>
    );
  };
}

function lazyWithChunkRetry(
  pageLabel: string,
  importer: () => Promise<{ default: ComponentType<any> }>,
) {
  return lazy(async () => {
    const retryKey = `${CHUNK_RETRY_PREFIX}${pageLabel}`;
    const alreadyRetried = typeof window !== "undefined" && sessionStorage.getItem(retryKey) === "1";

    try {
      const mod = await importer();
      if (typeof window !== "undefined") sessionStorage.removeItem(retryKey);
      return mod;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      const isChunkLoadError =
        /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i.test(
          message,
        );

      if (isChunkLoadError && !alreadyRetried && typeof window !== "undefined") {
        sessionStorage.setItem(retryKey, "1");
        window.location.reload();
        return { default: createChunkFallback(pageLabel) };
      }

      console.error(`[route-load] ${pageLabel} failed:`, error);
      return { default: createChunkFallback(pageLabel) };
    }
  });
}

const LoadingDock = lazyWithChunkRetry("Loading Dock", () => import("./pages/LoadingDock"));
const Test = lazyWithChunkRetry("Test", () => import("./pages/Test"));
const ProductOptions = lazyWithChunkRetry("Product Options", () => import("./pages/ProductOptions"));
const Admin = lazyWithChunkRetry("Admin", () => import("./pages/Admin"));
const NotFound = lazyWithChunkRetry("Not Found", () => import("./pages/NotFound"));

function RouteFallback() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="text-sm text-muted-foreground text-center">Loading page...</div>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Global resilience: keep showing cached data on errors, retry silently
      retry: 2,
      retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      placeholderData: keepPreviousData,
      // throwOnError: false is the default — queries won't crash components on error
    },
  },
});
queryClient.setQueryDefaults(["recent-submissions"], {
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  retry: 2,
  staleTime: 30_000,
  refetchOnMount: true,
  refetchOnWindowFocus: true,
  placeholderData: keepPreviousData,
});

/**
 * Listens for config changes from ANY other connected client.
 * When tab names are saved elsewhere, applies them locally then runs
 * the same Google Sync as the nav button — no page reload, no state reset.
 */
function CrossConnectionConfigSync() {
  const qc = useQueryClient();

  // Pull global settings from Supabase into localStorage on boot
  useEffect(() => {
    initGlobalSettings();
  }, []);

  useEffect(() => {
    // Same as the Google Sync nav button — refresh all data, keep all UI state
    const triggerGoogleSync = (includeDock = false) => {
      syncGoogleSheetQueries(qc, { includeDock }).catch((err) => {
        console.warn("[configSync] failed to sync queries:", err);
      });
    };

    const unsub = onConfigChange((event, payload) => {
      if (event === "tab-names-saved") {
        // Apply the new tab names to localStorage on this client first
        const incoming = payload.tabValues as Record<string, string> | undefined;
        if (incoming) {
          for (const tab of DEFAULT_SHEET_TABS) {
            if (incoming[tab.key] !== undefined) setSheetTabName(tab.key, incoming[tab.key]);
          }
          // Notify Admin page UI to update its tabValues state in real-time
          window.dispatchEvent(new CustomEvent("tab-names-updated", { detail: incoming }));
        }
        // Then run the Google Sync — identical to the nav button
        triggerGoogleSync(true);
      } else if (event === "connection-settings-saved") {
        if (payload.INSTRUCTIONS_PDF_URL !== undefined)
          setConfigValue("INSTRUCTIONS_PDF_URL", String(payload.INSTRUCTIONS_PDF_URL));
        if (payload.DRIVE_CSV_FOLDER_ID !== undefined)
          setConfigValue("DRIVE_CSV_FOLDER_ID", String(payload.DRIVE_CSV_FOLDER_ID));
        triggerGoogleSync(true);
      } else if (event === "categories-saved") {
        triggerGoogleSync(false);
      } else if (event === "gemini-enabled-changed") {
        const enabled = Boolean(payload.enabled);
        updateGeminiConfig({ enabled });
      } else if (event === "ai-collision-tuning-saved") {
        setAiCollisionTuningConfig(payload);
        window.dispatchEvent(new CustomEvent("ai-collision-tuning-updated"));
      } else if (event === "test-csv-compare-settings-saved") {
        const incoming = payload.ignoredColumns;
        if (Array.isArray(incoming)) {
          setTestCsvCompareIgnoredColumns(incoming.map((entry) => String(entry ?? "")));
        }
      }
    });

    return unsub;
  }, [qc]);

  return null;
}

function PendingSubmitRecoveryBootstrap() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const recoveringSkusRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const runRecoverySweep = async () => {
      if (cancelled) return;

      const entries = listPendingSubmitRecoveries().sort((a, b) => a.submittedAtEpochMs - b.submittedAtEpochMs);
      if (entries.length === 0) return;

      for (const entry of entries) {
        if (cancelled) return;

        const normalizedSku = entry.sku.trim().toUpperCase();
        if (!normalizedSku || recoveringSkusRef.current.has(normalizedSku)) continue;

        const now = Date.now();
        if (entry.expiresAt <= now) {
          removePendingSubmitRecovery(entry.sku);
          removePendingDockSubmit(entry.sku);
          await removeGlobalPendingDockSubmit({
            sku: entry.sku,
            submittedAtEpochMs: entry.submittedAtEpochMs,
          });
          window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
          toast({
            variant: "destructive",
            title: "Saved submit expired",
            description: `SKU ${entry.sku} could not be safely recovered and was removed from local recovery storage.`,
            duration: 12000,
          });
          continue;
        }

        const ageMs = now - entry.submittedAtEpochMs;
        if (ageMs >= PENDING_SUBMIT_RECOVERY_WARN_AFTER_MS && !entry.warnedAt) {
          markPendingSubmitRecoveryWarned(entry.sku, now);
          toast({
            title: entry.isOverwrite ? "Interrupted override detected" : "Interrupted submit detected",
            description:
              `SKU ${entry.sku} was saved locally after an interruption. The app will retry automatically once it confirms the backend has no active record for it.`,
            duration: 12000,
          });
        }

        let status: Awaited<ReturnType<typeof checkDockRowStatus>> | null = null;
        try {
          status = await checkDockRowStatus(entry.sku);
        } catch {
          continue;
        }

        if (!status?.success) continue;

        if (status.pending) {
          removePendingSubmitRecovery(entry.sku);
          continue;
        }

        if (status.existsInDock || status.actionable) {
          removePendingSubmitRecovery(entry.sku);
          removePendingDockSubmit(entry.sku);
          await removeGlobalPendingDockSubmit({
            sku: entry.sku,
            submittedAtEpochMs: entry.submittedAtEpochMs,
          });
          window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
          continue;
        }

        if (status.error) {
          removePendingSubmitRecovery(entry.sku);
          removePendingDockSubmit(entry.sku);
          await removeGlobalPendingDockSubmit({
            sku: entry.sku,
            submittedAtEpochMs: entry.submittedAtEpochMs,
          });
          window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
          toast({
            variant: "destructive",
            title: "Recovered submit cancelled",
            description: `SKU ${entry.sku} reported a dock error, so the saved recovery entry was discarded.`,
            duration: 12000,
          });
          continue;
        }

        if (ageMs < PENDING_SUBMIT_RECOVERY_FIRST_RETRY_DELAY_MS) continue;
        if ((now - entry.lastAttemptAt) < PENDING_SUBMIT_RECOVERY_RETRY_INTERVAL_MS) continue;

        // ── Safety: hard cap on retry attempts ──
        if (entry.attemptCount >= PENDING_SUBMIT_RECOVERY_MAX_ATTEMPTS) {
          console.warn(`[recovery] SKU ${entry.sku} exceeded max attempts (${PENDING_SUBMIT_RECOVERY_MAX_ATTEMPTS}), abandoning.`);
          removePendingSubmitRecovery(entry.sku);
          removePendingDockSubmit(entry.sku);
          await removeGlobalPendingDockSubmit({
            sku: entry.sku,
            submittedAtEpochMs: entry.submittedAtEpochMs,
          });
          window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
          toast({
            variant: "destructive",
            title: "Recovery abandoned",
            description: `SKU ${entry.sku} could not be automatically recovered after ${PENDING_SUBMIT_RECOVERY_MAX_ATTEMPTS} attempts. Please resubmit manually if needed.`,
            duration: 12000,
          });
          continue;
        }

        // ── Safety: re-check dock status right before re-submit to avoid duplicates ──
        let preSubmitStatus: Awaited<ReturnType<typeof checkDockRowStatus>> | null = null;
        try {
          preSubmitStatus = await checkDockRowStatus(entry.sku);
        } catch { /* ignore — will skip re-submit if we can't verify */ }
        if (preSubmitStatus?.success && (preSubmitStatus.existsInDock || preSubmitStatus.pending)) {
          console.log(`[recovery] SKU ${entry.sku} already in dock or pending — skipping re-submit.`);
          removePendingSubmitRecovery(entry.sku);
          if (preSubmitStatus.existsInDock) {
            removePendingDockSubmit(entry.sku);
            await removeGlobalPendingDockSubmit({
              sku: entry.sku,
              submittedAtEpochMs: entry.submittedAtEpochMs,
            });
            window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
          }
          continue;
        }

        recoveringSkusRef.current.add(normalizedSku);
        try {
          markPendingSubmitRecoveryAttempt(entry.sku, now);
          void persistGlobalPendingDockSubmit({
            sku: entry.sku,
            submittedAt: entry.submittedAt,
            submittedAtEpochMs: entry.submittedAtEpochMs,
            isOverwrite: entry.isOverwrite,
          });
          persistPendingDockSubmit({
            sku: entry.sku,
            submittedAt: entry.submittedAt,
            submittedAtEpochMs: entry.submittedAtEpochMs,
            isOverwrite: entry.isOverwrite,
          });
          window.dispatchEvent(
            new CustomEvent("optimistic-submit", {
              detail: {
                sku: entry.sku,
                submittedAt: entry.submittedAt,
                submittedAtEpochMs: entry.submittedAtEpochMs,
                isOverwrite: entry.isOverwrite,
              },
            }),
          );

          const result = await submitProduct(entry.payload);
          if (!result.pending) {
            removePendingSubmitRecovery(entry.sku);
          }
          void qc.invalidateQueries({ queryKey: ["recent-submissions"] });

          if (result.processedAt) {
            window.dispatchEvent(
              new CustomEvent("optimistic-submit-complete", {
                detail: { sku: entry.sku, processedAt: result.processedAt },
              }),
            );
          }

          toast({
            title: entry.isOverwrite ? "Override resumed" : "Submit resumed",
            description: `SKU ${entry.sku} was recovered and pushed automatically after an interruption.`,
            duration: 8000,
          });
        } catch (error) {
          if (isDuplicateTitleSubmitError(error)) {
            removePendingSubmitRecovery(entry.sku);
            removePendingDockSubmit(entry.sku);
            await removeGlobalPendingDockSubmit({
              sku: entry.sku,
              submittedAtEpochMs: entry.submittedAtEpochMs,
            });
            window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
            toast({
              variant: "destructive",
              title: "Recovered submit needs confirmation",
              description:
                `SKU ${entry.sku} was not auto-resubmitted because "${error.duplicateTitle}" already exists in ${error.duplicateTitleSources.join(" & ")}. Reopen the form and submit again if you want to continue.`,
              duration: 12000,
            });
            continue;
          }
          removePendingDockSubmit(entry.sku);
          await removeGlobalPendingDockSubmit({
            sku: entry.sku,
            submittedAtEpochMs: entry.submittedAtEpochMs,
          });
          window.dispatchEvent(new CustomEvent("optimistic-submit-cancel", { detail: { sku: entry.sku } }));
        } finally {
          recoveringSkusRef.current.delete(normalizedSku);
        }
      }
    };

    void runRecoverySweep();
    const intervalId = window.setInterval(() => {
      void runRecoverySweep();
    }, 15_000);
    const handleFocus = () => {
      void runRecoverySweep();
    };
    const handleOnline = () => {
      void runRecoverySweep();
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [qc, toast]);

  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <PdfFilesProvider>
          <CompareAiProvider>
            <CrossConnectionConfigSync />
            <PendingSubmitRecoveryBootstrap />
            <AppLayout>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route
                  path="/loading-dock"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <LoadingDock />
                    </Suspense>
                  }
                />
                <Route
                  path="/test"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <Test />
                    </Suspense>
                  }
                />
                <Route
                  path="/product-options"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <ProductOptions />
                    </Suspense>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <Admin />
                    </Suspense>
                  }
                />
                <Route
                  path="*"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <NotFound />
                    </Suspense>
                  }
                />
              </Routes>
            </AppLayout>
          </CompareAiProvider>
        </PdfFilesProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

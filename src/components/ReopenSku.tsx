import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { reopenSku, type ReopenedProduct } from "@/lib/api";

interface ReopenSkuProps {
  onReopened: (data: ReopenedProduct) => void;
  dockSkus?: string[];
}

export function ReopenSku({ onReopened, dockSkus = [] }: ReopenSkuProps) {
  const { toast } = useToast();
  const [sku, setSku] = useState("");
  const [dockSku, setDockSku] = useState("");
  const [loading, setLoading] = useState(false);
  const [reopened, setReopened] = useState(false);

  const handleReopen = useCallback(async () => {
    const trimmed = sku.trim();
    if (!trimmed) {
      toast({ variant: "destructive", title: "SKU Required", description: "Enter a SKU to reopen." });
      return;
    }

    setLoading(true);
    try {
      const data = await reopenSku(trimmed);
      setReopened(true);
      onReopened(data);
      toast({ title: "SKU Reopened", description: `${trimmed} has been reopened for editing.` });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Reopen Failed",
        description: err instanceof Error ? err.message : "Could not reopen SKU.",
      });
    } finally {
      setLoading(false);
    }
  }, [sku, toast, onReopened]);

  const handleDockSkuReopen = useCallback(async () => {
    if (!dockSku) {
      toast({ variant: "destructive", title: "SKU Required", description: "Select a SKU from the dock." });
      return;
    }

    setLoading(true);
    try {
      const data = await reopenSku(dockSku);
      setReopened(true);
      onReopened(data);
      toast({ title: "SKU Reopened", description: `${dockSku} has been reopened for editing.` });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Reopen Failed",
        description: err instanceof Error ? err.message : "Could not reopen SKU.",
      });
    } finally {
      setLoading(false);
    }
  }, [dockSku, toast, onReopened]);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-4">
        {/* Manual SKU entry */}
        <div className="flex-1 space-y-1.5">
          <Label className="text-xs font-medium">Reopen SKU</Label>
          <div className="flex gap-2">
            <Input
              value={sku}
              onChange={(e) => {
                setSku(e.target.value);
                setReopened(false);
              }}
              placeholder="Enter SKU…"
              className="h-9 text-sm font-mono flex-1"
              disabled={dockSku !== ""}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleReopen}
              disabled={loading || !sku.trim()}
              className="h-9 shrink-0"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* SKU from Loading Dock dropdown */}
        {dockSkus.length > 0 && (
          <div className={`flex-1 space-y-1.5 opacity-50 ${sku.trim() ? "" : ""}`} style={{ opacity: sku.trim() ? 0.5 : 1 }}>
            <Label className="text-xs font-medium">SKU from Loading Dock</Label>
            <div className="flex gap-2">
              <Select value={dockSku} onValueChange={(value) => {
                setDockSku(value === "__clear__" ? "" : value);
                setReopened(false);
              }} disabled={sku.trim() !== ""}>
                <SelectTrigger className="h-9 flex-1" disabled={sku.trim() !== ""}>
                  <SelectValue placeholder={sku.trim() ? "Not available" : "Select SKU…"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__clear__">
                    Select SKU…
                  </SelectItem>
                  {dockSkus.map((skuOption) => (
                    <SelectItem key={skuOption} value={skuOption}>
                      {skuOption}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={handleDockSkuReopen}
                disabled={loading || !dockSku || sku.trim() !== ""}
                className="h-9 shrink-0"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      {reopened && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/60 border border-border">
          <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            This SKU was reopened. After editing, it must be resubmitted to be completed again.
          </p>
        </div>
      )}
    </div>
  );
}

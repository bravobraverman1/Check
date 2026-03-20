import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormSection } from "@/components/FormSection";
import { Eye, Ban, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { tempMakeVisible, markNotForSale, markSkuComplete, markSkuIncomplete, type RecentSubmission } from "@/lib/api";
import { checkSkuStatusFresh } from "@/lib/supabaseGoogleSheets";
import { syncGoogleSheetQueries } from "@/lib/querySync";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const ProductOptions = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const getDockCount = () => (queryClient.getQueryData<RecentSubmission[]>(["recent-submissions"]) ?? []).length;

  // Temp Make Visible
  const [visSkU, setVisSku] = useState("");
  const [visLoading, setVisLoading] = useState(false);

  const handleMakeVisible = useCallback(async () => {
    if (!visSkU.trim()) {
      toast({ variant: "destructive", title: "SKU Required", description: "Enter a SKU." });
      return;
    }
    setVisLoading(true);
    try {
      const result = await tempMakeVisible(visSkU.trim());
      if (!result.success) {
        if (result.alreadyState) {
          toast({ title: "Already Visible", description: result.error || `SKU "${visSkU.trim()}" is already visible.` });
        } else {
          toast({ variant: "destructive", title: "SKU Not Found", description: result.error || `SKU "${visSkU.trim()}" was not found.` });
        }
        return;
      }
      toast({ title: "Success", description: `SKU ${visSkU} is now visible.` });
      setVisSku("");
      await syncGoogleSheetQueries(queryClient);
    } catch (err) {
      toast({
        title: "Sync issue",
        description: "Could not update visibility right now — please try again shortly.",
      });
    } finally {
      setVisLoading(false);
    }
  }, [visSkU, toast]);

  // Mark Not For Sale
  const [nfsSkU, setNfsSku] = useState("");
  const [nfsLoading, setNfsLoading] = useState(false);

  const handleMarkNotForSale = useCallback(async () => {
    if (!nfsSkU.trim()) {
      toast({ variant: "destructive", title: "SKU Required", description: "Enter a SKU." });
      return;
    }
    setNfsLoading(true);
    try {
      // Pre-flight: check if another user just submitted this SKU
      const { recentSubmit } = await checkSkuStatusFresh(nfsSkU.trim());
      if (recentSubmit) {
        toast({
          variant: "destructive",
          title: "Conflict Detected",
          description: `SKU "${nfsSkU.trim()}" was submitted by another user in the last 2 minutes. Please wait before marking NOT FOR SALE.`,
        });
        setNfsLoading(false);
        return;
      }

      const result = await markNotForSale(nfsSkU.trim(), getDockCount());
      if (!result.success) {
        if (result.alreadyState) {
          toast({ title: "Already NOT FOR SALE", description: result.error || `SKU "${nfsSkU.trim()}" is already NOT FOR SALE.` });
        } else {
          toast({ variant: "destructive", title: "SKU Not Found", description: result.error || `SKU "${nfsSkU.trim()}" was not found.` });
        }
        return;
      }
      toast({ title: "Success", description: `SKU ${nfsSkU} marked as NOT FOR SALE.` });
      setNfsSku("");
      await syncGoogleSheetQueries(queryClient);
    } catch (err) {
      toast({
        title: "Sync issue",
        description: "Could not update SKU right now — please try again shortly.",
      });
    } finally {
      setNfsLoading(false);
    }
  }, [nfsSkU, toast]);

  // Mark SKU Complete
  const [completeSku, setCompleteSku] = useState("");
  const [completeLoading, setCompleteLoading] = useState(false);

  const handleMarkComplete = useCallback(async () => {
    if (!completeSku.trim()) {
      toast({ variant: "destructive", title: "SKU Required", description: "Enter a SKU." });
      return;
    }
    setCompleteLoading(true);
    try {
      const result = await markSkuComplete(completeSku.trim(), getDockCount());
      if (!result.success) {
        if (result.alreadyState) {
          toast({ title: "Already Complete", description: result.error || `SKU "${completeSku.trim()}" is already complete.` });
        } else {
          toast({ variant: "destructive", title: "SKU Not Found", description: result.error || `SKU "${completeSku.trim()}" was not found.` });
        }
        return;
      }
      toast({ title: "Success", description: `SKU ${completeSku} marked as complete.` });
      setCompleteSku("");
      await syncGoogleSheetQueries(queryClient);
    } catch (err) {
      toast({
        title: "Sync issue",
        description: "Could not update SKU right now — please try again shortly.",
      });
    } finally {
      setCompleteLoading(false);
    }
  }, [completeSku, toast]);

  // Mark SKU Incomplete
  const [incompleteSku, setIncompleteSku] = useState("");
  const [incompleteLoading, setIncompleteLoading] = useState(false);

  const handleMarkIncomplete = useCallback(async () => {
    if (!incompleteSku.trim()) {
      toast({ variant: "destructive", title: "SKU Required", description: "Enter a SKU." });
      return;
    }
    setIncompleteLoading(true);
    try {
      const result = await markSkuIncomplete(incompleteSku.trim(), getDockCount());
      if (!result.success) {
        if (result.alreadyState) {
          toast({ title: "Already TO DO", description: result.error || `SKU "${incompleteSku.trim()}" is already TO DO.` });
        } else {
          toast({ variant: "destructive", title: "SKU Not Found", description: result.error || `SKU "${incompleteSku.trim()}" was not found.` });
        }
        return;
      }
      toast({ title: "Success", description: `SKU ${incompleteSku} marked as TO DO.` });
      setIncompleteSku("");
      await syncGoogleSheetQueries(queryClient);
    } catch (err) {
      toast({
        title: "Sync issue",
        description: "Could not update SKU right now — please try again shortly.",
      });
    } finally {
      setIncompleteLoading(false);
    }
  }, [incompleteSku, toast]);

  return (
    <div className="space-y-6">
      {/* Temp Make Visible */}
      <FormSection title="Temp Make Visible" defaultOpen collapsible={false}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Temporarily changes the visibility of a single SKU so it appears in the SKU dropdown menu and can be selected, filled in, and completed.
          </p>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">
                SKU <span className="text-destructive">*</span>
              </Label>
              <Input
                value={visSkU}
                onChange={(e) => setVisSku(e.target.value)}
                placeholder="Enter SKU…"
                className="h-9 text-sm font-mono w-48"
              />
            </div>
            <Button
              type="button"
              onClick={handleMakeVisible}
              disabled={visLoading}
              className="h-9"
            >
              {visLoading ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Eye className="h-4 w-4 mr-1.5" />
              )}
              Make Visible
            </Button>
          </div>
        </div>
      </FormSection>

      {/* Mark SKU COMPLETE */}
      <FormSection title="Mark SKU COMPLETE" defaultOpen collapsible={false}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Use when Eran or another employee has already completed this SKU outside the system. Changes the status to COMPLETE without requiring data entry.
          </p>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">
                SKU <span className="text-destructive">*</span>
              </Label>
              <Input
                value={completeSku}
                onChange={(e) => setCompleteSku(e.target.value)}
                placeholder="Enter SKU…"
                className="h-9 text-sm font-mono w-48"
              />
            </div>
            <Button
              type="button"
              onClick={handleMarkComplete}
              disabled={completeLoading}
              className="h-9"
            >
              {completeLoading ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-1.5" />
              )}
              Mark COMPLETE
            </Button>
          </div>
        </div>
      </FormSection>

      {/* Mark SKU TO DO */}
      <FormSection title="Mark SKU TO DO" defaultOpen collapsible={false}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Sets the SKU status to TO DO so it appears in the SKU dropdown menu and can be selected, filled in, and completed.
          </p>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">
                SKU <span className="text-destructive">*</span>
              </Label>
              <Input
                value={incompleteSku}
                onChange={(e) => setIncompleteSku(e.target.value)}
                placeholder="Enter SKU…"
                className="h-9 text-sm font-mono w-48"
              />
            </div>
            <Button
              type="button"
              onClick={handleMarkIncomplete}
              disabled={incompleteLoading}
              className="h-9"
            >
              {incompleteLoading ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4 mr-1.5" />
              )}
              Mark TO DO
            </Button>
          </div>
        </div>
      </FormSection>

      {/* Mark SKU NOT FOR SALE */}
      <FormSection title="Mark SKU NOT FOR SALE" defaultOpen collapsible={false}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Changes the SKU status to NOT FOR SALE and updates the system. Eran is notified when this occurs.
          </p>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">
                SKU <span className="text-destructive">*</span>
              </Label>
              <Input
                value={nfsSkU}
                onChange={(e) => setNfsSku(e.target.value)}
                placeholder="Enter SKU…"
                className="h-9 text-sm font-mono w-48"
              />
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={nfsLoading || !nfsSkU.trim()}
                  className="h-9"
                >
                  {nfsLoading ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Ban className="h-4 w-4 mr-1.5" />
                  )}
                  Mark NOT FOR SALE
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will mark SKU <strong className="font-mono">{nfsSkU}</strong> as
                    NOT FOR SALE.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleMarkNotForSale}>
                    Confirm
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </FormSection>
    </div>
  );
};

export default ProductOptions;

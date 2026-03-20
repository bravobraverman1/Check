import { Button } from "@/components/ui/button";
import { Wand2 } from "lucide-react";
import type { FilterProposal } from "@/lib/parseGeminiSections";
import { isMissingValue } from "@/lib/missingValueMarkers";

interface FilterConfidenceControlProps {
  onApplyEligible: () => void;
  proposals: FilterProposal[];
  /** Pre-computed count of eligible filters */
  eligibleCount?: number;
}

export function FilterConfidenceControl({
  onApplyEligible,
  proposals,
  eligibleCount,
}: FilterConfidenceControlProps) {
  if (proposals.length === 0) return null;

  const eligible = eligibleCount ?? proposals.filter((p) => !isMissingValue(p.value)).length;

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 text-[10px] gap-1"
        onClick={onApplyEligible}
      >
        <Wand2 className="h-2.5 w-2.5" />
        Apply ({eligible})
      </Button>
    </div>
  );
}

// Per-filter override options
export const FILTER_OVERRIDE_OPTIONS = [
  { label: "Use Global", value: "global" },
  { label: "Always Manual", value: "manual" },
  { label: "Allow from 60%", value: "60" },
  { label: "Allow from 70%", value: "70" },
] as const;

export type FilterOverrideValue = typeof FILTER_OVERRIDE_OPTIONS[number]["value"];

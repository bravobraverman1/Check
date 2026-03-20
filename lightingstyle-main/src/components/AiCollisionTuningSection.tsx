import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  getAiCollisionTuningConfig,
  getDefaultAiCollisionTuningConfig,
  setAiCollisionTuningConfig,
  type AiCollisionTuningConfig,
} from "@/lib/aiCollisionTuningConfig";
import { broadcastConfigChange } from "@/lib/configSync";

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-medium">{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-8 text-sm"
      />
    </div>
  );
}

export function AiCollisionTuningSection() {
  const { toast } = useToast();
  const defaults = useMemo(() => getDefaultAiCollisionTuningConfig(), []);
  const [draft, setDraft] = useState<AiCollisionTuningConfig>(() => getAiCollisionTuningConfig());

  const save = () => {
    const saved = setAiCollisionTuningConfig(draft);
    setDraft(saved);
    window.dispatchEvent(new CustomEvent("ai-collision-tuning-updated", { detail: saved }));
    broadcastConfigChange("ai-collision-tuning-saved", saved as unknown as Record<string, unknown>);
    toast({
      title: "AI collision tuning saved",
      description: "Form two-PDF conflict behavior now uses the updated tuning values.",
    });
  };

  const reset = () => {
    const saved = setAiCollisionTuningConfig(defaults);
    setDraft(saved);
    window.dispatchEvent(new CustomEvent("ai-collision-tuning-updated", { detail: saved }));
    broadcastConfigChange("ai-collision-tuning-saved", saved as unknown as Record<string, unknown>);
    toast({
      title: "AI collision tuning reset",
      description: "Defaults restored.",
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tune how aggressively two-PDF conflicts are detected, surfaced, and confidence-penalized.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <NumberField
          id="collision-max-rows"
          label="Two-PDF conflict max rows"
          min={8}
          max={200}
          value={draft.twoPdfConflictMaxRows}
          onChange={(value) => setDraft((prev) => ({ ...prev, twoPdfConflictMaxRows: value }))}
        />
        <NumberField
          id="collision-value-limit"
          label="Two-PDF conflict value limit"
          min={2}
          max={200}
          value={draft.twoPdfConflictValueLimit}
          onChange={(value) => setDraft((prev) => ({ ...prev, twoPdfConflictValueLimit: value }))}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="force-coverage-compare"
          type="checkbox"
          checked={draft.forceCoverageCompare}
          onChange={(event) => setDraft((prev) => ({ ...prev, forceCoverageCompare: event.target.checked }))}
          className="h-4 w-4"
        />
        <Label htmlFor="force-coverage-compare" className="text-sm font-medium">
          Always run follow-up compare enrichment for two-PDF mode
        </Label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <NumberField
          id="penalty-global-high"
          label="Global penalty (high conflict count)"
          min={0}
          max={60}
          value={draft.penaltyGlobalHigh}
          onChange={(value) => setDraft((prev) => ({ ...prev, penaltyGlobalHigh: value }))}
        />
        <NumberField
          id="penalty-global-medium"
          label="Global penalty (medium conflict count)"
          min={0}
          max={60}
          value={draft.penaltyGlobalMedium}
          onChange={(value) => setDraft((prev) => ({ ...prev, penaltyGlobalMedium: value }))}
        />
        <NumberField
          id="penalty-global-low"
          label="Global penalty (low conflict count)"
          min={0}
          max={60}
          value={draft.penaltyGlobalLow}
          onChange={(value) => setDraft((prev) => ({ ...prev, penaltyGlobalLow: value }))}
        />
        <NumberField
          id="penalty-field-required"
          label="Field penalty (required conflict)"
          min={0}
          max={80}
          value={draft.penaltyFieldRequired}
          onChange={(value) => setDraft((prev) => ({ ...prev, penaltyFieldRequired: value }))}
        />
        <NumberField
          id="penalty-field-optional"
          label="Field penalty (optional conflict)"
          min={0}
          max={80}
          value={draft.penaltyFieldOptional}
          onChange={(value) => setDraft((prev) => ({ ...prev, penaltyFieldOptional: value }))}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={save}>Save Collision Tuning</Button>
        <Button type="button" size="sm" variant="outline" onClick={reset}>Reset Defaults</Button>
      </div>
    </div>
  );
}

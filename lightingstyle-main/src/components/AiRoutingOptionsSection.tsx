import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { broadcastConfigChange } from "@/lib/configSync";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AI_ACTION_DEFINITIONS,
  AI_PROMPT_OPTIONS,
  type AiActionId,
  type AiRoutingConfig,
  getAiRoutingConfig,
  getDefaultAiRoutingConfig,
  setAiRoutingConfig,
} from "@/lib/aiRoutingConfig";
import {
  ChevronDown,
  RotateCcw,
  Save,
  Zap,
  Settings2,
} from "lucide-react";

function ToggleChip({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all cursor-pointer border ${
        checked
          ? "bg-primary/10 text-primary border-primary/30"
          : "bg-muted/50 text-muted-foreground border-transparent hover:bg-muted"
      }`}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      />
      {label}
    </button>
  );
}

function CheckboxItem({
  label,
  value,
  checked,
  onChange,
}: {
  label: string;
  value: string;
  checked: boolean;
  onChange: (value: string, checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2.5 py-1.5 px-2 rounded-md hover:bg-muted/50 cursor-pointer transition-colors group">
      <Checkbox
        checked={checked}
        onCheckedChange={(c) => onChange(value, !!c)}
      />
      <span className="text-xs group-hover:text-foreground transition-colors">
        {label}
      </span>
    </label>
  );
}

function ActionCard({
  action,
  actionConfig,
  onUpdate,
  onReset,
}: {
  action: (typeof AI_ACTION_DEFINITIONS)[number];
  actionConfig: AiRoutingConfig[AiActionId];
  onUpdate: (updates: Partial<AiRoutingConfig[AiActionId]>) => void;
  onReset: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const togglePrompt = (value: string, checked: boolean) => {
    const next = checked
      ? [...actionConfig.promptCandidates, value]
      : actionConfig.promptCandidates.filter((v) => v !== value);
    onUpdate({ promptCandidates: next.length ? next : actionConfig.promptCandidates });
  };

  const promptLabels = actionConfig.promptCandidates
    .map((v) => AI_PROMPT_OPTIONS.find((o) => o.value === v)?.label ?? v)
    .map((l) => l.replace(/\s*\(.*?\)\s*$/, ""));

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={`rounded-xl border transition-all ${
          actionConfig.enabled
            ? "border-border bg-card shadow-sm"
            : "border-border/50 bg-muted/30 opacity-75"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3">
          <Switch
            checked={actionConfig.enabled}
            onCheckedChange={(checked) => onUpdate({ enabled: checked })}
          />
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex-1 flex items-center gap-2 text-left min-w-0 cursor-pointer group"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                  {action.label}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {action.description}
                </p>
              </div>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200 ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </button>
          </CollapsibleTrigger>
        </div>

        {/* Summary badges (collapsed view) */}
        {!isOpen && (
          <div className="px-4 pb-3 flex flex-wrap gap-1.5">
            {promptLabels.map((label) => (
              <Badge
                key={label}
                variant="secondary"
                className="text-[10px] font-normal px-2 py-0.5"
              >
                <Zap className="h-2.5 w-2.5 mr-1" />
                {label}
              </Badge>
            ))}
          </div>
        )}

        {/* Expanded content */}
        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-4 border-t border-border/50 pt-3">
            {/* Prompt candidates */}
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 mb-2">
                  <Zap className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-semibold text-foreground">Prompt Candidates</span>
                </div>
                <div className="space-y-0.5">
                  {AI_PROMPT_OPTIONS.map((option) => (
                    <CheckboxItem
                      key={option.value}
                      label={option.label}
                      value={option.value}
                      checked={actionConfig.promptCandidates.includes(option.value)}
                      onChange={togglePrompt}
                    />
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground px-2">
                  Instruction PDFs are resolved from the active prompt folder:{" "}
                  <code>document-uploads-constant/prompt-[promptType]</code>.
                </p>
              </div>
            </div>

            {/* Toggles as chips */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold text-foreground">Options</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <ToggleChip
                  label="Require PDF"
                  checked={actionConfig.requireInstructionPdf}
                  onChange={(v) => onUpdate({ requireInstructionPdf: v })}
                />
                <ToggleChip
                  label="Additional Instructions"
                  checked={actionConfig.includeAdditionalInstructions}
                  onChange={(v) => onUpdate({ includeAdditionalInstructions: v })}
                />
                <ToggleChip
                  label="Strict Guard"
                  checked={actionConfig.strictResponseGuard}
                  onChange={(v) => onUpdate({ strictResponseGuard: v })}
                />
                <ToggleChip
                  label="Single Pass"
                  checked={actionConfig.singlePass}
                  onChange={(v) => onUpdate({ singlePass: v })}
                />
                <ToggleChip
                  label="Direct Files"
                  checked={actionConfig.directFiles}
                  onChange={(v) => onUpdate({ directFiles: v })}
                />
              </div>
            </div>

            {/* Reset */}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onReset}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset to Default
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function AiRoutingOptionsSection() {
  const { toast } = useToast();
  const [config, setConfig] = useState<AiRoutingConfig>(() => getAiRoutingConfig());

  const groupedActions = useMemo(() => {
    const groups: Record<string, typeof AI_ACTION_DEFINITIONS> = {};
    for (const action of AI_ACTION_DEFINITIONS) {
      if (!groups[action.group]) groups[action.group] = [];
      groups[action.group].push(action);
    }
    return groups;
  }, []);

  const updateAction = (actionId: AiActionId, updates: Partial<AiRoutingConfig[AiActionId]>) => {
    setConfig((prev) => ({
      ...prev,
      [actionId]: { ...prev[actionId], ...updates },
    }));
  };

  const resetAction = (actionId: AiActionId) => {
    const defaults = getDefaultAiRoutingConfig();
    setConfig((prev) => ({ ...prev, [actionId]: defaults[actionId] }));
  };

  const resetAll = () => setConfig(getDefaultAiRoutingConfig());

  const save = () => {
    setAiRoutingConfig(config);
    broadcastConfigChange("ai-routing-config-changed", {
      updatedAt: new Date().toISOString(),
    });
    toast({
      title: "AI routing saved",
      description: "Prompt/PDF mappings and toggles are now active.",
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs text-foreground space-y-1">
        <p className="font-semibold flex items-center gap-1.5">
          <Settings2 className="h-3.5 w-3.5 text-primary" />
          Global settings — shared across all users
        </p>
        <p className="text-muted-foreground">
          Changes saved here are synced to the database and apply to every browser and user.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Map prompts and instruction PDFs to each AI action. Click any card to expand and configure.
      </p>

      {Object.entries(groupedActions).map(([groupName, actions]) => (
        <div key={groupName} className="space-y-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {groupName}
          </h4>
          <div className="space-y-2">
            {actions.map((action) => (
              <ActionCard
                key={action.id}
                action={action}
                actionConfig={config[action.id]}
                onUpdate={(updates) => updateAction(action.id, updates)}
                onReset={() => resetAction(action.id)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 pt-2 sticky bottom-0 bg-background/80 backdrop-blur-sm py-3 -mx-1 px-1">
        <Button type="button" onClick={save} size="sm">
          <Save className="h-3.5 w-3.5 mr-1.5" />
          Save AI Routing
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={resetAll}>
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          Reset All
        </Button>
      </div>
    </div>
  );
}

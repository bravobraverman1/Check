import { useMemo, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/SearchableSelect";
import { Sparkles, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PropertyDefinition, LegalValue } from "@/data/defaultProperties";
import type { FilterProposal } from "@/lib/parseGeminiSections";
import {
  formatNumericForInput,
  parseNumericValueForExpectedUnit,
  stripTrailingUnitSuffix,
} from "@/lib/unitNormalization";
import { isMissingValue } from "@/lib/missingValueMarkers";

// ============================================================
// CUSTOMIZABLE UNITS SYSTEM
// ============================================================

const extractNameAndUnit = (propertyName: string): { displayName: string; unit: string | undefined } => {
  let name = propertyName;
  name = name.replace(/\*/g, "").replace(/\s{2,}/g, " ").trim();
  const hashMatch = name.match(/^(.+?)\s*#\d+\s*$/);
  if (hashMatch) {
    name = hashMatch[1].trim();
  }
  const unitMatch = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (unitMatch) {
    return { displayName: unitMatch[1].trim(), unit: unitMatch[2].trim() };
  }
  return { displayName: name, unit: undefined };
};

const GREEN_LABELS = new Set<string>();
const MINIMUM_AI_VISIBLE_CONFIDENCE = 60;
const AI_WARNING_THRESHOLD_CONFIDENCE = 75;

/**
 * A text-type field is treated as numeric-only when it has a unitSuffix.
 * This is data-driven: the unitSuffix comes from the Filters sheet (Column C)
 * or from the property name's parenthesized suffix — no hardcoded field names.
 */
const isNumericProperty = (_propertyName: string, unitSuffix?: string): boolean => {
  return !!unitSuffix;
};

const sanitizeNumericInput = (input: string): string => {
  return input.replace(/[^\d.]/g, "");
};

// stripTrailingUnits is now imported from unitNormalization.ts (single source of truth for known unit tokens)

/**
 * Parse a numeric value from an AI proposal, stripping unit suffixes.
 * Strips the known unit first, then falls back to common units.
 */
function parseNumericFromProposal(value: string, knownUnit?: string): string {
  const numeric = parseNumericValueForExpectedUnit(value, knownUnit);
  return numeric === null ? "" : formatNumericForInput(numeric);
}

/** Source of a filter value: manual user edit, AI auto-fill, AI override (replaced a pre-existing value), or empty */
export type FilterValueSource = "manual" | "ai" | "override" | "sheet" | "empty";

function FanCutoutInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hasPairMode = value.includes("X") || value.includes("x");
  const pairMatch = value.match(/^(\d*)X(\d*)$/i);
  const pairValue1 = pairMatch ? pairMatch[1] : "";
  const pairValue2 = pairMatch ? pairMatch[2] : "";
  const diameterValue = !hasPairMode ? value : "";
  const hasPairValue = !!(pairValue1 || pairValue2);
  const hasDiameterValue = diameterValue && diameterValue.length > 0;

  const handlePairChange = (num1: string, num2: string) => {
    const sanitized1 = sanitizeNumericInput(num1);
    const sanitized2 = sanitizeNumericInput(num2);
    onChange(`${sanitized1}X${sanitized2}`);
  };

  const handleDiameterChange = (num: string) => {
    const sanitized = sanitizeNumericInput(num);
    onChange(sanitized);
  };

  return (
    <div className="space-y-1.5">
      <div className={`flex gap-0.5 items-center ${hasDiameterValue ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="relative flex-1">
          <Input type="text" inputMode="decimal" placeholder="W" value={pairValue1}
            onChange={(e) => handlePairChange(e.target.value, pairValue2)}
            onKeyPress={(e) => { if (!/[\d.]/.test(e.key)) e.preventDefault(); }}
            onPaste={(e) => { e.preventDefault(); handlePairChange(sanitizeNumericInput(e.clipboardData.getData("text")), pairValue2); }}
            className="h-6 text-xs w-full pr-5" disabled={!!hasDiameterValue} />
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">cm</span>
        </div>
        <span className="text-xs font-semibold">×</span>
        <div className="relative flex-1">
          <Input type="text" inputMode="decimal" placeholder="H" value={pairValue2}
            onChange={(e) => handlePairChange(pairValue1, e.target.value)}
            onKeyPress={(e) => { if (!/[\d.]/.test(e.key)) e.preventDefault(); }}
            onPaste={(e) => { e.preventDefault(); handlePairChange(pairValue1, sanitizeNumericInput(e.clipboardData.getData("text"))); }}
            className="h-6 text-xs w-full pr-5" disabled={!!hasDiameterValue} />
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">cm</span>
        </div>
      </div>
      <div className={`relative ${hasPairValue ? "opacity-50 pointer-events-none" : ""}`}>
        <Input type="text" inputMode="decimal" placeholder="Diameter" value={diameterValue}
          onChange={(e) => handleDiameterChange(e.target.value)}
          onKeyPress={(e) => { if (!/[\d.]/.test(e.key)) e.preventDefault(); }}
          onPaste={(e) => { e.preventDefault(); handleDiameterChange(sanitizeNumericInput(e.clipboardData.getData("text"))); }}
          className="h-6 text-xs pr-7" disabled={!!hasPairValue} />
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">cm</span>
      </div>
    </div>
  );
}

interface DynamicSpecificationsProps {
  properties: PropertyDefinition[];
  legalValues: LegalValue[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onOtherValue?: (propertyName: string, value: string) => void;
  selectedMainCategory?: string;
  masterLookup?: Array<{ defaultName: string; categoryPath: string; nameStructure?: string; nameExample?: string }>;
  masterDefaults?: Array<{ name: string; allowedProperties: string[] }>;
  onMandatoryKeysChange?: (keys: string[]) => void;
  mandatoryErrors?: Set<string>;
  onHasFilters?: (has: boolean) => void;
  /** AI filter proposals from Gemini */
  filterProposals?: FilterProposal[];
  /** Track which filters were set by AI vs manual */
  filterSources?: Record<string, FilterValueSource>;
  onFilterSourceChange?: (key: string, source: FilterValueSource) => void;
  /** Track which filters were AI-filled then manually edited */
  manuallyEditedFilters?: Set<string>;
  /** Clear all filter values */
  onClearAll?: () => void;
  optionsRefreshing?: boolean;
  onOptionsOpen?: () => void;
}

export function DynamicSpecifications({
  properties,
  legalValues,
  values,
  onChange,
  onOtherValue,
  selectedMainCategory,
  masterLookup = [],
  masterDefaults = [],
  onMandatoryKeysChange,
  mandatoryErrors,
  onHasFilters,
  filterProposals = [],
  filterSources = {},
  onFilterSourceChange,
  manuallyEditedFilters = new Set(),
  onClearAll,
  optionsRefreshing = false,
  onOptionsOpen,
}: DynamicSpecificationsProps) {
  // Per-filter overrides removed — all proposals are eligible

  const sections = useMemo(() => {
    let filteredProperties = properties;
    if (!selectedMainCategory) {
      filteredProperties = [];
    } else if (selectedMainCategory) {
      const activeLookup = masterLookup.filter((entry) => entry.defaultName && entry.defaultName.trim());
      if (activeLookup.length > 0 && masterDefaults.length > 0) {
        const normalizedSelected = selectedMainCategory.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "");
        const matches = activeLookup.filter((entry) => {
          const entryPath = entry.categoryPath;
          return normalizedSelected === entryPath || normalizedSelected.startsWith(entryPath + "/");
        });
        if (matches.length === 0) {
          filteredProperties = [];
        } else {
          const bestMatch = matches.reduce((best, current) =>
            current.categoryPath.length > best.categoryPath.length ? current : best
          );
          const defaultEntry = masterDefaults.find((d) =>
            d.name === bestMatch.defaultName ||
            d.name.trim().toLowerCase() === bestMatch.defaultName.trim().toLowerCase()
          );
          if (defaultEntry && defaultEntry.allowedProperties.length > 0) {
            filteredProperties = properties.filter((p) => {
              const propNoUnit = p.name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
              const propBase = propNoUnit.replace(/\s*#\d+\s*$/, "").trim();
              return defaultEntry.allowedProperties.some((allowed) => {
                const allowedNoUnit = allowed.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
                const allowedHasHash = /#\d+\s*$/.test(allowed.trim());
                if (allowedHasHash) {
                  // Exact #N match: "Colour #1" only matches property "Colour #1"
                  return allowedNoUnit === propNoUnit;
                }
                // No #N in allowed → match all variants with that base name
                const allowedBase = allowedNoUnit.replace(/\s*#\d+\s*$/, "").trim();
                return allowedBase === propBase || allowedBase === propNoUnit;
              });
            });
          } else {
            filteredProperties = [];
          }
        }
      } else {
        filteredProperties = [];
      }
    }

    // Debug: log which master filter was matched and which properties were resolved
    if (selectedMainCategory && filteredProperties !== properties) {
      console.log("[Filters] Category:", selectedMainCategory, "→ Matched", filteredProperties.length, "properties:", filteredProperties.map(p => p.name));
    }

    const map = new Map<string, PropertyDefinition[]>();
    for (const prop of filteredProperties) {
      const group = map.get(prop.section) || [];
      group.push(prop);
      map.set(prop.section, group);
    }
    return Array.from(map.entries());
  }, [properties, selectedMainCategory, masterLookup, masterDefaults]);

  const pairedGroups = useMemo(() => {
    const baseMap = new Map<string, string[]>();
    for (const prop of properties) {
      const hashIdx = prop.name.lastIndexOf("#");
      if (hashIdx > 0) {
        const base = prop.name.substring(0, hashIdx).trim();
        const group = baseMap.get(base) || [];
        group.push(prop.name);
        baseMap.set(base, group);
      }
    }
    const lookup = new Map<string, string[]>();
    for (const siblings of baseMap.values()) {
      if (siblings.length < 2) continue;
      for (const name of siblings) {
        lookup.set(name, siblings.filter((s) => s !== name));
      }
    }
    return lookup;
  }, [properties]);

  const optionsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const lv of legalValues) {
      const list = map.get(lv.propertyName) || [];
      list.push(lv.allowedValue);
      map.set(lv.propertyName, list);
    }
    for (const [, siblings] of pairedGroups) {
      if (siblings.length === 0) continue;
      const groupNames = new Set<string>();
      for (const s of siblings) { groupNames.add(s); }
      for (const entry of pairedGroups.entries()) {
        if (siblings.includes(entry[0])) {
          groupNames.add(entry[0]);
          entry[1].forEach((s) => groupNames.add(s));
        }
      }
      const merged = Array.from(new Set(
        Array.from(groupNames).flatMap((n) => map.get(n) || [])
      ));
      if (merged.length > 0) {
        for (const n of groupNames) {
          map.set(n, merged);
        }
      }
    }
    return map;
  }, [legalValues, pairedGroups]);

  const visibleFilterProposals = useMemo(
    () => filterProposals.filter((proposal) => Number(proposal.confidence) >= MINIMUM_AI_VISIBLE_CONFIDENCE),
    [filterProposals],
  );

  // Build proposal map: case-insensitive trimmed display name → FilterProposal
  const proposalMap = useMemo(() => {
    const m = new Map<string, FilterProposal>();
    for (const p of visibleFilterProposals) {
      const exact = p.filterName.trim().toLowerCase();
      if (!m.has(exact)) m.set(exact, p);
    }
    return m;
  }, [visibleFilterProposals]);

  /** Lookup a proposal: try full name with #N first, fall back to base name only if no #N variants exist */
  const lookupProposal = useCallback((propName: string, displayName: string): FilterProposal | undefined => {
    // 1. Try full name with #N (e.g. "colour #1")
    const fullKey = propName.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
    const exact = proposalMap.get(fullKey);
    if (exact) return exact;
    // 2. Fall back to base name only if no #N variants exist in the map
    const baseKey = displayName.toLowerCase();
    if (baseKey === fullKey) return proposalMap.get(baseKey); // no #N in prop name
    // Check if ANY #N variant exists — if so, don't fall back (AI didn't provide for this #N)
    for (const key of proposalMap.keys()) {
      if (key.replace(/\s*#\d+\s*$/, "") === baseKey && key !== baseKey) return undefined;
    }
    return proposalMap.get(baseKey);
  }, [proposalMap]);

  const handleOtherSubmit = useCallback((propertyName: string, key: string, value: string, unitSuffix?: string) => {
    const sanitizedValue = isNumericProperty(propertyName, unitSuffix) ? sanitizeNumericInput(value) : value;
    onChange(key, sanitizedValue);
    onFilterSourceChange?.(key, "manual");
    onOtherValue?.(propertyName, sanitizedValue);
    const siblings = pairedGroups.get(propertyName);
    if (siblings) {
      for (const sibling of siblings) {
        onOtherValue?.(sibling, sanitizedValue);
      }
    }
  }, [onChange, onOtherValue, pairedGroups, onFilterSourceChange]);

  const mandatoryKeySet = useMemo(() => {
    const keys: string[] = [];
    for (const [, props] of sections) {
      for (const prop of props) {
        if (prop.required) keys.push(prop.key);
      }
    }
    return keys;
  }, [sections]);

  useEffect(() => {
    onMandatoryKeysChange?.(mandatoryKeySet);
  }, [mandatoryKeySet, onMandatoryKeysChange]);

  useEffect(() => {
    onHasFilters?.(sections.length > 0);
  }, [sections.length, onHasFilters]);

  // Count how many proposals are eligible for auto-fill (all non-missing with valid values)
  const eligibleCount = useMemo(() => {
    let count = 0;
    for (const [, props] of sections) {
      for (const prop of props) {
        const source = filterSources[prop.key] || "empty";
        if (source !== "empty") continue;

        const { displayName, unit: extractedUnit } = extractNameAndUnit(prop.name);
        const proposal = lookupProposal(prop.name, displayName);
        if (!proposal || isMissingValue(proposal.value)) continue;

        if (prop.inputType === "dropdown") {
          const allowed = optionsMap.get(prop.name) || [];
          if (!allowed.some((v) => v.toLowerCase() === proposal.value.toLowerCase())) continue;
        }

        const displayUnit = extractedUnit || prop.unitSuffix;
        if (prop.inputType === "number" || isNumericProperty(displayName, displayUnit)) {
          const numeric = parseNumericFromProposal(proposal.value, displayUnit);
          if (!numeric) continue;
        }

        count++;
      }
    }
    return count;
  }, [sections, lookupProposal, optionsMap, filterSources]);

  // Apply eligible proposals handler — respects locks and source tracking
  const handleApplyEligible = useCallback(() => {
    const currentValues = { ...values };
    for (const [, props] of sections) {
      for (const prop of props) {
        const source = filterSources[prop.key] || "empty";
        if (source !== "empty") continue;

        const { displayName, unit: extractedUnit } = extractNameAndUnit(prop.name);
        const proposal = lookupProposal(prop.name, displayName);
        if (!proposal || isMissingValue(proposal.value)) continue;

        // Validate ENUM — skip invalid values (not in legal list)
        if (prop.inputType === "dropdown") {
          const allowed = optionsMap.get(prop.name) || [];
          const isValid = allowed.some((v) => v.toLowerCase() === proposal.value.toLowerCase());
          if (!isValid) continue;
        }

        // Determine if this is an override (replacing a pre-existing value)
        const hadPreviousValue = !!currentValues[prop.key]?.trim();

        // Validate NUMBER — parse with known unit
        const displayUnit = extractedUnit || prop.unitSuffix;
        if (prop.inputType === "number" || isNumericProperty(displayName, displayUnit)) {
          const numeric = parseNumericFromProposal(proposal.value, displayUnit);
          if (!numeric) continue;
          onChange(prop.key, numeric);
          onFilterSourceChange?.(prop.key, hadPreviousValue ? "override" : "ai");
          continue;
        }

        onChange(prop.key, stripTrailingUnitSuffix(proposal.value));
        onFilterSourceChange?.(prop.key, hadPreviousValue ? "override" : "ai");
      }
    }
  }, [sections, values, lookupProposal, optionsMap, onChange, filterSources, onFilterSourceChange]);

  // Auto-apply eligible proposals when they arrive
  useEffect(() => {
    if (visibleFilterProposals.length > 0 && eligibleCount > 0) {
      handleApplyEligible();
    }
  }, [eligibleCount, handleApplyEligible, visibleFilterProposals]);

  if (sections.length === 0 && selectedMainCategory) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No filters available for the selected category.</p>;
  }

  return (
    <div className="space-y-4">

      {sections.map(([sectionName, props]) => (
        <div key={sectionName} className="space-y-3">
          {sectionName.toLowerCase() !== "filters" && (
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {sectionName}
            </p>
          )}
          {sectionName.toLowerCase() === "filters" && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Each filter label shows whether the field is mandatory or optional.
              </p>
              <p className="text-xs text-destructive leading-relaxed">
                Please avoid "Other." Exhaust all existing options first and use it only when no listed value applies.
              </p>
              <p className="text-xs text-destructive leading-relaxed">
                ⚠️ Ensure all entered values match the displayed units (shown in grey next to each input field).
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-5">
            {props.map((prop) => {
              const { displayName, unit: extractedUnit } = extractNameAndUnit(prop.name);
              const mandatory = prop.required ?? false;
              const displayUnit = extractedUnit || prop.unitSuffix;
              const isFanCutout = displayName === "Fan Cutout" || prop.name === "Fan Cutout";
              const hasMandatoryError = mandatory && mandatoryErrors?.has(prop.key);
              const fieldHighlightClass = hasMandatoryError
                ? "rounded-md border border-destructive/60 bg-destructive/5 p-2"
                : "";
              const controlHighlightClass = hasMandatoryError
                ? "border-destructive/70 ring-1 ring-destructive/40"
                : "";
              const isManuallyEdited = manuallyEditedFilters.has(prop.key);
               const source = filterSources[prop.key] || "empty";
               const isOverridden = source === "override";

               // AI suggestion for this filter (case-insensitive match)
               const proposal = lookupProposal(prop.name, displayName);
               const isAutoFillEligible = !!proposal && !isMissingValue(proposal.value);
               const isAutoFilled = (source === "ai" || source === "override") && isAutoFillEligible;
               const proposalConfidence = proposal ? Number(proposal.confidence) : NaN;
               const isLowConfidence = Number.isFinite(proposalConfidence)
                 ? proposalConfidence < AI_WARNING_THRESHOLD_CONFIDENCE
                 : false;

               // Validate enum proposals
               let enumInvalid = false;
               if (proposal && !isMissingValue(proposal.value) && prop.inputType === "dropdown") {
                 const allowed = optionsMap.get(prop.name) || [];
                 enumInvalid = !allowed.some((v) => v.toLowerCase() === proposal.value.toLowerCase());
               }

              // For manual change handler — marks source as manual, BUT if value matches AI proposal, mark as AI
              const handleManualChange = (key: string, value: string) => {
                onChange(key, value);
                // Check if the manually selected value matches the AI proposal
                const proposalValue = proposal?.value;
                if (value && proposalValue && !isMissingValue(proposalValue) && value.toLowerCase() === proposalValue.toLowerCase()) {
                  onFilterSourceChange?.(key, "ai");
                } else {
                  onFilterSourceChange?.(key, value ? "manual" : "empty");
                }
              };

              // Compute display value for suggestion hint (strip unit for numeric)
              const suggestionDisplayValue = proposal && !isMissingValue(proposal.value)
                ? (isNumericProperty(displayName, displayUnit)
                    ? parseNumericFromProposal(proposal.value, displayUnit) || proposal.value
                    : proposal.value)
                : undefined;

              return (
                <div key={prop.key} className={cn("space-y-1.5", fieldHighlightClass)}>
                  <Label className={`text-sm font-semibold leading-none flex items-center gap-1.5 flex-wrap ${GREEN_LABELS.has(displayName) ? "text-green-700" : "text-foreground"}`}>
                    <span className="tracking-[0.01em]">{displayName}</span>
                    <span className={`text-[12px] font-medium ${mandatory ? "text-destructive/90" : "text-muted-foreground"}`}>
                      ({mandatory ? "mandatory" : "optional"})
                    </span>
                    {hasMandatoryError && (
                      <span className="text-destructive text-[10px] font-medium uppercase tracking-wide">Required</span>
                    )}
                    {/* AI / Overridden / Edited badges */}
                    {(isAutoFilled || isOverridden) && proposal && !isManuallyEdited && (
                      <Badge
                        variant="outline"
                        className={`ml-1 text-[11px] px-1.5 py-0 h-5 font-mono ${isLowConfidence ? "bg-red-50 text-red-700 border-red-300" : "bg-green-50 text-green-700 border-green-300"}`}
                      >
                        AI {proposal.confidence}%
                      </Badge>
                    )}
                    {isAutoFilled && proposal && !isManuallyEdited && isLowConfidence && (
                      <Badge
                        variant="outline"
                        className="text-[11px] px-1.5 py-0 h-5 font-mono bg-red-50 text-red-700 border-red-300"
                      >
                        Unsure
                      </Badge>
                    )}
                    {isOverridden && proposal && !isManuallyEdited && !isLowConfidence && (
                      <Badge
                        variant="outline"
                        className="text-[11px] px-1.5 py-0 h-5 font-mono bg-orange-50 text-orange-700 border-orange-300"
                      >
                        Overridden
                      </Badge>
                    )}
                    {isManuallyEdited && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-mono bg-amber-50 text-amber-700 border-amber-300">
                        Edited
                      </Badge>
                    )}
                    {/* Inline suggestion — show when current value differs from AI proposal */}
                    {suggestionDisplayValue && !isAutoFilled && !enumInvalid && (() => {
                      const currentVal = values[prop.key] || "";
                      const proposalVal = prop.inputType === "dropdown"
                        ? proposal!.value
                        : suggestionDisplayValue;
                      return currentVal.toLowerCase() !== proposalVal.toLowerCase();
                    })() && (
                      <button
                        type="button"
                        onClick={() => {
                          if (prop.inputType === "number" || isNumericProperty(displayName, displayUnit)) {
                            const numeric = parseNumericFromProposal(proposal!.value, displayUnit);
                            onChange(prop.key, numeric);
                          } else {
                            onChange(prop.key, proposal!.value);
                          }
                          onFilterSourceChange?.(prop.key, "ai");
                        }}
                        className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                      >
                        <Sparkles className="h-2.5 w-2.5 text-primary/60" />
                        Apply {suggestionDisplayValue}
                      </button>
                    )}
                  </Label>

                  {prop.inputType === "dropdown" && (
                    <SearchableSelect
                      value={values[prop.key] || ""}
                      onValueChange={(v) => handleManualChange(prop.key, v)}
                      options={optionsMap.get(prop.name) || []}
                      placeholder="Select..."
                      className={controlHighlightClass}
                      allowOther
                      propertyName={prop.name}
                      isRefreshing={optionsRefreshing}
                      onOpenRefresh={onOptionsOpen}
                      numericOther={isNumericProperty(displayName, displayUnit)}
                      onOtherSubmit={(v) => handleOtherSubmit(prop.name, prop.key, v, displayUnit)}
                    />
                  )}
                  {prop.inputType === "text" && !isFanCutout && (
                    <div className="relative">
                      <Input
                        value={values[prop.key] || ""}
                        onChange={(e) => {
                          if (isNumericProperty(displayName, displayUnit)) {
                            handleManualChange(prop.key, sanitizeNumericInput(e.target.value));
                          } else {
                            handleManualChange(prop.key, e.target.value);
                          }
                        }}
                        onKeyPress={(e) => {
                          if (isNumericProperty(displayName, displayUnit) && !/[\d.]/.test(e.key)) e.preventDefault();
                        }}
                        onPaste={(e) => {
                          if (isNumericProperty(displayName, displayUnit)) {
                            e.preventDefault();
                            handleManualChange(prop.key, sanitizeNumericInput(e.clipboardData.getData("text")));
                          }
                        }}
                        placeholder={`Enter ${displayName.toLowerCase()}`}
                        className={cn(displayUnit ? "h-9 text-sm pr-10" : "h-9 text-sm", controlHighlightClass)}
                      />
                      {displayUnit && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{displayUnit}</span>
                      )}
                    </div>
                  )}
                  {isFanCutout && (
                    <FanCutoutInput value={values[prop.key] || ""} onChange={(v) => handleManualChange(prop.key, v)} />
                  )}
                  {prop.inputType === "number" && (
                    <div className="relative">
                      <Input
                        type="text" inputMode="decimal"
                        value={values[prop.key] || ""}
                        onChange={(e) => handleManualChange(prop.key, sanitizeNumericInput(e.target.value))}
                        onKeyPress={(e) => { if (!/[\d.]/.test(e.key)) e.preventDefault(); }}
                        onPaste={(e) => { e.preventDefault(); handleManualChange(prop.key, sanitizeNumericInput(e.clipboardData.getData("text"))); }}
                        placeholder="0"
                        className={cn(displayUnit ? "h-9 text-sm pr-10" : "h-9 text-sm", controlHighlightClass)}
                      />
                      {displayUnit && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{displayUnit}</span>
                      )}
                    </div>
                  )}
                  {prop.inputType === "boolean" && (
                    <div className="flex items-center gap-2 h-9">
                      <Switch
                        checked={values[prop.key] === "Yes"}
                        onCheckedChange={(checked) => handleManualChange(prop.key, checked ? "Yes" : "No")}
                      />
                      <span className="text-xs text-muted-foreground">
                        {values[prop.key] === "Yes" ? "Yes" : "No"}
                      </span>
                    </div>
                  )}

                  {/* Enum invalid warning — below field (only if not already overridden/applied) */}
                  {proposal && !isMissingValue(proposal.value) && enumInvalid && !isOverridden && source !== "manual" && !values[prop.key] && (
                    <span className="text-[10px] text-destructive">
                      ⚠ AI suggested "{proposal.value}" — not in allowed values
                    </span>
                  )}

                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Clear Filters button */}
      {sections.length > 0 && onClearAll && (
        <div className="pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClearAll}
            className="text-xs"
          >
            <XCircle className="h-3 w-3 mr-1" />
            Clear All Filters
          </Button>
        </div>
      )}
    </div>
  );
}

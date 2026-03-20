import { useState, useMemo, useRef, useEffect } from "react";
import { ChevronDown, Search, Check, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  allowNone?: boolean;
  allowOther?: boolean;
  onOtherSubmit?: (value: string) => void;
  propertyName?: string;
  isRefreshing?: boolean;
  onOpenRefresh?: () => void;
  /** When true, the "Other" input restricts to numeric-only values.
   *  Data-driven: the caller derives this from the property's unitSuffix / inputType. */
  numericOther?: boolean;
}

const OTHER_SENTINEL = "__OTHER__";

// Helper to sanitize numeric input
const sanitizeNumericInput = (input: string): string => {
  return input.replace(/[^\d.]/g, "");
};

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  className,
  allowNone = true,
  allowOther = false,
  onOtherSubmit,
  propertyName,
  isRefreshing = false,
  onOpenRefresh,
  numericOther = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherText, setOtherText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  const isOtherValue = value && !options.includes(value) && value !== "";

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const base = allowNone ? ["", ...options] : options;
    const result = q ? base.filter((o) => o.toLowerCase().includes(q)) : base;
    return result;
  }, [options, search, allowNone]);

  useEffect(() => {
    if (open) {
      setShowOtherInput(false);
      setOtherText("");
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setSearch("");
      setShowOtherInput(false);
      setOtherText("");
    }
  }, [open]);

  useEffect(() => {
    if (showOtherInput) {
      setTimeout(() => otherInputRef.current?.focus(), 50);
    }
  }, [showOtherInput]);

  const handleOtherConfirm = () => {
    if (otherText.trim()) {
      let finalValue = otherText.trim();

      // If this is a numeric property, validate numeric input
      if (numericOther) {
        const sanitized = sanitizeNumericInput(finalValue);
        const numValue = parseFloat(sanitized);
        if (isNaN(numValue) || sanitized === "") {
          alert(`Invalid value. ${propertyName || "This field"} requires a numeric value only.`);
          return;
        }
        finalValue = sanitized;
      } else {
        finalValue = finalValue.toUpperCase();
      }

      // Check if this value already exists in options (case-insensitive)
      const existingMatch = options.find((o) => o.toLowerCase() === finalValue.toLowerCase());
      if (existingMatch) {
        // Use the existing option instead of creating a duplicate
        onValueChange(existingMatch);
        setShowOtherInput(false);
        setOtherText("");
        setOpen(false);
        return;
      }

      onOtherSubmit?.(finalValue);
      onValueChange(finalValue);
      setShowOtherInput(false);
      setOtherText("");
      setOpen(false);
    }
  };

  const displayValue = value || placeholder;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) onOpenRefresh?.();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          className={cn("w-full justify-start h-9 text-sm font-normal gap-2", className)}
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {isOtherValue ? `${value} (custom)` : displayValue}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 z-50 bg-popover"
        align="start"
        sideOffset={4}
      >
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        <div className="max-h-[200px] overflow-y-auto">
          {filtered.length === 0 && !allowOther ? (
            <p className="text-sm text-muted-foreground text-center py-3">No results</p>
          ) : (
            <div className="p-1">
              {isRefreshing && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Refreshing options...</span>
                </div>
              )}
              {!showOtherInput && filtered.map((opt) => (
                <button
                  key={opt || "__none__"}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left hover:bg-muted/60 transition-colors",
                    value === opt && "bg-muted"
                  )}
                  onClick={() => {
                    onValueChange(opt);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-3.5 w-3.5 shrink-0", value === opt ? "opacity-100" : "opacity-0")} />
                  <span>{opt || "None"}</span>
                </button>
              ))}

              {/* Other option */}
              {allowOther && !showOtherInput && (
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left hover:bg-muted/60 transition-colors text-primary"
                  onClick={() => setShowOtherInput(true)}
                >
                  <span className="h-3.5 w-3.5 shrink-0 text-center text-xs font-bold">+</span>
                  <span>Other…</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Other input area */}
        {allowOther && showOtherInput && (
          <div className="p-2 border-t border-border">
            <div className="flex items-center gap-1.5">
              <Input
                ref={otherInputRef}
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="Enter custom value…"
                className="h-7 text-xs flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleOtherConfirm(); }
                  if (e.key === "Escape") setShowOtherInput(false);
                }}
              />
              <Button type="button" size="sm" className="h-7 text-xs px-2" onClick={handleOtherConfirm}>
                Add
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

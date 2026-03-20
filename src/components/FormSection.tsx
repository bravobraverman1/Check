import { useState, useEffect } from "react";
import { ChevronRight } from "lucide-react";
interface FormSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  required?: boolean;
  forceOpen?: boolean;
  openSignal?: number;
  closeSignal?: number;
  /** When false the section is always open and the toggle button is hidden. Defaults to true. */
  collapsible?: boolean;
  /** When true, children stay mounted (hidden) when collapsed so internal state is preserved. */
  keepMounted?: boolean;
}
export function FormSection({
  title,
  children,
  defaultOpen = true,
  required = false,
  forceOpen,
  openSignal,
  closeSignal,
  collapsible = true,
  keepMounted = false,
}: FormSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen !== undefined) {
      setIsOpen(forceOpen);
    }
  }, [forceOpen]);

  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) {
      setIsOpen(true);
    }
  }, [openSignal]);

  useEffect(() => {
    if (closeSignal !== undefined && closeSignal > 0) {
      setIsOpen(false);
    }
  }, [closeSignal]);

  const effectiveOpen = collapsible ? isOpen : true;

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full px-5 py-3.5 hover:bg-accent/40 transition-colors text-center items-start justify-between flex flex-col"
        >
          <div className="gap-2 items-center justify-start flex flex-row">
            <span className="flex items-center justify-center w-4 h-4 shrink-0">
              <ChevronRight
                className={`h-4 w-4 text-muted-foreground will-change-transform transition-transform duration-200 ease-out ${isOpen ? "rotate-90" : "rotate-0"}`}
              />
            </span>
            <span className="font-semibold text-sm text-foreground">{title}</span>
            {required && <span className="text-destructive text-xs">*</span>}
          </div>
        </button>
      ) : (
        <div className="w-full px-5 py-3.5 flex flex-col items-start">
          <div className="gap-2 items-center justify-start flex flex-row">
            <span className="font-semibold text-sm text-foreground">{title}</span>
            {required && <span className="text-destructive text-xs">*</span>}
          </div>
        </div>
      )}
      {keepMounted ? (
        <div className={`px-5 pb-5 pt-2 border-t border-border ${effectiveOpen ? "" : "hidden"}`}>{children}</div>
      ) : (
        effectiveOpen && (
          <div className="px-5 pb-5 pt-2 border-t border-border">{children}</div>
        )
      )}
    </div>
  );
}

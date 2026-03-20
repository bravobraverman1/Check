import { cn } from "@/lib/utils";

interface AiProgressBlockProps {
  title: string;
  progress: number;
  tags?: string[];
  className?: string;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function AiProgressBlock({
  title,
  progress,
  tags = [],
  className,
}: AiProgressBlockProps) {
  const normalizedProgress = clampProgress(progress);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-foreground">
          {title}{" "}
          <span className="text-primary tabular-nums">{normalizedProgress}%</span>
        </p>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
        <div
          className="bg-primary h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${normalizedProgress}%` }}
        />
      </div>
    </div>
  );
}


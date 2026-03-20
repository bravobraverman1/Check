/**
 * Token usage tracker backed by the Supabase `token_usage` table.
 * Records each AI call's actual token counts from Google's usageMetadata
 * and allows querying totals — visible to all users.
 */

import { supabase } from "@/integrations/supabase/client";

export interface TokenUsageEntry {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  promptType?: string;
}

export interface TokenUsageSummary {
  totalPrompts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

const EMPTY_SUMMARY: TokenUsageSummary = {
  totalPrompts: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
};

/**
 * Record a single AI call's token usage into the global table.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function recordTokenUsage(entry: Omit<TokenUsageEntry, "timestamp">) {
  supabase
    .from("token_usage" as never)
    .insert({
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      model: entry.model,
      prompt_type: entry.promptType ?? null,
    } as never)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) {
        console.warn("[tokenTracker] insert failed:", error.message);
      }
    });
}

/**
 * Get aggregated token usage. Pass days=0 for all-time (default).
 */
export async function getUsageSummary(days: number = 0, since?: string): Promise<TokenUsageSummary> {
  try {
    let query = supabase
      .from("token_usage" as never)
      .select("input_tokens, output_tokens");

    if (since) {
      query = query.gte("created_at" as never, since as never);
    } else if (days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("created_at" as never, cutoff as never);
    }

    const { data, error } = await query;

    if (error) {
      console.warn("[tokenTracker] query failed:", error.message);
      return EMPTY_SUMMARY;
    }

    if (!data || !Array.isArray(data) || data.length === 0) return EMPTY_SUMMARY;

    const rows = data as Array<{ input_tokens: number; output_tokens: number }>;
    const totalInputTokens = rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
    const totalOutputTokens = rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0);
    const totalTokens = totalInputTokens + totalOutputTokens;

    return {
      totalPrompts: rows.length,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
    };
  } catch (err) {
    console.warn("[tokenTracker] getUsageSummary error:", err);
    return EMPTY_SUMMARY;
  }
}

/**
 * Delete all token usage records from the database.
 */
export async function clearUsageData(): Promise<void> {
  const { error } = await supabase
    .from("token_usage" as never)
    .delete()
    .gte("id" as never, 0 as never);

  if (error) {
    console.warn("[tokenTracker] clear failed:", error.message);
  }
}

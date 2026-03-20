import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken } from "../_shared/googleAuth.ts";
import { getCorsHeaders, jsonResponse, parseJsonObject, rejectIfMissingProjectKey, rejectIfOriginNotAllowed } from "../_shared/security.ts";

/** Timing-safe string comparison to prevent timing attacks */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // Use constant-time XOR comparison
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/** Run a BigQuery query and return rows */
async function runBigQueryQuery(
  projectId: string,
  query: string,
  accessToken: string,
  location?: string
): Promise<Record<string, unknown>[]> {
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`;

  const body: Record<string, unknown> = {
    query,
    useLegacySql: false,
    timeoutMs: 30000,
  };
  if (location) {
    body.location = location;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BigQuery query failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (!data.rows || data.rows.length === 0) {
    return [];
  }

  const fields = data.schema.fields.map((f: { name: string }) => f.name);
  return data.rows.map((row: { f: Array<{ v: string }> }) => {
    const obj: Record<string, unknown> = {};
    row.f.forEach((cell, i) => {
      obj[fields[i]] = cell.v;
    });
    return obj;
  });
}

async function isValidPublishableProjectKey(supabaseUrl: string, key: string): Promise<boolean> {
  if (!supabaseUrl || !key || !key.startsWith("sb_publishable_")) return false;

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      method: "GET",
      headers: {
        apikey: key,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  const blockedOriginResponse = rejectIfOriginNotAllowed(origin, "POST, OPTIONS", req);
  if (blockedOriginResponse) return blockedOriginResponse;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed" }, 405, corsHeaders);
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedSecret = req.headers.get("x-cron-secret");
  // Timing-safe comparison to prevent timing attacks on the cron secret
  const hasCronSecret = Boolean(cronSecret) && Boolean(providedSecret) &&
    cronSecret!.length === providedSecret!.length &&
    timingSafeEqual(cronSecret!, providedSecret!);

  if (!hasCronSecret) {
    const apiKey = (req.headers.get("apikey") || "").trim();
    const bearerToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const isPublishablePair =
      apiKey.length > 0 && bearerToken.length > 0 && apiKey === bearerToken && apiKey.startsWith("sb_publishable_");

    if (isPublishablePair) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const validPublishableKey = await isValidPublishableProjectKey(supabaseUrl, apiKey);
      if (!validPublishableKey) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
    } else {
      const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
      if (authRejected) return authRejected;
    }
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const GCP_SERVICE_ACCOUNT_JSON = Deno.env.get("GCP_SERVICE_ACCOUNT_JSON") || "";
  const GCP_PROJECT_ID = Deno.env.get("GCP_PROJECT_ID") || "";
  const BQ_BILLING_TABLE = Deno.env.get("BQ_BILLING_TABLE") || "";
  const BQ_LOCATION = Deno.env.get("BQ_LOCATION") || ""; // e.g. "australia-southeast1", "US", "EU"

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Missing Supabase env vars" }, 500, corsHeaders);
  }

  if (!GCP_SERVICE_ACCOUNT_JSON || !GCP_PROJECT_ID || !BQ_BILLING_TABLE) {
    return jsonResponse(
      {
        error: "Missing GCP secrets. Required: GCP_SERVICE_ACCOUNT_JSON, GCP_PROJECT_ID, BQ_BILLING_TABLE",
      },
      500,
      corsHeaders,
    );
  }

  // Validate BQ_BILLING_TABLE format to prevent SQL injection via env misconfiguration.
  // Expected format: project.dataset.table or dataset.table
  const validTablePattern = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+){1,2}$/;
  if (!validTablePattern.test(BQ_BILLING_TABLE)) {
    return jsonResponse({ error: "BQ_BILLING_TABLE has an invalid format" }, 500, corsHeaders);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let rangeDays = 30;
  try {
    const body = await parseJsonObject(req);
    const rangeDaysCandidate = Number(body.range_days);
    if ([7, 30].includes(rangeDaysCandidate)) {
      rangeDays = rangeDaysCandidate;
    }
  } catch {
    // Use default
  }

  try {
    // 1. Parse service account
    let serviceAccount: { client_email: string; private_key: string; project_id?: string };
    try {
      serviceAccount = JSON.parse(GCP_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GCP_SERVICE_ACCOUNT_JSON is not valid JSON");
    }

    // 2. Get access token
    console.log("[billing-snapshot] Authenticating with Google...");
    const accessToken = await getGoogleAccessToken(serviceAccount, [
      "https://www.googleapis.com/auth/bigquery.readonly",
    ]);
    console.log("[billing-snapshot] Authenticated successfully");

    // 3. Calculate rolling query window (last N days)
    const now = new Date();
    const windowStart = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const rangeStart = windowStart.toISOString().slice(0, 10);
    const rangeEnd = now.toISOString().slice(0, 10);

    const costQuery = `
      SELECT
        ROUND(SUM(cost), 4) AS total_cost,
        ANY_VALUE(currency) AS currency
      FROM \`${BQ_BILLING_TABLE}\`
      WHERE usage_start_time >= TIMESTAMP('${rangeStart}')
    `;

    console.log("[billing-snapshot] Running BigQuery cost query from", rangeStart);
    const costRows = await runBigQueryQuery(GCP_PROJECT_ID, costQuery, accessToken, BQ_LOCATION || undefined);
    console.log("[billing-snapshot] BigQuery result:", JSON.stringify(costRows));

    const totalCost = costRows.length > 0 ? parseFloat(String(costRows[0].total_cost || "0")) : 0;
    const currency = costRows.length > 0 ? String(costRows[0].currency || "AUD") : "AUD";

    // 4. Get token usage from Supabase (same rolling window)
    const { data: tokenRows, error: tokenErr } = await supabase
      .from("token_usage")
      .select("input_tokens, output_tokens")
      .gte("created_at", windowStart.toISOString());

    if (tokenErr) {
      console.warn("[billing-snapshot] token_usage query error:", tokenErr.message);
    }

    const promptCount = tokenRows?.length ?? 0;
    const inputTokens = (tokenRows ?? []).reduce(
      (s: number, r: { input_tokens: number }) => s + (r.input_tokens ?? 0),
      0
    );
    const outputTokens = (tokenRows ?? []).reduce(
      (s: number, r: { output_tokens: number }) => s + (r.output_tokens ?? 0),
      0
    );
    const avgCostPerPrompt = promptCount > 0 ? totalCost / promptCount : 0;

    // 5. Upsert snapshot into billing_snapshots (one row per range_days)
    const snapshot = {
      range_days: rangeDays,
      range_start: rangeStart || null,
      range_end: rangeEnd || null,
      currency,
      total_cost: totalCost,
      prompt_count: promptCount,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      avg_cost_per_prompt: Math.round(avgCostPerPrompt * 1000000) / 1000000,
      bigquery_table: BQ_BILLING_TABLE,
      notes: `Auto-snapshot for last ${rangeDays} days`,
      status: "success",
      error_message: null,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from("billing_snapshots")
      .upsert(snapshot, { onConflict: "range_days" });

    if (upsertErr) {
      throw new Error(`Upsert failed: ${upsertErr.message}`);
    }

    console.log("[billing-snapshot] Snapshot saved successfully:", {
      totalCost,
      currency,
      promptCount,
      avgCostPerPrompt: snapshot.avg_cost_per_prompt,
    });

    return jsonResponse(
      {
        success: true,
        snapshot,
      },
      200,
      corsHeaders,
    );
  } catch (err) {
    const errorRef = crypto.randomUUID();
    console.error("[billing-snapshot] Error:", { errorRef, err });

    // Save error status WITHOUT overwriting the last good cost data.
    // Only update status/error fields so the dashboard can show an error badge
    // while still displaying the previous successful snapshot values.
    try {
      const { data: existing } = await supabase
        .from("billing_snapshots")
        .select("id")
        .eq("range_days", rangeDays)
        .maybeSingle();

      if (existing) {
        // Row exists — only update status fields, preserve cost data
        await supabase
          .from("billing_snapshots")
          .update({
            status: "error",
            error_message: `billing_snapshot_failed:${errorRef}`,
            updated_at: new Date().toISOString(),
          })
          .eq("range_days", rangeDays);
      } else {
        // No row yet — insert a minimal error row
        await supabase.from("billing_snapshots").insert({
          range_days: rangeDays,
          status: "error",
          error_message: `billing_snapshot_failed:${errorRef}`,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (saveErr) {
      console.error("[billing-snapshot] Failed to save error snapshot:", saveErr);
    }

    return jsonResponse({ error: "Failed to refresh billing snapshot", error_ref: errorRef }, 500, corsHeaders);
  }
});

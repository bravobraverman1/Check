import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, jsonResponse, rejectIfMissingProjectKey, rejectIfOriginNotAllowed } from "../_shared/security.ts";

/** Convert ArrayBuffer to hex string */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate Cloudinary API signature */
async function cloudinarySignature(
  params: Record<string, string>,
  apiSecret: string
): Promise<string> {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const data = new TextEncoder().encode(sorted + apiSecret);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return toHex(hash);
}

/** Delete a single Cloudinary asset by public_id using Admin API */
async function destroyCloudinaryAsset(
  publicId: string,
  cloudName: string,
  apiKey: string,
  apiSecret: string
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params: Record<string, string> = {
    public_id: publicId,
    timestamp,
  };
  const signature = await cloudinarySignature(params, apiSecret);

  const url = `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`;
  const fd = new FormData();
  fd.append("public_id", publicId);
  fd.append("timestamp", timestamp);
  fd.append("api_key", apiKey);
  fd.append("signature", signature);

  try {
    const res = await fetch(url, { method: "POST", body: fd });
    const data = await res.json();
    if (data.result === "ok" || data.result === "not found") {
      return { success: true };
    }
    return { success: false, error: "cloudinary_delete_failed" };
  } catch (err) {
    console.error("destroyCloudinaryAsset error:", err);
    return { success: false, error: "cloudinary_delete_exception" };
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

  // Allow either cron secret (preferred for scheduled jobs) or project key auth.
  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedSecret = req.headers.get("x-cron-secret");
  const hasCronSecret = Boolean(cronSecret) && providedSecret === cronSecret;
  if (!hasCronSecret) {
    const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
    if (authRejected) return authRejected;
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY") || "";
  const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET") || "";

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Missing Supabase env vars" }, 500, corsHeaders);
  }

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return jsonResponse(
      { error: "Missing Cloudinary secrets (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)" },
      500,
      corsHeaders,
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // Select rows older than 30 days that haven't been deleted
    const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const { data: expired, error: selectErr } = await supabase
      .from("temp_images")
      .select("id, cloudinary_public_id")
      .is("deleted_at", null)
      .lt("created_at", new Date(Date.now() - RETENTION_MS).toISOString())
      .limit(100);

    if (selectErr) {
      throw new Error(`DB select failed: ${selectErr.message}`);
    }

    if (!expired || expired.length === 0) {
      return jsonResponse({ success: true, message: "No expired images to clean up", deleted: 0 }, 200, corsHeaders);
    }

    let deletedCount = 0;
    let errorCount = 0;

    for (const row of expired) {
      const result = await destroyCloudinaryAsset(
        row.cloudinary_public_id,
        CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET
      );

      if (result.success) {
        await supabase
          .from("temp_images")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", row.id);
        deletedCount++;
      } else {
        await supabase
          .from("temp_images")
          .update({ delete_error: result.error || "Unknown error" })
          .eq("id", row.id);
        errorCount++;
        console.error(`Failed to delete ${row.cloudinary_public_id}:`, result.error);
      }
    }

    return jsonResponse(
      {
        success: true,
        message: `Processed ${expired.length} expired images`,
        deleted: deletedCount,
        errors: errorCount,
      },
      200,
      corsHeaders,
    );
  } catch (err) {
    const errorRef = crypto.randomUUID();
    console.error("cleanup-cloudinary error:", { errorRef, err });
    return jsonResponse({ error: "Cloudinary cleanup failed", error_ref: errorRef }, 500, corsHeaders);
  }
});

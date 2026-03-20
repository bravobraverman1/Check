import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  getCorsHeaders,
  jsonResponse,
  parseJsonObject,
  rejectIfMissingProjectKey,
  rejectIfOriginNotAllowed,
} from "../_shared/security.ts";

const REQUEST_TIMEOUT_MS = Number(Deno.env.get("IMAGE_PROXY_TIMEOUT_MS") || "12000");
const MAX_IMAGE_BYTES = Number(Deno.env.get("IMAGE_PROXY_MAX_BYTES") || `${8 * 1024 * 1024}`);
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "0.0.0.0",
]);

function isIpv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  if (!isIpv4(host)) return false;
  const octets = host.split(".").map((n) => Number(n));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return true;

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;

  // IPv4-mapped IPv6 addresses: ::ffff:x.x.x.x or ::x.x.x.x
  const ipv4MappedMatch = normalized.match(
    /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (ipv4MappedMatch) {
    return isPrivateIpv4(ipv4MappedMatch[1]);
  }

  // Full form: 0:0:0:0:0:ffff:x.x.x.x
  const fullFormMatch = normalized.match(
    /^0:0:0:0:0:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (fullFormMatch) {
    return isPrivateIpv4(fullFormMatch[1]);
  }

  return false;
}

function isBlockedHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return true;
  if (BLOCKED_HOSTS.has(normalized)) return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  if (isPrivateIpv4(normalized)) return true;
  if (normalized.includes(":") && isPrivateIpv6(normalized)) return true;
  return false;
}

function validateProxyTarget(target: URL): string | null {
  if (!["http:", "https:"].includes(target.protocol)) {
    return "Only HTTP(S) URLs are allowed";
  }

  if (target.username || target.password) {
    return "URLs with embedded credentials are not allowed";
  }

  if (target.port && !["80", "443"].includes(target.port)) {
    return "Only default HTTP/HTTPS ports are allowed";
  }

  const host = target.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    return "Target host is not allowed";
  }

  return null;
}

async function fetchWithValidation(initialUrl: URL): Promise<Response> {
  let current = initialUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ImageProxy/2.0)",
          Accept: "image/*",
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) {
      throw new Error("Upstream redirect missing location header");
    }

    const next = new URL(location, current.toString());
    const validationError = validateProxyTarget(next);
    if (validationError) {
      throw new Error(validationError);
    }
    current = next;
  }

  throw new Error("Too many redirects");
}

async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Image exceeds maximum size");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  const blockedOriginResponse = rejectIfOriginNotAllowed(origin, "POST, OPTIONS", req);
  if (blockedOriginResponse) {
    return blockedOriginResponse;
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST requests are allowed" }, 405, corsHeaders);
  }

  const authRejected = await rejectIfMissingProjectKey(req, corsHeaders);
  if (authRejected) return authRejected;

  try {
    const body = await parseJsonObject(req);
    const urlValue = body.url;
    if (typeof urlValue !== "string" || !urlValue.trim()) {
      return jsonResponse({ error: "Missing url parameter" }, 400, corsHeaders);
    }

    const targetUrl = urlValue.trim();

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return jsonResponse({ error: "Invalid URL" }, 400, corsHeaders);
    }

    const validationError = validateProxyTarget(parsedUrl);
    if (validationError) {
      return jsonResponse({ error: validationError }, 403, corsHeaders);
    }

    const imgRes = await fetchWithValidation(parsedUrl);

    if (!imgRes.ok) {
      await imgRes.body?.cancel();
      return jsonResponse({ error: `Upstream returned ${imgRes.status}` }, 502, corsHeaders);
    }

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const contentLength = Number(imgRes.headers.get("content-length") || "0");

    if (!contentType.startsWith("image/")) {
      await imgRes.body?.cancel();
      return jsonResponse({ error: "URL does not point to an image" }, 400, corsHeaders);
    }

    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      await imgRes.body?.cancel();
      return jsonResponse({ error: "Image exceeds maximum allowed size" }, 413, corsHeaders);
    }

    const imageBytes = await readBodyWithLimit(imgRes.body, MAX_IMAGE_BYTES);

    return new Response(imageBytes as unknown as BodyInit, {
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy error";
    const isBadRequest = err instanceof Error && /invalid json|json body must|invalid url|missing url/i.test(err.message);
    if (isBadRequest) {
      return jsonResponse({ error: message }, 400, corsHeaders);
    }
    const errorRef = crypto.randomUUID();
    console.error("image-proxy internal error:", { errorRef, err });
    return jsonResponse({ error: "Image proxy failed", error_ref: errorRef }, 500, corsHeaders);
  }
});

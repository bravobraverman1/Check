/**
 * Shared Google Service Account JWT auth for Supabase Edge Functions.
 *
 * Used by: google-sheets (Sheets API), billing-snapshot (BigQuery API).
 * Each caller passes its own scopes.
 */

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/** Decode base64 (standard or URL-safe) to Uint8Array */
function b64decode(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Base64url-encode a UTF-8 string (for JWT header/payload) */
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Base64url-encode raw signature bytes */
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Create a signed RS256 JWT for Google service account auth */
async function createGoogleJWT(
  credentials: ServiceAccountCredentials,
  scopes: string[],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: credentials.client_email,
      scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = new TextEncoder().encode(`${header}.${payload}`);

  // Import the RSA private key
  const pemBody = credentials.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const keyData = b64decode(pemBody);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signingInput,
  );

  const sigB64 = base64UrlEncodeBytes(new Uint8Array(signature));
  return `${header}.${payload}.${sigB64}`;
}

/**
 * Get an OAuth2 access token from Google using a service account.
 * @param credentials - Service account email + private key
 * @param scopes - OAuth2 scopes to request
 * @returns Bearer access token string
 */
export async function getGoogleAccessToken(
  credentials: ServiceAccountCredentials,
  scopes: string[],
): Promise<string> {
  const jwt = await createGoogleJWT(credentials, scopes);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    const raw = JSON.stringify(data);
    if (
      data?.error === "invalid_grant" &&
      String(data?.error_description || "").includes("Invalid JWT Signature")
    ) {
      throw new Error(
        "Invalid service account key. The private key does not match the client_email or the key is malformed. " +
        "Recreate the JSON key and update the environment secret, then redeploy.",
      );
    }
    throw new Error(`Failed to get access token: ${raw}`);
  }

  return data.access_token;
}

/**
 * Parse a service account JSON key from a raw string (supports both
 * direct JSON and base64-encoded JSON, common in env var storage).
 */
export function parseServiceAccountKey(raw: string): ServiceAccountCredentials | null {
  const tryParse = (value: string): ServiceAccountCredentials | null => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && parsed.client_email && parsed.private_key) {
        return parsed as ServiceAccountCredentials;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  // Attempt base64 decode (common when secrets are stored encoded)
  try {
    const decoded = atob(raw);
    return tryParse(decoded);
  } catch {
    return null;
  }
}

/**
 * Normalize PEM private key: convert literal \n escapes to real newlines,
 * strip carriage returns.
 */
export function normalizePrivateKey(key: string): string {
  if (!key) return key;
  const normalized = key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
  return normalized.replace(/\r/g, "").trim();
}

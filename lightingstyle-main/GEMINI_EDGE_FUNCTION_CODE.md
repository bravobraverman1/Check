# Edge Function Code — Ready to Copy-Paste

**Copy the entire code block below and paste into Supabase Edge Functions.**

---

## How to Use This Code

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project
3. Click **"Edge Functions"** (left sidebar)
4. Click **"Create a new function"**
5. Name: `gemini-processor` (exact, lowercase, hyphen)
6. **Copy and paste the entire code block below** into the editor
7. Click **"Create function"** or **"Save"**

---

## Edge Function Code: `supabase/functions/gemini-processor/index.ts`

**Copy everything from START to END:**

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GOOGLE_AI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

interface GeminiRequest {
  prompt: string;
  documentText?: string;
  files?: Array<{ bucket: string; path: string }>;
  jsonMode?: boolean;
}

interface ExtractedData {
  [key: string]: string | string[] | object | null;
}

interface GeminiResponse {
  success: boolean;
  data?: ExtractedData | string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

// Validate request
function validateRequest(req: GeminiRequest): { valid: boolean; error?: string } {
  if (!req.prompt || typeof req.prompt !== "string") {
    return { valid: false, error: "Missing or invalid 'prompt'" };
  }
  if (!req.documentText && (!req.files || req.files.length === 0)) {
    return { valid: false, error: "Provide either 'documentText' or 'files'" };
  }
  return { valid: true };
}

// Get document content from Supabase Storage
async function getDocumentContent(supabaseClient: any, bucket: string, path: string): Promise<string> {
  const { data, error } = await supabaseClient.storage.from(bucket).download(path);
  
  if (error) {
    throw new Error(`Failed to download file from ${bucket}/${path}: ${error.message}`);
  }

  // For PDFs and images, convert to base64 (Gemini can process them)
  const arrayBuffer = await data.arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
}

// Call Google Gemini API
async function callGeminiAPI(prompt: string, documentContent: string, jsonMode: boolean = false): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable not set");
  }

  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "text/plain",
              data: documentContent,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2000,
      ...(jsonMode && {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            extracted_data: { type: "object" },
          },
        },
      }),
    },
  };

  const response = await fetch(`${GOOGLE_AI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (!result.candidates || result.candidates.length === 0) {
    throw new Error("No response from Gemini API");
  }

  const content = result.candidates[0].content.parts[0].text;
  return content;
}

// Parse Gemini response
function parseGeminiResponse(response: string, jsonMode: boolean = false): ExtractedData | string {
  if (jsonMode) {
    try {
      return JSON.parse(response);
    } catch {
      return response;
    }
  }
  return response;
}

// Main handler
async function handleRequest(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(), status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const body = (await req.json()) as GeminiRequest;

    // Validate request
    const validationResult = validateRequest(body);
    if (!validationResult.valid) {
      return new Response(
        JSON.stringify({ success: false, error: validationResult.error }),
        {
          status: 400,
          headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
        }
      );
    }

    let documentContent = body.documentText || "";

    // Get content from files if provided
    if (body.files && body.files.length > 0) {
      const fileContents: string[] = [];
      for (const file of body.files) {
        const content = await getDocumentContent(supabaseClient, file.bucket, file.path);
        fileContents.push(content);
      }
      documentContent = fileContents.join("\n---\n");
    }

    // Call Gemini API
    const geminiResponse = await callGeminiAPI(body.prompt, documentContent, body.jsonMode);
    const parsedResponse = parseGeminiResponse(geminiResponse, body.jsonMode);

    const response: GeminiResponse = {
      success: true,
      data: parsedResponse,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error:", error);
    const response: GeminiResponse = {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }
}

serve(handleRequest);
```

---

## After Pasting

1. Click **"Save"** or **"Create function"**
2. Wait for deployment (shows green checkmark)
3. **DO NOT** manually redeploy yet
4. Follow [GEMINI_SETUP_PRODUCTION.md](GEMINI_SETUP_PRODUCTION.md) STEP 3-4
5. After adding secrets to Supabase, run GitHub Actions workflow to redeploy with secrets loaded

---

## What This Code Does

1. **Receives requests** from your frontend (supabase.functions.invoke)
2. **Gets the API key** from Supabase Secrets Vault (GEMINI_API_KEY)
3. **Downloads files** from Supabase Storage if provided
4. **Calls Google Gemini API** with the prompt and document
5. **Parses the response** (JSON or text mode)
6. **Returns extracted data** to frontend

**Security:** 
- API key NEVER exposed to browser
- All processing happens server-side
- CORS headers prevent unauthorized access
- Every request validated

---

## Troubleshooting

### "GEMINI_API_KEY not set" error

**Problem:** The secret wasn't loaded when function deployed.

**Solution:**
1. Go to GitHub → Actions
2. Find "Deploy Gemini Processor" workflow
3. Click "Run workflow"
4. Wait 2-3 minutes
5. Try again

**Why:** Edge Functions load secrets at deployment time. If you add a secret AFTER they deploy, the function doesn't know about it until you redeploy.

---

### "Cannot parse response" error

**Problem:** Gemini API returned unexpected format.

**Check:**
1. Verify GEMINI_API_KEY is correct (copy from Google Cloud)
2. Try replacing with a fresh API key
3. Check your Google Cloud project has Gemini API enabled

---

### "Supabase client error"

**Problem:** Can't connect to Supabase Storage.

**Check:**
1. SUPABASE_URL and SUPABASE_ANON_KEY are set (auto-loaded)
2. Storage bucket exists and is named `document-uploads`
3. Bucket has proper policies for authenticated users

---

## Next Steps

1. ✅ Paste this code into Supabase Edge Functions (name: `gemini-processor`)
2. ✅ Follow [GEMINI_SETUP_PRODUCTION.md](GEMINI_SETUP_PRODUCTION.md) STEP 3-4
3. ✅ Run GitHub Actions "Deploy Gemini Processor" workflow
4. ✅ Test connection in Admin panel
5. ✅ Follow [GEMINI_COPY_PASTE_INTEGRATION.md](GEMINI_COPY_PASTE_INTEGRATION.md)

---

## Questions?

See [GEMINI_SETUP_PRODUCTION.md](GEMINI_SETUP_PRODUCTION.md) for complete setup guide.

# Gemini AI Setup Guide — Complete Step-by-Step

**🚀 Fast Setup: 15 minutes total**

This guide walks you through:
1. Getting a Gemini API key from Google Cloud
2. Adding it to Supabase (secure, server-side)
3. Deploying the Edge Function via GitHub Actions
4. Creating storage bucket for documents
5. Testing in your app

---

## ⚠️ IMPORTANT: Most Common Mistake

**If you get a "Cannot find Gemini API" error when testing:**
- **Problem:** You added secrets to Supabase AFTER deploying the Edge Function
- **Solution:** Run the GitHub Actions workflow "Deploy Gemini Processor" (STEP 4)
- **Why:** Edge Functions only load secrets at deployment time — they need to be redeployed after adding secrets

👉 **Quick Fix:** Go to GitHub → Actions → "Deploy Gemini Processor" → Run workflow

---

## Overview

Follow these steps in order:

1. **STEP 1:** Create a Google Cloud project and get Gemini API key
2. **STEP 2:** Create the Edge Function in your repository  
3. **STEP 3:** Add secrets to Supabase (server-side security)
4. **STEP 4:** Deploy via GitHub Actions (auto-handles function deployment)
5. **STEP 5:** Create storage bucket for document uploads
6. **STEP 6:** Add components to your app
7. **STEP 7:** Test your connection

---

## STEP 1: Get Gemini API Key from Google Cloud

### Create a new Google Cloud project (if you don't have one)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the **project selector** at the top (near the search bar)
3. Click **"Create New Project"**
4. Enter a project name (e.g., `Product Entry Hub AI`)
5. Click **"Create"** and wait for it to initialize

### Enable the Gemini API

1. In [Google Cloud Console](https://console.cloud.google.com/), make sure your new project is selected (top dropdown)
2. Click **"APIs & Services"** in the left sidebar
3. Click **"Library"**
4. Search for **"Gemini"** or **"Google AI"**
5. Click on **"Gemini API"** (or "Google AI API")
6. Click **"Enable"** (blue button)
7. Wait for it to enable (1-2 seconds)

### Create an API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **"APIs & Services"** → **"Credentials"**
2. Click **"+ Create Credentials"** → **"API Key"**
3. Your API Key is created and displayed
4. **Copy this key** (you'll need it in STEP 3)
5. Recommended: Click the **pencil icon** to rename it to something like `Product Entry Hub Gemini Key`

**That's it for Google Cloud!** Keep the API key safe.

---

## STEP 2: Create the Edge Function File in Your Repository

You will now add the Edge Function code to your repository. This gets deployed by the GitHub Actions workflow in Step 4.

### 1) Create the function directory

In your repository, create this folder structure:

```
supabase/
  functions/
    gemini-processor/
      (you'll add index.ts here)
```

If the `supabase/functions/` folder doesn't exist yet, create it.

### 2) Create `supabase/functions/gemini-processor/index.ts`

Create a new file at that exact path and paste this entire code block:

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

### 3) Verify the file exists

Run this in your terminal to verify:

```bash
cat supabase/functions/gemini-processor/index.ts
```

You should see the code you just pasted. If the file doesn't exist or is empty, try creating it again.

---

## STEP 3: Add Your API Key to Supabase Secrets

Your Gemini API key must be stored in Supabase (never in your frontend code).

### 1) Go to Supabase Secrets

1. Open [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project (or create a new one if needed)
3. Go to **Settings** → **Secrets and Vault** (left sidebar)

### 2) Add the GEMINI_API_KEY secret

1. Click **"New Secret"** (or "Add new secret")
2. **Name:** `GEMINI_API_KEY` (exact, uppercase)
3. **Value:** Paste the API key you got from Google Cloud (STEP 1)
4. Click **"Add Secret"**
5. You should see it listed with a green checkmark

**✅ Do NOT close this page yet.** You need the secrets to be saved before deploying.

---

## STEP 4: Deploy via GitHub Actions (Auto-Deploys Edge Function)

This step deploys your Edge Function to Supabase automatically. You don't write any code—just run a pre-built workflow.

> **Note:** The GitHub Actions workflow automatically adds your Edge Function to Supabase and loads your secrets.

### One-time setup: Add GitHub Secrets

Before running the workflow, add three secrets to GitHub. These allow the workflow to access your Supabase project.

1. Go to your GitHub repository: `https://github.com/bravobraverman1/lighting-style-product-creation`
2. Click the **Settings** tab (top right)
3. In the left sidebar, click **"Secrets and variables"** → **"Actions"**

Add these three secrets (click "New repository secret" for each):

**Secret 1: `SUPABASE_ACCESS_TOKEN`**
- Get from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
- Create a new token if needed
- Copy and paste it into GitHub

**Secret 2: `SUPABASE_PROJECT_REF`**
- Go to Supabase dashboard → **Settings** → **General**
- Copy the **Reference ID** (looks like: `abcdefghijklmnop`)
- Paste into GitHub

**Secret 3: `SUPABASE_DB_PASSWORD`**
- This is your Supabase database password (set when you created the project)
- If you don't remember it, reset it in Supabase → **Settings** → **Database**
- Paste into GitHub

### Run the deployment workflow (5 clicks)

1. Go to your GitHub repository → **Actions** tab
2. In the left sidebar, find and click **"Deploy Gemini Processor"**
3. Click the **"Run workflow"** button (blue button on the right)
4. Select **"production"** from the dropdown (if asked)
5. Click **"Run workflow"** to start
6. Wait 2–3 minutes for completion (green checkmark ✓ = success)

**That's it!** Your Gemini Edge Function is now deployed and secrets are loaded.

---

## STEP 5: Create Storage Bucket for Document Uploads

Documents need to be temporarily stored while Gemini processes them.

### Create the bucket

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project
3. Click **"Storage"** (left sidebar)
4. Click **"Create new bucket"**
5. **Name:** `document-uploads` (exact, lowercase, with hyphen)
6. **Public bucket?** Choose **Private** (more secure)
7. Click **"Create bucket"**

### Add upload policies (allows your app to upload)

1. Click on the `document-uploads` bucket
2. Go to the **"Policies"** tab
3. Click **"New policy"** or **"+ Add a policy"**
4. Create a policy:
   - **Board:** SELECT
   - **Allow:** Authenticated users
   - **With expression:** Leave blank or default
5. Click **"Review** then **"Save"**
6. Repeat for **INSERT** (uploading) and **DELETE** (cleanup)

Your bucket is ready for document uploads.

---

## STEP 6: Add Gemini Components to Your App

Now integrate the UI components into your application.

### In `src/pages/Admin.tsx`

Find the section with "FILTER Rules Editor" and add this import at the top:

```typescript
import { GeminiAdminPanel } from "@/components/GeminiAdminPanel";
```

Then add this component after the "FILTER Rules Editor" section:

```tsx
{/* Gemini AI Configuration */}
<GeminiAdminPanel />
```

### In `src/components/ProductEntryForm.tsx`

Add these imports at the top:

```typescript
import { DocumentUpload } from "@/components/DocumentUpload";
import { isGeminiConfigured } from "@/lib/geminiConfig";
```

Find where the form fields start (look for "Specifications" section) and add before it:

```tsx
{/* Document Upload (Gemini AI) */}
{isGeminiConfigured() && <DocumentUpload />}
```

That's it! The components are now integrated.

---

## STEP 7: Test Your Connection

### Verify everything works

1. Open your app and go to the **Admin** page
2. Scroll down to find the **"Gemini AI"** section (grey box)
3. Click the **"Test Connection"** button (blue)
4. Wait a moment for the test to complete

### What should happen

**✅ Success:** You'll see **"✓ Gemini API Connected"** in green
- This means your API key is working and Gemini is ready
- You can now use document upload in the Product Entry Form

**❌ Error:** You'll see an error message in red
- See the [Troubleshooting](#troubleshooting) section below

---

## Troubleshooting

### "Cannot find Gemini API" or "API key not set"

**Problem:** The Edge Function doesn't have your API key.

**Solution:**
1. Make sure `GEMINI_API_KEY` is added to Supabase Secrets (STEP 3)
2. Go to GitHub → **Actions** → **"Deploy Gemini Processor"** → **"Run workflow"**
3. Wait 2-3 minutes for deployment to complete
4. Try the test again

**Why:** Edge Functions load secrets at deployment time. If you add a secret after deploying, the function doesn't know about it until you redeploy.

---

### "Cannot connect to Supabase" or "Invalid URL"

**Problem:** Your app can't reach Supabase.

**Check:**
1. In your app's environment variables, verify `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set
2. Try refreshing the page
3. Check browser console (F12 → Console) for error messages
4. Make sure you're using the right Supabase project

---

### "Failed to access storage bucket"

**Problem:** Documents can't be uploaded or accessed.

**Check:**
1. The `document-uploads` bucket exists (Storage → buckets list)
2. The bucket has policies allowing authenticated users (Security)
3. Your app is authenticated (you're logged in)

---

### "Gemini returns empty results"

**Problem:** The API works but extracted data is missing.

**Check:**
1. The custom prompt in Admin → Gemini AI section (if you customized it)
2. The document format (PDFs, images, text all work)
3. Document size (shouldn't be huge, <10MB recommended)
4. Try uploading a different file

---

## Customization

### Custom Extraction Prompts

You can customize what Gemini extracts:

1. Go to Admin → **Gemini AI** section
2. Find **"Custom Extraction Prompt"** (collapsible)
3. Edit the prompt to match what you want
4. Click **"Save Settings"**
5. Test it in the Product Entry Form

Example custom prompt:
```
Extract product information from the document:
- Product name
- Model number
- Features (as a list)
- Specifications
- Price (if available)
Return as JSON with these keys: name, model, features, specs, price
```

---

## Success Checklist

After completing all steps, you should have:

- [ ] Gemini API key from Google Cloud
- [ ] `GEMINI_API_KEY` secret in Supabase
- [ ] Edge Function deployed via GitHub Actions (green checkmark in workflow)
- [ ] `document-uploads` storage bucket created
- [ ] GeminiAdminPanel added to Admin.tsx
- [ ] DocumentUpload added to ProductEntryForm.tsx
- [ ] Test connection shows ✓ Connected
- [ ] Can upload documents and extract data

---

## Free Tier Resources

Gemini AI is free for testing:

- **Requests per minute:** 15
- **Tokens per month:** 1,000,000
- **Models available:** `gemini-1.5-flash` (fastest, cheapest)

For heavy usage, upgrade to paid tier in Google Cloud Console.

---

## Next Steps

1. ✅ Complete all 7 steps above
2. Start using AI document upload in Product Entry Form
3. Customize extraction prompts as needed
4. Monitor API usage in [Google Cloud Console](https://console.cloud.google.com/billing)

---

## Video Summary

No video yet, but the steps mirror the [Google Sheets Setup](GOOGLE_SHEETS_SETUP.md) pattern:

1. Get credentials from external service (Google Cloud)
2. Add to Supabase Secrets
3. Create Edge Function file in repository
4. Deploy via GitHub Actions (automatic)
5. Create storage/resources needed
6. Add components to app
7. Test connection

Same workflow, different service. You got this! 🚀

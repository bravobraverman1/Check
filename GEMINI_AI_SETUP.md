# Gemini AI Integration Setup Guide

This guide explains how to set up Google Gemini AI in your Product Entry Hub application using Supabase Edge Functions for secure server-side processing.

## ⚠️ SECURITY: Why Server-Side?

Your Gemini API key is **NEVER** stored in your browser or frontend code. Instead:
- ✅ API key stored securely in Supabase (server-side only)
- ✅ Frontend sends documents to Edge Function
- ✅ Edge Function calls Gemini with your secret key
- ✅ Frontend receives results only

---

## Overview: What You'll Get

| Feature | Where |
|---------|-------|
| AI product data extraction from PDFs | Product Entry Form → "Generate product data and title" section |
| AI datasheet comparison (Supplier vs LS) | Admin → "Compare Two Datasheets" |
| Versioned AI prompts per category | Admin → "AI Prompts" section |
| PDF reference files (manual context) | Admin → "AI Instructions Constants" |

---

## Table of Contents

1. [STEP 1: Get a Gemini API Key](#step-1-get-a-gemini-api-key)
2. [STEP 2: Add API Key to Supabase](#step-2-add-api-key-to-supabase)
3. [STEP 3: Deploy Edge Functions](#step-3-deploy-edge-functions)
4. [STEP 4: Create Supabase Storage Buckets](#step-4-create-supabase-storage-buckets)
5. [STEP 5: Create the AI Prompts Database Table](#step-5-create-the-ai-prompts-database-table)
6. [STEP 6: Deploy the manage-ai-prompt Edge Function](#step-6-deploy-the-manage-ai-prompt-edge-function)
7. [STEP 7: Test Your Setup](#step-7-test-your-setup)
8. [AI Prompts System Reference](#ai-prompts-system-reference)
9. [Compare Two Datasheets Reference](#compare-two-datasheets-reference)
10. [Troubleshooting](#troubleshooting)

---

## STEP 1: Get a Gemini API Key

**Option A: Google AI Studio (Easiest — recommended)**

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with your Google account
3. Click **"Get API key"** in the left sidebar
4. Click **"Create API key"**
5. Copy the key — it starts with `AIza...`

**Option B: Google Cloud Console**

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. Enable the **"Generative Language API"** (APIs & Services → Library)
4. Go to **APIs & Services → Credentials → + Create Credentials → API Key**
5. Copy the key

> **Restrict your key (recommended):** In Credentials, click the key → API restrictions → select "Generative Language API" → Save

---

## STEP 2: Add API Key to Supabase

> **Navigate to:** Supabase Dashboard → **Edge Functions** → **Secrets**
> ⚠️ Do NOT use Settings → Secrets and Vault — that is a different section.

1. Click **"Add or Replace Secrets"**
2. Name: `GEMINI_API_KEY`
3. Value: Paste your API key from STEP 1
4. Click **Save**

---

## STEP 3: Deploy Edge Functions

The app uses **4 Edge Functions** — all deployed via GitHub Actions from `https://github.com/bravobraverman1/lighting-style-product-creation/actions`.

### All 4 Edge Functions at a Glance

| GitHub Actions Workflow | Edge Function | Purpose | Secrets Required |
|------------------------|--------------|---------|-----------------|
| **Deploy Gemini Processor** | `gemini-processor` | Handles PDF/image uploads, calls Gemini API | `GEMINI_API_KEY` |
| **Deploy manage-ai-prompt Edge Func...** | `manage-ai-prompt` | Saves, activates, lists, removes versioned prompts | Auto (`SUPABASE_SERVICE_ROLE_KEY`) |
| **Deploy Google Sheets Connection** | `google-sheets` | Reads/writes data to Google Sheets | `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_SHEET_ID` |
| **Deploy cleanup-uploads Edge Function** | `cleanup-uploads` | Deletes expired PDF uploads from storage buckets | Auto (`SUPABASE_SERVICE_ROLE_KEY`) |

> All 4 workflows require `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` as GitHub Secrets (set once — see below).

---

### One-Time GitHub Secrets Setup

Before running any workflow, add these secrets at:  
👉 `https://github.com/bravobraverman1/lighting-style-product-creation/settings/secrets/actions`

| Secret Name | Value | Where to get it |
|-------------|-------|----------------|
| `SUPABASE_ACCESS_TOKEN` | Starts with `sbp_...` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → Generate new token |
| `SUPABASE_PROJECT_REF` | e.g. `abcdefghijklmnop` | Supabase Dashboard → Project Settings → General → **Reference ID** |
| `SUPABASE_DB_PASSWORD` | Your database password | Set on project creation; reset at Settings → Database → Reset password |

---

### Deploy via GitHub Actions (Recommended)

Go to: `https://github.com/bravobraverman1/lighting-style-product-creation/actions`

**1. Deploy gemini-processor** *(AI PDF processing)*
1. Click **"Deploy Gemini Processor"** in the left sidebar
2. Click **"Run workflow"** → select `production` → **"Run workflow"**
3. Wait for green ✓ (1–2 minutes)

**2. Deploy manage-ai-prompt** *(AI prompt versioning)*
1. Click **"Deploy manage-ai-prompt Edge Func..."** in the left sidebar
2. Click **"Run workflow"** → **"Run workflow"**
3. Wait for green ✓

**3. Deploy google-sheets** *(Google Sheets integration)*
1. Click **"Deploy Google Sheets Connection"** in the left sidebar
2. Click **"Run workflow"** → select `production` → **"Run workflow"**
3. Wait for green ✓

**4. Deploy cleanup-uploads** *(Automatic PDF cleanup)*
1. Click **"Deploy cleanup-uploads Edge Function"** in the left sidebar
2. Click **"Run workflow"** → **"Run workflow"**
3. Wait for green ✓

---

### What Each Function Does in Detail

#### `gemini-processor`
- Accepts PDF files, fetches them from Supabase Storage server-side
- Calls the Gemini API using your `GEMINI_API_KEY` (never exposed to the browser)
- Supports `jsonMode: true` for structured JSON responses
- Used by: Product Entry Form (AI data extraction) and Admin → Compare Two Datasheets

#### `manage-ai-prompt`
- Stores versioned AI prompts in the `ai_prompts` Supabase table
- Supports multiple prompt categories (`product_data`, `compare_sheets`) independently
- No extra secrets needed — uses auto-provisioned `SUPABASE_SERVICE_ROLE_KEY`

#### `google-sheets`
- Reads categories, brands, products, filters from Google Sheets
- Writes product submissions to the `OUTPUT_Work` tab
- See [GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md) for full configuration

#### `cleanup-uploads`
- **Targeted cleanup:** Removes a user's uploaded PDFs immediately when they close their browser tab (via `sendBeacon`)
- **Scheduled cleanup:** Removes any PDF older than 2 hours across all 4 upload buckets (run as a cron job)
- Protects your storage quota — PDFs are temporary and never kept after processing
- No extra secrets needed — uses auto-provisioned `SUPABASE_SERVICE_ROLE_KEY`

---

### Deploy via Supabase CLI (Alternative)

```bash
supabase functions deploy gemini-processor
supabase functions deploy manage-ai-prompt
supabase functions deploy google-sheets
supabase functions deploy cleanup-uploads
```

---

## STEP 4: Create Supabase Storage Buckets

The application uses **5 storage buckets**. Create all of them in **Supabase → Storage → New bucket**.

### Transient Upload Buckets (for PDF processing)

Create these **4 buckets** — all must be **public** with full anonymous access:

| Bucket Name | Public? | RLS Policy |
|-------------|---------|-----------|
| `document-uploads-1` | ✅ Public | Allow ALL operations for `anon` |
| `document-uploads-2` | ✅ Public | Allow ALL operations for `anon` |
| `document-uploads-3` | ✅ Public | Allow ALL operations for `anon` |
| `document-uploads-4` | ✅ Public | Allow ALL operations for `anon` |

**Why 4 buckets?** The app rotates between them automatically to avoid conflicts from multiple simultaneous uploads.

**RLS Policy SQL** (run for each bucket, replacing `bucket-name`):

```sql
CREATE POLICY "anon_all_document_uploads_1"
ON storage.objects FOR ALL
TO anon
USING (bucket_id = 'document-uploads-1')
WITH CHECK (bucket_id = 'document-uploads-1');
```

Repeat for buckets 2, 3, and 4.

### Constants Bucket (for permanent reference PDFs)

| Bucket Name | Public? | RLS Policy |
|-------------|---------|-----------|
| `document-uploads-constant` | ✅ Public | Allow ALL operations for `anon` |

```sql
CREATE POLICY "anon_all_document_uploads_constant"
ON storage.objects FOR ALL
TO anon
USING (bucket_id = 'document-uploads-constant')
WITH CHECK (bucket_id = 'document-uploads-constant');
```

> **Note:** Filenames are automatically sanitized (spaces and non-ASCII replaced with `_`) to prevent Supabase "Invalid key" errors.

---

## STEP 5: Create the AI Prompts Database Table

Run this SQL in **Supabase → SQL Editor**:

```sql
-- Create the AI prompts table
CREATE TABLE IF NOT EXISTS public.ai_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL,
  description text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT false,
  prompt_type text NOT NULL DEFAULT 'product_data'
);

CREATE INDEX IF NOT EXISTS ai_prompts_version_idx ON public.ai_prompts(version);
CREATE INDEX IF NOT EXISTS ai_prompts_active_idx ON public.ai_prompts(is_active);
CREATE INDEX IF NOT EXISTS ai_prompts_type_idx ON public.ai_prompts(prompt_type);

-- Enable Row Level Security
ALTER TABLE public.ai_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_anon_read"
ON public.ai_prompts FOR SELECT TO anon USING (true);
```

> **Already have the table but getting a `PGRST204` / `prompt_type column not found` error?**
> Run this migration instead:
> ```sql
> ALTER TABLE public.ai_prompts ADD COLUMN IF NOT EXISTS prompt_type text NOT NULL DEFAULT 'product_data';
> CREATE INDEX IF NOT EXISTS ai_prompts_type_idx ON public.ai_prompts(prompt_type);
> ```

### `prompt_type` Values

The `prompt_type` column keeps prompt histories separate per feature:

| `prompt_type` value | Used by | Where in UI |
|--------------------|---------|-------------|
| `product_data` | Generate product data & title | Admin → AI Prompts (Product Data tab) |
| `compare_sheets` | Compare Two Datasheets | Admin → AI Prompts (Compare Sheets tab) |

---

## STEP 6: manage-ai-prompt Function Reference

Already deployed in STEP 3. This documents what it handles:

| Action | Description |
|--------|-------------|
| `list` | Returns all versions for a `prompt_type`, newest first |
| `save` | Creates a new version (auto-increments within the `prompt_type`) |
| `activate` | Sets a version as active for its `prompt_type` (clears others) |
| `remove` | Deletes a version and re-sequences remaining versions |
| `get_active` | Returns the currently active prompt for a `prompt_type` |

The function requires `promptType` in the request body — defaults to `"product_data"` for backward compatibility.

---

## STEP 7: Test Your Setup

### A. Test Gemini Connection

1. Open your app → **Admin** page
2. Open **"Connections & AI Setup"** → **"Gemini AI Setup"**
3. Click **"Run Verification"** (or "Test Connection")
4. You should see green checkmarks for:
   - ✅ `gemini-processor` function reachable
   - ✅ `GEMINI_API_KEY` secret detected
   - ✅ Storage buckets accessible

### B. Test AI Prompt Saving

**Product data prompt (prompt_type: product_data):**
1. Admin → **"Generate product data and title"** → AI Prompts tab
2. Type a test prompt in the editor
3. Click **"Save"**
4. Should show "Version 1 saved" toast

**Compare sheets prompt (prompt_type: compare_sheets):**
1. Admin → **"Compare Two Datasheets"** section → AI Prompts tab
2. Type a test prompt in the editor
3. Click **"Save"**
4. Should show "Version 1 saved" toast (independent version from product_data)

### C. Test Document Processing

1. Go to the **Product Entry Form**
2. Select a SKU
3. Upload a product PDF in the "Generate product data and title" section
4. Click **"Generate"**
5. Gemini extracts data and populates the form fields

---

## AI Prompts System Reference

### How It Works

- Each prompt category (`product_data`, `compare_sheets`) has its **own independent version history**
- The **Active Prompt** is the one used during AI processing
- The editor auto-loads the Active Prompt on page open
- Saving creates a new version; it does **not** automatically become active
- Use **"Save & Set Active"** (or the Activate button) to make a version the active one
- Duplicate content is blocked — you cannot save the same text twice

### Admin UI Behaviour

| Action | Result |
|--------|--------|
| **Save** | Creates new version, resets editor to Active Prompt |
| **Save & Set Active** | Creates new version AND sets it as the active prompt |
| **Activate (version dropdown)** | Sets selected version as active without saving new |
| **Remove Version** | Deletes version, re-sequences remaining, auto-activates next highest if active was deleted |
| **Clear selection** | Resets editor to the Active Prompt content |

### Variable Injection in Prompts

You can use dynamic variables in your prompts:

| Variable | Replaced with | When used |
|----------|--------------|-----------|
| `{{SKU}}` | The selected SKU value | Compare Datasheets |
| `{{#IF SKU}}...{{/IF}}` | Shows block only if SKU is provided | Compare Datasheets |

Example prompt snippet:
```
{{#IF SKU}}
The product SKU is: {{SKU}}
{{/IF}}

Compare the Supplier datasheet against the LS datasheet and return differences.
```

---

## Compare Two Datasheets Reference

Located in **Admin → "Compare Two Datasheets"**

### How It Works

1. Upload a **Supplier PDF** and an **LS PDF**
2. Optionally enter a **SKU** (injected into the prompt via `{{SKU}}`)
3. Click **Compare**
4. Gemini compares both documents using the `compare_sheets` active prompt
5. Results display in a 3-column table: **Field | Supplier | LS**

### What Gets Sent to Gemini

- Both PDF files (uploaded to storage, fetched server-side)
- The active `compare_sheets` prompt (with `{{SKU}}` injected if provided)
- The **"AI Compare Datasheets"** reference PDF from the Constants section (if uploaded) — provides additional context

### Expected JSON Response Format

The prompt should instruct Gemini to return:

```json
{
  "extracted_data": [
    { "field": "Wattage", "supplier": "10W", "ls": "12W" },
    { "field": "Colour Temp", "supplier": "3000K", "ls": "4000K" }
  ]
}
```

### Example Compare Sheets Prompt

```
You are comparing a Supplier product datasheet against an LS (internal) datasheet.

{{#IF SKU}}
Product SKU: {{SKU}}
{{/IF}}

Identify all differences between the two documents. For each differing field, return:
- field: the specification name
- supplier: the value from the Supplier document
- ls: the value from the LS document

Return ONLY a JSON object with this structure:
{
  "extracted_data": [
    { "field": "...", "supplier": "...", "ls": "..." }
  ]
}

If a field exists in one document but not the other, use "N/A" for the missing value.
```

---

## AI Instructions Constants Reference

Located in **Admin → "AI Instructions Constants"**

Three permanent PDF upload slots used to provide reference context to Gemini:

| Slot | Internal Key | Used by |
|------|-------------|---------|
| AI Product Creation Manual #1 | `PROD_CREATION_TWO_PDF` | Product data generation (2-PDF mode) |
| AI Product Creation Manual #2 | `PROD_CREATION_SINGLE_PDF` | Product data generation (1-PDF mode) |
| AI Compare Datasheets | `AI_COMPARE_DATASHEETS_PDF` | Compare Two Datasheets feature |

Files are stored in the `document-uploads-constant` bucket.

**Download behaviour:** Files download via a fetch-to-blob approach (bypasses ad blockers that block direct storage URLs).

---

## gemini-processor Edge Function Reference

The `gemini-processor` function:

- Accepts PDF files as base64 `inlineData` parts or as text parts
- Fetches PDFs from Supabase Storage **server-side** using the service role key (client never sends binary payloads)
- Supports `jsonMode: true` in the request body to request JSON-formatted Gemini responses
- Uses a wildcard CORS policy (`Access-Control-Allow-Origin: *`)
- Reads `GEMINI_API_KEY` from Supabase Secrets at runtime

### Request Body Format

```json
{
  "bucketName": "document-uploads-1",
  "fileNames": ["sanitized_filename.pdf"],
  "prompt": "Your prompt here",
  "jsonMode": true,
  "promptType": "product_data"
}
```

---

## Supabase Secrets Required

| Secret | Function | Description |
|--------|----------|-------------|
| `GEMINI_API_KEY` | `gemini-processor` | Your Google Gemini API key |
| `SUPABASE_URL` | Both | Auto-set by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | `manage-ai-prompt` | Auto-set by Supabase |

---

## Costs & Quotas

### Google Gemini Free Tier (via AI Studio)

| Limit | Value |
|-------|-------|
| Requests per minute | 15 RPM |
| Tokens per month | 1 million (free) |
| Price beyond free | ~$0.075 per 1M input tokens |

Check usage: Google Cloud Console → Billing, or AI Studio → Usage

---

## Troubleshooting

### `PGRST204` — `prompt_type` column not found
Run in Supabase SQL Editor:
```sql
ALTER TABLE public.ai_prompts ADD COLUMN IF NOT EXISTS prompt_type text NOT NULL DEFAULT 'product_data';
```
Then redeploy `manage-ai-prompt`.

### `Edge function returned 500`
Check Supabase → Edge Functions → `manage-ai-prompt` / `gemini-processor` → **Logs** for the actual error message.

### "Gemini API key not configured"
→ Verify `GEMINI_API_KEY` is in Supabase → Edge Functions → Secrets (not Settings → Vault).
→ Redeploy `gemini-processor` after adding the secret.

### "Storage bucket not found"
→ Verify all 5 buckets exist: `document-uploads-1` through `document-uploads-4`, and `document-uploads-constant`.
→ Check bucket RLS policies allow anonymous access.

### "Invalid key" storage error
→ The filename contains special characters. The app auto-sanitizes filenames, but verify the upload component is using the sanitized name.

### Compare Datasheets shows no table / empty results
→ Verify your active `compare_sheets` prompt instructs Gemini to return `{ "extracted_data": [...] }` JSON.
→ Check `jsonMode: true` is being sent in the request (it is, by default).

### Prompt saves to wrong category
→ Each Admin section uses its own `promptType`. Product Data → `product_data`. Compare Sheets → `compare_sheets`. They are independent.

### API key works in test but fails in production
→ Redeploy the Edge Function after adding/changing secrets. Secrets are only loaded at deploy time.

---

## Quick Reference Checklist

### GitHub Secrets (one-time)
| Task | Done? |
|------|-------|
| `SUPABASE_ACCESS_TOKEN` added to GitHub Secrets | ☐ |
| `SUPABASE_PROJECT_REF` added to GitHub Secrets | ☐ |
| `SUPABASE_DB_PASSWORD` added to GitHub Secrets | ☐ |

### Supabase Secrets
| Task | Done? |
|------|-------|
| `GEMINI_API_KEY` added to Supabase → Edge Functions → Secrets | ☐ |
| `GOOGLE_SERVICE_ACCOUNT_KEY` added to Supabase → Edge Functions → Secrets | ☐ |
| `GOOGLE_SHEET_ID` added to Supabase → Edge Functions → Secrets | ☐ |

### Edge Functions (all 4 deployed via GitHub Actions)
| Task | Done? |
|------|-------|
| `gemini-processor` deployed | ☐ |
| `manage-ai-prompt` deployed | ☐ |
| `google-sheets` deployed | ☐ |
| `cleanup-uploads` deployed | ☐ |

### Supabase Database Tables
| Task | Done? |
|------|-------|
| `ai_prompts` table created with `prompt_type` column | ☐ |

### Supabase Storage Buckets (all 5)
| Task | Done? |
|------|-------|
| `document-uploads-1` bucket created (public + anon RLS) | ☐ |
| `document-uploads-2` bucket created (public + anon RLS) | ☐ |
| `document-uploads-3` bucket created (public + anon RLS) | ☐ |
| `document-uploads-4` bucket created (public + anon RLS) | ☐ |
| `document-uploads-constant` bucket created (public + anon RLS) | ☐ |

### Verification
| Task | Done? |
|------|-------|
| Gemini AI test passes in Admin panel | ☐ |
| Google Sheets test passes in Admin panel | ☐ |
| Product data prompt saved and activated | ☐ |
| Compare sheets prompt saved and activated | ☐ |

---

## All GitHub Actions Workflows — Quick Links

| Workflow | Direct Link |
|----------|------------|
| Deploy Gemini Processor | [Run workflow](https://github.com/bravobraverman1/lighting-style-product-creation/actions/workflows/deploy-gemini-processor.yml) |
| Deploy manage-ai-prompt | [Run workflow](https://github.com/bravobraverman1/lighting-style-product-creation/actions/workflows/deploy-manage-ai-prompt.yml) |
| Deploy Google Sheets Connection | [Run workflow](https://github.com/bravobraverman1/lighting-style-product-creation/actions/workflows/deploy-google-sheets.yml) |
| Deploy cleanup-uploads | [Run workflow](https://github.com/bravobraverman1/lighting-style-product-creation/actions/workflows/deploy-cleanup-uploads.yml) |

---

## Support

If stuck:

1. Supabase Dashboard → Edge Functions → **Logs** (most helpful)
2. Browser console → F12 → Console tab
3. Admin panel → Gemini AI Setup → Run Verification
  (Path: **Admin → Connections & AI Setup → Gemini AI Setup**)
4. Check this guide's Troubleshooting section

Good luck! 🚀

# Google Sheets Integration Setup Guide

This guide explains how to link your Google Sheets file to the Product Entry Hub application using a Google Service Account connected through a Supabase Edge Function.

## ⚠️ IMPORTANT: Most Common Mistake

**If you get a "Cannot Read Secrets" error when testing:**
- **Problem:** You added secrets to Supabase AFTER deploying the Edge Function
- **Solution:** Run the GitHub Actions workflow "Deploy Google Sheets Connection" (STEP 5)
- **Why:** Edge Functions only load secrets at deployment time — they need to be redeployed after adding new secrets

👉 **Quick Fix:** GitHub → Actions → "Deploy Google Sheets Connection" → Run workflow

---

## Overview

Follow these steps in order:

1. **STEP 1:** Create a Google Service Account
2. **STEP 2:** Share your Google Sheet with the service account
3. **STEP 3:** Deploy the Edge Function (first time setup)
4. **STEP 4:** Add credentials to Supabase Secrets
5. **STEP 5:** Redeploy after adding secrets (GitHub Actions)
6. **STEP 6:** Create the required database table
7. **STEP 7:** Configure tab names in Admin panel
8. **STEP 8:** Test your connection

---

## STEP 1: Create a Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. **Enable both APIs:**
   - **Google Sheets API**
   - **Google Drive API**
   - (APIs & Services → Library → search each → Enable)
4. Navigate to **IAM & Admin** → **Service Accounts**
5. Click **Create Service Account**
6. Enter a name (e.g., `product-entry-hub-sheets`)
7. Click **Create and Continue**
8. Grant the service account the **Editor** role
9. Click **Done**

---

## STEP 2: Share Your Google Sheet

### Download the Service Account Key

1. In Google Cloud Console → **IAM & Admin** → **Service Accounts**
2. Click on your service account
3. Go to the **Keys** tab
4. Click **Add Key** → **Create new key**
5. Select **JSON** format → Click **Create**
6. A JSON file downloads — **keep it secure**

### Share the Sheet

1. Open the downloaded JSON file
2. Copy the `client_email` value (e.g., `name@project.iam.gserviceaccount.com`)
3. Open your Google Sheet
4. Click **Share** → Add the service account email as **Editor** → **Share**

---

## STEP 3: Deploy the `google-sheets` Edge Function

> **🚨 Do NOT run the Lovable "Security Fixer" for anything related to Edge Functions or cloud services.**

The Edge Function code is already in your repository at `supabase/functions/google-sheets/index.ts`.

### Deploy via GitHub Actions (Recommended)

1. Go to your GitHub repository → **Actions** tab
2. Click **"Deploy Google Sheets Connection"** in the left sidebar
3. Click **"Run workflow"** → select `production` → **"Run workflow"**
4. Wait 1–2 minutes for the green ✓

### Deploy via Supabase CLI (Alternative)

```bash
supabase functions deploy google-sheets
```

---

## STEP 4: Add Credentials to Supabase

> **Navigate to:** Supabase Dashboard → **Edge Functions** → **Secrets**
> ⚠️ Do NOT use Settings → Secrets and Vault — that is a different section.

Add these two secrets:

| Secret Name | Value |
|-------------|-------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Paste the **entire contents** of the JSON key file you downloaded |
| `GOOGLE_SHEET_ID` | The ID from your Google Sheet URL (the long string between `/d/` and `/edit`) |

**How to find your Sheet ID:**
```
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_IS_HERE/edit
```

> **Tip:** You can paste the JSON key exactly as-is (multi-line). The Edge Function handles both raw JSON and base64-encoded formats automatically.

---

## STEP 0 (First-Time Only): Configure `src/config/publicEnv.ts`

This file connects the frontend to your Supabase project. **If you cloned this repo fresh, update it before anything else works.**

```ts
// src/config/publicEnv.ts
export const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_...";
export const SUPABASE_FUNCTIONS_URL = "https://YOUR_PROJECT_REF.supabase.co/functions/v1";
```

### Where to get these values

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → select your project
2. Click **Settings** (gear icon) → **API**
3. Copy:
   - **Project URL** → paste as `SUPABASE_URL`
   - **anon / public** key → paste as `SUPABASE_ANON_KEY`
   - `SUPABASE_FUNCTIONS_URL` = your Project URL + `/functions/v1`

> **These are safe to commit.** The anon key is a *publishable* key — it's designed to be public and is restricted by Row Level Security (RLS). Real secrets (Gemini API key, Google Service Account key) are stored only in Supabase Edge Function Secrets.

> **Already set up?** If you're working in Lovable and the app already connects to Supabase, these values are already correct in your repo — no action needed.

---


Edge Functions only pick up new secrets when redeployed. After adding your secrets in STEP 4:

1. Go to GitHub → **Actions** tab
2. Click **"Deploy Google Sheets Connection"**
3. Click **"Run workflow"** → **"Run workflow"**
4. Wait for the green ✓

---

## STEP 6: Create the Required Database Table (First Time Only)

The AI Prompts feature requires a table in Supabase. Run this SQL in **Supabase → SQL Editor**:

```sql
-- Create the AI prompts table (supports multiple prompt categories)
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

> **If you already have an `ai_prompts` table** (created before the `prompt_type` column was added), run this instead:
> ```sql
> ALTER TABLE public.ai_prompts ADD COLUMN IF NOT EXISTS prompt_type text NOT NULL DEFAULT 'product_data';
> CREATE INDEX IF NOT EXISTS ai_prompts_type_idx ON public.ai_prompts(prompt_type);
> ```

---

## STEP 7: Configure Tab Names in Admin Panel

The application reads data from specific Google Sheet tabs. Go to your app → **Admin** → **Extra Settings** → **Sheet Tab Names**.

### Required Sheet Tab Structure

Your Google Sheet must have tabs with these **exact names** (or configure custom names in Admin):

| Config Key | Default Tab Name | What It Contains |
|------------|-----------------|------------------|
| Categories | `Categories` | Category paths (one per row, `/` separated) |
| MASTER_Filters | `MASTER_Filters` | Filter default sets (replaces old MASTER_DEFAULTS tab) |
| Filters | `Filters` | Property names + allowed values (replaces old LEGAL tab) |
| Brands | `Brands` | Brand code, brand name, website |
| Products | `Products` | Product master list with Price (Col C) and Visibility (Col D) |
| PRODUCTS TO DO | `PRODUCTS TO DO` | SKUs to work on — SKU (A), Brand (B), Status (C), Visibility (D) |
| Events | `Events` | Event log |
| OUTPUT_Template | `OUTPUT_Template` | Template reference for the copy engine |
| OUTPUT_Work | `OUTPUT_Work` | Scratch pad — product submissions written here |
| Loading Dock | `Loading Dock` | Final export destination (generated by Google Apps Script) |

> **Note:** If your tabs have different names, update them in **Admin → Extra Settings → Sheet Tab Names** — no code changes needed.

### Tab Name Details

#### `Categories` Tab
- Row 1: Header (ignored)
- Row 2+: Full category paths using `/` separator
- Example: `Indoor Lights/Ceiling Lights/Downlights`

#### `Filters` Tab (formerly `LEGAL`)
- Row 1: Header (ignored)
- Column A: Property name (e.g., `Colour Temperature`)
- Columns B+: Allowed values (e.g., `2700K`, `3000K`, `4000K`)

#### `MASTER_Filters` Tab (formerly `MASTER_DEFAULTS`)
- Row 1: Filter default set names (column headers)
- Rows 2+: Property names belonging to each filter set

#### `PRODUCTS TO DO` Tab
- Row 1: Header (ignored)
- Col A: SKU
- Col B: Brand
- Col C: Status — must be `READY` to appear in the SKU selector
- Col D: Visibility — must be `1` or greater to appear

#### `Products` Tab
- Col A: SKU
- Col B: (varies)
- Col C: Price (used for retail price calculation)
- Col D: Visibility (`1` = visible/Y, anything else = N)

#### `Brands` Tab
- Row 1: Header (ignored)
- Col A: Brand code (short code)
- Col B: Brand full name
- Col C: Website URL

---

## STEP 8: Test Your Connection

1. Open your app → **Admin** page
2. Open **Connections & AI Setup** → **Google Sheets Connection**
3. Click **"Test Connection"**
4. You should see green checkmarks for:
   - ✅ Edge Function reachable
   - ✅ Credentials valid
   - ✅ Sheet accessible
   - ✅ Data loaded

---

## Sheet Tab Names — Quick Reference

| What the app calls it | Default Google Sheet tab name | Configurable? |
|----------------------|------------------------------|---------------|
| `SHEET_CATEGORIES` | `Categories` | ✅ Yes |
| `SHEET_MASTER_DEFAULTS` | `MASTER_Filters` | ✅ Yes |
| `SHEET_LEGAL` | `Filters` | ✅ Yes |
| `SHEET_BRANDS` | `Brands` | ✅ Yes |
| `SHEET_PRODUCTS` | `Products` | ✅ Yes |
| `SHEET_PRODUCTS_TODO` | `PRODUCTS TO DO` | ✅ Yes |
| `SHEET_EVENTS` | `Events` | ✅ Yes |
| `SHEET_OUTPUT_TEMPLATE` | `OUTPUT_Template` | ✅ Yes |
| `SHEET_OUTPUT_WORK` | `OUTPUT_Work` | ✅ Yes |
| `SHEET_LOADING_DOCK` | `Loading Dock` | ✅ Yes |

---

## Edge Function Actions Reference

The `google-sheets` Edge Function supports these actions:

| Action | Purpose | Required Fields |
|--------|---------|----------------|
| `read` | Load all sheet data (SKUs, categories, filters, brands) | `tabNames` |
| `write` | Append a row to OUTPUT_Work | `rowData`, `tabNames` |
| `write-categories` | Overwrite the Categories tab | `categoryPaths`, `tabNames` |
| `write-brands` | Overwrite the Brands tab | `brands[]`, `tabNames` |
| `write-legal` | Add a value to the Filters tab | `propertyName`, `value`, `tabNames` |

---

## Product Export Pipeline

The product submission flow:

```
Product Entry Form
      ↓
  Edge Function (action: "write")
      ↓
  OUTPUT_Work tab (scratch)
      ↓
  Google Apps Script onChange trigger (CopyEngine.gs)
      ↓
  Loading Dock tab (final 4-row export blocks)
```

### OUTPUT_Work Row Format

Submissions write a **2-row block** to OUTPUT_Work:

| Row | Col J Content |
|-----|--------------|
| Row 2 (Product) | `<p>{AI-Description}</p><p><strong>{AI-Data}<br/></p>` |
| Row 3 (Email) | Notes for Email Body |

**Pricing logic (resolved server-side):**
- Price → looked up from `Products` tab by SKU (Col C)
- Retail Price → `ROUND(RANDBETWEEN(1.3 × Price, 1.4 × Price), 0)`
- Visibility → `Y` if Products Col D = `1`, otherwise `N`

**Image requirements:**
- 8–20 images (JPEG, JPG, GIF, WebP, PNG)
- First image = thumbnail

---

## Supabase Secrets Required

| Secret | Where to set | Description |
|--------|-------------|-------------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Supabase → Edge Functions → Secrets | Full JSON key file contents |
| `GOOGLE_SHEET_ID` | Supabase → Edge Functions → Secrets | Sheet ID from URL |
| `SUPABASE_URL` | Auto-set by Supabase | Available automatically |
| `SUPABASE_ANON_KEY` | Auto-set by Supabase | Available automatically |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase | Used by `manage-ai-prompt` function |

---

## Troubleshooting

### "Cannot Read Secrets" / credentials missing
→ Redeploy the Edge Function (STEP 5) — secrets are loaded at deploy time.

### "Invalid JWT Signature"
→ The `private_key` in your JSON is malformed. Delete the key in Google Cloud Console, create a new one, and re-paste into Supabase Secrets.

### "CATEGORIES tab is empty or missing data"
→ The `Categories` tab exists but has no data from row 2 onwards. Add category paths starting at A2.

### Tab not found / empty data
→ Check **Admin → Extra Settings → Sheet Tab Names**. The name must match the Google Sheet tab exactly (case-sensitive).

### "useDefaults: true" returned
→ Either `GOOGLE_SERVICE_ACCOUNT_KEY` or `GOOGLE_SHEET_ID` is not set. Check Supabase → Edge Functions → Secrets.

### PGRST204 error (ai_prompts column missing)
→ Run the SQL in STEP 6 to add the `prompt_type` column to the `ai_prompts` table.

### SKU doesn't appear in selector
→ Check `PRODUCTS TO DO` tab: Status (Col C) must be `READY` and Visibility (Col D) must be `1` or greater.

---

## Security Notes

- Service Account key is stored **only** in Supabase Secrets (server-side encrypted)
- The frontend **never** sees your Google credentials
- CORS: The edge function reflects the request origin but requires a valid `apikey` header (sent automatically by the Supabase JS client)
- Rotate your service account key every 90–180 days in production

---

## New Project Checklist

- [ ] Google Cloud project created
- [ ] Google Sheets API enabled
- [ ] Google Drive API enabled
- [ ] Service Account created and JSON key downloaded
- [ ] Google Sheet shared with service account email
- [ ] `google-sheets` Edge Function deployed (GitHub Actions)
- [ ] `GOOGLE_SERVICE_ACCOUNT_KEY` added to Supabase Secrets
- [ ] `GOOGLE_SHEET_ID` added to Supabase Secrets
- [ ] Edge Function redeployed after adding secrets
- [ ] `ai_prompts` table created (with `prompt_type` column) in Supabase SQL Editor
- [ ] `manage-ai-prompt` Edge Function deployed
- [ ] `gemini-processor` Edge Function deployed
- [ ] Storage buckets created (`document-uploads-1` through `document-uploads-4`, `document-uploads-constant`)
- [ ] Sheet tab names configured in Admin panel (if different from defaults)
- [ ] Connection tested successfully in Admin panel

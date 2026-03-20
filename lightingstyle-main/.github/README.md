# GitHub Actions Workflows

This directory contains automated workflows for the Product Entry Hub project.

## Available Workflows

### Deploy Google Sheets Connection

**File:** `workflows/deploy-google-sheets.yml`

**Purpose:** Automatically deploys the Google Sheets Edge Function to your Supabase project.

**How to use:**
1. Go to the **Actions** tab in your GitHub repository
2. Select **"Deploy Google Sheets Connection"** from the left sidebar
3. Click **"Run workflow"**
4. Select your desired environment (production or staging)
5. Click **"Run workflow"** button
6. Wait for completion (typically 2-3 minutes)

**Required Secrets:**

Before running this workflow, you must set up the following GitHub Secrets in your repository:

- **`SUPABASE_ACCESS_TOKEN`** - Your Supabase personal access token
  - Get this from: https://supabase.com/dashboard/account/tokens
  
- **`SUPABASE_PROJECT_REF`** - Your Supabase project reference ID
  - Found in: Supabase Dashboard → Project Settings → General → Reference ID
  
- **`SUPABASE_DB_PASSWORD`** - Your Supabase database password
  - Set during project creation; you can reset it in Project Settings

**Setting up GitHub Secrets:**

1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **"New repository secret"**
4. Add each of the three secrets above
5. Click **"Add secret"**

**What it does:**

- ✓ Authenticates with Supabase
- ✓ Deploys the Google Sheets Edge Function
- ✓ Verifies the deployment was successful
- ✓ Provides deployment status report

**Troubleshooting:**

If the workflow fails:
1. Check the **Actions** tab for error messages
2. Verify all three secrets are set correctly in repository settings
3. Ensure your Supabase project is accessible
4. Check that `SUPABASE_PROJECT_REF` matches your actual project ID

## Manual Deployment Alternative

If you prefer to deploy manually without GitHub Actions:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_ID
supabase functions deploy google-sheets
```

However, using GitHub Actions is recommended as it eliminates the need for local CLI setup.

# GitHub Actions Setup for Google Sheets Connection

## Overview

This document explains how to set up GitHub Actions to automatically activate your Google Sheets connection. This eliminates the need for local CLI installation and provides a simple, click-only activation process.

## What is GitHub Actions?

GitHub Actions is a free CI/CD platform built into GitHub that allows you to automate tasks. In this case, we're using it to automatically deploy the Google Sheets Edge Function to your Supabase project.

**Benefits:**
- ✓ No local software installation required
- ✓ No terminal commands needed
- ✓ Secure handling of credentials
- ✓ Automatic deployment and verification
- ✓ One-time setup, then just click-to-deploy

## Prerequisites

Before running the workflow, you need:

1. A GitHub repository for your project
2. A Supabase project set up
3. Three pieces of information from Supabase (see below)

## Step 1: Gather Your Supabase Information

You'll need three pieces of information from Supabase:

### Get Your Supabase Access Token

1. Visit https://supabase.com/dashboard/account/tokens
2. Click **"Generate new token"**
3. Give it a name like "Product Entry Hub"
4. Copy the token (starts with `sbp_`)
5. **Keep this safe!** You'll need it in the next step

### Get Your Supabase Project Reference

1. Go to https://supabase.com/dashboard
2. Select your project
3. Click **Settings** (gear icon) → **General**
4. Look for **Reference ID** (e.g., `abcdefghijklmnop`)
5. Copy this value

### Get Your Database Password

This is the password you created when you initially set up your Supabase project. If you don't remember it:

1. Go to https://supabase.com/dashboard
2. Select your project
3. Click **Settings** → **Database**
4. Click **Reset password** to set a new one
5. Copy the new password

## Step 2: Add GitHub Secrets

Now you'll add these three pieces of information as GitHub Secrets.

1. Go to your GitHub repository
2. Click **Settings** (top navigation)
3. Click **Secrets and variables** → **Actions** (left sidebar)
4. Click **New repository secret**
5. Add the first secret:
   - **Name:** `SUPABASE_ACCESS_TOKEN`
   - **Value:** Paste the token you copied (starts with `sbp_`)
   - Click **Add secret**

6. Click **New repository secret** again
7. Add the second secret:
   - **Name:** `SUPABASE_PROJECT_REF`
   - **Value:** Paste your project reference ID (e.g., `abcdefghijklmnop`)
   - Click **Add secret**

8. Click **New repository secret** one more time
9. Add the third secret:
   - **Name:** `SUPABASE_DB_PASSWORD`
   - **Value:** Paste your database password
   - Click **Add secret**

**✓ Done!** You should now see all three secrets listed.

## Step 3: Run the Workflow

Now you can activate your Google Sheets connection with just a few clicks:

1. Go to your GitHub repository
2. Click the **Actions** tab (top navigation)
3. In the left sidebar, click **"Deploy Google Sheets Connection"**
4. Click the **"Run workflow"** button on the right
5. Select your environment:
   - **production** (recommended for most users)
   - **staging** (for testing)
6. Click **"Run workflow"** to start the deployment

**⏳ Wait for completion:** The workflow typically takes 2-3 minutes.

When it's done, you'll see a green checkmark (✓) indicating success.

## Step 4: Verify the Connection

After the workflow completes successfully:

1. Go back to your Product Entry Hub application
2. Navigate to the **Admin** page
3. Scroll to **Google Sheets Connection**
4. Click **"Test Connection"**
5. You should see a success message

That's it! Your Google Sheets connection is now active.

## What the Workflow Does

When you run the workflow, it:

1. **Authenticates** with Supabase using your access token
2. **Links** to your specific Supabase project
3. **Deploys** the Google Sheets Edge Function
4. **Verifies** the deployment was successful
5. **Reports** the status back to you

All of this happens automatically—no CLI commands needed!

## Troubleshooting

### Workflow Failed with "Authentication failed"

**Cause:** The GitHub Secrets are incorrect or missing.

**Solution:**
1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Verify all three secrets are present:
   - `SUPABASE_ACCESS_TOKEN` (starts with `sbp_`)
   - `SUPABASE_PROJECT_REF` (your project ID)
   - `SUPABASE_DB_PASSWORD` (your database password)
3. If any are missing or invalid, update them
4. Run the workflow again

### Workflow Failed with "Project not found"

**Cause:** The `SUPABASE_PROJECT_REF` is incorrect.

**Solution:**
1. Go to https://supabase.com/dashboard
2. Select your project
3. Click **Settings** → **General**
4. Copy the correct **Reference ID**
5. Go to GitHub → **Settings** → **Secrets and variables** → **Actions**
6. Update `SUPABASE_PROJECT_REF` with the correct value
7. Run the workflow again

### Workflow Failed with "Unable to connect to database"

**Cause:** The `SUPABASE_DB_PASSWORD` is incorrect.

**Solution:**
1. Go to https://supabase.com/dashboard
2. Select your project
3. Click **Settings** → **Database**
4. Click **Reset password**
5. Copy the new password
6. Go to GitHub → **Settings** → **Secrets and variables** → **Actions**
7. Update `SUPABASE_DB_PASSWORD` with the new password
8. Run the workflow again

### Test Connection Fails in Admin Panel

Even if the workflow succeeded, the Test Connection might fail. This usually means:

1. **Browser-based config:** Your credentials in the browser might be wrong
2. **Server-side config:** Edge Function deployed, but needs verification

Try:
1. Clear browser cache (Ctrl+Shift+Delete or Cmd+Shift+Delete)
2. Reload the Admin page
3. Click **Test Connection** again

If still failing:
1. Verify service account email has Editor access to your Google Sheet
2. Check that `GOOGLE_SERVICE_ACCOUNT_KEY` and `GOOGLE_SHEET_ID` are set in Supabase secrets
3. Go to Supabase Dashboard → Edge Functions → Logs to check for deployment errors

## Manual Alternative

If you prefer not to use GitHub Actions, you can deploy manually with the CLI:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy google-sheets
```

However, GitHub Actions is recommended as it requires no local setup.

## Security Notes

- **GitHub Secrets are encrypted** - They're never visible in logs or on screen
- **Access token is limited-scope** - It only allows deploying Edge Functions
- **No credentials in version control** - Nothing is committed to your repository
- **Automatic cleanup** - Old access tokens can be revoked anytime in Supabase dashboard

## Next Steps

After successful activation:

1. ✓ Test the connection in Admin panel
2. ✓ Load a product from the SKU Selector
3. ✓ Verify your real data loads (not mock data)
4. ✓ Submit a test product to verify write access
5. ✓ Check your OUTPUT sheet to confirm data was written

---

**Questions?** See [GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md) for complete documentation.

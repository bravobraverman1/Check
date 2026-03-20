# Edge Functions Audit

Date: 2026-03-12

## Summary

The project does not currently have a large number of unused Supabase Edge Functions.

Current functions fall into four groups:

- `google-sheets`: primary app backend for form, dock, SKU, MPN, CSV, and sheet writes
- `ai-jobs` + `ai-worker`: paired AI pipeline; they should stay split
- utility functions used directly by the UI: `image-proxy`, `cloudinary-sign-upload`, `manage-ai-prompt`, `billing-snapshot`
- maintenance functions: `cleanup-uploads`, `cleanup-cloudinary`

## Function Classification

### Keep

- `google-sheets`
  - Used heavily across form and Loading Dock flows.
  - This is the main operational backend.
  - It is very large and should be split internally over time, but not removed.

- `ai-jobs`
  - Used by the Gemini/AI job system.
  - Acts as orchestration and status API.

- `ai-worker`
  - Used by `ai-jobs` for actual processing.
  - Should remain separate from `ai-jobs` because it has different runtime behavior and workload.

- `image-proxy`
  - Used by `ProductViewDialog` and image preview flows.

- `cloudinary-sign-upload`
  - Used by Cloudinary upload flows in the frontend.

- `manage-ai-prompt`
  - Used by AI prompt admin/editor flows.

- `billing-snapshot`
  - Used by the billing/admin panel.

- `cleanup-uploads`
  - Used for storage cleanup of transient and form JSON files.

- `cleanup-cloudinary`
  - Not called by the main UI, but is a valid maintenance/scheduled function.
  - Keep if Cloudinary temp cleanup is still part of operations.

## Removed / Dead Paths

- Removed dead `form-views` cleanup path from `cleanup-uploads`.
  - The app now writes form JSON snapshots under `form-imports`.
  - No live code writes to `form-views`.

## Functions That Should Not Be Combined

- `ai-jobs` + `ai-worker`
  - Separation is intentional and useful.
  - Combining them would make reliability worse, not better.

- `cleanup-uploads` + `cleanup-cloudinary`
  - Similar naming, but different auth, targets, and failure modes.
  - Better kept separate.

- `image-proxy` + `cloudinary-sign-upload`
  - Different trust boundaries and responsibilities.
  - Should stay separate.

## Main Structural Risk

The real structural problem is not “too many edge functions”.

It is that `google-sheets` is a monolith and currently owns too many unrelated behaviors:

- sheet reads
- sheet writes
- Loading Dock actions
- OUTPUT_Work staging
- CSV generation
- MPN reservation/attachment/logging
- form email queueing

## Recommended Next Refactor

If we split anything, split `google-sheets` by domain, for example:

- `google-sheets-read`
- `google-sheets-write`
- `google-sheets-mpn`
- `google-sheets-dock`

That is a larger refactor and should be done intentionally, not mixed into unrelated UI changes.

## Notes From This Audit

- The failing GitHub runs in the screenshot were `Quality Gate` failures, not evidence that every deploy workflow or every edge function was broken.
- The specific dead code found during this audit was the old `form-views` storage cleanup/policy path.

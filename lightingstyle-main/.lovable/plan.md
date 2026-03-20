

# Product Entry App - Tree Category Dropdown Rebuild

## Overview
Replace the current 3-dropdown cascading category selector with a modern tree dropdown that supports multi-select of leaf nodes, a "Set Main Category" feature, search/filter, and dynamic loading from Google Sheets. Also polish the overall visual design.

---

## Changes Summary

### 1. New Component: `CategoryTreeDropdown`
Replace `CategorySelector.tsx` with a new tree dropdown component that:
- Opens a popover/dropdown panel showing the full category tree
- Parent nodes have expand/collapse chevrons and are **not selectable**
- Leaf nodes have checkboxes for multi-select
- Includes a search input at the top that filters the tree as you type
- Selected leaf categories appear as pill/badge chips below the trigger
- Each selected chip has a star icon button to mark it as MAIN (only one allowed)
- The MAIN category gets a visual "MAIN" pill tag or filled star
- Below the dropdown, show read-only preview fields:
  - "Main: Indoor Lights/Ceiling Lights/Downlights"
  - "Others: Outdoor Lights/Flood Lights; Decorative Lights/Neon Signs"

### 2. Update Category Data Model
- Keep `categoryData.ts` as the static fallback
- Add a helper function `buildFullPath(node)` that generates the slash-separated path for any leaf
- Add a flat leaf-path extraction utility for search filtering
- New state shape: `selectedPaths: string[]` and `mainPath: string`

### 3. Update `ProductEntryForm`
- Replace the 3 choice state variables (`choice1`, `choice2`, `choice3`) with:
  - `selectedCategories: string[]` (full path strings)
  - `mainCategory: string` (single full path)
- Update validation:
  - At least one category selected
  - Main category must be set (error: "Please set one selected category as the MAIN category.")
- Update form data output to include:
  - `MainCategoryPath` (single string)
  - `OtherCategoryPaths` (semicolon-separated, excluding main)
  - `AllCategoryPaths` (semicolon-separated, main first)
- Update submission payload columns to match the new headers (Timestamp, SKU, Title, MainCategoryPath, OtherCategoryPaths, AllCategoryPaths, image/spec columns)

### 4. Visual Polish
- Refine `FormSection` card styling: add `shadow-sm`, softer border radius (`rounded-lg`), consistent padding
- Ensure the page background uses a soft neutral tone (e.g., `bg-gray-50`)
- Consistent button and input styling with the primary accent color
- Category tree dropdown: clean indentation, smooth expand/collapse animations

### 5. Google Sheets Dynamic Loading (Placeholder)
- Add a `useCategories()` hook that attempts to fetch category data from a Google Sheets endpoint on page load
- Falls back to the static `categoryTree` if the fetch fails
- The hook returns `{ categories, isLoading, error }`
- The actual Google Sheets URL will be a placeholder/TODO -- the user will need to provide the Apps Script endpoint

---

## Technical Details

### CategoryTreeDropdown Component Structure
```
Popover (trigger = button showing selected count)
  +-- Search Input
  +-- ScrollArea (max-height constrained)
       +-- TreeNode (recursive)
            - If has children: chevron + label (click expands)
            - If leaf: checkbox + label (click selects)
  +-- Footer: "X selected"

Below popover:
  +-- Selected category pills with star/main toggle
  +-- Read-only preview: Main / Others
```

### Files to Create
- `src/components/CategoryTreeDropdown.tsx` -- the new tree dropdown
- `src/hooks/useCategories.ts` -- hook for dynamic category loading

### Files to Modify
- `src/components/ProductEntryForm.tsx` -- replace category state and validation
- `src/components/FormSection.tsx` -- minor style polish
- `src/pages/Index.tsx` -- minor style refinements
- `src/data/categoryData.ts` -- add path-building utilities
- `src/index.css` -- any global style tweaks

### Files to Remove
- `src/components/CategorySelector.tsx` -- replaced by `CategoryTreeDropdown`

### Validation Rules
- At least one leaf category must be selected
- Exactly one selected category must be marked as MAIN
- If categories are selected but no MAIN is set, show: "Please set one selected category as the MAIN category."

### Output Format
| Field | Format |
|---|---|
| MainCategoryPath | `Indoor Lights/Ceiling Lights/Downlights` |
| OtherCategoryPaths | `Outdoor Lights/Flood Lights;Decorative Lights/Neon Signs` |
| AllCategoryPaths | `Indoor Lights/Ceiling Lights/Downlights;Outdoor Lights/Flood Lights;Decorative Lights/Neon Signs` |


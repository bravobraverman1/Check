import { useState, useEffect } from "react";
import { CategoryLevel, categoryTree } from "@/data/categoryData";

// TODO: Replace with your Google Apps Script endpoint URL
const GOOGLE_SHEETS_CATEGORIES_URL = "";

export function useCategories() {
  const [categories, setCategories] = useState<CategoryLevel[]>(categoryTree);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!GOOGLE_SHEETS_CATEGORIES_URL) {
      // No endpoint configured, use static fallback
      return;
    }

    const fetchCategories = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(GOOGLE_SHEETS_CATEGORIES_URL);
        if (!res.ok) throw new Error("Failed to fetch categories");
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setCategories(data);
        }
      } catch (err) {
        console.error("Category fetch failed, using static fallback:", err);
        setError(err instanceof Error ? err.message : "Failed to load categories");
      } finally {
        setIsLoading(false);
      }
    };

    fetchCategories();
  }, []);

  return { categories, isLoading, error };
}

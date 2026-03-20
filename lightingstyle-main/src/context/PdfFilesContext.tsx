import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getTabScopedStorageKey } from "@/lib/browserTabScope";

interface PdfFilesContextValue {
  datasheetFile: File | null;
  setDatasheetFile: (f: File | null) => void;
  websitePdfFile: File | null;
  setWebsitePdfFile: (f: File | null) => void;
}

const PdfFilesContext = createContext<PdfFilesContextValue | null>(null);

const PDF_DB_NAME = "lighting-style-pdf-cache";
const PDF_STORE_NAME = "pdf_files";
const DATASHEET_KEY = "datasheet";
const WEBSITE_KEY = "website";

interface PersistedPdfRecord {
  key: string;
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

function getIndexedDb(): IDBFactory | null {
  if (typeof window === "undefined") return null;
  return window.indexedDB ?? null;
}

function openPdfDb(): Promise<IDBDatabase | null> {
  const indexedDb = getIndexedDb();
  if (!indexedDb) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      const request = indexedDb.open(PDF_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PDF_STORE_NAME)) {
          db.createObjectStore(PDF_STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readPdfFromDb(key: string): Promise<File | null> {
  const db = await openPdfDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PDF_STORE_NAME, "readonly");
      const store = tx.objectStore(PDF_STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const record = request.result as PersistedPdfRecord | undefined;
        if (!record || !record.blob) {
          resolve(null);
          return;
        }
        resolve(new File([record.blob], record.name, {
          type: record.type || "application/pdf",
          lastModified: record.lastModified || Date.now(),
        }));
      };
      request.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
      tx.onabort = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writePdfToDb(key: string, file: File | null): Promise<void> {
  const db = await openPdfDb();
  if (!db) return;

  const arrayBuffer = file ? await file.arrayBuffer() : null;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_STORE_NAME, "readwrite");
      const store = tx.objectStore(PDF_STORE_NAME);

      if (!file || !arrayBuffer) {
        store.delete(key);
      } else {
        const record: PersistedPdfRecord = {
          key,
          name: file.name,
          type: file.type || "application/pdf",
          lastModified: file.lastModified || Date.now(),
          blob: new Blob([arrayBuffer], { type: file.type || "application/pdf" }),
        };
        store.put(record);
      }

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export function PdfFilesProvider({ children }: { children: ReactNode }) {
  const [datasheetFile, setDatasheetFileState] = useState<File | null>(null);
  const [websitePdfFile, setWebsitePdfFileState] = useState<File | null>(null);
  const datasheetTouchedRef = useRef(false);
  const websiteTouchedRef = useRef(false);
  const datasheetStorageKey = useMemo(() => getTabScopedStorageKey(DATASHEET_KEY), []);
  const websiteStorageKey = useMemo(() => getTabScopedStorageKey(WEBSITE_KEY), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [restoredDatasheet, restoredWebsite] = await Promise.all([
        readPdfFromDb(datasheetStorageKey),
        readPdfFromDb(websiteStorageKey),
      ]);
      if (cancelled) return;

      if (!datasheetTouchedRef.current) {
        setDatasheetFileState((current) => current || restoredDatasheet);
      }
      if (!websiteTouchedRef.current) {
        setWebsitePdfFileState((current) => current || restoredWebsite);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [datasheetStorageKey, websiteStorageKey]);

  const setDatasheetFile = useCallback((file: File | null) => {
    datasheetTouchedRef.current = true;
    setDatasheetFileState(file);
    void writePdfToDb(datasheetStorageKey, file);
  }, [datasheetStorageKey]);

  const setWebsitePdfFile = useCallback((file: File | null) => {
    websiteTouchedRef.current = true;
    setWebsitePdfFileState(file);
    void writePdfToDb(websiteStorageKey, file);
  }, [websiteStorageKey]);

  return (
    <PdfFilesContext.Provider value={{ datasheetFile, setDatasheetFile, websitePdfFile, setWebsitePdfFile }}>
      {children}
    </PdfFilesContext.Provider>
  );
}

export function usePdfFiles() {
  const ctx = useContext(PdfFilesContext);
  if (!ctx) throw new Error("usePdfFiles must be used inside PdfFilesProvider");
  return ctx;
}

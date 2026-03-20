import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { getTabScopedStorageKey } from "@/lib/browserTabScope";
import { PdfFilesProvider, usePdfFiles } from "@/context/PdfFilesContext";

interface PersistedPdfRecord {
  key: string;
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

const DATASHEET_STORAGE_KEY = getTabScopedStorageKey("datasheet");
const WEBSITE_STORAGE_KEY = getTabScopedStorageKey("website");

function createIndexedDbMock(seedRecords: PersistedPdfRecord[]) {
  const records = new Map(seedRecords.map((record) => [record.key, record]));
  const pendingReads: Array<{
    request: { result?: PersistedPdfRecord; onsuccess?: (() => void) | null };
    tx: { oncomplete?: (() => void) | null };
    result?: PersistedPdfRecord;
  }> = [];

  const db = {
    objectStoreNames: {
      contains: (name: string) => name === "pdf_files",
    },
    createObjectStore: () => undefined,
    transaction: () => {
      const tx: { oncomplete?: (() => void) | null } = {};
      return {
        ...tx,
        objectStore: () => ({
          get: (key: string) => {
            const request: { result?: PersistedPdfRecord; onsuccess?: (() => void) | null } = {};
            pendingReads.push({
              request,
              tx,
              result: records.get(key),
            });
            return request;
          },
          put: (record: PersistedPdfRecord) => {
            records.set(record.key, record);
            queueMicrotask(() => tx.oncomplete?.());
          },
          delete: (key: string) => {
            records.delete(key);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
    },
    close: () => undefined,
  } as unknown as IDBDatabase;

  return {
    indexedDb: {
      open: () => {
        const request: {
          result: IDBDatabase;
          onsuccess?: (() => void) | null;
          onerror?: (() => void) | null;
          onupgradeneeded?: (() => void) | null;
        } = { result: db };
        queueMicrotask(() => request.onsuccess?.());
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory,
    pendingReadCount: () => pendingReads.length,
    hasRecord: (key: string) => records.has(key),
    resolveReads: async () => {
      const reads = pendingReads.splice(0);
      await act(async () => {
        for (const pending of reads) {
          pending.request.result = pending.result;
          pending.request.onsuccess?.();
          pending.tx.oncomplete?.();
        }
      });
    },
  };
}

function PdfFilesProbe() {
  const { datasheetFile, setDatasheetFile, websitePdfFile, setWebsitePdfFile } = usePdfFiles();

  return (
    <div>
      <div data-testid="datasheet-name">{datasheetFile?.name ?? ""}</div>
      <div data-testid="website-name">{websitePdfFile?.name ?? ""}</div>
      <button
        type="button"
        onClick={() => {
          setDatasheetFile(null);
          setWebsitePdfFile(null);
        }}
      >
        Clear PDFs
      </button>
    </div>
  );
}

describe("PdfFilesProvider", () => {
  const originalIndexedDb = window.indexedDB;

  afterEach(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      writable: true,
      value: originalIndexedDb,
    });
  });

  it("does not restore stale cached PDFs after the form explicitly clears them", async () => {
    const staleDatasheet = new File(["datasheet"], "stale-datasheet.pdf", { type: "application/pdf" });
    const staleWebsite = new File(["website"], "stale-website.pdf", { type: "application/pdf" });
    const indexedDbMock = createIndexedDbMock([
      {
        key: DATASHEET_STORAGE_KEY,
        name: staleDatasheet.name,
        type: staleDatasheet.type,
        lastModified: staleDatasheet.lastModified,
        blob: staleDatasheet,
      },
      {
        key: WEBSITE_STORAGE_KEY,
        name: staleWebsite.name,
        type: staleWebsite.type,
        lastModified: staleWebsite.lastModified,
        blob: staleWebsite,
      },
    ]);

    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      writable: true,
      value: indexedDbMock.indexedDb,
    });

    render(
      <PdfFilesProvider>
        <PdfFilesProbe />
      </PdfFilesProvider>,
    );

    await waitFor(() => {
      expect(indexedDbMock.pendingReadCount()).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear PDFs" }));

    await indexedDbMock.resolveReads();

    await waitFor(() => {
      expect(screen.getByTestId("datasheet-name")).toHaveTextContent("");
      expect(screen.getByTestId("website-name")).toHaveTextContent("");
      expect(indexedDbMock.hasRecord(DATASHEET_STORAGE_KEY)).toBe(false);
      expect(indexedDbMock.hasRecord(WEBSITE_STORAGE_KEY)).toBe(false);
    });
  });
});

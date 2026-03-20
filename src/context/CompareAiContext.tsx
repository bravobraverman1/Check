import React, { createContext, useContext, useRef, useState } from "react";

export interface ComparisonRow {
  field: string;
  supplier: string;
  ls: string;
}

export interface CompareProgressState {
  progress: number;
  chunksDone: number;
  chunksTotal: number;
  chunksError: number;
}

interface CompareAiState {
  comparing: boolean;
  setComparing: (v: boolean) => void;
  rows: ComparisonRow[];
  setRows: (r: ComparisonRow[]) => void;
  debugPrompt: string;
  setDebugPrompt: (s: string) => void;
  debugOutput: string;
  setDebugOutput: (s: string) => void;
  compareComplete: boolean;
  setCompareComplete: (v: boolean) => void;
  additionalInstructions: string;
  setAdditionalInstructions: (s: string) => void;
  compareAttempted: boolean;
  setCompareAttempted: (v: boolean) => void;
  noReportableDifferences: boolean;
  setNoReportableDifferences: (v: boolean) => void;
  compareProgress: CompareProgressState;
  setCompareProgress: (v: CompareProgressState | ((prev: CompareProgressState) => CompareProgressState)) => void;
  comparePhase: string;
  setComparePhase: (s: string) => void;
  compareStageTags: string[];
  setCompareStageTags: (tags: string[]) => void;
  supplierFileName: string | null;
  setSupplierFileName: (v: string | null) => void;
  lsFileName: string | null;
  setLsFileName: (v: string | null) => void;
  supplierData: ArrayBuffer | null;
  setSupplierData: (v: ArrayBuffer | null) => void;
  lsData: ArrayBuffer | null;
  setLsData: (v: ArrayBuffer | null) => void;
  sku: string;
  setSku: (s: string) => void;
  leftPaneWidthPct: number;
  setLeftPaneWidthPct: (n: number) => void;
  cancelledRef: React.MutableRefObject<boolean>;
}

const CompareAiContext = createContext<CompareAiState | null>(null);

export function CompareAiProvider({ children }: { children: React.ReactNode }) {
  const [comparing, setComparing] = useState(false);
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [debugPrompt, setDebugPrompt] = useState("");
  const [debugOutput, setDebugOutput] = useState("");
  const [compareComplete, setCompareComplete] = useState(false);
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [compareAttempted, setCompareAttempted] = useState(false);
  const [noReportableDifferences, setNoReportableDifferences] = useState(false);
  const [compareProgress, setCompareProgress] = useState<CompareProgressState>({
    progress: 0,
    chunksDone: 0,
    chunksTotal: 0,
    chunksError: 0,
  });
  const [comparePhase, setComparePhase] = useState("Idle");
  const [compareStageTags, setCompareStageTags] = useState<string[]>([]);
  const [supplierFileName, setSupplierFileName] = useState<string | null>(null);
  const [lsFileName, setLsFileName] = useState<string | null>(null);
  const [supplierData, setSupplierData] = useState<ArrayBuffer | null>(null);
  const [lsData, setLsData] = useState<ArrayBuffer | null>(null);
  const [sku, setSku] = useState("");
  const [leftPaneWidthPct, setLeftPaneWidthPct] = useState(50);
  const cancelledRef = useRef(false);

  return (
    <CompareAiContext.Provider
      value={{
        comparing,
        setComparing,
        rows,
        setRows,
        debugPrompt,
        setDebugPrompt,
        debugOutput,
        setDebugOutput,
        compareComplete,
        setCompareComplete,
        additionalInstructions,
        setAdditionalInstructions,
        compareAttempted,
        setCompareAttempted,
        noReportableDifferences,
        setNoReportableDifferences,
        compareProgress,
        setCompareProgress,
        comparePhase,
        setComparePhase,
        compareStageTags,
        setCompareStageTags,
        supplierFileName,
        setSupplierFileName,
        lsFileName,
        setLsFileName,
        supplierData,
        setSupplierData,
        lsData,
        setLsData,
        sku,
        setSku,
        leftPaneWidthPct,
        setLeftPaneWidthPct,
        cancelledRef,
      }}
    >
      {children}
    </CompareAiContext.Provider>
  );
}

export function useCompareAi() {
  const ctx = useContext(CompareAiContext);
  if (!ctx) throw new Error("useCompareAi must be inside CompareAiProvider");
  return ctx;
}

/**
 * AI Prompt Versions
 *
 * All prompt versions are stored here in code (version-controlled).
 * To add a new version, append an entry to the versions array below.
 */

export interface AIPromptVersion {
  version: number;
  description: string;
  content: string;
  createdAt: string; // ISO string
}

export interface AIPromptHistory {
  currentVersion: number;
  versions: AIPromptVersion[];
}

export const aiPromptHistory: AIPromptHistory = {
  currentVersion: 0,
  versions: [],
};

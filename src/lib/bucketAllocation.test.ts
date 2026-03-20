import { beforeEach, describe, expect, it, vi } from "vitest";

const bucketAllocationMocks = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  uploadMock: vi.fn(),
  fromMock: vi.fn(),
  ensureEdgeAuthSessionMock: vi.fn(async () => undefined),
  getEdgeAuthTroubleshootingMessageMock: vi.fn(() => null),
}));

vi.mock("@/config/publicEnv", () => ({
  SUPABASE_ANON_KEY: "sb_publishable_test_key",
}));

vi.mock("@/lib/edgeAuth", () => ({
  ensureEdgeAuthSession: bucketAllocationMocks.ensureEdgeAuthSessionMock,
  getEdgeAuthTroubleshootingMessage: bucketAllocationMocks.getEdgeAuthTroubleshootingMessageMock,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: bucketAllocationMocks.getSessionMock,
    },
    storage: {
      from: bucketAllocationMocks.fromMock,
    },
  },
}));

describe("bucketAllocation upload auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bucketAllocationMocks.fromMock.mockReturnValue({
      upload: bucketAllocationMocks.uploadMock,
    });
    bucketAllocationMocks.getSessionMock.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    bucketAllocationMocks.uploadMock.mockResolvedValue({ error: null });
  });

  it("requires a real session before publishable-key storage uploads", async () => {
    const { uploadFilesToBucket } = await import("@/lib/bucketAllocation");

    await expect(
      uploadFilesToBucket("document-uploads-1", [
        { label: "datasheet", file: new File(["pdf"], "sample.pdf", { type: "application/pdf" }) },
      ]),
    ).rejects.toThrow(/Anonymous auth is required/i);
  });

  it("normalizes raw storage fetch failures into a clearer upload error", async () => {
    bucketAllocationMocks.getSessionMock.mockResolvedValue({
      data: { session: { access_token: "token" } },
      error: null,
    });
    bucketAllocationMocks.uploadMock.mockRejectedValue(new Error("Failed to fetch"));

    const { uploadFilesToBucket } = await import("@/lib/bucketAllocation");

    await expect(
      uploadFilesToBucket("document-uploads-1", [
        { label: "datasheet", file: new File(["pdf"], "sample.pdf", { type: "application/pdf" }) },
      ]),
    ).rejects.toThrow(/Could not upload PDFs to Supabase Storage/i);
  });
});

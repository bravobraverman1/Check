import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  clearDockFormSnapshotsForTest,
} from "@/lib/dockFormSnapshots";
import {
  clearTestState,
  ensureStorageApis,
  formAdminMocks,
  renderWithQuery,
} from "@/test/form-admin.smoke.shared";

let ProductEntryForm: () => JSX.Element;

function renderForm() {
  return renderWithQuery(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProductEntryForm />
    </MemoryRouter>,
  );
}

async function chooseSku() {
  fireEvent.click(await screen.findByRole("button", { name: "Pick SKU" }));
}

async function fillMinimumValidForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Pick SKU" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick Category" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Image" }));
  fireEvent.click(await screen.findByRole("button", { name: "Fill Mandatory Filter" }));
  fireEvent.change(screen.getByLabelText(/^Title/i), {
    target: { value: "Current Form Title" },
  });
  fireEvent.change(screen.getByLabelText(/AI-Data/i), {
    target: { value: "CRI: 90\nColour: WHITE" },
  });
  fireEvent.change(screen.getByLabelText(/AI-Description/i), {
    target: { value: "Valid description for current form actions." },
  });
}

function getFooterButton(name: "View" | "Send By Email" | "Download"): HTMLButtonElement {
  const button = screen.getAllByRole("button", { name, hidden: true }).find((candidate) => {
    return candidate.className.includes("rounded-full");
  });
  if (!button) {
    throw new Error(`Could not find footer button: ${name}`);
  }
  return button as HTMLButtonElement;
}

function getDialogButton(name: "Download" | "Cancel" | "Load CSV" | "Overwrite" | "Submit Anyway"): HTMLButtonElement {
  const button = screen.getAllByRole("button", { name }).find((candidate) => {
    return !candidate.className.includes("rounded-full");
  });
  if (!button) {
    throw new Error(`Could not find dialog button: ${name}`);
  }
  return button as HTMLButtonElement;
}

describe("ProductEntryForm current actions", () => {
  beforeAll(async () => {
    ensureStorageApis();
    ({ ProductEntryForm } = await import("@/components/ProductEntryForm"));
  });

  beforeEach(() => {
    clearTestState();
    clearDockFormSnapshotsForTest();
  });

  it("keeps View, Send By Email, and Download disabled until a SKU is selected", async () => {
    renderForm();

    expect(getFooterButton("View")).toBeDisabled();
    expect(getFooterButton("Send By Email")).toBeDisabled();
    expect(getFooterButton("Download")).toBeDisabled();

    await chooseSku();

    await waitFor(() => {
      expect(getFooterButton("View")).not.toBeDisabled();
      expect(getFooterButton("Send By Email")).not.toBeDisabled();
      expect(getFooterButton("Download")).not.toBeDisabled();
    });
  });

  it("resolves brand and price from sheet lookup by SKU", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchSkuSheetDetails).mockResolvedValueOnce({
      brand: "Florabelle",
      price: "304.00",
      visibility: "1",
    });

    renderForm();

    await chooseSku();

    await waitFor(() => {
      expect(screen.getByDisplayValue("Florabelle")).toBeInTheDocument();
      expect(screen.getByDisplayValue("$304.00")).toBeInTheDocument();
    });
  });

  it("blocks Send By Email when required fields are missing", async () => {
    const api = await import("@/lib/api");
    renderForm();

    await chooseSku();
    fireEvent.click(getFooterButton("Send By Email"));

    await waitFor(() => {
      expect(vi.mocked(api.sendProductByEmail)).not.toHaveBeenCalled();
      expect(formAdminMocks.toastMock).toHaveBeenCalledWith(expect.objectContaining({
        variant: "destructive",
        title: expect.stringMatching(/^Cannot send email/),
      }));
    });
  });

  it("sends email through the current direct form action path", async () => {
    const api = await import("@/lib/api");
    renderForm();
    await fillMinimumValidForm();

    fireEvent.click(getFooterButton("Send By Email"));

    await waitFor(() => {
      expect(vi.mocked(api.sendProductByEmail)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.markSkuComplete)).toHaveBeenCalledWith("SKU-1", expect.any(Number));
      expect(formAdminMocks.toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Sent By Email",
      }));
    });
  });

  it("opens View without touching MPN resolution", async () => {
    const api = await import("@/lib/api");
    renderForm();
    await fillMinimumValidForm();

    fireEvent.click(getFooterButton("View"));

    await waitFor(() => {
      expect(vi.mocked(api.resolveFormMpnStateDirect)).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "Current Form Title" })).toBeInTheDocument();
    });

    fireEvent.click(getFooterButton("View"));

    await waitFor(() => {
      expect(vi.mocked(api.resolveFormMpnStateDirect)).not.toHaveBeenCalled();
    });
  });

  it("opens the download confirmation and downloads the current form CSV", async () => {
    const api = await import("@/lib/api");
    renderForm();
    await fillMinimumValidForm();

    fireEvent.click(getFooterButton("Download"));

    expect(screen.getByText("Download CSV?")).toBeInTheDocument();
    expect(screen.getByText(/mark the SKU as COMPLETE in Products To Do/i)).toBeInTheDocument();

    fireEvent.click(getDialogButton("Download"));

    await waitFor(() => {
      expect(vi.mocked(api.downloadProductCsv)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.markSkuComplete)).toHaveBeenCalledWith("SKU-1", expect.any(Number));
      expect(formAdminMocks.toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Downloaded",
      }));
    });
  });

  it("marks the SKU as COMPLETE after a confirmed download", async () => {
    const api = await import("@/lib/api");
    renderForm();
    await fillMinimumValidForm();

    fireEvent.click(getFooterButton("Download"));
    fireEvent.click(getDialogButton("Download"));

    await waitFor(() => {
      expect(vi.mocked(api.markSkuComplete)).toHaveBeenCalledWith("SKU-1", expect.any(Number));
      expect(formAdminMocks.toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Downloaded",
      }));
    });
  });
});

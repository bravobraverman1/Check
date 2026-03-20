import React from "react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import {
  clearTestState,
  ensureStorageApis,
  formAdminMocks,
} from "@/test/form-admin.smoke.shared";

let Admin: (props: Record<string, unknown>) => JSX.Element;

describe("Admin smoke coverage", () => {
  beforeAll(async () => {
    ensureStorageApis();
    ({ default: Admin } = await import("@/pages/Admin"));
  });

  beforeEach(() => {
    clearTestState();
  });

  it("renders Admin tab and executes core action buttons", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={["/admin"]}
      >
        <QueryClientProvider client={queryClient}>
          <Admin />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("CompareDatasheets Stub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Tab Names/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Test Connection/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Force Refresh Data/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save Tab Names/i }));
    await waitFor(() => {
      expect(formAdminMocks.broadcastConfigChangeMock).toHaveBeenCalled();
      expect(formAdminMocks.syncGoogleSheetQueriesMock).toHaveBeenCalled();
    });

    const modelSelect = screen.getByRole("combobox");
    fireEvent.change(modelSelect, { target: { value: "gemini-2.5-pro" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => {
      expect(formAdminMocks.updateGeminiConfigMock).toHaveBeenCalledWith({ model: "gemini-2.5-pro" });
    });

    fireEvent.click(screen.getByRole("button", { name: /Test Connection/i }));
    await waitFor(() => {
      expect(formAdminMocks.invokeGoogleSheetsFunctionMock).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: /Force Refresh Data/i }));
    await waitFor(() => {
      expect(formAdminMocks.syncGoogleSheetQueriesMock).toHaveBeenCalled();
    });
  });
});

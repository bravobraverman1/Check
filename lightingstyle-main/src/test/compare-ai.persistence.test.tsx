import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

import { CompareAiProvider, useCompareAi } from "@/context/CompareAiContext";

function CompareRouteProbe() {
  const navigate = useNavigate();
  const {
    comparing,
    setComparing,
    rows,
    setRows,
    comparePhase,
    setComparePhase,
    compareComplete,
    setCompareComplete,
    cancelledRef,
  } = useCompareAi();

  return (
    <div>
      <div data-testid="phase">{comparePhase}</div>
      <div data-testid="status">{comparing ? "running" : "idle"}</div>
      <div data-testid="rows">{rows.length}</div>
      <div data-testid="complete">{compareComplete ? "yes" : "no"}</div>
      <button
        type="button"
        onClick={() => {
          cancelledRef.current = false;
          setComparing(true);
          setCompareComplete(false);
          setComparePhase("Running compare");
          setRows([]);
          setTimeout(() => {
            if (cancelledRef.current) return;
            setRows([{ field: "Colour", supplier: "Black", ls: "Black" }]);
            setComparePhase("Comparison complete");
            setCompareComplete(true);
            setComparing(false);
          }, 25);
        }}
      >
        Start compare
      </button>
      <button type="button" onClick={() => navigate("/admin")}>
        Go Admin
      </button>
    </div>
  );
}

function AdminRouteProbe() {
  const navigate = useNavigate();
  const { comparing, rows, comparePhase, compareComplete } = useCompareAi();

  return (
    <div>
      <div data-testid="admin-phase">{comparePhase}</div>
      <div data-testid="admin-status">{comparing ? "running" : "idle"}</div>
      <div data-testid="admin-rows">{rows.length}</div>
      <div data-testid="admin-complete">{compareComplete ? "yes" : "no"}</div>
      <button type="button" onClick={() => navigate("/test")}>
        Back To Compare
      </button>
    </div>
  );
}

describe("Compare AI session persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps compare progress and results alive across route changes in the same session", () => {
    vi.useFakeTimers();

    render(
      <CompareAiProvider>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          initialEntries={["/test"]}
        >
          <Routes>
            <Route path="/test" element={<CompareRouteProbe />} />
            <Route path="/admin" element={<AdminRouteProbe />} />
          </Routes>
        </MemoryRouter>
      </CompareAiProvider>,
    );

    fireEvent.click(screen.getByText("Start compare"));
    expect(screen.getByTestId("status").textContent).toBe("running");
    expect(screen.getByTestId("phase").textContent).toBe("Running compare");

    fireEvent.click(screen.getByText("Go Admin"));
    expect(screen.getByTestId("admin-status").textContent).toBe("running");
    expect(screen.getByTestId("admin-rows").textContent).toBe("0");

    act(() => {
      vi.advanceTimersByTime(30);
    });

    expect(screen.getByTestId("admin-status").textContent).toBe("idle");
    expect(screen.getByTestId("admin-phase").textContent).toBe("Comparison complete");
    expect(screen.getByTestId("admin-rows").textContent).toBe("1");
    expect(screen.getByTestId("admin-complete").textContent).toBe("yes");

    fireEvent.click(screen.getByText("Back To Compare"));
    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(screen.getByTestId("phase").textContent).toBe("Comparison complete");
    expect(screen.getByTestId("rows").textContent).toBe("1");
    expect(screen.getByTestId("complete").textContent).toBe("yes");
  });
});

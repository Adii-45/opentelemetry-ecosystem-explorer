/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { JavaReleaseComparisonPage } from "./java-release-comparison-page";
import type { InstrumentationDiff, ReleaseDiff } from "./utils/release-diff";

vi.mock("@/hooks/use-javaagent-data", () => ({
  useVersions: vi.fn(),
}));

vi.mock("./hooks/use-release-comparison", () => ({
  useReleaseComparison: vi.fn(),
}));

vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button>Back</button>,
}));

import { useVersions } from "@/hooks/use-javaagent-data";
import { useReleaseComparison } from "./hooks/use-release-comparison";

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

async function selectStatus(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: "Status" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

function renderPage(initialPath = "/java-agent/releases?from=1.0.0&to=2.0.0") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/java-agent/releases" element={<JavaReleaseComparisonPage />} />
      </Routes>
      <LocationDisplay />
    </MemoryRouter>
  );
}

const mockVersions = {
  data: {
    versions: [
      { version: "2.0.0", is_latest: true },
      { version: "1.0.0", is_latest: false },
    ],
  },
  loading: false,
  error: null,
};

function makeInstrumentation(
  id: string,
  status: InstrumentationDiff["status"]
): InstrumentationDiff {
  return {
    id,
    displayName: `${id} Display`,
    status,
    telemetryDiff: { metrics: [], spans: [] },
  };
}

function makeDiff(): ReleaseDiff {
  return {
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    instrumentations: [
      makeInstrumentation("added-1", "added"),
      makeInstrumentation("changed-1", "changed"),
      makeInstrumentation("removed-1", "removed"),
      makeInstrumentation("unchanged-1", "unchanged"),
    ],
    aggregateMetrics: [],
    totals: { added: 1, changed: 1, removed: 1 },
  };
}

describe("JavaReleaseComparisonPage status filter", () => {
  beforeEach(() => {
    vi.mocked(useVersions).mockReturnValue(mockVersions);
    vi.mocked(useReleaseComparison).mockReturnValue({
      diff: makeDiff(),
      loading: false,
      error: null,
    });
  });

  it("shows all changed modules and correct summary counts when no filter is applied", () => {
    renderPage();

    expect(screen.getByText("added-1 Display")).toBeInTheDocument();
    expect(screen.getByText("changed-1 Display")).toBeInTheDocument();
    expect(screen.getByText("removed-1 Display")).toBeInTheDocument();
    expect(screen.queryByText("unchanged-1 Display")).not.toBeInTheDocument();

    const addedTile = screen.getByText("Modules Added").previousSibling as HTMLElement;
    expect(addedTile.textContent).toBe("1");
  });

  it("narrows the module list and updates the URL when a status is selected", async () => {
    const user = userEvent.setup();
    renderPage();

    await selectStatus(user, "Added");

    expect(screen.getByText("added-1 Display")).toBeInTheDocument();
    expect(screen.queryByText("changed-1 Display")).not.toBeInTheDocument();
    expect(screen.queryByText("removed-1 Display")).not.toBeInTheDocument();

    expect(screen.getByTestId("location").textContent).toContain("status=added");
  });

  it("switching the selection replaces the previous filter rather than combining with it", async () => {
    const user = userEvent.setup();
    renderPage();

    await selectStatus(user, "Added");
    expect(screen.getByTestId("location").textContent).toContain("status=added");

    await selectStatus(user, "Removed");

    expect(screen.getByTestId("location").textContent).toContain("status=removed");
    expect(screen.getByTestId("location").textContent).not.toContain("added");
    expect(screen.queryByText("added-1 Display")).not.toBeInTheDocument();
    expect(screen.getByText("removed-1 Display")).toBeInTheDocument();
  });

  it("selecting 'All Statuses' clears the status param and restores the full list", async () => {
    const user = userEvent.setup();
    renderPage("/java-agent/releases?from=1.0.0&to=2.0.0&status=added");

    expect(screen.getByRole("button", { name: "Status" })).toHaveTextContent("Added");

    await selectStatus(user, "All Statuses");

    expect(screen.getByTestId("location").textContent).not.toContain("status=");
    expect(screen.getByText("added-1 Display")).toBeInTheDocument();
    expect(screen.getByText("changed-1 Display")).toBeInTheDocument();
    expect(screen.getByText("removed-1 Display")).toBeInTheDocument();
  });

  it("does not change the Changes Summary stat tiles when a filter is applied", async () => {
    const user = userEvent.setup();
    renderPage();

    const addedTile = screen.getByText("Modules Added").previousSibling as HTMLElement;
    const changedTile = screen.getByText("Modules Changed").previousSibling as HTMLElement;
    const removedTile = screen.getByText("Modules Removed").previousSibling as HTMLElement;
    const before = [addedTile.textContent, changedTile.textContent, removedTile.textContent];

    await selectStatus(user, "Added");

    const after = [addedTile.textContent, changedTile.textContent, removedTile.textContent];
    expect(after).toEqual(before);
  });

  it("pre-filters the list when the status param is present on initial load", () => {
    renderPage("/java-agent/releases?from=1.0.0&to=2.0.0&status=removed");

    expect(screen.queryByText("added-1 Display")).not.toBeInTheDocument();
    expect(screen.queryByText("changed-1 Display")).not.toBeInTheDocument();
    expect(screen.getByText("removed-1 Display")).toBeInTheDocument();
  });

  it("degrades gracefully to showing everything when the status param is invalid", () => {
    renderPage("/java-agent/releases?from=1.0.0&to=2.0.0&status=bogus");

    expect(screen.getByText("added-1 Display")).toBeInTheDocument();
    expect(screen.getByText("changed-1 Display")).toBeInTheDocument();
    expect(screen.getByText("removed-1 Display")).toBeInTheDocument();
  });

  it("shows the filtered-empty state when the selection matches nothing, distinct from no-changes", async () => {
    const user = userEvent.setup();
    vi.mocked(useReleaseComparison).mockReturnValue({
      diff: {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        instrumentations: [makeInstrumentation("added-1", "added")],
        aggregateMetrics: [],
        totals: { added: 1, changed: 0, removed: 0 },
      },
      loading: false,
      error: null,
    });
    renderPage();

    await selectStatus(user, "Removed");

    expect(screen.getByText("No modules match the selected filters.")).toBeInTheDocument();
    expect(
      screen.queryByText("No changes found in telemetry or configuration.")
    ).not.toBeInTheDocument();
  });

  it("shows the no-changes empty state when there are no changes at all and no filter is active", () => {
    vi.mocked(useReleaseComparison).mockReturnValue({
      diff: {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        instrumentations: [makeInstrumentation("unchanged-1", "unchanged")],
        aggregateMetrics: [],
        totals: { added: 0, changed: 0, removed: 0 },
      },
      loading: false,
      error: null,
    });

    renderPage();

    expect(screen.getByText("No changes found in telemetry or configuration.")).toBeInTheDocument();
  });

  it("preserves status filter parameter when auto-filling missing from/to versions", () => {
    renderPage("/java-agent/releases?status=added");

    expect(screen.getByTestId("location").textContent).toContain("status=added");
    expect(screen.getByTestId("location").textContent).toContain("from=1.0.0");
    expect(screen.getByTestId("location").textContent).toContain("to=2.0.0");
  });

  it("preserves status filter parameter when changing version selection", async () => {
    const user = userEvent.setup();
    renderPage("/java-agent/releases?from=1.0.0&to=2.0.0&status=added");

    const selectors = screen.getAllByRole("combobox");
    await user.selectOptions(selectors[0], "2.0.0");

    expect(screen.getByTestId("location").textContent).toContain("status=added");
  });
});

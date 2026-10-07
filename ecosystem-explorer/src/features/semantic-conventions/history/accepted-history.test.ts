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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { HistoryManifest, TimelineData } from "../types";
import { projectAcceptedHistory, validateHistory } from "./accepted-history";

const dataDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../public/data/semantic-conventions"
);
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(dataDir, file), "utf8"));

let timeline: TimelineData;
let manifest: HistoryManifest;

beforeAll(() => {
  timeline = read<TimelineData>("timeline.json");
  manifest = read<HistoryManifest>("sources.json");
});
const clone = <T>(value: T): T => structuredClone(value);

describe("accepted-history sidecar", () => {
  it("validates against the unchanged timeline", () => {
    expect(validateHistory(timeline, manifest)).toEqual([]);
  });

  it("maps every one of the 48 legacy date keys to exactly one source", () => {
    const keys = manifest.releases.map((release) => release.key);
    expect(keys).toHaveLength(48);
    expect(new Set(keys).size).toBe(48);
    expect([...keys].sort()).toEqual(Object.keys(timeline.dates).sort());
  });

  it("splits spec-era keys from core tags without guessing", () => {
    const sourceOf = (key: string) => manifest.releases.find((r) => r.key === key)?.source;
    expect(sourceOf("1.20.0")).toBe("opentelemetry-specification");
    expect(sourceOf("1.21.0")).toBe("semantic-conventions");
    expect(sourceOf("1.41.1")).toBe("semantic-conventions");
  });

  it("keeps the v1.41.1 patch release's baseline on the release it patched", () => {
    const history = projectAcceptedHistory(timeline, manifest);
    const release = (key: string) => history.releases.find((r) => r.key === key);
    expect(release("semantic-conventions@v1.41.1")?.baseline).toBe("semantic-conventions@v1.41.0");
    expect(release("semantic-conventions@v1.42.0")?.baseline).toBe("semantic-conventions@v1.41.0");
  });

  it("starts core review at v1.44.0 and GenAI at its first native commit", () => {
    const start = (id: string) => manifest.sources.find((s) => s.id === id);
    expect(start("semantic-conventions")).toMatchObject({
      mode: "release",
      reviewedStart: { tag: "v1.44.0", commit: "e10a930844c6951757a43b849d364f7d056ac32b" },
    });
    expect(start("semantic-conventions-genai")).toMatchObject({
      mode: "commit",
      reviewedStart: { commit: "ebe3d1fb9fdda3398099e11ef91c4c490912f88d" },
    });
  });
});

describe("validateHistory", () => {
  it("rejects an unknown schema version", () => {
    const bad = clone(manifest);
    bad.schemaVersion = 2;
    expect(validateHistory(timeline, bad).join()).toContain("schemaVersion");
  });

  it("rejects an unknown source ID on a release", () => {
    const bad = clone(manifest);
    bad.releases[0].source = "nope";
    expect(validateHistory(timeline, bad).join()).toContain("unknown source nope");
  });

  it("rejects a date key without a mapping and a mapping without a date key", () => {
    const bad = clone(manifest);
    bad.releases = bad.releases.filter((r) => r.key !== "1.44.0");
    bad.releases.push({ ...bad.releases[0], key: "9.9.9" });
    const problems = validateHistory(timeline, bad).join("\n");
    expect(problems).toContain("dates key 1.44.0 has no source mapping");
    expect(problems).toContain("release mapping 9.9.9 has no entry in dates");
  });

  it("rejects a bare key mapped to two sources", () => {
    const bad = clone(manifest);
    bad.releases.push({ ...bad.releases[0], source: "semantic-conventions" });
    expect(validateHistory(timeline, bad).join()).toContain("mapped more than once");
  });

  it("rejects malformed immutable revisions", () => {
    const bad = clone(manifest);
    bad.releases.find((r) => r.key === "1.44.0")!.commit = "e10a930";
    expect(validateHistory(timeline, bad).join()).toContain("40-character SHA");
    const noStart = clone(manifest);
    (noStart.sources[1] as { reviewedStart: { commit: string } }).reviewedStart.commit = "abc";
    expect(validateHistory(timeline, noStart).join()).toContain("reviewedStart.commit");
  });

  it("rejects a monitored-source release without an immutable commit", () => {
    const bad = clone(manifest);
    delete bad.releases.find((r) => r.key === "1.44.0")!.commit;
    expect(validateHistory(timeline, bad).join()).toContain("requires an immutable commit");
  });

  it("rejects a baseline from another source", () => {
    const bad = clone(manifest);
    bad.releases.find((r) => r.key === "1.21.0")!.baseline = "1.20.0";
    expect(validateHistory(timeline, bad).join()).toContain("baseline 1.20.0 is not a release of");
  });

  it("rejects events pointing at an undeclared repository", () => {
    const bad = clone(timeline);
    bad.events[0].source = "https://github.com/example/other/blob/main/README.md";
    expect(validateHistory(bad, manifest).join()).toContain("declared repository");
  });

  it("rejects an unknown event lane and an event/date mismatch", () => {
    const bad = clone(timeline);
    bad.events[0].lane = "missing";
    const withRelease = bad.events.find((e) => e.release !== null)!;
    withRelease.date = "1999-01-01";
    const problems = validateHistory(bad, manifest).join("\n");
    expect(problems).toContain("unknown lane missing");
    expect(problems).toContain("differs from dates[");
  });

  it("rejects evidence for an unknown event or outside the declared repositories", () => {
    const bad = clone(manifest);
    bad.evidence[0].eventId = "no-such-event";
    bad.evidence[1].links = ["http://github.com/open-telemetry/semantic-conventions/x"];
    const problems = validateHistory(timeline, bad).join("\n");
    expect(problems).toContain("unknown event no-such-event");
    expect(problems).toContain("not an https URL");
  });

  it("requires the migration event to be a moved event in the lane", () => {
    const bad = clone(manifest);
    bad.lanes.find((l) => l.lane === "genai")!.migration!.eventId = "genai-introduced";
    expect(validateHistory(timeline, bad).join()).toContain("must be a moved event");
  });
});

describe("validateHistory on malformed manifests", () => {
  // Deliberately loose: these tests hand the validator shapes the types forbid.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = Record<string, any>;
  const validate = (mutate: (m: Loose) => void) => {
    const bad = clone(manifest) as unknown as Loose;
    mutate(bad);
    return validateHistory(timeline, bad as unknown as HistoryManifest);
  };

  it("reports a missing lane namespaces instead of throwing", () => {
    expect(validate((m) => delete m.lanes[0].namespaces)).toEqual([
      "lanes[0].namespaces must be an array of strings",
    ]);
  });

  it("reports mistyped lane, binding and migration shapes", () => {
    const problems = validate((m) => {
      m.lanes[1] = "http";
      m.lanes[2].namespaces = "rpc";
      m.lanes[3].migration = { eventId: 7 };
    }).join("\n");
    expect(problems).toContain("lanes[1] must be an object");
    expect(problems).toContain("lanes[2].namespaces must be an array of strings");
    expect(problems).toContain("lanes[3].migration.eventId must be a non-empty string");
    expect(problems).toContain("lanes[3].migration.from must be a non-empty string");
  });

  it("reports missing top-level collections and a non-object file", () => {
    expect(validate((m) => delete m.releases)).toContain("releases must be an array");
    expect(validate((m) => (m.evidence = {}))).toContain("evidence must be an array");
    expect(validateHistory(timeline, null as unknown as HistoryManifest)).toEqual([
      "sources.json must be a JSON object",
    ]);
  });

  it("reports malformed sources, releases and evidence", () => {
    const problems = validate((m) => {
      delete m.sources[0].paths;
      delete m.sources[0].reviewedStart;
      m.sources[2].mode = "watch";
      delete m.releases[0].tag;
      m.evidence[0].links = [1];
    }).join("\n");
    expect(problems).toContain("sources[0].paths must be an array of strings");
    expect(problems).toContain("sources[0].reviewedStart must be an object");
    expect(problems).toContain("sources[2].mode must be one of");
    expect(problems).toContain("releases[0].tag must be a non-empty string");
    expect(problems).toContain("evidence[0].links must be an array of strings");
  });

  it("still reports invalid references once the shape is valid", () => {
    expect(validate((m) => (m.lanes[0].lane = "missing")).join()).toContain(
      "lane binding for unknown lane missing"
    );
  });

  it("accepts the editor $schema hint", () => {
    expect(manifest.$schema).toBeTruthy();
    expect(validateHistory(timeline, manifest)).toEqual([]);
  });
});

describe("projectAcceptedHistory", () => {
  let history: ReturnType<typeof projectAcceptedHistory>;

  beforeAll(() => {
    history = projectAcceptedHistory(timeline, manifest);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(projectAcceptedHistory(timeline, manifest))).toBe(
      JSON.stringify(history)
    );
    const reordered = clone(manifest);
    reordered.sources.reverse();
    reordered.releases.reverse();
    expect(JSON.stringify(projectAcceptedHistory(timeline, reordered))).toBe(
      JSON.stringify(history)
    );
  });

  it("carries every timeline event unchanged, so manual corrections are represented", () => {
    const projected = history.lanes.flatMap((lane) => lane.events);
    expect(projected).toHaveLength(timeline.events.length);
    for (const original of timeline.events) {
      const { sourceId, releaseKey, evidence, ...event } = projected.find(
        (e) => e.id === original.id
      )!;
      expect(event).toEqual(original);
      expect(sourceId).toBeTruthy();
      expect(releaseKey === null).toBe(original.release === null);
      expect(Array.isArray(evidence)).toBe(true);
    }
  });

  it("qualifies release identity by source", () => {
    const events = history.lanes.flatMap((lane) => lane.events);
    expect(events.find((e) => e.id === "http-baseline")?.releaseKey).toBe(
      "opentelemetry-specification@v1.20.0"
    );
    expect(events.find((e) => e.id === "process-rc")?.releaseKey).toBe(
      "semantic-conventions@v1.43.0"
    );
    expect(events.find((e) => e.id === "http-origin")?.sourceId).toBe(
      "opentelemetry-specification"
    );
  });

  it("keeps the GenAI lane continuous across the move", () => {
    const genai = history.lanes.find((lane) => lane.id === "genai")!;
    expect(genai.events.map((e) => e.id)).toContain("genai-moved");
    expect(genai.migration).toEqual({
      eventId: "genai-moved",
      from: "semantic-conventions",
      to: "semantic-conventions-genai",
    });
  });

  it("exposes no candidate or unreviewed state in the public sidecar or its projection", () => {
    const sidecar = readFileSync(resolve(dataDir, "sources.json"), "utf8");
    for (const text of [sidecar, JSON.stringify(history)]) {
      expect(text).not.toMatch(/unreviewed|reviewStatus/i);
    }
  });

  it("refuses to project invalid input", () => {
    const bad = clone(manifest);
    bad.schemaVersion = 99;
    expect(() => projectAcceptedHistory(timeline, bad)).toThrow(
      /Invalid semantic-convention history/
    );
  });
});

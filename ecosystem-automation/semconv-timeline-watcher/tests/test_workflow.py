# Copyright The OpenTelemetry Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

# Copyright The OpenTelemetry Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Static checks of the nightly workflow: triggers, concurrency, permissions, pinning and the trust boundary.

GitHub Actions itself is not run here; these tests pin the properties that can be verified from the file.
"""

import re
from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parents[3] / ".github/workflows/nightly-semconv-timeline.yml"


@pytest.fixture(scope="module")
def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


def steps_of(job):
    return job.get("steps", [])


def test_runs_nightly_and_on_demand_with_replay_inputs(workflow):
    triggers = workflow[True]  # PyYAML reads the bare key `on` as a boolean
    assert triggers["schedule"] and set(triggers["workflow_dispatch"]["inputs"]) == {
        "source",
        "tag",
        "from",
        "to",
        "force",
    }
    assert triggers["workflow_dispatch"]["inputs"]["source"]["options"] == [
        "all",
        "semantic-conventions",
        "semantic-conventions-genai",
    ]


def test_overlapping_runs_queue_instead_of_racing(workflow):
    assert workflow["concurrency"] == {"group": "${{ github.workflow }}", "cancel-in-progress": False}
    assert workflow["permissions"] == {"contents": "read"}


def test_each_source_has_an_isolated_discover_review_chain_and_failures_notify(workflow):
    jobs = workflow["jobs"]
    assert set(jobs) == {"core-discover", "core-review", "genai-discover", "genai-review", "notify"}
    assert jobs["core-review"]["needs"] == ["core-discover"] and jobs["genai-review"]["needs"] == ["genai-discover"]
    assert set(jobs["notify"]["needs"]) == set(jobs) - {"notify"}
    assert "failure" in jobs["notify"]["with"]["success"]
    for source, short in (("semantic-conventions", "core"), ("semantic-conventions-genai", "genai")):
        discover = jobs[f"{short}-discover"]
        assert f"--source {source}" in discover["with"]["watcher-command"]
        assert discover["with"]["registry-path"] == f"ecosystem-registry/semantic-conventions/{source}/"
        assert discover["with"]["branch-name"] == f"otelbot/automated-semconv-timeline-{short}"
        assert discover["permissions"] == {"contents": "write", "pull-requests": "write"}


def test_the_privileged_review_job_never_executes_code_from_the_automation_branch(workflow):
    for short in ("core", "genai"):
        job = workflow["jobs"][f"{short}-review"]
        assert job["permissions"] == {"contents": "read", "issues": "write", "pull-requests": "read"}
        checkouts = [s for s in steps_of(job) if str(s.get("uses", "")).startswith("actions/checkout")]
        branch = [s for s in checkouts if "ref" in s.get("with", {})]
        assert len(checkouts) == 2 and len(branch) == 1
        assert branch[0]["with"]["path"] == "automation-data"  # data only, in its own directory
        assert all(s["with"]["persist-credentials"] is False for s in checkouts)
        trusted = [s for s in checkouts if s not in branch][0]
        assert "path" not in trusted["with"] and "ref" not in trusted["with"]  # the default branch, at the root
        runs = "\n".join(s["run"] for s in steps_of(job) if "run" in s)
        assert "uv sync --locked" in runs and "automation-data" not in runs  # nothing runs from the branch directory
        env_registry = [s["env"]["REGISTRY_DIR"] for s in steps_of(job) if "REGISTRY_DIR" in s.get("env", {})]
        assert env_registry and all("automation-data/ecosystem-registry" in e for e in env_registry)


def test_review_creates_issues_before_the_check_that_fails_the_job(workflow):
    for short in ("core", "genai"):
        names = [s.get("name") for s in steps_of(workflow["jobs"][f"{short}-review"])]
        assert names.index("Create or update review issues") < names.index("Validate state and dispositions")
        check = [
            s
            for s in steps_of(workflow["jobs"][f"{short}-review"])
            if s.get("name") == "Validate state and dispositions"
        ][0]
        assert check["if"] == "${{ !cancelled() }}"


def test_third_party_actions_are_pinned_to_commit_shas(workflow):
    for job in workflow["jobs"].values():
        for step in steps_of(job):
            uses = step.get("uses")
            if uses and not uses.startswith("./"):
                assert re.search(r"@[0-9a-f]{40}\b", uses), uses

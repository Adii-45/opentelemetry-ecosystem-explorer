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

"""Parser for Python instrumentation package metadata.

Reads pyproject.toml (authoritative) and package.py (cross-check only), per
projects/135-python-instrumentation/02-schema-design.md §5. package.py is
parsed with `ast.literal_eval` rather than executed, since it is untrusted
upstream code.
"""

import ast
import logging
import re
import tomllib
from pathlib import Path

logger = logging.getLogger(__name__)

REPOSITORY = "open-telemetry/opentelemetry-python-contrib"

# instrumentation-genai packages are explicitly out of scope; see package_scanner.py.
INSTRUMENTS_SOURCE_KEYS = ("instruments", "instruments-any")

# Matches a PEP 508-ish requirement string's leading distribution name (and an
# optional extras marker), capturing the remainder verbatim so version_range is
# stored as the raw specifier text rather than a renormalized round-trip
# (projects/135-python-instrumentation/02-schema-design.md §4: "not renormalized").
_REQUIREMENT_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$")

_PACKAGE_PY_FIELDS = {
    "_instruments": "instruments",
    "_supports_metrics": "supports_metrics",
    "_semconv_status": "semantic_convention_status",
}


def _split_requirement(spec: str) -> tuple[str, str] | None:
    """Split a requirement string into (library, raw version range).

    Returns None if `spec` isn't a parseable requirement string.
    """
    if not isinstance(spec, str):
        return None
    match = _REQUIREMENT_RE.match(spec)
    if not match:
        return None
    name = match.group(1)
    # Drop an environment marker (e.g. `; python_version >= "3.9"`) rather than
    # folding it into version_range — instrumentation optional-deps don't use
    # markers in practice, but this keeps the field's meaning unambiguous if one
    # ever appears.
    version_range = match.group(2).split(";", 1)[0].strip()
    return name, version_range


def _normalize_for_comparison(library: str, version_range: str) -> tuple[str, str]:
    """Normalize a (library, version_range) pair for disagreement comparison only.

    Whitespace differences between pyproject.toml and package.py (e.g.
    "flask >= 1.0" vs "flask>=1.0") describe the same requirement and must not
    be reported as a disagreement; the raw text is still preserved verbatim in
    the parsed output.
    """
    return library.strip().lower(), re.sub(r"\s+", "", version_range)


class PackageParser:
    """
    Parses metadata from a single Python instrumentation package directory.

    Reads pyproject.toml and package.py. Does not scrape README.md — the audit
    (projects/135-python-instrumentation/01-metadata-audit.md) found individual
    package READMEs add no metadata beyond the structured sources.
    """

    def __init__(self, package_path: Path, repo_path: Path):
        """
        Args:
            package_path: Path to the instrumentation package directory
            repo_path: Path to the cloned opentelemetry-python-contrib repository
        """
        self.package_path = package_path
        self.repo_path = repo_path
        self._package_py_instruments: list[str] | None = None
        self._pyproject_instruments: list[tuple[str, str]] = []

    def parse(self) -> dict | None:
        """
        Parse all available metadata for this package.

        Returns:
            Dict of metadata fields matching the python registry schema
            (projects/135-python-instrumentation/02-schema-design.md §4), or
            None if pyproject.toml is missing/invalid or has no package name.
        """
        pyproject_data = self._parse_pyproject_toml()
        if pyproject_data is None:
            return None

        project = pyproject_data.get("project", {})
        if not isinstance(project, dict):
            logger.warning("pyproject.toml for %s has no [project] table", self.package_path.name)
            return None

        name = project.get("name", "")
        if not name:
            logger.warning("pyproject.toml for %s has no project name", self.package_path.name)
            return None

        version = self._resolve_version(pyproject_data)

        optional_deps = project.get("optional-dependencies", {})
        instruments = self._parse_instruments(optional_deps)
        self._pyproject_instruments = [(e["library"], e["version_range"]) for e in instruments]

        entry_points = self._parse_entry_points(project)

        urls = project.get("urls", {})
        homepage = self._extract_homepage(urls)

        package_py_info = self._find_and_parse_package_py()
        self._package_py_instruments = package_py_info["instruments"]

        source_path = str(self.package_path.relative_to(self.repo_path))

        return {
            "name": name,
            "version": version,
            "description": project.get("description", ""),
            "requires_python": project.get("requires-python", ""),
            "repository": REPOSITORY,
            "source_path": source_path,
            "homepage": homepage,
            "instruments": instruments,
            "entry_points": entry_points,
            "semantic_convention_status": package_py_info["semantic_convention_status"],
            "supports_metrics": package_py_info["supports_metrics"],
        }

    def has_metadata_disagreement(self) -> bool:
        """
        Check whether package.py's `_instruments` disagrees with pyproject.toml's
        `instruments`/`instruments-any`. Must be called after parse().

        pyproject.toml is authoritative (schema design §5); this is a reporting-only
        cross-check, not a source of registry data. Returns False if package.py
        doesn't define `_instruments` at all — there's nothing to disagree with.

        Returns:
            True if the two sources describe different sets of instrumented
            libraries/ranges.
        """
        if self._package_py_instruments is None:
            return False

        package_py_set = set()
        for spec in self._package_py_instruments:
            parsed = _split_requirement(spec)
            if parsed is not None:
                package_py_set.add(_normalize_for_comparison(*parsed))

        pyproject_set = {_normalize_for_comparison(library, rng) for library, rng in self._pyproject_instruments}

        return package_py_set != pyproject_set

    def _parse_pyproject_toml(self) -> dict | None:
        """Read and parse pyproject.toml."""
        path = self.package_path / "pyproject.toml"
        try:
            with path.open("rb") as f:
                return tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError) as e:
            logger.warning("Failed to parse pyproject.toml for %s: %s", self.package_path.name, e)
            return None

    def _resolve_version(self, pyproject_data: dict) -> str:
        """
        Resolve the package's own version.

        A static `[project].version` is used directly. A `dynamic = ["version"]`
        declaration (the common case — see schema design §5) is resolved via
        `[tool.hatch.version].path`, reading `__version__` from that file rather
        than the string literally declared in pyproject.toml.
        """
        project = pyproject_data.get("project", {})
        static_version = project.get("version")
        if isinstance(static_version, str) and static_version:
            return static_version

        dynamic = project.get("dynamic", [])
        if not isinstance(dynamic, list) or "version" not in dynamic:
            return ""

        version_path = pyproject_data.get("tool", {}).get("hatch", {}).get("version", {}).get("path")
        if not isinstance(version_path, str) or not version_path:
            logger.warning("No [tool.hatch.version].path for dynamic version in %s", self.package_path.name)
            return ""

        version_file = self.package_path / version_path
        if not version_file.exists():
            logger.warning("Version file %s not found for %s", version_path, self.package_path.name)
            return ""

        return self._read_dunder_version(version_file)

    def _read_dunder_version(self, version_file: Path) -> str:
        """Safely extract `__version__ = "..."` from a version file via ast, without executing it."""
        try:
            tree = ast.parse(version_file.read_text())
        except (OSError, SyntaxError) as e:
            logger.warning("Failed to parse version file %s: %s", version_file, e)
            return ""

        for node in ast.iter_child_nodes(tree):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__version__":
                    try:
                        value = ast.literal_eval(node.value)
                    except (ValueError, SyntaxError):
                        logger.warning("Could not evaluate __version__ in %s", version_file)
                        return ""
                    return value if isinstance(value, str) else ""
        return ""

    def _parse_instruments(self, optional_deps: object) -> list[dict]:
        """
        Parse `instruments` / `instruments-any` from [project.optional-dependencies].

        `source_key` is preserved per entry rather than collapsed — the audit
        didn't establish the precise semantic difference between the two keys
        (schema design §4).

        Returns:
            List of {library, version_range, source_key} dicts, sorted by
            (source_key, library, version_range) for deterministic output.
        """
        if not isinstance(optional_deps, dict):
            return []

        results = []
        for source_key in INSTRUMENTS_SOURCE_KEYS:
            specs = optional_deps.get(source_key, [])
            if not isinstance(specs, list):
                continue
            for spec in specs:
                parsed = _split_requirement(spec)
                if parsed is None:
                    logger.warning(
                        "Could not parse requirement %r (%s) for %s", spec, source_key, self.package_path.name
                    )
                    continue
                library, version_range = parsed
                results.append({"library": library, "version_range": version_range, "source_key": source_key})

        return sorted(results, key=lambda e: (e["source_key"], e["library"], e["version_range"]))

    def _parse_entry_points(self, project: dict) -> list[dict]:
        """
        Parse [project.entry-points.opentelemetry_instrumentor] entries.

        Returns:
            List of {name, value} dicts, sorted by name for deterministic output.
        """
        entry_points_table = project.get("entry-points", {})
        if not isinstance(entry_points_table, dict):
            return []

        instrumentor_entries = entry_points_table.get("opentelemetry_instrumentor", {})
        if not isinstance(instrumentor_entries, dict):
            return []

        return sorted(
            ({"name": name, "value": value} for name, value in instrumentor_entries.items() if isinstance(value, str)),
            key=lambda e: e["name"],
        )

    def _extract_homepage(self, urls: object) -> str | None:
        """Best-effort homepage URL from [project.urls], case-insensitive key match."""
        if not isinstance(urls, dict):
            return None
        for key, value in urls.items():
            if isinstance(key, str) and key.lower() == "homepage" and isinstance(value, str):
                return value
        return None

    def _find_and_parse_package_py(self) -> dict:
        """
        Locate and parse this package's package.py.

        package.py's location varies with the instrumented module's dotted path
        (e.g. src/opentelemetry/instrumentation/aws_lambda/package.py), so it is
        discovered by searching rather than assumed from the directory name.

        Returns:
            Dict with 'instruments' (list[str] | None), 'semantic_convention_status'
            (str | None), and 'supports_metrics' (bool | None). All None if no
            package.py was found.
        """
        candidates = sorted(
            p for p in self.package_path.rglob("package.py") if "tests" not in p.parts and "test" not in p.parts
        )
        if not candidates:
            return {"instruments": None, "semantic_convention_status": None, "supports_metrics": None}

        if len(candidates) > 1:
            logger.warning(
                "Multiple package.py files found for %s; using %s",
                self.package_path.name,
                candidates[0],
            )

        return self._parse_package_py(candidates[0])

    def _parse_package_py(self, path: Path) -> dict:
        """
        Safely extract `_instruments`, `_supports_metrics`, and `_semconv_status`
        from a package.py file via `ast.literal_eval`. The file is never executed.
        """
        result: dict = {"instruments": None, "semantic_convention_status": None, "supports_metrics": None}

        try:
            tree = ast.parse(path.read_text())
        except (OSError, SyntaxError) as e:
            logger.warning("Failed to parse %s: %s", path, e)
            return result

        for node in ast.iter_child_nodes(tree):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not (isinstance(target, ast.Name) and target.id in _PACKAGE_PY_FIELDS):
                    continue
                try:
                    value = ast.literal_eval(node.value)
                except (ValueError, SyntaxError):
                    logger.warning("Could not evaluate %s in %s", target.id, path)
                    continue

                field = _PACKAGE_PY_FIELDS[target.id]
                if field == "instruments" and isinstance(value, (list, tuple)):
                    result[field] = list(value)
                elif field != "instruments":
                    result[field] = value

        return result

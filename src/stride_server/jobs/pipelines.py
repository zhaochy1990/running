"""Pipeline-definition loading + in-memory registry.

Pipeline definitions live in a YAML file (``config/pipelines.yaml``), loaded
fail-fast at startup by BOTH the API process (in ``create_app``) and the worker
process (in ``__main__.main``). Definitions are static topology (which steps,
what order, whose handler) — configuration, not runtime data — so they live in
YAML and are validated against the handler registry at load time.

Mirrors the shape of ``stride_server.jobs.registry`` (module-level dict +
``get_*`` lookups). Linear-only today; ``depends`` is captured so the structure
is ready for future parallel/DAG execution.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .registry import get_handler


class PipelineConfigError(RuntimeError):
    """Raised on any invalid pipeline definition — aborts startup."""


@dataclass(frozen=True)
class PipelineStep:
    name: str
    job_type: str
    depends: tuple[str, ...] = ()


@dataclass(frozen=True)
class PipelineDef:
    name: str
    steps: tuple[PipelineStep, ...]

    def first_step(self) -> PipelineStep:
        return self.steps[0]

    def step(self, name: str) -> PipelineStep | None:
        return next((s for s in self.steps if s.name == name), None)

    def next_step(self, after: str) -> PipelineStep | None:
        """The step immediately following ``after`` in declaration order.

        Linear execution: steps run in the order declared. Returns None if
        ``after`` is the last step.
        """
        for i, s in enumerate(self.steps):
            if s.name == after:
                return self.steps[i + 1] if i + 1 < len(self.steps) else None
        return None


_PIPELINES: dict[str, PipelineDef] = {}


def default_pipelines_path() -> Path:
    """`config/pipelines.yaml` at the repo/image root, or a test override."""
    override = os.environ.get("STRIDE_PIPELINES_CONFIG_PATH")
    if override:
        return Path(override)
    from stride_server.deps import PROJECT_ROOT

    return PROJECT_ROOT / "config" / "pipelines.yaml"


def load_pipelines(path: str | Path | None = None) -> dict[str, PipelineDef]:
    """Parse + validate the YAML file and populate the registry. Fail-fast.

    Validates: parseable YAML; each pipeline has >=1 step; unique step names;
    every step's ``job_type`` has a registered handler; every ``depends`` name
    refers to an earlier step. Raises ``PipelineConfigError`` on any violation.
    Call AFTER handlers are registered so the job_type check can see them.
    """
    import yaml

    p = Path(path) if path is not None else default_pipelines_path()
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise PipelineConfigError(f"failed to load pipelines from {p}: {exc}") from exc

    if not isinstance(raw, dict) or "pipelines" not in raw:
        raise PipelineConfigError(f"{p}: top-level 'pipelines' mapping required")
    pipelines_raw = raw["pipelines"]
    if not isinstance(pipelines_raw, dict) or not pipelines_raw:
        raise PipelineConfigError(f"{p}: 'pipelines' must be a non-empty mapping")

    parsed: dict[str, PipelineDef] = {}
    for name, body in pipelines_raw.items():
        parsed[name] = _parse_pipeline(str(name), body, source=str(p))

    _PIPELINES.clear()
    _PIPELINES.update(parsed)
    return dict(_PIPELINES)


def _parse_pipeline(name: str, body: object, *, source: str) -> PipelineDef:
    if not isinstance(body, dict) or not isinstance(body.get("steps"), list) or not body["steps"]:
        raise PipelineConfigError(f"{source}: pipeline {name!r} needs a non-empty 'steps' list")

    steps: list[PipelineStep] = []
    seen: set[str] = set()
    for raw_step in body["steps"]:
        if not isinstance(raw_step, dict):
            raise PipelineConfigError(f"{source}: pipeline {name!r} has a non-mapping step")
        step_name = raw_step.get("name")
        job_type = raw_step.get("job_type")
        if not step_name or not job_type:
            raise PipelineConfigError(
                f"{source}: pipeline {name!r} step needs both 'name' and 'job_type'"
            )
        if step_name in seen:
            raise PipelineConfigError(
                f"{source}: pipeline {name!r} has duplicate step name {step_name!r}"
            )
        if get_handler(job_type) is None:
            raise PipelineConfigError(
                f"{source}: pipeline {name!r} step {step_name!r} references job_type "
                f"{job_type!r} with no registered handler"
            )
        depends = tuple(raw_step.get("depends") or ())
        for dep in depends:
            if dep not in seen:
                raise PipelineConfigError(
                    f"{source}: pipeline {name!r} step {step_name!r} depends on "
                    f"{dep!r} which is not an earlier step"
                )
        steps.append(PipelineStep(name=str(step_name), job_type=str(job_type), depends=depends))
        seen.add(step_name)

    return PipelineDef(name=name, steps=tuple(steps))


def get_pipeline(name: str) -> PipelineDef | None:
    return _PIPELINES.get(name)


def registered_pipelines() -> list[str]:
    return sorted(_PIPELINES)


def clear_pipelines_for_tests() -> None:
    _PIPELINES.clear()

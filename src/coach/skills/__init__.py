"""Markdown-as-prompt skill framework for the coach agent.

A reusable substrate: prompt *content* lives in markdown skill directories
(``SKILL.md`` entry + ``{{include}}``d fragments, with ``shared/`` modules
reused across S1 / S2 / S3), and code supplies only the runtime ``${context}``.
See :mod:`coach.skills.loader`.
"""
from .loader import Skill, load_skill, render_fragment, render_skill

__all__ = ["Skill", "load_skill", "render_fragment", "render_skill"]

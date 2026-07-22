"""Cooperative cancellation signal for async jobs."""

from __future__ import annotations


class JobCancelled(Exception):
    """The job was deliberately cancelled and must not retry or poison."""


class CancellationCheckUnavailable(Exception):
    """The worker could not safely determine whether a job was cancelled."""

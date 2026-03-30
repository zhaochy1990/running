"""Matplotlib chart generators for running analysis."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd


def plot_weekly_mileage(weekly: pd.DataFrame) -> None:
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 5))
    x = range(len(weekly))
    labels = [f"W{int(w)}" for (_, w) in weekly.index]

    ax.bar(x, weekly["distance_km"], color="#4A90D9", alpha=0.8)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45)
    ax.set_ylabel("Distance (km)")
    ax.set_title("Weekly Mileage")
    ax.grid(axis="y", alpha=0.3)

    plt.tight_layout()
    plt.show()


def plot_training_load(df: pd.DataFrame) -> None:
    import matplotlib.pyplot as plt

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8), sharex=True)

    ax1.plot(df["date"], df["ati"], label="ATI (Acute)", color="#E74C3C", linewidth=1.5)
    ax1.plot(df["date"], df["cti"], label="CTI (Chronic)", color="#3498DB", linewidth=1.5)
    ax1.set_ylabel("Training Load")
    ax1.set_title("Training Load Trend")
    ax1.legend()
    ax1.grid(alpha=0.3)

    ax2.plot(df["date"], df["rhr"], label="RHR", color="#2ECC71", linewidth=1.5)
    ax2.set_ylabel("Resting HR (bpm)")
    ax2.set_xlabel("Date")
    ax2.legend()
    ax2.grid(alpha=0.3)

    # Rotate x labels
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.show()

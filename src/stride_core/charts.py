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


def plot_pmc(df: pd.DataFrame) -> None:
    """Performance Management Chart: CTI, ATI, and TSB with zone shading."""
    import pandas as pd
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 9), sharex=True,
                                    gridspec_kw={"height_ratios": [2, 1]})

    dates = pd.to_datetime(df["date"], format="%Y%m%d", errors="coerce")

    # Top panel: CTI (fitness) and ATI (fatigue)
    ax1.plot(dates, df["cti"], label="CTI (体能)", color="#00a85a", linewidth=2)
    ax1.plot(dates, df["ati"], label="ATI (疲劳)", color="#0097a7", linewidth=1.5, alpha=0.8)
    ax1.fill_between(dates, df["cti"], df["ati"],
                     where=df["cti"] >= df["ati"], color="#00a85a", alpha=0.08)
    ax1.fill_between(dates, df["cti"], df["ati"],
                     where=df["cti"] < df["ati"], color="#d32f2f", alpha=0.08)
    ax1.set_ylabel("Training Load Index")
    ax1.set_title("Performance Management Chart (PMC)", fontsize=14, fontweight="bold")
    ax1.legend(loc="upper left")
    ax1.grid(alpha=0.3)

    # Bottom panel: TSB (form) with zone bands
    tsb = df["tsb"]
    ax2.axhspan(25, tsb.max() + 10, color="#ffab00", alpha=0.06, label="减量过多 (>25)")
    ax2.axhspan(10, 25, color="#00a85a", alpha=0.08, label="比赛就绪 (10~25)")
    ax2.axhspan(-10, 10, color="#888888", alpha=0.04, label="过渡区 (-10~10)")
    ax2.axhspan(-30, -10, color="#0097a7", alpha=0.06, label="正常训练 (-30~-10)")
    ax2.axhspan(tsb.min() - 10, -30, color="#d32f2f", alpha=0.06, label="过度负荷 (<-30)")

    ax2.plot(dates, tsb, color="#5c6bc0", linewidth=2, label="TSB (状态)")
    ax2.axhline(y=0, color="#888888", linewidth=0.8, linestyle="-")
    ax2.fill_between(dates, tsb, 0,
                     where=tsb >= 0, color="#00a85a", alpha=0.15)
    ax2.fill_between(dates, tsb, 0,
                     where=tsb < 0, color="#d32f2f", alpha=0.1)
    ax2.set_ylabel("TSB (Form)")
    ax2.set_xlabel("Date")
    ax2.legend(loc="lower left", fontsize=8, ncol=3)
    ax2.grid(alpha=0.3)

    ax2.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d"))
    plt.xticks(rotation=45)
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

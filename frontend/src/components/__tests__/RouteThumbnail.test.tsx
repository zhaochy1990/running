import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RouteShapeV2, RouteThumb } from "../../api";
import { LEGACY_POLYLINE, LOOP_WITH_SIDE_STREET, NARROW_OUT_AND_BACK } from "../../test/routeThumbFixtures";
import RouteThumbnail from "../RouteThumbnail";

function renderThumb(routeThumb: RouteThumb | null | undefined, size = 56) {
  const { container } = render(<RouteThumbnail routeThumb={routeThumb} size={size} color="#ff0000" />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("thumbnail rendered no svg");
  return {
    strokes: Array.from(svg.querySelectorAll("polyline")),
    markers: Array.from(svg.querySelectorAll("circle")),
  };
}

const pointsOf = (strokes: Element[]) => strokes.map((stroke) => stroke.getAttribute("points"));

describe("RouteThumbnail", () => {
  it("renders a sport placeholder when the activity has no GPS", () => {
    render(<RouteThumbnail routeThumb={null} sportName="力量训练" size={56} />);

    expect(document.querySelector("svg > polyline")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-label='力量训练']")).toBeInTheDocument();
  });

  it("draws a legacy single polyline as one stroke with markers at its ends", () => {
    const { strokes, markers } = renderThumb(LEGACY_POLYLINE);

    expect(pointsOf(strokes)).toEqual(["5,95 50,20 95,5"]);
    expect(strokes[0]).toHaveAttribute("stroke", "#ff0000");
    expect(strokes[0]).toHaveAttribute("stroke-width", "3");
    expect(strokes[0]).toHaveAttribute("fill", "none");

    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveAttribute("cx", "5");
    expect(markers[0]).toHaveAttribute("cy", "95");
    expect(markers[0]).toHaveAttribute("fill", "#ff0000");
    expect(markers[1]).toHaveAttribute("cx", "95");
    expect(markers[1]).toHaveAttribute("cy", "5");
    expect(markers[1]).toHaveAttribute("fill", "#1a1c2e");
  });

  it("starts a new path for every stroke of a v2 shape", () => {
    const { strokes } = renderThumb(LOOP_WITH_SIDE_STREET);

    expect(pointsOf(strokes)).toEqual(["5.1,79.9 50,79.9 94.9,79.9 94.9,20.1 50,20.1 5.1,20.1 5.1,79.9", "50,79.9 50,20.1"]);
    for (const stroke of strokes) {
      expect(stroke).toHaveAttribute("stroke", "#ff0000");
      expect(stroke).toHaveAttribute("fill", "none");
      expect(stroke).toHaveAttribute("stroke-linecap", "round");
      expect(stroke).toHaveAttribute("stroke-linejoin", "round");
    }
  });

  it("never bridges a GPS break: the parts of the trace stay separate paths", () => {
    // A >30 s gap splits the trace: two loops far apart, nothing between them.
    const gpsBreak: RouteShapeV2 = {
      v: 2,
      strokes: [
        [
          [5.1, 65.0],
          [35.0, 65.0],
          [35.0, 35.0],
          [5.1, 35.0],
          [5.1, 65.0],
        ],
        [
          [65.0, 65.0],
          [94.9, 65.0],
          [94.9, 35.0],
          [65.0, 35.0],
          [65.0, 65.0],
        ],
      ],
      start: [5.1, 65.0],
      end: [65.0, 65.0],
      short: 30.1,
      long: 90.0,
      travel: 239.4,
    };
    const { strokes, markers } = renderThumb(gpsBreak);

    expect(pointsOf(strokes)).toEqual(["5.1,65 35,65 35,35 5.1,35 5.1,65", "65,65 94.9,65 94.9,35 65,35 65,65"]);
    expect(markers[0]).toHaveAttribute("cx", "5.1");
    expect(markers[0]).toHaveAttribute("cy", "65");
    expect(markers[1]).toHaveAttribute("cx", "65");
    expect(markers[1]).toHaveAttribute("cy", "65");
  });

  it("puts the markers at the run's real start and end, not at the ends of a stroke", () => {
    const { strokes, markers } = renderThumb(NARROW_OUT_AND_BACK);

    // The stroke stops at the turnaround; the run itself ended back at the start.
    expect(strokes[0].getAttribute("points")).toBe("5,50.4 95,50.4 95,49.6");
    expect(markers[0]).toHaveAttribute("cx", "5");
    expect(markers[0]).toHaveAttribute("cy", "50.4");
    expect(markers[1]).toHaveAttribute("cx", "5");
    expect(markers[1]).toHaveAttribute("cy", "50.4");
  });

  // Epic devops#1034 "36 px 可读性": the two narrow routes draw at 0.90 px where
  // the rest draw at 1.20 px, and a display of 56 px or more uses the regular
  // width. The svg maps 100 viewbox units onto `size` px.
  const strokeWidthOf = (routeThumb: RouteThumb, size: number) => parseFloat(renderThumb(routeThumb, size).strokes[0].getAttribute("stroke-width") ?? "");

  it("thins a narrow out-and-back at 36 px", () => {
    expect(strokeWidthOf(NARROW_OUT_AND_BACK, 36)).toBeCloseTo(2.5, 5); // 0.90 px
  });

  it("keeps the regular width for an ordinary route at 36 px and for every route from 56 px up", () => {
    expect(strokeWidthOf(LOOP_WITH_SIDE_STREET, 36)).toBeCloseTo(3.3333, 4); // 1.20 px
    expect(strokeWidthOf(NARROW_OUT_AND_BACK, 56)).toBeCloseTo(3.3333, 4); // 56 / 30 px
    expect(strokeWidthOf(LOOP_WITH_SIDE_STREET, 56)).toBeCloseTo(3.3333, 4);
  });

  it("renders the placeholder for a shape version it does not know", () => {
    // A newer algorithm version reaches an older client as plain JSON, which
    // the declared type cannot express.
    const newerVersion = { ...LOOP_WITH_SIDE_STREET, v: 3 } as unknown as RouteThumb;
    const { container } = render(<RouteThumbnail routeThumb={newerVersion} sportName="Run" />);

    expect(container.querySelector("polyline")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-label='室内活动']")).toBeInTheDocument();
  });
});

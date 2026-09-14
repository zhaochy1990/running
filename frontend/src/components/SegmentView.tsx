import type { Segment } from "../api";

const ZONE_COLORS = ["#00c853", "#64dd17", "#ffab00", "#ff6d00", "#ff1744"];

function getPaceColor(pace: number | null): string {
  if (!pace) return "#555570";
  if (pace > 360) return ZONE_COLORS[0];
  if (pace > 300) return ZONE_COLORS[1];
  if (pace > 260) return ZONE_COLORS[2];
  if (pace > 230) return ZONE_COLORS[3];
  return ZONE_COLORS[4];
}

function getHRColor(hr: number | null): string {
  if (!hr) return "#555570";
  if (hr < 130) return ZONE_COLORS[0];
  if (hr < 145) return ZONE_COLORS[1];
  if (hr < 160) return ZONE_COLORS[2];
  if (hr < 175) return ZONE_COLORS[3];
  return ZONE_COLORS[4];
}

const SEG_NAME_COLORS: Record<string, string> = {
  热身: "#00e5ff",
  慢跑: "#00e676",
  大步跑: "#ff6d00",
  恢复: "#64dd17",
  放松: "#b388ff",
  快跑: "#ff1744",
  训练: "#ffab00",
};

function segColor(name: string): string {
  return SEG_NAME_COLORS[name] || "#8888a0";
}

/** Flat list of an activity's segments (the API's single lap/segment table). */
export default function SegmentView({ segments }: { segments: Segment[] }) {
  return (
    <div className="space-y-2">
      {segments.map((seg, i) => (
        <SegmentRow key={i} index={i + 1} segment={seg} />
      ))}
    </div>
  );
}

function SegmentRow({ index, segment }: { index: number; segment: Segment }) {
  const color = segColor(segment.seg_name);
  const isRecovery = segment.seg_name === "恢复";

  return (
    <div className={`rounded-lg overflow-hidden ${isRecovery ? "border border-border-subtle/30" : "border border-border-subtle"}`}>
      <div className={`w-full flex items-center gap-3 px-4 text-left ${isRecovery ? "py-1 opacity-35" : "py-3"} bg-bg-card`}>
        {/* Index + name */}
        <div className="flex items-center gap-2 min-w-[140px]">
          <span className="w-6" />
          <span className="text-xs font-mono text-text-muted w-5">{index}</span>
          <div className="w-1.5 h-5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium" style={{ color }}>
            {segment.seg_name}
          </span>
        </div>

        {/* Metrics */}
        <div className="flex-1 flex items-center gap-6">
          <SegMetric label="距离" value={`${segment.distance_km} km`} />
          <SegMetric label="时长" value={segment.duration_fmt} />
          <SegMetric label="配速" value={segment.pace_fmt} color={getPaceColor(segment.avg_pace)} />
          <SegMetric label="心率" value={segment.avg_hr ? `${segment.avg_hr}` : "—"} color={getHRColor(segment.avg_hr)} />
        </div>

        {/* Spacer for alignment */}
        <span className="w-4" />
      </div>
    </div>
  );
}

function SegMetric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-[60px]">
      <p className="text-[11px] font-mono text-text-muted">{label}</p>
      <p className="text-xs font-mono font-medium mt-0.5" style={color ? { color } : undefined}>
        {value}
      </p>
    </div>
  );
}

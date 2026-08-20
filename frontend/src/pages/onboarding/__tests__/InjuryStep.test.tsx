import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listInjuries: vi.fn(),
  createInjury: vi.fn(),
  updateInjury: vi.fn(),
  deleteInjury: vi.fn(),
}));

vi.mock("../../../api", () => api);

import InjuryStep from "../InjuryStep";

const injury = {
  id: "injury-1",
  description: "左膝疼痛",
  recovery_status: "active" as const,
  running_restriction: "easy_only" as const,
  created_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listInjuries.mockResolvedValue({ items: [], next_cursor: null });
});

describe("InjuryStep", () => {
  it("skips without saving and calls onSuccess immediately", async () => {
    const onSuccess = vi.fn();
    render(<InjuryStep onSuccess={onSuccess} />);

    await screen.findByText("记录伤病情况");
    fireEvent.click(screen.getByRole("button", { name: "跳过，继续" }));

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(api.createInjury).not.toHaveBeenCalled();
    expect(api.updateInjury).not.toHaveBeenCalled();
  });

  it("persists create and reloads immediately", async () => {
    api.createInjury.mockResolvedValue({ ok: true, status: 201, data: injury });
    api.listInjuries.mockResolvedValueOnce({ items: [], next_cursor: null }).mockResolvedValueOnce({ items: [injury], next_cursor: null });

    render(<InjuryStep onSuccess={vi.fn()} />);
    await screen.findByText("记录伤病情况");
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "左膝疼痛" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));

    await waitFor(() =>
      expect(api.createInjury).toHaveBeenCalledWith({
        description: "左膝疼痛",
        recovery_status: "active",
        running_restriction: "easy_only",
      }),
    );
    expect(await screen.findByText("左膝疼痛")).toBeInTheDocument();
    expect(api.listInjuries).toHaveBeenCalledTimes(2);
  });

  it("persists update and reloads immediately", async () => {
    api.listInjuries.mockResolvedValue({ items: [injury], next_cursor: null });
    api.updateInjury.mockResolvedValue({ ok: true, status: 200, data: { ...injury, description: "右膝疼痛" } });
    render(<InjuryStep onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "右膝疼痛" } });
    fireEvent.click(screen.getByRole("button", { name: "更新记录" }));

    await waitFor(() => expect(api.updateInjury).toHaveBeenCalledWith("injury-1", expect.objectContaining({ description: "右膝疼痛" })));
    expect(api.listInjuries).toHaveBeenCalledTimes(2);
  });

  it("persists delete and reloads immediately", async () => {
    api.listInjuries.mockResolvedValue({ items: [injury], next_cursor: null });
    api.deleteInjury.mockResolvedValue({ ok: true, status: 204, data: {} });
    render(<InjuryStep onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    await waitFor(() => expect(api.deleteInjury).toHaveBeenCalledWith("injury-1"));
    expect(api.listInjuries).toHaveBeenCalledTimes(2);
  });
});

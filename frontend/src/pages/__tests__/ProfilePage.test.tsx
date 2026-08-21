import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ProfilePage from "../ProfilePage";

const apiMock = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
  patchMyProfile: vi.fn(),
  deleteMyAccount: vi.fn(),
  listInjuries: vi.fn(),
  createInjury: vi.fn(),
  updateInjury: vi.fn(),
  deleteInjury: vi.fn(),
  refresh: vi.fn(),
  clearSession: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../api", () => ({
  getMyProfile: apiMock.getMyProfile,
  patchMyProfile: apiMock.patchMyProfile,
  deleteMyAccount: apiMock.deleteMyAccount,
  listInjuries: apiMock.listInjuries,
  createInjury: apiMock.createInjury,
  updateInjury: apiMock.updateInjury,
  deleteInjury: apiMock.deleteInjury,
}));

vi.mock("../../UserContextValue", () => ({
  useUser: () => ({ refresh: apiMock.refresh }),
}));

vi.mock("../../store/authStore", () => ({
  useAuthStore: (selector: (state: { clearSession: () => void }) => unknown) => selector({ clearSession: apiMock.clearSession }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => apiMock.navigate,
  };
});

function profileResponse() {
  return {
    id: "user-1",
    display_name: "Runner",
    profile: {},
    onboarding: {
      coros_ready: true,
      profile_ready: true,
      completed_at: null,
    },
  };
}

const injury = {
  id: "injury-1",
  description: "左膝疼痛",
  recovery_status: "active" as const,
  running_restriction: "easy_only" as const,
  created_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProfilePage running profile", () => {
  it("patches the selected running age", async () => {
    apiMock.getMyProfile.mockResolvedValue({
      ...profileResponse(),
      profile: { dob: "1990-01-01", sex: "male", height_cm: 180, weight_kg: 70 },
      running_age_range: "unknown",
    });
    apiMock.listInjuries.mockResolvedValue({ items: [], next_cursor: null });
    apiMock.patchMyProfile.mockResolvedValue({ ok: true, status: 200, data: {} });

    renderPage();
    await screen.findByText("危险区：注销账号");
    fireEvent.change(screen.getByLabelText("跑龄"), { target: { value: "1y_3y" } });
    fireEvent.click(screen.getByRole("button", { name: "保存个人资料" }));

    await waitFor(() => expect(apiMock.patchMyProfile).toHaveBeenCalledWith(expect.objectContaining({ running_age_range: "1y_3y" })));
  });

  it("reloads the first injury page after create, update, and delete", async () => {
    apiMock.getMyProfile.mockResolvedValue(profileResponse());
    apiMock.listInjuries
      .mockResolvedValueOnce({ items: [], next_cursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [injury], next_cursor: null })
      .mockResolvedValueOnce({ items: [{ ...injury, description: "右膝疼痛" }], next_cursor: null })
      .mockResolvedValueOnce({ items: [], next_cursor: null });
    apiMock.createInjury.mockResolvedValue({ ok: true, status: 201, data: injury });
    apiMock.updateInjury.mockResolvedValue({ ok: true, status: 200, data: { ...injury, description: "右膝疼痛" } });
    apiMock.deleteInjury.mockResolvedValue({ ok: true, status: 204, data: {} });

    renderPage();
    await screen.findByText("危险区：注销账号");
    await waitFor(() => expect(apiMock.listInjuries).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("伤病描述"), { target: { value: "左膝疼痛" } });
    fireEvent.click(screen.getByRole("button", { name: "添加伤病记录" }));
    await waitFor(() => expect(apiMock.listInjuries).toHaveBeenCalledTimes(2));
    expect(apiMock.listInjuries).toHaveBeenLastCalledWith();

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("伤病描述"), { target: { value: "右膝疼痛" } });
    fireEvent.click(screen.getByRole("button", { name: "更新记录" }));
    await waitFor(() => expect(apiMock.listInjuries).toHaveBeenCalledTimes(3));
    expect(apiMock.updateInjury).toHaveBeenCalledWith("injury-1", expect.objectContaining({ description: "右膝疼痛" }));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(apiMock.listInjuries).toHaveBeenCalledTimes(4));
    expect(apiMock.deleteInjury).toHaveBeenCalledWith("injury-1");
  });
});

describe("ProfilePage account deletion", () => {
  it("requires explicit confirmation before deleting the account", async () => {
    apiMock.getMyProfile.mockResolvedValue(profileResponse());
    apiMock.deleteMyAccount.mockResolvedValue({ ok: true, status: 204, data: {} });

    renderPage();

    await screen.findByText("危险区：注销账号");
    const button = screen.getByRole("button", { name: "永久注销账号" });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("删除账号"), { target: { value: "删除" } });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("删除账号"), { target: { value: "删除账号" } });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(apiMock.deleteMyAccount).toHaveBeenCalledTimes(1));
    expect(apiMock.clearSession).toHaveBeenCalledTimes(1);
    expect(apiMock.navigate).toHaveBeenCalledWith("/login", { replace: true });
  });

  it("shows a team ownership hint when account deletion is blocked", async () => {
    apiMock.getMyProfile.mockResolvedValue(profileResponse());
    apiMock.deleteMyAccount.mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: "user owns teams" },
    });

    renderPage();

    await screen.findByText("危险区：注销账号");
    fireEvent.change(screen.getByPlaceholderText("删除账号"), { target: { value: "删除账号" } });
    fireEvent.click(screen.getByRole("button", { name: "永久注销账号" }));

    expect(await screen.findByText("注销失败：你仍然拥有团队。请先到团队页面转让队长或解散团队，然后再注销账号。")).toBeInTheDocument();
    expect(apiMock.clearSession).not.toHaveBeenCalled();
  });
});

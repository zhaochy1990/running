import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PhoneBindPrompt from "../PhoneBindPrompt";

const apiMock = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  bindPhone: vi.fn(),
}));

const store = vi.hoisted(() => ({
  sendSmsCode: vi.fn(),
}));

vi.mock("../../api", () => ({ getAuthUser: apiMock.getAuthUser, bindPhone: apiMock.bindPhone }));
vi.mock("../../store/authStore", () => ({
  useAuthStore: () => store,
}));

beforeEach(() => {
  apiMock.getAuthUser.mockReset();
  apiMock.bindPhone.mockReset().mockResolvedValue({ ok: true, status: 200, data: { status: "ok" } });
  store.sendSmsCode.mockReset().mockResolvedValue(undefined);
});

describe("PhoneBindPrompt", () => {
  it("does not show the modal for a user with a bound phone", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: null, phone: "13800138000" });
    render(<PhoneBindPrompt>CONTENT</PhoneBindPrompt>);
    expect(screen.getByText("CONTENT")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the modal when the user has no phone", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.com", phone: null });
    render(<PhoneBindPrompt>CONTENT</PhoneBindPrompt>);
    expect(await screen.findByRole("dialog", { name: "绑定手机号" })).toBeInTheDocument();
  });

  it("does not show the modal when the identity fetch fails (transient error)", async () => {
    apiMock.getAuthUser.mockRejectedValue(new Error("API error: 503"));
    render(<PhoneBindPrompt>CONTENT</PhoneBindPrompt>);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("dismisses on 稍后再说 and stays dismissed for the session", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.com", phone: null });
    render(<PhoneBindPrompt>CONTENT</PhoneBindPrompt>);
    fireEvent.click(await screen.findByRole("button", { name: "稍后再说" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

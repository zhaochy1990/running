import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PhoneBindingSection from "../PhoneBindingSection";

const apiMock = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  unbindPhone: vi.fn(),
  bindPhone: vi.fn(),
}));

const store = vi.hoisted(() => ({
  sendSmsCode: vi.fn(),
}));

vi.mock("../../api", () => ({ getAuthUser: apiMock.getAuthUser, unbindPhone: apiMock.unbindPhone, bindPhone: apiMock.bindPhone }));
vi.mock("../../store/authStore", () => ({
  useAuthStore: () => store,
}));

beforeEach(() => {
  apiMock.getAuthUser.mockReset();
  apiMock.unbindPhone.mockReset().mockResolvedValue({ ok: true, status: 200, data: { status: "ok" } });
  apiMock.bindPhone.mockReset().mockResolvedValue({ ok: true, status: 200, data: { status: "ok" } });
  store.sendSmsCode.mockReset().mockResolvedValue(undefined);
});

describe("PhoneBindingSection", () => {
  it("shows the masked phone and actions when bound", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: null, phone: "13800138000" });
    render(<PhoneBindingSection />);
    expect(await screen.findByText("138****8000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更换手机号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解绑" })).toBeInTheDocument();
  });

  it("shows a bind button when no phone is bound", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.com", phone: null });
    render(<PhoneBindingSection />);
    expect(await screen.findByRole("button", { name: "绑定手机" })).toBeInTheDocument();
  });

  it("unbinds after confirmation and clears the phone", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: null, phone: "13800138000" });
    render(<PhoneBindingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "解绑" }));

    fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
    await waitFor(() => expect(apiMock.unbindPhone).toHaveBeenCalled());

    expect(await screen.findByRole("button", { name: "绑定手机" })).toBeInTheDocument();
  });

  it("surfaces the last-login-method refusal", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: null, phone: "13800138000" });
    apiMock.unbindPhone.mockResolvedValue({ ok: false, status: 400, data: { error: "cannot_unlink_last_account" } });
    render(<PhoneBindingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "解绑" }));
    fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));

    expect(await screen.findByText("这是你唯一的登录方式，无法解绑")).toBeInTheDocument();
  });

  it("opens the bind modal from the bind button", async () => {
    apiMock.getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.com", phone: null });
    render(<PhoneBindingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "绑定手机" }));
    expect(screen.getByRole("dialog", { name: "绑定手机号" })).toBeInTheDocument();
  });
});

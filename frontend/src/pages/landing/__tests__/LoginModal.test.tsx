import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import LoginModal from "../LoginModal";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  sendSmsCode: vi.fn(),
  loginWithPhone: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../../store/authStore", () => ({
  useAuthStore: () => ({
    login: mocks.login,
    sendSmsCode: mocks.sendSmsCode,
    loginWithPhone: mocks.loginWithPhone,
  }),
}));
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

function renderModal() {
  return render(
    <MemoryRouter>
      <LoginModal onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

function switchToPhoneTab() {
  fireEvent.click(screen.getByRole("button", { name: "手机号" }));
}

afterEach(() => {
  mocks.login.mockReset();
  mocks.sendSmsCode.mockReset();
  mocks.loginWithPhone.mockReset();
  mocks.navigate.mockReset();
  vi.useRealTimers();
});

describe("LoginModal", () => {
  it("submits credentials and navigates home on success", async () => {
    mocks.login.mockResolvedValue(undefined);
    renderModal();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "runner@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith("runner@example.com", "secret123"));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/"));
  });

  it("shows a credential error on 401", async () => {
    mocks.login.mockRejectedValue({ status: 401 });
    renderModal();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "x@y.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));
    expect(await screen.findByText("邮箱或密码错误")).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('renders the overlay with the "open" class so it is visible when mounted', () => {
    // The .login-overlay CSS rule is display:none until the "open" class is added.
    // React mounts the modal conditionally, so it must always carry "open" — otherwise
    // the modal is in the DOM but invisible (caught by the browser smoke, missed by jsdom).
    renderModal();
    expect(screen.getByRole("dialog", { name: "登录 STRIDE" })).toHaveClass("open");
  });

  it("does not render OAuth or forgot-password entries", () => {
    renderModal();
    expect(screen.queryByText(/Google 继续/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Strava 继续/)).not.toBeInTheDocument();
    expect(screen.queryByText("忘记密码?")).not.toBeInTheDocument();
  });

  it("defaults to the email tab and swaps the form to phone on tab switch", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "邮箱" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();

    switchToPhoneTab();

    expect(screen.getByRole("button", { name: "手机号" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "邮箱" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toBeInTheDocument();
    expect(screen.getByLabelText("验证码")).toBeInTheDocument();
  });

  it("signs in with phone + code and navigates home", async () => {
    mocks.loginWithPhone.mockResolvedValue(undefined);
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    await waitFor(() => expect(mocks.loginWithPhone).toHaveBeenCalledWith("13800138000", "123456", ""));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/"));
  });

  it("sends a code and runs a 60s countdown on the resend button", async () => {
    vi.useFakeTimers();
    mocks.sendSmsCode.mockResolvedValue(undefined);
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    await act(async () => {});

    expect(mocks.sendSmsCode).toHaveBeenCalledWith("13800138000");
    expect(screen.getByRole("button", { name: /重新获取\(60s\)/ })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button", { name: /重新获取\(59s\)/ })).toBeDisabled();

    for (let second = 0; second < 59; second++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(screen.getByRole("button", { name: "获取验证码" })).not.toBeDisabled();
  });

  it("rejects a malformed phone locally without requesting a code", async () => {
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "138" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(await screen.findByText("请输入正确的手机号")).toBeInTheDocument();
    expect(mocks.sendSmsCode).not.toHaveBeenCalled();
  });

  it("rejects an 11-digit phone with an invalid prefix locally", async () => {
    // The backend's rule is ^1[3-9]\d{9}$; a bare 11-digit check would let
    // 10000000000 through and turn the ensuing bad_request into an invite prompt.
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "10000000000" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(await screen.findByText("请输入正确的手机号")).toBeInTheDocument();
    expect(mocks.sendSmsCode).not.toHaveBeenCalled();
  });

  it("rejects a malformed code locally without calling the API", async () => {
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    expect(await screen.findByText("请输入 6 位验证码")).toBeInTheDocument();
    expect(mocks.loginWithPhone).not.toHaveBeenCalled();
  });

  it("reveals the invite field on invalid_invite_code and resubmits with it", async () => {
    mocks.loginWithPhone.mockRejectedValueOnce({ status: 401, error: "invalid_invite_code" });
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    expect(await screen.findByText("邀请码无效")).toBeInTheDocument();
    const invite = screen.getByLabelText("邀请码");

    fireEvent.change(invite, { target: { value: "INVITE-1" } });
    mocks.loginWithPhone.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    await waitFor(() => expect(mocks.loginWithPhone).toHaveBeenLastCalledWith("13800138000", "123456", "INVITE-1"));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/"));
  });

  it("reveals the invite field when the backend requires an invite code", async () => {
    // Under an invite-gated deployment a brand-new phone with no invite code is
    // rejected with a generic bad_request ("invite_code is required") before the
    // SMS code is consumed — that is the backend's "new phone, needs an invite"
    // signal, so it must reveal the field without burning the code.
    mocks.loginWithPhone.mockRejectedValueOnce({ status: 400, error: "bad_request" });
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    expect(await screen.findByLabelText("邀请码")).toBeInTheDocument();
    expect(screen.getByText("请输入邀请码")).toBeInTheDocument();
  });

  it("keeps the invite field open on invite_code_already_used", async () => {
    mocks.loginWithPhone.mockRejectedValueOnce({ status: 409, error: "invite_code_already_used" });
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    expect(await screen.findByText("邀请码已被使用")).toBeInTheDocument();
    expect(screen.getByLabelText("邀请码")).toBeInTheDocument();
  });

  it.each([
    ["sms_code_invalid", "验证码错误"],
    ["sms_code_expired", "验证码已过期,请重新获取"],
    ["sms_attempts_exceeded", "尝试次数过多,请重新获取验证码"],
    ["sms_not_configured", "短信服务未配置,请使用邮箱登录"],
    ["service_unavailable", "服务暂时不可用,请稍后再试"],
    ["user_disabled", "账号已被禁用"],
  ])("maps %s to its message", async (error, message) => {
    mocks.loginWithPhone.mockRejectedValueOnce({ status: 400, error });
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it.each([
    ["sms_send_cooldown", "发送过于频繁,请稍后再试"],
    ["sms_daily_limit", "今日验证码次数已达上限"],
  ])("maps the send failure %s to its message", async (error, message) => {
    mocks.sendSmsCode.mockRejectedValueOnce({ status: 429, error });
    renderModal();
    switchToPhoneTab();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("clears the previous error when switching tabs", async () => {
    mocks.login.mockRejectedValue({ status: 401 });
    renderModal();
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "x@y.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /^登录$/ }));
    expect(await screen.findByText("邮箱或密码错误")).toBeInTheDocument();

    switchToPhoneTab();
    expect(screen.queryByText("邮箱或密码错误")).not.toBeInTheDocument();
  });
});

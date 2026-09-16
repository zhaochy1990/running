import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PhoneBindModal from "../PhoneBindModal";

const apiMock = vi.hoisted(() => ({
  bindPhone: vi.fn(),
}));

const store = vi.hoisted(() => ({
  sendSmsCode: vi.fn(),
}));

vi.mock("../../api", () => ({ bindPhone: apiMock.bindPhone }));
vi.mock("../../store/authStore", () => ({
  useAuthStore: () => store,
}));

function renderModal(props: Partial<React.ComponentProps<typeof PhoneBindModal>> = {}) {
  const onClose = vi.fn();
  const onBound = vi.fn();
  const utils = render(<PhoneBindModal open currentPhone={null} onClose={onClose} onBound={onBound} {...props} />);
  return { onClose, onBound, ...utils };
}

beforeEach(() => {
  store.sendSmsCode.mockReset().mockResolvedValue(undefined);
  apiMock.bindPhone.mockReset().mockResolvedValue({ ok: true, status: 200, data: { status: "ok" } });
});

describe("PhoneBindModal", () => {
  it("renders nothing while closed", () => {
    const { queryByRole } = render(
      <PhoneBindModal open={false} currentPhone={null} onClose={() => {}} />,
    );
    expect(queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends a bind-mode code (login_only false) and starts the countdown", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(store.sendSmsCode).toHaveBeenCalledWith("13800138000", { loginOnly: false });
    expect(await screen.findByText(/重新获取/)).toBeInTheDocument();
  });

  it("rejects an invalid phone before any request", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    expect(store.sendSmsCode).not.toHaveBeenCalled();
    expect(screen.getByText("请输入正确的手机号")).toBeInTheDocument();
  });

  it("binds on submit and fires onBound + onClose", async () => {
    const { onBound, onClose } = renderModal();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "绑定" }));
    });

    expect(apiMock.bindPhone).toHaveBeenCalledWith("13800138000", "123456");
    expect(onBound).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the phone_already_bound message when bind is rejected", async () => {
    apiMock.bindPhone.mockResolvedValue({ ok: false, status: 409, data: { error: "phone_already_bound" } });
    renderModal();
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "绑定" }));

    expect(await screen.findByText("该手机号已被其他账号绑定")).toBeInTheDocument();
  });

  it("renders the rebind mode with the masked current phone", () => {
    renderModal({ currentPhone: "13800138000" });
    expect(screen.getByRole("heading", { name: "更换手机号" })).toBeInTheDocument();
    expect(screen.getByText("当前手机号 138****8000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更换手机号" })).toBeInTheDocument();
  });
});

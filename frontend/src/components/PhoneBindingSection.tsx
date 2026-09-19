import { useEffect, useState } from "react";
import { getAuthUser, unbindPhone } from "../api";
import PhoneBindModal from "./PhoneBindModal";

const UNBIND_ERROR_MESSAGES: Record<string, string> = {
  cannot_unlink_last_account: "这是你唯一的登录方式，无法解绑",
  phone_not_bound: "当前未绑定手机号",
};

function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}

// The settings-page phone row: shows the bound phone (or a bind button), with
// 更换手机号 / 解绑 actions. Reuses PhoneBindModal for bind & rebind; unbind
// asks for confirmation and surfaces the last-login-method refusal.
export default function PhoneBindingSection() {
  const [phone, setPhone] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [error, setError] = useState("");

  const reload = () => {
    getAuthUser()
      .then((info) => setPhone(info.phone))
      .catch(() => setError("加载手机号信息失败"));
  };

  useEffect(() => {
    let cancelled = false;
    getAuthUser()
      .then((info) => {
        if (cancelled) return;
        setPhone(info.phone);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError("加载手机号信息失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnbind = async () => {
    setError("");
    setConfirmUnbind(false);
    try {
      const result = await unbindPhone();
      if (!result.ok) {
        const x = result.data as { error?: string };
        setError(UNBIND_ERROR_MESSAGES[x.error ?? ""] ?? "解绑失败，请重试");
        return;
      }
      setPhone(null);
    } catch {
      setError("解绑失败，请重试");
    }
  };

  return (
    <section className="mt-8 space-y-4">
      <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">手机号</h3>
      <p className="text-sm text-text-muted">绑定手机号后，可用短信验证码登录。</p>
      {error && (
        <div role="alert" className="text-sm text-red-400">
          {error}
        </div>
      )}

      {loaded &&
        (phone ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-card p-3">
            <div>
              <p className="text-sm text-text-primary">{maskPhone(phone)}</p>
              <p className="mt-0.5 text-xs text-text-muted">已绑定</p>
            </div>
            <div className="flex gap-3 text-sm">
              <button type="button" onClick={() => setBindOpen(true)} className="text-accent-green">
                更换手机号
              </button>
              <button type="button" onClick={() => setConfirmUnbind(true)} className="text-red-400">
                解绑
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setBindOpen(true)}
            className="w-full rounded-lg border border-accent-green/40 px-4 py-2 text-sm text-accent-green hover:bg-accent-green/10 transition-colors"
          >
            绑定手机
          </button>
        ))}

      {confirmUnbind && phone && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm text-text-primary">
            确定要解绑手机号 {maskPhone(phone)} 吗？解绑后将无法再用该手机号登录。
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => setConfirmUnbind(false)} className="rounded-lg border border-border-subtle px-3 py-1.5 text-sm text-text-secondary">
              取消
            </button>
            <button type="button" onClick={() => void handleUnbind()} className="rounded-lg bg-red-500/90 px-3 py-1.5 text-sm text-bg-base">
              确认解绑
            </button>
          </div>
        </div>
      )}

      <PhoneBindModal open={bindOpen} currentPhone={phone} onClose={() => setBindOpen(false)} onBound={reload} secondaryLabel="取消" />
    </section>
  );
}

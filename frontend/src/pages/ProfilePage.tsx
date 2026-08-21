import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  createInjury,
  deleteInjury,
  deleteMyAccount,
  getMyProfile,
  listInjuries,
  patchMyProfile,
  updateInjury,
  type InjuryInput,
  type InjuryRecord,
  type ProfilePatchIn,
  type RunningAgeRange,
} from "../api";
import { useAuthStore } from "../store/authStore";
import { useUser } from "../UserContextValue";

interface FieldError {
  [field: string]: string;
}
interface ProfilePageProps {
  embedded?: boolean;
}

const AGE_OPTIONS: { value: RunningAgeRange; label: string }[] = [
  { value: "unknown", label: "不确定 / 暂不透露" },
  { value: "lt_6m", label: "不足 6 个月" },
  { value: "6m_1y", label: "6 个月至 1 年" },
  { value: "1y_3y", label: "1 至 3 年" },
  { value: "3y_plus", label: "3 年以上" },
];

const inputCls = (field?: string, errors: FieldError = {}) =>
  `w-full rounded-lg border px-3 py-2 text-sm text-text-primary bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent-green ${field && errors[field] ? "border-red-500/60" : "border-border-subtle"}`;

export default function ProfilePage({ embedded }: ProfilePageProps = {}) {
  const navigate = useNavigate();
  const { refresh } = useUser();
  const clearSession = useAuthStore((s) => s.clearSession);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldError>({});
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [runningAgeRange, setRunningAgeRange] = useState<RunningAgeRange>("unknown");

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        const profile = p.profile || {};
        setDisplayName(p.display_name || String(profile.display_name || ""));
        setDob(String(profile.dob || ""));
        setSex(String(profile.sex || ""));
        setHeightCm(profile.height_cm != null ? String(profile.height_cm) : "");
        setWeightKg(profile.weight_kg != null ? String(profile.weight_kg) : "");
        setRunningAgeRange((p.running_age_range || profile.running_age_range || "unknown") as RunningAgeRange);
      })
      .catch(() => setError("加载资料失败"))
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setFieldErrors({});
    setSaving(true);
    const patch: ProfilePatchIn = {};
    if (displayName.trim()) patch.display_name = displayName.trim();
    if (dob) patch.dob = dob;
    if (sex) patch.sex = sex;
    if (heightCm) patch.height_cm = parseFloat(heightCm);
    if (weightKg) patch.weight_kg = parseFloat(weightKg);
    patch.running_age_range = runningAgeRange;
    try {
      const result = await patchMyProfile(patch);
      if (result.ok) {
        setSuccess("个人资料已保存");
        await refresh();
      } else if (result.status === 422) {
        const detail = (result.data as { detail?: unknown }).detail;
        if (Array.isArray(detail)) {
          const errs: FieldError = {};
          for (const item of detail) {
            const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : "error";
            errs[String(field)] = item.msg || "无效值";
          }
          setFieldErrors(errs);
        } else setError("输入数据有误，请检查各字段");
      } else setError(`保存失败 (${result.status})`);
    } catch {
      setError("请求失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const deletionErrorMessage = (status: number, detail: unknown) => {
    if (status === 409) return "注销失败：你仍然拥有团队。请先到团队页面转让队长或解散团队，然后再注销账号。";
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object" && "message" in detail && typeof (detail as { message?: unknown }).message === "string")
      return (detail as { message: string }).message;
    return `注销失败 (${status})`;
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirm.trim() !== "删除账号" || deleting) return;
    setError("");
    setSuccess("");
    setDeleting(true);
    try {
      const result = await deleteMyAccount();
      if (!result.ok) {
        setError(deletionErrorMessage(result.status, result.data.detail));
        return;
      }
      clearSession();
      navigate("/login", { replace: true });
    } catch {
      setError("注销请求失败，请重试");
    } finally {
      setDeleting(false);
    }
  };

  if (loading)
    return (
      <div className={embedded ? "py-10 flex items-center justify-center" : "max-w-3xl mx-auto px-8 py-20 flex items-center justify-center"}>
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    );

  return (
    <div className={embedded ? "" : "max-w-3xl mx-auto px-4 py-6 sm:px-8 sm:py-8"}>
      {!embedded && (
        <>
          <button onClick={() => navigate(-1)} className="text-xs font-mono text-text-muted hover:text-text-secondary mb-4">
            ← 返回
          </button>
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-text-primary">个人资料</h1>
            <p className="text-sm font-mono text-text-muted mt-1">更新个人资料、跑龄和伤病记录</p>
          </div>
        </>
      )}
      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="mb-4 rounded-lg bg-accent-green/10 border border-accent-green/30 px-3 py-2 text-sm text-accent-green">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <section className="space-y-4">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">个人资料与跑龄</h3>
          <div>
            <label className="block text-xs font-mono text-text-muted mb-1">显示名称</label>
            <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls("display_name", fieldErrors)} />
            {fieldErrors.display_name && <p className="text-xs text-red-400 mt-1">{fieldErrors.display_name}</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted mb-1">出生日期</label>
              <input type="date" required value={dob} onChange={(e) => setDob(e.target.value)} className={inputCls("dob", fieldErrors)} />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted mb-1">性别</label>
              <select required value={sex} onChange={(e) => setSex(e.target.value)} className={inputCls("sex", fieldErrors)}>
                <option value="">请选择</option>
                <option value="male">男</option>
                <option value="female">女</option>
                <option value="other">其他</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-text-muted mb-1">身高 (cm)</label>
              <input
                type="number"
                required
                min="100"
                max="250"
                step="0.1"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                className={inputCls("height_cm", fieldErrors)}
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted mb-1">体重 (kg)</label>
              <input
                type="number"
                required
                min="30"
                max="300"
                step="0.1"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                className={inputCls("weight_kg", fieldErrors)}
              />
            </div>
          </div>
          <div>
            <label htmlFor="settings-running-age" className="block text-xs font-mono text-text-muted mb-1">
              跑龄
            </label>
            <select
              id="settings-running-age"
              required
              value={runningAgeRange}
              onChange={(e) => setRunningAgeRange(e.target.value as RunningAgeRange)}
              className={inputCls("running_age_range", fieldErrors)}
            >
              {AGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存个人资料"}
          </button>
        </section>
      </form>

      <InjuryManager />

      <section className="mt-10 rounded-2xl border border-red-500/30 bg-red-500/5 p-5">
        <h3 className="text-sm font-semibold text-red-400">危险区：注销账号</h3>
        <p className="mt-2 text-sm leading-6 text-text-secondary">注销会永久删除你的账号及训练数据。该操作无法恢复。</p>
        <label className="mt-4 block text-xs font-mono text-text-muted">输入“删除账号”以确认</label>
        <input
          type="text"
          value={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.value)}
          className="mt-2 w-full rounded-lg border border-red-500/30 bg-bg-base px-3 py-2 text-sm text-text-primary"
          placeholder="删除账号"
        />
        <button
          type="button"
          onClick={handleDeleteAccount}
          disabled={deleting || deleteConfirm.trim() !== "删除账号"}
          className="mt-4 w-full rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 disabled:opacity-50"
        >
          {deleting ? "正在注销..." : "永久注销账号"}
        </button>
      </section>
    </div>
  );
}

function InjuryManager() {
  const [items, setItems] = useState<InjuryRecord[]>([]);
  const [form, setForm] = useState<InjuryInput>({ description: "", recovery_status: "active", running_restriction: "easy_only" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    if (typeof listInjuries !== "function") return;
    try {
      setItems((await listInjuries()).items);
      setError("");
    } catch {
      setError("加载伤病记录失败");
    }
  };
  useEffect(() => {
    if (typeof listInjuries !== "function") return undefined;
    let active = true;
    listInjuries()
      .then((response) => {
        if (!active) return;
        setItems(response.items);
        setError("");
      })
      .catch(() => {
        if (active) setError("加载伤病记录失败");
      });
    return () => {
      active = false;
    };
  }, []);

  const reset = () => {
    setEditingId(null);
    setForm({ description: "", recovery_status: "active", running_restriction: "easy_only" });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.description.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, description: form.description.trim() };
      const result = editingId ? await updateInjury(editingId, payload) : await createInjury(payload);
      if (!result.ok) {
        setError("伤病记录保存失败，请检查输入");
        return;
      }
      reset();
      await reload();
    } catch {
      setError("伤病记录保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    try {
      const result = await deleteInjury(id);
      if (!result.ok) setError("删除伤病记录失败");
      else await reload();
    } catch {
      setError("删除伤病记录失败");
    }
  };

  return (
    <section className="mt-8 space-y-4">
      <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">伤病记录</h3>
      <p className="text-sm text-text-muted">独立保存，更新会立即生效。</p>
      {error && (
        <div role="alert" className="text-sm text-red-400">
          {error}
        </div>
      )}
      {items.map((item) => (
        <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-bg-card p-3">
          <div>
            <p className="text-sm text-text-primary">{item.description}</p>
            <p className="mt-1 text-xs text-text-muted">
              {item.recovery_status === "active" ? "恢复中" : "已恢复"} ·{" "}
              {item.running_restriction === "none" ? "不限跑" : item.running_restriction === "easy_only" ? "仅轻松跑" : "暂不跑"}
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              className="text-accent-green"
              onClick={() => {
                setEditingId(item.id);
                setForm({ description: item.description, recovery_status: item.recovery_status, running_restriction: item.running_restriction });
              }}
            >
              编辑
            </button>
            <button type="button" className="text-red-400" onClick={() => void remove(item.id)}>
              删除
            </button>
          </div>
        </div>
      ))}
      <form onSubmit={save} className="space-y-3">
        <textarea
          required
          maxLength={1000}
          rows={3}
          aria-label="伤病描述"
          placeholder="例：左膝疼痛"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary"
        />
        <div className="grid grid-cols-2 gap-3">
          <select
            aria-label="伤病状态"
            value={form.recovery_status}
            onChange={(e) => {
              const status = e.target.value as InjuryInput["recovery_status"];
              setForm({
                ...form,
                recovery_status: status,
                running_restriction: status === "recovered" ? "none" : form.running_restriction === "none" ? "easy_only" : form.running_restriction,
              });
            }}
            className="rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary"
          >
            <option value="active">恢复中</option>
            <option value="recovered">已恢复</option>
          </select>
          <select
            aria-label="跑步限制"
            value={form.running_restriction}
            onChange={(e) => setForm({ ...form, running_restriction: e.target.value as InjuryInput["running_restriction"] })}
            className="rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary"
          >
            <option value="none">不限跑</option>
            <option value="easy_only">仅轻松跑</option>
            <option value="no_running">暂不跑</option>
          </select>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving || !form.description.trim()}
            className="flex-1 rounded-lg bg-accent-green px-4 py-2 text-sm text-bg-base disabled:opacity-50"
          >
            {saving ? "保存中..." : editingId ? "更新记录" : "添加伤病记录"}
          </button>
          {editingId && (
            <button type="button" onClick={reset} className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary">
              取消
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

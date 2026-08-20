import { useEffect, useState, type FormEvent } from "react";
import { createInjury, deleteInjury, listInjuries, updateInjury, type InjuryInput, type InjuryRecord } from "../../api";

interface Props {
  onSuccess: () => void;
}

type RecoveryStatus = InjuryInput["recovery_status"];
type RunningRestriction = InjuryInput["running_restriction"];

const emptyForm: InjuryInput = {
  description: "",
  recovery_status: "active",
  running_restriction: "easy_only",
};

export default function InjuryStep({ onSuccess }: Props) {
  const [items, setItems] = useState<InjuryRecord[]>([]);
  const [form, setForm] = useState<InjuryInput>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const reload = async () => {
    setLoading(true);
    try {
      setItems((await listInjuries()).items);
      setError("");
    } catch {
      setError("加载伤病记录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    listInjuries()
      .then((response) => {
        if (!active) return;
        setItems(response.items);
        setError("");
      })
      .catch(() => {
        if (active) setError("加载伤病记录失败，请重试");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.description.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = editingId
        ? await updateInjury(editingId, { ...form, description: form.description.trim() })
        : await createInjury({ ...form, description: form.description.trim() });
      if (!result.ok) {
        setError("保存伤病记录失败，请检查输入");
        return;
      }
      resetForm();
      await reload();
    } catch {
      setError("保存伤病记录失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      const result = await deleteInjury(id);
      if (!result.ok) {
        setError("删除伤病记录失败，请重试");
        return;
      }
      await reload();
    } catch {
      setError("删除伤病记录失败，请重试");
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">记录伤病情况</h2>
        <p className="mt-1 text-sm text-text-muted">可选。保存后会立即生效，也可以跳过。</p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {!loading && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-border-subtle bg-bg-base p-3">
              <div className="flex items-start justify-between gap-3">
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
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="injury-description" className="mb-1 block text-xs font-mono uppercase tracking-wider text-text-muted">
            描述
          </label>
          <textarea
            id="injury-description"
            required
            maxLength={1000}
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className={inputCls}
            placeholder="例：左膝疼痛"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-text-muted">
            状态
            <select
              value={form.recovery_status}
              onChange={(e) => {
                const status = e.target.value as RecoveryStatus;
                setForm({
                  ...form,
                  recovery_status: status,
                  running_restriction: status === "recovered" ? "none" : form.running_restriction === "none" ? "easy_only" : form.running_restriction,
                });
              }}
              className={`${inputCls} mt-1`}
            >
              <option value="active">恢复中</option>
              <option value="recovered">已恢复</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            跑步限制
            <select
              value={form.running_restriction}
              onChange={(e) => setForm({ ...form, running_restriction: e.target.value as RunningRestriction })}
              className={`${inputCls} mt-1`}
            >
              <option value="none">不限跑</option>
              <option value="easy_only">仅轻松跑</option>
              <option value="no_running">暂不跑</option>
            </select>
          </label>
        </div>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving || !form.description.trim()}
            className="flex-1 rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-bg-base disabled:opacity-50"
          >
            {saving ? "保存中..." : editingId ? "更新记录" : "保存记录"}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm} className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary">
              取消
            </button>
          )}
        </div>
      </form>

      <button
        type="button"
        onClick={onSuccess}
        className="w-full rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
      >
        跳过，继续
      </button>
    </div>
  );
}

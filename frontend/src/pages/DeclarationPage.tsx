/**
 * DeclarationPage — 公开法务声明页（隐私政策 / 用户协议）。
 *
 * App Store 提审硬要求「公开可访问的隐私政策 URL」（devops#750 调研、
 * devops#759 发布流程 / devops#773 收官票执行项）。Web 侧此前没有公开
 * 路由（所有内容路由都在登录门后），本页补齐：`https://stride-running.cn/privacy`。
 *
 * 数据源与 iOS DeclarationView / 小程序声明页同一公开端点
 * `GET /api/declarations/{doc_type}`（auth:false），内容即运营发布的
 * markdown 正文——三端单一事实源，不在前端硬编码副本。
 *
 * 渲染复用 SafeMarkdown（安全口径见该组件）：永不 rehypeRaw，链接
 * scheme 白名单。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import SafeMarkdown from "../components/SafeMarkdown";
import { apiUrl } from "../lib/apiRouting";

export type DeclarationDocType = "privacy_policy" | "user_agreement";

interface DeclarationPageProps {
  docType: DeclarationDocType;
}

interface DeclarationResponse {
  doc_type: string;
  version: number;
  title: string;
  effective_at: string;
  updated_at: string;
  content_markdown: string;
}

type LoadState = "loading" | "ready" | "missing" | "error";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function DeclarationPage({ docType }: DeclarationPageProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [doc, setDoc] = useState<DeclarationResponse | null>(null);
  // 重试计数器：按钮事件里 +1 触发 effect 重拉（「回到 loading」由按钮
  // 事件处理器置位；effect 体内不同步 setState——沿 ActivitiesPage 口径）。
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("GET", `/api/declarations/${docType}`))
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setState("missing");
          return;
        }
        if (!res.ok) {
          setState("error");
          return;
        }
        setDoc((await res.json()) as DeclarationResponse);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [docType, reloadToken]);

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-10 text-text-primary">
      <div className="mx-auto max-w-2xl">
        {state === "loading" && (
          <div className="flex items-center justify-center py-20">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent-green/30 border-t-accent-green" />
          </div>
        )}

        {state === "missing" && (
          <div className="flex flex-col items-center gap-2 py-20 text-center">
            <p className="text-sm text-text-muted">该声明尚未发布</p>
          </div>
        )}

        {state === "error" && (
          <div className="flex flex-col items-center gap-4 py-20 text-center">
            <p className="text-sm text-text-muted">加载失败，请检查网络后重试</p>
            <button
              type="button"
              onClick={() => {
                setState("loading");
                setReloadToken((token) => token + 1);
              }}
              className="rounded-md border border-accent-green/40 px-4 py-2 text-sm text-accent-green transition-colors hover:bg-accent-green/10"
            >
              重试
            </button>
          </div>
        )}

        {state === "ready" && doc && (
          <article className="prose max-w-none">
            <SafeMarkdown content={doc.content_markdown} />
            {doc.effective_at && (
              <p className="mt-8 border-t border-border-subtle pt-4 text-xs text-text-muted">
                生效日期：{formatDate(doc.effective_at)} · v{doc.version}
              </p>
            )}
          </article>
        )}

        <footer className="mt-12 border-t border-border-subtle pt-6 text-center text-xs text-text-muted">
          <Link to="/" className="text-accent-green/80 hover:text-accent-green">
            StrideWise · 马拉松训练助手
          </Link>
        </footer>
      </div>
    </main>
  );
}

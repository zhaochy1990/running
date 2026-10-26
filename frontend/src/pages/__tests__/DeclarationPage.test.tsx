import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import DeclarationPage from "../DeclarationPage";

/**
 * 公开声明页（App Store 隐私政策 URL 合规件，devops#773）。
 * 核对点：公开端点拉取、404 分流、markdown 正文渲染、危险链接惰性化。
 * 页脚 Link 需要 Router 上下文 → MemoryRouter 包一层。
 */
function renderPage(docType: "privacy_policy" | "user_agreement" = "privacy_policy") {
  return render(
    <MemoryRouter>
      <DeclarationPage docType={docType} />
    </MemoryRouter>,
  );
}
describe("DeclarationPage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function mockDeclaration() {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          doc_type: "privacy_policy",
          version: 3,
          title: "隐私政策",
          effective_at: "2026-09-16T06:16:32.608Z",
          updated_at: "2026-09-16T06:16:32.608Z",
          content_markdown: "# 隐私政策\n\n**正文段落** 与 [官网](https://stride-running.cn) 链接",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  it("renders markdown content from the public declarations endpoint", async () => {
    mockDeclaration();

    renderPage("privacy_policy");

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "隐私政策" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/declarations/privacy_policy"));
    expect(screen.getByText("正文段落")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "官网" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://stride-running.cn/");
    expect(link.rel).toContain("noopener");
    // 生效日期脚注（UTC ISO → YYYY-MM-DD）
    expect(screen.getByText(/生效日期：2026-09-16/)).toBeInTheDocument();
  });

  it("renders a not-published empty state on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    renderPage("user_agreement");

    await waitFor(() => {
      expect(screen.getByText("该声明尚未发布")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/declarations/user_agreement"));
  });

  it("offers retry after a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    renderPage("privacy_policy");

    await waitFor(() => {
      expect(screen.getByText("加载失败，请检查网络后重试")).toBeInTheDocument();
    });

    mockDeclaration();
    screen.getByRole("button", { name: "重试" }).click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "隐私政策" })).toBeInTheDocument();
    });
  });

  it("never turns javascript: links into clickable anchors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          doc_type: "privacy_policy",
          version: 1,
          title: "隐私政策",
          effective_at: "2026-09-16T06:16:32.608Z",
          updated_at: "2026-09-16T06:16:32.608Z",
          content_markdown: "[危险](javascript:alert(1))",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderPage("privacy_policy");

    await waitFor(() => {
      expect(screen.getByText("危险")).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "危险" })).not.toBeInTheDocument();
  });
});

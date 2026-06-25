# -*- coding: utf-8 -*-
"""Build a print-ready PDF from the product-vision Markdown via Edge headless."""
import pathlib, subprocess, sys, urllib.parse
import markdown

HERE = pathlib.Path(__file__).resolve().parent
MD = HERE / "STRIDE_COACH_PRODUCT_VISION.md"
HTML = HERE / "STRIDE_COACH_PRODUCT_VISION.html"
PDF = HERE / "STRIDE_COACH_PRODUCT_VISION.pdf"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

CSS = """
@page { size: A4; margin: 17mm 15mm 16mm 15mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
       font-size: 10.8pt; line-height: 1.55; color:#1a1a1a; }
h1,h2,h3 { word-break: keep-all; line-break: strict; }
h1 { font-size: 19pt; color:#0f172a; border-bottom:3px solid #16a34a;
     padding-bottom:6px; margin-top:0; }
h2 { font-size: 15pt; color:#15803d; border-bottom:1px solid #e2e8f0;
     padding-bottom:3px; margin-top:1.5em; page-break-after:avoid; }
h3 { font-size: 12.5pt; color:#166534; margin-top:1.1em; page-break-after:avoid; }
table { border-collapse:collapse; width:100%; font-size:9.3pt; margin:9px 0; }
th,td { border:1px solid #cbd5e1; padding:5px 7px; text-align:left; vertical-align:top; }
th { background:#f0fdf4; color:#14532d; }
tr,td,th { page-break-inside:avoid; }
code { background:#f1f5f9; padding:1px 4px; border-radius:3px;
       font-family:Consolas,monospace; font-size:9pt; color:#be123c; }
pre { background:#f8fafc; border:1px solid #e2e8f0; padding:10px;
      border-radius:6px; overflow:auto; page-break-inside:avoid; }
pre code { background:none; color:#0f172a; }
blockquote { border-left:4px solid #16a34a; margin:9px 0; padding:5px 13px;
             color:#475569; background:#f8fafc; }
a { color:#15803d; text-decoration:none; }
strong { color:#0f172a; }
hr { border:none; border-top:1px solid #e5e7eb; margin:1.3em 0; }
ul,ol { margin:6px 0 6px 0; padding-left:22px; }
li { margin:2px 0; }
"""

def main():
    text = MD.read_text(encoding="utf-8")
    body = markdown.markdown(
        text,
        extensions=["tables", "fenced_code", "sane_lists", "attr_list", "toc", "nl2br"],
    )
    html = (f"<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
            f"<style>{CSS}</style></head><body>{body}</body></html>")
    HTML.write_text(html, encoding="utf-8")

    # Decide target; delete stale first so a locked file can't masquerade as success.
    target = PDF
    if PDF.exists():
        try:
            PDF.unlink()
        except PermissionError:
            target = HERE / "STRIDE_COACH_PRODUCT_VISION_NEW.pdf"
            print(f"[WARN] 原 PDF 被占用（查看器没关）-> 改写到新文件: {target.name}")
            if target.exists():
                try:
                    target.unlink()
                except PermissionError:
                    sys.exit("新文件也被占用，请关闭所有 PDF 查看器后重试。")

    url = "file:///" + str(HTML).replace("\\", "/")
    cmd = [EDGE, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
           f"--print-to-pdf={target}", "--print-to-pdf-no-header", url]
    print("Running Edge headless...")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not target.exists():
        print("STDERR:", r.stderr[-2000:]); sys.exit("PDF not produced")
    print(f"OK -> {target}  ({target.stat().st_size//1024} KB)  written fresh")

if __name__ == "__main__":
    import urllib.request
    main()

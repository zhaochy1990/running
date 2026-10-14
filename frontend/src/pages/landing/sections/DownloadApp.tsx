const ANDROID_RELEASES_URL =
  "https://github.com/zhaochy1990/running/releases/latest";

// #467 收尾域：Landing「下载 App」区 —— Android 侧载 GitHub Releases，
// iOS / 鸿蒙 备案与上架进行中标注「即将上线」（#424 决议；上架后换商店链接为主）。
export default function DownloadApp() {
  return (
    <section className="download-app" id="download">
      <div className="wrap">
        <span className="eyebrow">下载 App</span>
        <h2>
          把训练装进<em>口袋</em>
        </h2>
        <p>
          STRIDE Android 客户端已开放侧载下载，手表同步、比赛策略与配速海报随身携带。
        </p>
        <div className="download-app__actions">
          <a
            className="download-app__btn download-app__btn--primary"
            href={ANDROID_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Android 下载
          </a>
          <span className="download-app__btn download-app__btn--soon">
            iOS · 即将上线
          </span>
          <span className="download-app__btn download-app__btn--soon">
            鸿蒙 · 即将上线
          </span>
        </div>
        <div className="download-app__note">
          Android 侧载安装包来自 GitHub Releases（自动跳转最新版本）
        </div>
      </div>
    </section>
  );
}

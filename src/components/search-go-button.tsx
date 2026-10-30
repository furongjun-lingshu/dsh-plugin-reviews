/**
 * 搜索按钮：主创定的形态（M3 filled 圆形 + 放大镜图标），与输入框同一行。
 *
 * 为什么抽成组件：站内搜索框有七处（首页 / 插件目录 / 评测列表 / 整合包 / 我的评测 /
 * 收藏 / 选插件），此前只有前三个是放大镜，其余写着「搜索」两个字——同一类动作在站内
 * 长出两种样子。现在统一走这里，改一次全站一致，也不必再手抄 SVG 路径。
 */

export function SearchGoButton({ label = '搜索' }: { label?: string }) {
  return (
    <button type="submit" className="search-go" aria-label={label}>
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
    </button>
  );
}

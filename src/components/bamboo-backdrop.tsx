/**
 * 竹叶感背景装饰（古风高雅 + 轻量叶片飘荡）。
 *
 * 纯 SVG + CSS 动画：不引图片资源、不加 JS 依赖。
 *  - 两角竹枝：细笔茎 + 几片竹叶，对角呼应，极低透明度（纸面肌理，不抢正文）；
 *  - 飘落的竹叶：7 片，各走一条慢速弧线下落（20~40 秒/片），到顶淡入、落地淡出；
 *  - prefers-reduced-motion: reduce 时叶片动画整体关闭（装饰不打扰阅读）。
 *
 * 固定在视口最底层（z-index 0），页面内容（.site-main）抬到 1 之上；
 * pointer-events: none —— 永远不挡点击。
 *
 * 竹叶符号只定义一次（<defs><symbol>），其余 <use> 复用；同一文档内跨 svg 引用成立。
 */
export function BambooBackdrop() {
  return (
    <div className="bamboo-backdrop" aria-hidden="true">
      {/* 竹叶符号：细长、微弯、尖头——古画笔意的基本形 */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <symbol id="bamboo-leaf" viewBox="0 0 24 64">
            <path d="M12 0.5 C5 17 1 37 0.4 63 C8 51 17 30 22.6 10 C20.6 4 16.6 0.5 12 0.5 Z" />
          </symbol>
        </defs>
      </svg>

      {/* 左上竹枝 */}
      <svg className="bamboo-branch branch-tl" viewBox="0 0 260 260">
        <g fill="none" stroke="currentColor" strokeLinecap="round">
          <path d="M-6 20 C 50 40, 94 88, 116 164" strokeWidth="2.2" />
          <path d="M34 42 C 42 76, 38 106, 20 140" strokeWidth="1.2" opacity="0.65" />
          <path d="M74 70 C 92 92, 116 102, 144 98" strokeWidth="1.2" opacity="0.65" />
        </g>
        <g fill="currentColor">
          <use href="#bamboo-leaf" transform="translate(16 30) rotate(40) scale(0.66)" />
          <use href="#bamboo-leaf" transform="translate(56 64) rotate(66) scale(0.54)" />
          <use href="#bamboo-leaf" transform="translate(94 106) rotate(96) scale(0.62)" />
          <use href="#bamboo-leaf" transform="translate(124 152) rotate(118) scale(0.46)" />
          <use href="#bamboo-leaf" transform="translate(202 26) rotate(-26) scale(0.4)" opacity="0.75" />
        </g>
      </svg>

      {/* 右下竹枝：整体水平镜像，与左上对角呼应 */}
      <svg className="bamboo-branch branch-br" viewBox="0 0 260 260">
        <g fill="none" stroke="currentColor" strokeLinecap="round">
          <path d="M-6 20 C 50 40, 94 88, 116 164" strokeWidth="2.2" />
          <path d="M34 42 C 42 76, 38 106, 20 140" strokeWidth="1.2" opacity="0.65" />
          <path d="M74 70 C 92 92, 116 102, 144 98" strokeWidth="1.2" opacity="0.65" />
        </g>
        <g fill="currentColor">
          <use href="#bamboo-leaf" transform="translate(16 30) rotate(40) scale(0.66)" />
          <use href="#bamboo-leaf" transform="translate(56 64) rotate(66) scale(0.54)" />
          <use href="#bamboo-leaf" transform="translate(94 106) rotate(96) scale(0.62)" />
          <use href="#bamboo-leaf" transform="translate(124 152) rotate(118) scale(0.46)" />
          <use href="#bamboo-leaf" transform="translate(202 26) rotate(-26) scale(0.4)" opacity="0.75" />
        </g>
      </svg>

      {/* 飘落竹叶：7 片，CSS 变量 --i 决定起点/节奏/速度 */}
      {Array.from({ length: 7 }).map((_, i) => (
        <span key={i} className="bamboo-leaf" style={{ ['--i' as string]: String(i) }}>
          <svg viewBox="0 0 24 64">
            <use href="#bamboo-leaf" />
          </svg>
        </span>
      ))}
    </div>
  );
}

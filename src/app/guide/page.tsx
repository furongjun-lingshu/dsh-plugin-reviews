import Link from 'next/link';
import type { Metadata } from 'next';
import { BackLink } from '@/components/back-link';

/**
 * 使用教程（给访客与普通用户看的入门页）。
 *
 * 定位：**3 分钟看懂的浓缩版**。完整版在 docs/教程-普通用户与访客.md。
 * 两份内容同源但定位不同——这里只留「第一次用必须知道」的六块，
 * 不要往这里堆细节，否则会和文档变成两份要同步的长文。
 *
 * ⚠️ 改内容时两处一起改（docs 与本站内页）。
 *
 * 纯静态页：无登录、无数据库，任何访客都能读——这与「访客能做什么」
 * 这一节的主张一致，教程自己就不该要求登录。
 */
export const metadata: Metadata = {
  title: '使用教程 · DSH 插件评测',
  description: '第一次来先看这里：三类内容是什么、要不要登录、怎么找插件、怎么投稿、有问题找谁。',
};

const V = { fontSize: 13, lineHeight: 1.7 } as const;
const cell = { padding: '8px 10px', borderBottom: '1px solid var(--line, #e3e7dd)', verticalAlign: 'top' } as const;
const h2 = { fontSize: 16, marginTop: 28, marginBottom: 10 } as const;

export default function GuidePage() {
  return (
    <div>
      <BackLink href="/">返回首页</BackLink>
      <h1>使用教程</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        第一次来先看这一页。想看完整版，仓库里有 <code>docs/教程-普通用户与访客.md</code>。
      </p>

      <h2 style={h2}>一、这里有哪三类内容</h2>
      <p style={V}>
        这是一个插件测评站。三个东西的关系是：<strong>插件是被测的对象，评测是关于它的结论，整合包是打包好的推荐组合。</strong>
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>内容</th>
            <th style={{ ...cell, textAlign: 'left' }}>是什么</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={cell}>插件</td>
            <td style={cell}>站点收录的 DSH 插件，记录仓库、版本、简介</td>
          </tr>
          <tr>
            <td style={cell}>评测</td>
            <td style={cell}>有人真的把它跑起来测试后写的报告</td>
          </tr>
          <tr>
            <td style={cell}>整合包</td>
            <td style={cell}>一组插件的组合，附一条可复制的安装命令</td>
          </tr>
        </tbody>
      </table>
      <p style={V}>
        另外还有<strong>讨论区</strong>（用户之间交流）与<strong>精选专栏</strong>（站方编辑挑选的推荐位）。
      </p>
      <p style={V}>
        精选是<strong>站方编辑挑的推荐位，不是评测结论本身</strong>。挑选时优先选已经有站方测评的插件，
        但精选只负责推荐——某个插件好不好用，仍以它详情页里的测评列表为准。
      </p>

      <h2 style={h2}>二、要不要登录</h2>
      <p style={V}>
        <strong>不登录也能用大部分内容。</strong>插件、评测、整合包、讨论区，访客都看得到。
        需要登录的是「产生内容」与「记录偏好」的操作。
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>功能</th>
            <th style={{ ...cell, textAlign: 'left' }}>访客</th>
            <th style={{ ...cell, textAlign: 'left' }}>登录后</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['看插件 / 评测 / 整合包 / 讨论区', true, true],
            ['发评测', false, true],
            ['评论、点赞', false, true],
            ['收藏', false, true],
            ['在讨论区发帖', false, true],
            ['举报违规内容', false, true],
            ['收到通知', false, true],
          ].map(([label, guest, logged]) => (
            <tr key={String(label)}>
              <td style={cell}>{String(label)}</td>
              <td style={cell}>{guest ? '✅' : '❌'}</td>
              <td style={cell}>{logged ? '✅' : '❌'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={V}>
        登录入口在页面<strong>右上角</strong>，用 GitHub 账号，不需要另外注册密码。
      </p>

      <h2 style={h2}>三、怎么找东西</h2>
      <ul style={{ ...V, paddingLeft: 20 }}>
        <li>
          <strong>找插件</strong>：顶部导航「插件」进目录，可以搜索、按分类筛选、按更新时间或评测数量排序。
        </li>
        <li>
          <strong>读评测</strong>：导航「评测」，也可以在插件详情页的评测列表里进。
        </li>
        <li>
          <strong>找整合包</strong>：导航「整合包」。整合包和插件的收藏是分开的。
        </li>
      </ul>

      <h2 style={h2}>四、这里的评测为什么没有星级</h2>
      <p style={V}>
        <strong>本站不给总分、不用星级。</strong>一篇评测的结论只能是五个之一：
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>结论</th>
            <th style={{ ...cell, textAlign: 'left' }}>需要证据链</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['真有用', '必须'],
            ['帮倒忙', '必须'],
            ['没啥差别', '必须'],
            ['还说不准', '不需要'],
            ['没法测', '不需要'],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={cell}>{k}</td>
              <td style={cell}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={V}>
        有结论的三者<strong>必须附带至少一条能点开的链接</strong>（复现步骤、日志、对比记录）。
        这样你看到的结论背后都有东西可查，而不是一句主观感受。
      </p>

      <h2 style={h2}>五、怎么投稿</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>你想做</th>
            <th style={{ ...cell, textAlign: 'left' }}>从哪进</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['写一篇评测', '插件详情页的「写一篇评测」'],
            ['让站上收录一个插件', '插件页的「提交插件」'],
            ['做一个整合包', '「我的 → 整合包」的「新建整合包」'],
            ['在讨论区发帖', '讨论区 → 分区 → 发帖'],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={cell}>{k}</td>
              <td style={cell}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={V}>
        写评测最常见的卡点：选了「真有用 / 帮倒忙 / 没啥差别」但没填证据链，提交会被拒。
        补上复现步骤，或把结论改成「还说不准」，就能提交。
      </p>

      <h2 style={h2}>六、有问题该找谁</h2>
      <p style={V}>
        站上有<strong>三条</strong>看起来都能提问题的通道，但它们管的事完全不同。用错会白等很久。
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>你要说的事</th>
            <th style={{ ...cell, textAlign: 'left' }}>走哪条</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['这篇内容是假的 / 骂人的 / 抄的', '举报（内容上的举报按钮）'],
            ['这个插件的名字或简介写错了', '反馈资料错误（插件详情页）'],
            ['网站点了没反应 / 账号登不上 / 想提建议', '问题反馈（右上角账户菜单，需登录）'],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={cell}>{k}</td>
              <td style={cell}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={V}>
        <strong>讨论区不是反馈通道。</strong>在讨论区发帖说「这个 bug 怎么还没修」大概率没人处理——
        那里是用户之间交流的地方，站方不一定看得到。
        「问题反馈」要先登录：访客看不到账户菜单，登录后才出现。
      </p>

      <h2 style={h2}>还有问题？</h2>
      <p style={V}>
        完整教程在仓库 <code>docs/教程-普通用户与访客.md</code>。
        教程没覆盖到的问题，多半属于「站点功能异常」（走问题反馈）或「想问问别人」（走<Link href="/forum">讨论区</Link>）。
      </p>
    </div>
  );
}

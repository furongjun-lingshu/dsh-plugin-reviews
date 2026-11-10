/**
 * 讨论区首页：分区列表。
 *
 * 版式：M3 卡片网格（`.forum-board-grid` / `.forum-board-card`）——
 * 分区是"平级的目的地"，用卡片而不是长列表更符合讨论区的浏览方式：
 * 每张卡自带一个首字徽标、名称（官方/归档标签贴在名字后面）、描述与元信息，
 * 整卡可点，右侧一个 chevron 提示"点进去"。
 *
 * 匿名可看分区（它们本来就公开）；开关关闭时整页 404，与接口同口径。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumBoardService } from '@/server/modules/forum/boards';
import { POSTING_POLICY_LABELS, BOARD_STATUS_LABELS } from '@/packages/common/forum';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

/** 卡片左侧的首字徽标：取分区名第一个字符（中文取第一个字，英文取首字母）。 */
function boardInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toUpperCase() : '#';
}

export default async function ForumPage() {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const ctx = await currentContext();
  const boards = await createForumBoardService({ db }).listBoards(ctx);

  return (
    <div className="forum-page">
      <h1>讨论区</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        聊插件、评测与整合包之外的一切。
      </p>

      {boards.length === 0 ? (
        <p className="empty">还没有分区。</p>
      ) : (
        <ul className="forum-board-grid">
          {boards.map((board) => (
            <li key={board.boardId}>
              <Link href={'/forum/' + board.slug} className="forum-board-card" prefetch={false}>
                <span
                  className={board.isOfficial ? 'forum-board-avatar official' : 'forum-board-avatar'}
                  aria-hidden="true"
                >
                  {boardInitial(board.name)}
                </span>

                <span className="forum-board-main">
                  <span className="forum-board-title">
                    {board.name}
                    {board.isOfficial ? <span className="tag site">官方</span> : null}
                    {board.status === 'archived' ? (
                      <span className="tag">{BOARD_STATUS_LABELS.archived}</span>
                    ) : null}
                  </span>
                  {board.description ? (
                    <span className="forum-board-desc">{board.description}</span>
                  ) : null}
                  <span className="forum-board-meta">
                    <span>{POSTING_POLICY_LABELS[board.postingPolicy]}</span>
                    <span>创建于 {formatDateTimeOr(board.createdAt, '未知')}</span>
                  </span>
                </span>

                <span className="forum-board-chevron" aria-hidden="true">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>
        <Link href="/forum/applications">申请新建分区</Link>
      </p>
    </div>
  );
}
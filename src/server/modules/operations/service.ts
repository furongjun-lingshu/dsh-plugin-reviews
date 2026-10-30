/**
 * 审计记录服务（工作包 GT）。
 *
 * 权威依据：
 *  - 已删除的设计稿《模块签名契约》 第 8 节；
 *  - migrations/0001_baseline.sql §3.7（`UNIQUE(action_type, operation_key)`，
 *    `CHECK (actor_kind = 'system' AND actor_user_id IS NULL) OR (...)`）；
 *  - 并行工作包 §2.4（请求去重：同键同摘要 → 原结果；同键不同摘要 → `request_key_reused`）。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withTransaction } from '@/server/platform/tx';
import type { Tx } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { digest } from '@/server/platform/digest';
import type { OperationActorKind } from '@/packages/common/field-rules';
import { err } from '@/packages/common/errors';

export interface OperationRecordInput {
  actionType: string;
  operationKey: string;
  actorKind: OperationActorKind;
  actorUserId: string | null;
  targetType: string;
  targetId: string;
  targetSnapshot: unknown;
  changes: unknown;
  reason: string;
  taskId?: string | null;
  /** 由调用方传入事务句柄（与业务变更同事务）。 */
  tx?: unknown;
}

export interface OperationsService {
  record(input: OperationRecordInput): Promise<{ operationId: string; replayed: boolean }>;
}

function resolveDb(tx: unknown): SqliteDatabase | null {
  if (!tx || typeof tx !== 'object') return null;
  const candidate = tx as { db?: unknown };
  if (candidate.db && typeof candidate.db === 'object') return candidate.db as SqliteDatabase;
  const direct = tx as { prepare?: unknown };
  if (typeof direct.prepare === 'function') return tx as SqliteDatabase;
  return null;
}

/**
 * 审计去重摘要的**规范化输入**（架构第 66.3 节）。
 *
 * 只纳入"同一次操作必须一致"的字段。刻意**不含** `created_at`
 * （时间不是操作身份），也**不含** `taskId`（同一动作可能由不同任务触发，
 * 但重复投递应被识别为同一次操作）。`operation_key` 也不入摘要——
 * 它是查找键，不是内容。
 */
export function operationDigest(input: OperationRecordInput): string {
  return digest({
    action_type: input.actionType,
    operation_key: input.operationKey,
    actor_kind: input.actorKind,
    actor_user_id: input.actorUserId,
    target_type: input.targetType,
    target_id: input.targetId,
    target_snapshot: input.targetSnapshot ?? null,
    changes: input.changes ?? null,
    reason: input.reason,
  });
}

function recordWithin(
  handle: SqliteDatabase,
  input: OperationRecordInput,
  now: number,
): { operationId: string; replayed: boolean } {
  if (!input.actionType || input.actionType.trim() === '') {
    throw err.input('action_type 不能为空。', [{ path: 'actionType', message: '必填' }]);
  }
  if (!input.operationKey || input.operationKey.trim() === '') {
    throw err.input('operation_key 不能为空。', [{ path: 'operationKey', message: '必填' }]);
  }
  if (!input.reason || input.reason.trim() === '') {
    throw err.input('操作原因不能为空。', [{ path: 'reason', message: '必填' }]);
  }
  // 表 CHECK：system 身份 actor_user_id 必须为空；user/admin 必须非空。
  if (input.actorKind === 'system' && input.actorUserId !== null) {
    throw err.input('系统身份的审计记录不得带 actor_user_id。', [
      { path: 'actorUserId', message: '系统身份必须为空' },
    ]);
  }
  if (input.actorKind !== 'system' && input.actorUserId === null) {
    throw err.input('人工身份的审计记录必须带 actor_user_id。', [
      { path: 'actorUserId', message: '人工身份必填' },
    ]);
  }

  const existing = handle
    .prepare(
      `SELECT id, target_snapshot, changes, reason, actor_kind, actor_user_id, target_type, target_id
         FROM operation_records WHERE action_type = ? AND operation_key = ?`,
    )
    .get(input.actionType, input.operationKey) as
    | {
        id: string;
        target_snapshot: string;
        changes: string;
        reason: string;
        actor_kind: OperationActorKind;
        actor_user_id: string | null;
        target_type: string;
        target_id: string;
      }
    | undefined;

  if (existing) {
    // 同键：比对摘要。同摘要 → 返回原记录（replayed=true）；
    // 不同摘要 → request_key_reused（**不覆盖历史**）。
    const incoming = operationDigest(input);
    const stored = digest({
      action_type: input.actionType,
      operation_key: input.operationKey,
      actor_kind: existing.actor_kind,
      actor_user_id: existing.actor_user_id,
      target_type: existing.target_type,
      target_id: existing.target_id,
      target_snapshot: JSON.parse(existing.target_snapshot) as unknown,
      changes: JSON.parse(existing.changes) as unknown,
      reason: existing.reason,
    });
    if (stored !== incoming) {
      throw err.keyReused('同一 operation_key 已用于内容不同的操作。');
    }
    return { operationId: existing.id, replayed: true };
  }

  const id = newId();
  handle
    .prepare(
      `INSERT INTO operation_records
         (id, action_type, operation_key, actor_kind, actor_user_id, target_type, target_id,
          target_snapshot, changes, reason, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.actionType,
      input.operationKey,
      input.actorKind,
      input.actorUserId,
      input.targetType,
      input.targetId,
      JSON.stringify(input.targetSnapshot ?? null),
      JSON.stringify(input.changes ?? null),
      input.reason,
      input.taskId ?? null,
      now,
    );
  return { operationId: id, replayed: false };
}

/**
 * 在**已有事务内**写一条审计记录（同步）。
 *
 * 为什么需要它：`createOperationsService().record()` 是 async 接口，在同步事务回调里不能 await；
 * 而"审计必须与业务变更同事务"（架构 §6.4）这条不能破。给事务内的调用方一个同步入口，
 * 比让每个模块各自内联一份 INSERT 更能保证不变量只写一遍。
 */
export function recordOperationInTx(
  handle: SqliteDatabase,
  input: Omit<OperationRecordInput, 'tx'>,
  now: number = nowMs(),
): { operationId: string; replayed: boolean } {
  return recordWithin(handle, input, now);
}

export function createOperationsService(db: SqliteDatabase): OperationsService {
  return {
    async record(input) {
      const outer = resolveDb(input.tx);
      if (outer) return recordWithin(outer, input, nowMs());
      return withTransaction((tx: Tx) => recordWithin(tx.db, input, nowMs()), db);
    },
  };
}

let singleton: OperationsService | null = null;

export function operationsService(): OperationsService {
  if (!singleton) singleton = createOperationsService(getDb());
  return singleton;
}

export function resetOperationsService(): void {
  singleton = null;
}

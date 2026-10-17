/**
 * 草稿接口（架构第 68 节）。
 *
 * 方法语义**必须唯一**，否则调用方分不清"新建"和"保存"（早期版本把两者都放在 POST 上，
 * 结果保存请求被当成新建、静默返回未保存的草稿 —— 已修正）：
 *
 *   POST   /api/drafts        新建或复用草稿（只做定位，不改内容）
 *   PUT    /api/drafts        保存完整编辑内容（核验预期版本 + 请求去重）
 *   PATCH  /api/drafts        提交（生成不可变快照 + 首个检查任务）
 *   GET    /api/drafts?draftId=  读取有权编辑的草稿
 */

import { getDb } from '@/server/platform/db';
import { reviewsService } from '@/server/modules/reviews';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../_lib/context';
import { submitReview } from '@/server/workflows/submit-review';
import type { VersionValue } from '@/packages/common/field-rules';

export const runtime = 'nodejs';

interface EditBody {
  draftId?: unknown;
  requestKey?: unknown;
  title?: unknown;
  pluginId?: unknown;
  pluginVersion?: unknown;
  dshVersion?: unknown;
  body?: unknown;
  bodyMarkdown?: unknown;
  expectedVersion?: unknown;
  expectedSaveVersion?: unknown;
  /** 五状态判定（dsh-bench 规范）：PATCH 提交时原样透传，校验在 submitReview 内。 */
  verdict?: unknown;
  /** 证据链（[{url, note?}]）：同上。 */
  evidenceRefs?: unknown;
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw err.input(`${path} 必填。`, [{ path, message: '必填且不能为纯空白' }]);
  }
  return v;
}

function draftPayloadOf(body: EditBody) {
  // 结构必须完整：不允许用缺字段静默表达"沿用旧值"（架构第 68.2 节）。
  return {
    title: typeof body.title === 'string' ? body.title : '',
    pluginId: typeof body.pluginId === 'string' ? body.pluginId : null,
    pluginVersion: (body.pluginVersion ?? { kind: 'unknown' }) as VersionValue,
    dshVersion: (body.dshVersion ?? { kind: 'unknown' }) as VersionValue,
    body: Array.isArray(body.body) ? (body.body as { key: string; markdown: string }[]) : [],
  };
}

/** 新建或复用草稿：只做定位，不修改内容。 */
export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as EditBody;
    const requestKey = requireString(body.requestKey, 'requestKey');
    const pluginId = typeof body.pluginId === 'string' ? body.pluginId : null;
    const draft = await reviewsService.createOrGetDraft(ctx, { pluginId, requestKey }, getDb());
    return okJson(draft, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 保存。 */
export async function PUT(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as EditBody;
    const draftId = requireString(body.draftId, 'draftId');
    const requestKey = requireString(body.requestKey, 'requestKey');
    if (!Number.isInteger(body.expectedVersion)) {
      throw err.input('缺少预期保存版本。', [{ path: 'expectedVersion', message: '必须是整数' }]);
    }

    const result = await reviewsService.saveDraft(
      ctx,
      {
        draftId,
        expectedVersion: body.expectedVersion as number,
        requestKey,
        payload: draftPayloadOf(body),
      },
      getDb(),
    );
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 提交：生成不可变快照 + 首个检查任务。 */
export async function PATCH(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as EditBody;
    const draftId = requireString(body.draftId, 'draftId');
    const requestKey = requireString(body.requestKey, 'requestKey');
    if (!Number.isInteger(body.expectedSaveVersion)) {
      throw err.input('缺少作者确认的保存版本。', [{ path: 'expectedSaveVersion', message: '必须是整数' }]);
    }

    const result = await submitReview(
      ctx,
      {
        draftId,
        expectedSaveVersion: body.expectedSaveVersion as number,
        requestKey,
        publishIntent: 'publish',
        title: typeof body.title === 'string' ? body.title : '',
        bodyMarkdown: typeof body.bodyMarkdown === 'string' ? body.bodyMarkdown : '',
        pluginVersion: (body.pluginVersion ?? { kind: 'unknown' }) as VersionValue,
        dshVersion: (body.dshVersion ?? { kind: 'unknown' }) as VersionValue,
        // 五状态判定与证据链（dsh-bench 规范）：非字符串一律按「未给出」传 null
        // （同 draftPayloadOf 的口径），合法性校验在 submitReview 内 fail-closed。
        verdict: typeof body.verdict === 'string' ? body.verdict : null,
        evidenceRefs: body.evidenceRefs,
      },
      getDb(),
    );
    return okJson(result, requestId, 202);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 读取本人草稿。 */
export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const url = new URL(request.url);
    const draftId = url.searchParams.get('draftId');
    if (!draftId) throw err.input('缺少 draftId。', [{ path: 'draftId', message: '必填' }]);
    const ctx = await currentContext();
    const draft = await reviewsService.getDraft(ctx, draftId, getDb());
    return okJson(draft, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

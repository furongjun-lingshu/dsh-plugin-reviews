'use client';

/**
 * 评测编辑器。
 *
 * 几个刻意的设计决定：
 *  1. 编辑器内部只维护一份 markdown 全文（单一真相），保存时才拆成段落数组。
 *  2. `expectedVersion` 必须来自上一次响应，不能写死 0。冲突时提示刷新版本。
 *  3. 版本空值不是省略，而是明确的"未知"（产品规则：未知版本不是退回理由）。
 *  4. 图片两步上传：先登记拿附件 id，再 PUT 字节；只有附件就绪才把图片语法插到正文，
 *     未就绪的附件不写进正文，可稍后重新查询状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { BackLink } from './back-link';
import {
  ApiError,
  ErrorNotice,
  SuccessNotice,
  apiFetch,
  inputStyle,
  newRequestKey,
} from './api-client';
import { VERDICTS, verdictDef, type EvidenceRef, type VerdictKey } from '@/packages/common/verdict';

type VersionValue = { kind: 'unknown' } | { kind: 'known'; value: string };

interface DraftPayload {
  title: string;
  pluginId: string | null;
  pluginVersion: VersionValue;
  dshVersion: VersionValue;
  body: { key: string; markdown: string }[];
  /** v1 载荷没有这两项（可选）：读取方按「未给出」呈现。 */
  verdict?: VerdictKey | null;
  evidence?: EvidenceRef[];
}

interface DraftView {
  draftId: string;
  reviewId: string;
  ownerId: string;
  pluginId: string | null;
  payload: DraftPayload;
  payloadSchemaVersion: number;
  saveVersion: number;
  createdAt: number;
  savedAt: number;
}

interface SaveResult {
  saveVersion: number;
  savedAt: number;
  replayed: boolean;
}

interface AttachmentView {
  attachmentId: string;
  processingState: 'pending' | 'processing' | 'ready' | 'failed';
  lastErrorCode: string | null;
  originalFilename: string;
  displayUrl: string | null;
  width: number | null;
  height: number | null;
}

interface SubmitResult {
  submissionId: string;
  reviewRevisionId: string;
  reviewId: string;
  processingState: 'pending';
  taskId: string | null;
}

/**
 * 上传后**仍在处理中**的附件。
 * 媒体处理是两段式的（登记 → 收字节 → 生成展示图），所以 PUT 返回 `pending`/`processing`
 * 是正常中间态，不是失败；界面必须留着这条记录，让用户能继续查状态。
 */
interface PendingAttachment {
  attachmentId: string;
  filename: string;
  state: AttachmentView['processingState'];
  reason: string | null;
}

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * 证据文本 ↔ 证据数组。每行一条：`链接` 或 `链接 | 备注`。
 * 空行忽略；解析不清的行原样保留成 [url, note]=[行, null] 交给服务端校验拒绝——
 * 客户端不替服务端猜「你想写的是什么」。
 */
function parseEvidenceText(text: string): EvidenceRef[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const pipe = line.indexOf('|');
      if (pipe === -1) return { url: line, note: null };
      const url = line.slice(0, pipe).trim();
      const note = line.slice(pipe + 1).trim();
      return { url, note: note.length > 0 ? note : null };
    });
}

function formatEvidenceText(evidence: EvidenceRef[]): string {
  return evidence.map((item) => (item.note ? `${item.url} | ${item.note}` : item.url)).join('\n');
}

/** 把 markdown 全文拆成 body 数组：按空行分段，保证每段有稳定 key。 */
function toBodySegments(markdown: string): { key: string; markdown: string }[] {
  const paragraphs = markdown.split(/\n{2,}/);
  return paragraphs.map((text, index) => ({ key: `p${index}`, markdown: text }));
}

/** 版本选择器：未知 / 已知。 */
function VersionField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: VersionValue;
  onChange: (next: VersionValue) => void;
}) {
  const unknown = value.kind === 'unknown';
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>{label}</div>
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 12, fontSize: 14 }}>
        <input
          type="radio"
          name={label}
          checked={unknown}
          onChange={() => onChange({ kind: 'unknown' })}
        />
        未知
      </label>
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 12, fontSize: 14 }}>
        <input
          type="radio"
          name={label}
          checked={!unknown}
          onChange={() => onChange({ kind: 'known', value: '' })}
        />
        指定版本
      </label>
      {!unknown ? (
        <input
          type="text"
          value={value.kind === 'known' ? value.value : ''}
          onChange={(e) => onChange({ kind: 'known', value: e.target.value })}
          placeholder="例如 1.2.3 或提交号"
          style={{ ...inputStyle, marginTop: 6 }}
        />
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>未知版本是可以的，不是退回理由。</div>
      )}
    </div>
  );
}

export function ReviewEditor({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [title, setTitle] = useState('');
  const [bodyMarkdown, setBodyMarkdown] = useState('');
  const [pluginVersion, setPluginVersion] = useState<VersionValue>({ kind: 'unknown' });
  const [dshVersion, setDshVersion] = useState<VersionValue>({ kind: 'unknown' });
  // 五状态判定与证据链（dsh-bench 规范）：随保存进草稿，随提交进快照。
  const [verdict, setVerdict] = useState<VerdictKey | null>(null);
  const [evidenceText, setEvidenceText] = useState('');
  const [saveVersion, setSaveVersion] = useState(0);

  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submission, setSubmission] = useState<SubmitResult | null>(null);

  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<DraftView>(`/api/drafts?draftId=${encodeURIComponent(draftId)}`, {
        cache: 'no-store',
      });
      setDraft(data);
      setTitle(data.payload.title);
      // 数组还原成 markdown 全文：段间用空行分隔，与 toBodySegments 互为逆操作。
      setBodyMarkdown(data.payload.body.map((s) => s.markdown).join('\n\n'));
      setPluginVersion(data.payload.pluginVersion);
      setDshVersion(data.payload.dshVersion);
      // 旧草稿（v1 载荷）没有这两项：按「未给出」还原，不伪造。
      setVerdict(data.payload.verdict ?? null);
      setEvidenceText(formatEvidenceText(data.payload.evidence ?? []));
      setSaveVersion(data.saveVersion);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  const payloadPreview = useMemo(
    () => ({ segments: toBodySegments(bodyMarkdown).length, chars: bodyMarkdown.length }),
    [bodyMarkdown],
  );

  /** 保存：每次点击生成新的幂等键（这与"重试复用"并不冲突，见 doSave 的 retryKey 参数）。 */
  const doSave = async (retryKey?: string): Promise<number | null> => {
    const requestKey = retryKey ?? newRequestKey();
    const result = await apiFetch<SaveResult>('/api/drafts', {
      method: 'PUT',
      json: {
        draftId,
        requestKey,
        expectedVersion: saveVersion,
        title,
        pluginId: draft?.pluginId ?? null,
        pluginVersion,
        dshVersion,
        body: toBodySegments(bodyMarkdown),
        verdict,
        evidence: parseEvidenceText(evidenceText),
      },
    });
    setSaveVersion(result.saveVersion);
    setSaved(
      result.replayed
        ? `这次请求此前已处理过，当前保存版本 ${result.saveVersion}。`
        : `已保存，保存版本 ${result.saveVersion}。`,
    );
    return result.saveVersion;
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await doSave();
    } catch (e) {
      const err = e as ApiError;
      setError(err);
      if (err.code === 'version_conflict') {
        setSaved('检测到版本冲突：草稿已被其他保存更新。请刷新后基于最新版本重试。');
      }
    } finally {
      setBusy(false);
    }
  };

  /** 提交审核：先 PUT 保存，再用返回的最新版本 PATCH 提交。 */
  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    setSubmission(null);
    try {
      // 先保存，拿到权威 saveVersion —— 不能拿旧的 saveVersion 直接提交。
      const freshVersion = await doSave();
      if (freshVersion === null) return;

      if (verdict === null) {
        throw { code: 'input_invalid', message: '提交前请先给出判定（五状态之一）。' } as ApiError;
      }
      const result = await apiFetch<SubmitResult>('/api/drafts', {
        method: 'PATCH',
        json: {
          draftId,
          requestKey: newRequestKey(),
          expectedSaveVersion: freshVersion,
          title,
          bodyMarkdown,
          pluginVersion,
          dshVersion,
          verdict,
          evidenceRefs: parseEvidenceText(evidenceText),
        },
      });
      setSubmission(result);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** 上传后仍在处理中的附件（用于"重新查询状态"）。 */
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);

  /**
   * 查一次附件的真实状态；处理中不是失败，就绪后插入正文。
   */
  const queryAttachment = async (attachmentId: string, filename: string) => {
    setUploading(true);
    setError(null);
    try {
      const view = await apiFetch<AttachmentView>(
        `/api/attachments/${encodeURIComponent(attachmentId)}`,
        { cache: 'no-store' },
      );
      if (view.processingState === 'ready' && view.displayUrl) {
        insertAtCursor(`![${filename}](${view.displayUrl})`);
        setSaved(`图片已插入正文：${view.displayUrl}`);
        setPendingAttachment(null);
        return;
      }
      setPendingAttachment({
        attachmentId,
        filename,
        state: view.processingState,
        reason: view.lastErrorCode ?? null,
      });
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setUploading(false);
    }
  };

  /** 图片上传：登记 → PUT 字节 → 就绪则把图片插到光标处，未就绪则留下记录可继续查。 */
  const onUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      if (!ALLOWED_MIME.includes(file.type)) {
        throw new ApiError(
          { code: 'input_invalid', message: `只支持 PNG / JPEG / WebP，当前文件类型是 ${file.type || '未知'}。` },
          400,
        );
      }
      if (file.size > MAX_BYTES) {
        throw new ApiError(
          { code: 'input_invalid', message: `单张图片最多 10MB，当前 ${(file.size / 1024 / 1024).toFixed(1)}MB。` },
          400,
        );
      }

      // 第一步：登记（拿附件 id）。登记 ≠ 收到字节。
      const registered = await apiFetch<AttachmentView>(`/api/drafts/${encodeURIComponent(draftId)}/attachments`, {
        method: 'POST',
        json: { originalFilename: file.name, usage: 'body' },
      });

      // 第二步：PUT 原始字节，content-type 必须是允许的图片类型。
      const ready = await apiFetch<AttachmentView>(
        `/api/attachments/${encodeURIComponent(registered.attachmentId)}/file`,
        {
          method: 'PUT',
          headers: { 'content-type': file.type },
          body: file,
        },
      );

      if (ready.processingState === 'ready' && ready.displayUrl) {
        insertAtCursor(`![${file.name}](${ready.displayUrl})`);
        setSaved(`图片已插入正文：${ready.displayUrl}`);
        setPendingAttachment(null);
        return;
      }

      if (ready.processingState === 'failed') {
        // 终态失败：查状态也救不回来，如实给出原因（换一张再试）。
        throw new ApiError(
          {
            code: 'input_invalid',
            message: `图片处理失败${ready.lastErrorCode ? `（原因：${ready.lastErrorCode}）` : ''}。请换一张再试。`,
          },
          400,
        );
      }

      // 还在处理中：不是失败。留着这条记录，让用户能查状态，而不是只能重选文件重走一遍。
      setPendingAttachment({
        attachmentId: registered.attachmentId,
        filename: file.name,
        state: ready.processingState,
        reason: ready.lastErrorCode ?? null,
      });
      setSaved(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** 在光标处插入文本（没有焦点时追加到末尾）。 */
  const insertAtCursor = (snippet: string) => {
    const el = bodyRef.current;
    if (!el) {
      setBodyMarkdown((prev) => `${prev}\n\n${snippet}\n`);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = `${el.value.slice(0, start)}\n\n${snippet}\n\n${el.value.slice(end)}`;
    setBodyMarkdown(next);
    // 让光标停在插入内容之后，方便继续写。
    requestAnimationFrame(() => {
      const pos = start + snippet.length + 4;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  if (error && !draft) {
    return (
      <div>
        <BackLink href="/me">返回我的评测</BackLink>
        <h1 style={{ fontSize: 22 }}>无法打开草稿</h1>
        <ErrorNotice error={error} onDismiss={() => setError(null)} />
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>编辑评测草稿</h1>
      <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>
        草稿 <code>{draftId}</code> · 保存版本 <strong>{saveVersion}</strong> · 正文 {payloadPreview.chars} 字 /{' '}
        {payloadPreview.segments} 段
      </p>

      {/*
        插件绑定要在动手写之前说清楚：提交时会校验插件绑定 ——
        未绑定的草稿保存得了、提交不了。
      */}
      {draft ? (
        draft.pluginId ? (
          <p className="muted" style={{ fontSize: 14 }}>
            关联插件：
            <Link href={`/plugins/${draft.pluginId}`} style={{ color: 'var(--accent)' }}>
              {draft.pluginId}
            </Link>
          </p>
        ) : (
          <div
            className="notice warn"
            style={{
              fontSize: 14,
            }}
          >
            <strong>这份草稿还没有关联插件，无法提交审核。</strong>
            <br />
            请到插件目录打开对应插件，用那里的「写一篇评测」新建草稿（已保存的正文不会丢，可复制过去）。
            <Link href="/plugins" style={{ color: 'var(--accent)', marginLeft: 8 }}>
              去插件目录 →
            </Link>
          </div>
        )
      ) : null}

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {saved ? <SuccessNotice>{saved}</SuccessNotice> : null}
      {submission ? (
        <SuccessNotice>
          已提交审核，正在等待检查。
          <br />
          审核通过并发布后，读者才能在 <Link href={`/reviews/${submission.reviewId}`}>评测页</Link> 看到它。
        </SuccessNotice>
      ) : null}

      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        <div className="panel">
          <label htmlFor="title" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            标题
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：某插件的实测体验"
            style={inputStyle}
          />
          <p className="muted" style={{ fontSize: 13 }}>标题可以留空，提交时才有必填校验。</p>
        </div>

        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <label htmlFor="body" style={{ fontWeight: 600 }}>
              Markdown 正文
            </label>
            <span style={{ marginLeft: 'auto' }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onUpload(file);
                }}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                className="button"
              >
                {uploading ? '上传中…' : '插入图片'}
              </button>
            </span>
          </div>

          {/* 处理中的附件：可继续查状态。 */}
          {pendingAttachment ? (
            <div className="notice" style={{ marginTop: 12 }}>
              <div>
                图片「{pendingAttachment.filename}」还在处理中（状态：{pendingAttachment.state}
                {pendingAttachment.reason ? `，原因：${pendingAttachment.reason}` : ''}）。 处理完成后点「重新查询状态」
                就会插入正文；也可以先继续写，稍后再回来查。
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="link-btn"
                  disabled={uploading}
                  onClick={() => void queryAttachment(pendingAttachment.attachmentId, pendingAttachment.filename)}
                >
                  {uploading ? '正在查询…' : '重新查询状态'}
                </button>
                <button type="button" className="link-btn muted" onClick={() => setPendingAttachment(null)}>
                  先不管它
                </button>
              </div>
            </div>
          ) : null}

          <textarea
            id="body"
            ref={bodyRef}
            value={bodyMarkdown}
            onChange={(e) => setBodyMarkdown(e.target.value)}
            rows={18}
            placeholder={'支持 Markdown。\n\n用「插入图片」可上传 PNG/JPEG/WebP（≤10MB），成功后会把图片语法插到光标处。'}
            style={{ ...inputStyle, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 14, lineHeight: 1.6 }}
          />
        </div>

        <div className="panel">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>结论</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            一篇评测只给一个判定（对齐 dsh-bench 测评规范：五状态、不给总分、不用星级）。
            「真有用／帮倒忙／没啥差别」必须附证据链；「还说不准／没法测」可以没有。
          </p>
          {VERDICTS.map((v) => (
            <label
              key={v.key}
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 14, marginBottom: 8, fontSize: 14 }}
            >
              <input
                type="radio"
                name="verdict"
                checked={verdict === v.key}
                onChange={() => setVerdict(v.key)}
              />
              {v.label}
              {v.conclusive ? <span className="muted" style={{ fontSize: 12 }}>（需证据）</span> : null}
            </label>
          ))}
          {verdict !== null ? (
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>
              当前判定：{verdictDef(verdict).label}
              {verdictDef(verdict).conclusive ? '——请附至少一条可复核链接。' : '——证据可选。'}
            </p>
          ) : null}
          <label htmlFor="evidence" style={{ display: 'block', fontWeight: 600, margin: '10px 0 6px' }}>
            证据链（每行一条：链接 或 链接 | 备注）
          </label>
          <textarea
            id="evidence"
            value={evidenceText}
            onChange={(e) => setEvidenceText(e.target.value)}
            rows={4}
            placeholder={'https://github.com/.../compare/a...b | 配对 A/B 前后各 5 次读数\nhttps://.../issues/12#issuecomment-... | 复现步骤'}
            style={{ ...inputStyle, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 }}
          />
        </div>

        <div className="panel">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>被测版本</h2>
          <VersionField label="被测插件版本" value={pluginVersion} onChange={setPluginVersion} />
          <VersionField label="被测 DSH 版本" value={dshVersion} onChange={setDshVersion} />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void onSave()} disabled={busy} className="button primary">
            {busy ? '处理中…' : '保存'}
          </button>
          <button type="button" onClick={() => void onSubmit()} disabled={busy} className="button">
            提交审核
          </button>
          <button type="button" onClick={() => void load()} disabled={busy} className="link-btn">
            放弃改动并重新载入
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          「提交审核」会先保存、再生成不可变快照并进入待检查状态；提交后的正文不能在草稿里改写。
        </p>
      </div>
    </div>
  );
}

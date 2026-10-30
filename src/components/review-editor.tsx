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
import { DeleteDraftButton } from './delete-draft-button';
import {
  ApiError,
  ErrorNotice,
  SuccessNotice,
  apiFetch,
  inputStyle,
  newRequestKey,
} from './api-client';
import { VERDICTS, verdictDef, type EvidenceRef, type VerdictKey } from '@/packages/common/verdict';
import { ASSESSMENTS, type AssessmentLevel } from '@/packages/common/assessment';
import { DEFAULT_AUTOSAVE_SECONDS } from '@/packages/common/autosave';

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
  /** v3 载荷才有；旧载荷缺键按「未标注」呈现。 */
  assessmentLevel?: AssessmentLevel | null;
}

interface DraftView {
  draftId: string;
  reviewId: string;
  ownerId: string;
  pluginId: string | null;
  /** 插件展示名（未绑定为 null）：编辑器要给人看"对应哪个插件"，只给 UUID 等于没给。 */
  pluginLabel: string | null;
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

export function ReviewEditor({
  draftId,
  /**
   * 自动保存间隔（秒，0 = 关闭）：由**服务端**读每用户偏好后传入（迁移 0030）。
   * 刻意不在客户端 fetch：多一次请求就多一次"编辑器打开时先按默认值计时"的中间态，
   * 组件测试也会因此多出一条与业务无关的网络调用。
   */
  initialAutosaveSeconds = DEFAULT_AUTOSAVE_SECONDS,
  /** 单个 .md 导入上限（字节）：来自后台 imports.max_markdown_bytes，默认 512KB。 */
  maxMarkdownBytes = 512 * 1024,
}: {
  draftId: string;
  initialAutosaveSeconds?: number;
  maxMarkdownBytes?: number;
}) {
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [title, setTitle] = useState('');
  const [bodyMarkdown, setBodyMarkdown] = useState('');
  const [pluginVersion, setPluginVersion] = useState<VersionValue>({ kind: 'unknown' });
  const [dshVersion, setDshVersion] = useState<VersionValue>({ kind: 'unknown' });
  // 测评档位（快测/标准测评/深度审计/仅安全审计）：随保存进草稿，随提交进快照。
  const [assessmentLevel, setAssessmentLevel] = useState<AssessmentLevel | null>(null);
  const [assessmentHint, setAssessmentHint] = useState<string | null>(null);
  // 五状态判定与证据链（dsh-bench 规范）：随保存进草稿，随提交进快照。
  const [verdict, setVerdict] = useState<VerdictKey | null>(null);
  const [evidenceText, setEvidenceText] = useState('');
  /**
   * 提交必填项的**表单提示**（不是接口错误）。
   *
   * 没选判定是用户漏填，属于可预期的输入缺失：点「提交审核」时就地提示，
   * 不走 ErrorNotice（旧实现把裸对象当 ApiError 抛出，ErrorNotice 调
   * describeFields() 时二次崩溃，用户看到的是整页「这个页面出错了」）。
   */
  const [verdictHint, setVerdictHint] = useState<string | null>(null);
  const [saveVersion, setSaveVersion] = useState(0);
  /** 自动保存状态：idle 无改动 / pending 有改动待保存 / saving 保存中 / saved 已存 / error 失败。 */
  const [autoState, setAutoState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  /** 自动保存静默期（毫秒，0 = 关闭）。来源是**个人设置**里的偏好（迁移 0030）。 */
  const autosaveMs = initialAutosaveSeconds * 1000;
  /** 上次成功保存的内容指纹：相同就不重复存（避免打开页面就无谓写库）。 */
  const lastSavedDigestRef = useRef<string | null>(null);
  /** 自动保存定时器与「正在保存」标志（避免定时器与手动保存重入）。 */
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 当前封面展示图 URL（仅本会话内预览；权威副本在草稿引用里，提交后才公开）。 */
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const coverFileRef = useRef<HTMLInputElement | null>(null);
  const [submission, setSubmission] = useState<SubmitResult | null>(null);

  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const mdFileRef = useRef<HTMLInputElement | null>(null);
  const [importingMd, setImportingMd] = useState(false);
  /** 结论面板：提示出现时滚到这里，用户不用自己找是哪一项没选。 */
  const verdictPanelRef = useRef<HTMLDivElement | null>(null);

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
      setAssessmentLevel(data.payload.assessmentLevel ?? null);
      setEvidenceText(formatEvidenceText(data.payload.evidence ?? []));
      setSaveVersion(data.saveVersion);
      setError(null);
      // 记住「刚载入的内容」：没有改动就不自动保存。
      lastSavedDigestRef.current = null;
      setAutoState('idle');
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

  /**
   * 当前内容的指纹：用于判断「有没有真的改动」。
   *
   * 只覆盖会被 PUT 上去的字段（标题/正文/两个版本/档位/判定/证据）——
   * 光标移动、展开折叠这类纯界面状态不该触发写库。
   */
  const contentDigest = useCallback(
    () =>
      JSON.stringify({
        title,
        bodyMarkdown,
        pluginVersion,
        dshVersion,
        verdict,
        evidenceText,
        assessmentLevel,
      }),
    [title, bodyMarkdown, pluginVersion, dshVersion, verdict, evidenceText, assessmentLevel],
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
        evidenceRefs: parseEvidenceText(evidenceText),
        assessmentLevel,
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
    // 手动保存优先：清掉待执行的自动保存，避免两次 PUT 抢同一个 expectedVersion。
    if (autoTimerRef.current !== null) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    savingRef.current = true;
    // 先记住这次要保存的内容指纹：保存期间用户继续打字时，能正确判断"还有新改动待存"。
    const digestAtSave = contentDigest();
    try {
      const next = await doSave();
      if (next !== null) {
        lastSavedDigestRef.current = digestAtSave;
        setAutoState('saved');
      }
    } catch (e) {
      const err = e as ApiError;
      setError(err);
      if (err.code === 'version_conflict') {
        setSaved('检测到版本冲突：草稿已被其他保存更新。请刷新后基于最新版本重试。');
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  /**
   * 自动保存：改动后 **5 秒**无操作就存一次。
   *
   * 取舍（写清避免误读）：
   *   - 是**防抖**不是轮询：只在内容变化后计时，停下来 5 秒才写库；
   *   - 与手动保存共用一个标志（savingRef），定时器到点时若正在保存就跳过这一轮，
   *     下一轮改动会重新计时，不会两个 PUT 抢同一个 expectedVersion；
   *   - 内容与上次保存一致时**不写**（否则打开页面/切标签页也会刷版本号）；
   *   - 失败不弹 ErrorNotice（自动保存不该打断写作），只在状态条上标「自动保存失败」，
   *     用户仍可点「保存」重试；
   *   - 提交审核会自己先保存，所以提交开始时清掉待执行的自动保存。
   */
  useEffect(() => {
    if (draft === null) return;
    // 关闭自动保存：只做基线记录，不排定时器（手动「保存」照常可用）。
    const digest = contentDigest();
    if (autosaveMs <= 0) {
      setAutoState(lastSavedDigestRef.current === digest ? 'saved' : 'idle');
      return;
    }
    if (lastSavedDigestRef.current === null) {
      // 首次载入：记下基线，但不写库。
      lastSavedDigestRef.current = digest;
      return;
    }
    if (digest === lastSavedDigestRef.current) return;

    setAutoState('pending');
    if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = null;
      void (async () => {
        if (savingRef.current) {
          setAutoState('pending');
          return;
        }
        savingRef.current = true;
        setAutoState('saving');
        try {
          const result = await apiFetch<SaveResult>('/api/drafts', {
            method: 'PUT',
            json: {
              draftId,
              requestKey: newRequestKey(),
              expectedVersion: saveVersion,
              title,
              pluginId: draft.pluginId,
              pluginVersion,
              dshVersion,
              body: toBodySegments(bodyMarkdown),
              verdict,
              evidenceRefs: parseEvidenceText(evidenceText),
              assessmentLevel,
            },
          });
          setSaveVersion(result.saveVersion);
          lastSavedDigestRef.current = digest;
          setAutoState('saved');
        } catch {
          // 冲突/网络失败都只记状态：写作不打断，明确提示用户手动保存。
          setAutoState('error');
        } finally {
          savingRef.current = false;
        }
      })();
    }, autosaveMs);

    return () => {
      if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    };
  }, [
    draft,
    draftId,
    saveVersion,
    autosaveMs,
    contentDigest,
    title,
    bodyMarkdown,
    pluginVersion,
    dshVersion,
    verdict,
    evidenceText,
    assessmentLevel,
  ]);

  /** 提交审核：先 PUT 保存，再用返回的最新版本 PATCH 提交。 */
  const onSubmit = async () => {
    // 提交会自己先保存：清掉待执行的自动保存，避免并发 PUT。
    if (autoTimerRef.current !== null) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    setSubmission(null);
    try {
      // 提交前置校验：档位与判定都是必填项。漏选属于用户可修正的输入缺失，
      // 就地提示并停在表单里；不发起保存/提交，也不走 ErrorNotice。
      if (assessmentLevel === null) {
        setAssessmentHint('请先选择测评档位（快测／标准测评／深度审计／仅安全审计）。');
        verdictPanelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      setAssessmentHint(null);

      if (verdict === null) {
        setVerdictHint('请先选择判定（五状态之一）再提交审核；选好后点「提交审核」会一并保存并提交。');
        verdictPanelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      setVerdictHint(null);

      // 先保存，拿到权威 saveVersion —— 不能拿旧的 saveVersion 直接提交。
      const freshVersion = await doSave();
      if (freshVersion === null) return;

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
          assessmentLevel,
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

  /**
   * 图片上传：登记 → PUT 字节 → 就绪则按用途落地：
   *   - body（默认）：把图片语法插到光标处；
   *   - cover：记为草稿封面（服务端在就绪时写 draft_attachment_links，提交时固定进修订快照）。
   * 未就绪时留下记录可继续查状态。
   */
  const onUpload = async (file: File, usage: 'body' | 'cover' = 'body') => {
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
        json: { originalFilename: file.name, usage },
      });

      // 第二步：PUT 原始字节，content-type 必须是允许的图片类型。
      // 用途与草稿告诉服务端：封面要落到草稿引用上（而不是只插一段 markdown）。
      const query = usage === 'cover' ? `?usage=cover&draftId=${encodeURIComponent(draftId)}` : '';
      const ready = await apiFetch<AttachmentView>(
        `/api/attachments/${encodeURIComponent(registered.attachmentId)}/file${query}`,
        {
          method: 'PUT',
          headers: { 'content-type': file.type },
          body: file,
        },
      );

      if (ready.processingState === 'ready' && ready.displayUrl) {
        if (usage === 'cover') {
          setCoverUrl(ready.displayUrl);
          setSaved('封面已设置。提交审核后，读者看到的列表与详情会显示这张图。');
        } else {
          insertAtCursor(`![${file.name}](${ready.displayUrl})`);
          setSaved(`图片已插入正文：${ready.displayUrl}`);
        }
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

  /**
   * 导入 Markdown：把 .md/.markdown/.txt 的文本填进正文，**不自动保存**。
   * 覆盖非空正文前必须二次确认；只接受文本，大小上限 512KB。
   */
  const onImportMarkdown = async (file: File) => {
    setImportingMd(true);
    setError(null);
    try {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) {
        throw new ApiError(
          { code: 'input_invalid', message: '只支持 .md / .markdown / .txt 文件。' },
          400,
        );
      }
      if (file.size > maxMarkdownBytes) {
        throw new ApiError(
          {
            code: 'input_invalid',
            message: `Markdown 文件最大 ${Math.floor(maxMarkdownBytes / 1024)}KB，当前 ${(file.size / 1024).toFixed(0)}KB。`,
          },
          400,
        );
      }
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () =>
          reject(new ApiError({ code: 'input_invalid', message: '读取文件失败，请重试。' }, 400));
        reader.readAsText(file);
      });
      if (bodyMarkdown.trim().length > 0 && !window.confirm('导入会覆盖当前正文，继续？')) return;
      setBodyMarkdown(text);
      setSaved(`已导入「${file.name}」（${text.length} 字），点「保存」写入草稿。`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setImportingMd(false);
      if (mdFileRef.current) mdFileRef.current.value = '';
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
        {' · '}
        {/*
          自动保存状态：写作过程中最重要的一句反馈。失败时只标红提示，不弹错误框——
          自动保存不该打断写作；用户仍可点「保存」重试。
        */}
        <span
          className={autoState === 'error' ? 'muted' : 'muted'}
          style={{ color: autoState === 'error' ? 'var(--danger)' : undefined }}
        >
          {autosaveMs <= 0
            ? '自动保存已关闭（可在「个人设置 · 编辑」里开启）'
            : autoState === 'idle'
            ? `自动保存：停笔 ${Math.round(autosaveMs / 1000)} 秒后保存`
            : autoState === 'pending'
              ? '自动保存：等待写入…'
              : autoState === 'saving'
                ? '自动保存中…'
                : autoState === 'saved'
                  ? '已自动保存'
                  : '自动保存失败，请点「保存」重试'}
        </span>
      </p>

      {/*
        插件绑定要在动手写之前说清楚：提交时会校验插件绑定 ——
        未绑定的草稿保存得了、提交不了。
      */}
      {draft ? (
        draft.pluginId ? (
          <p className="muted" style={{ fontSize: 14 }}>
            对应插件：
            <Link href={`/plugins/${draft.pluginId}`} style={{ color: 'var(--accent)' }}>
              {draft.pluginLabel ?? draft.pluginId}
            </Link>
            <Link
              href={`/me/drafts/${draftId}/choose-plugin`}
              style={{ marginLeft: 12 }}
            >
              更换插件
            </Link>
          </p>
        ) : (
          <div className="notice warn" style={{ fontSize: 14 }}>
            <strong>这份草稿还没有对应的插件，无法提交审核。</strong>
            <br />
            点下面的按钮选一个（可搜索）；选完自动回到这里，正文不受影响。
            <div style={{ marginTop: 8 }}>
              <Link href={`/me/drafts/${draftId}/choose-plugin`} className="button primary">
                选择所对应的插件
              </Link>
            </div>
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
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
              <input
                ref={mdFileRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                style={{ display: 'none' }}
                aria-label="导入 Markdown 文件"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onImportMarkdown(file);
                }}
              />
              <button
                type="button"
                disabled={importingMd}
                onClick={() => mdFileRef.current?.click()}
                className="button"
              >
                {importingMd ? '导入中…' : '导入 Markdown'}
              </button>
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
              <input
                ref={coverFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onUpload(file, 'cover');
                  if (coverFileRef.current) coverFileRef.current.value = '';
                }}
              />
              <button
                type="button"
                className="button"
                disabled={uploading}
                onClick={() => coverFileRef.current?.click()}
                title="封面会用在评测列表与详情页顶部；没有封面时用生成的图"
              >
                {coverUrl ? '更换封面' : '设置封面'}
              </button>
            </span>
          </div>

          {/* 封面预览：让作者确认"读者会看到哪张图"，不必等到发布。 */}
          {coverUrl ? (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
                当前封面（提交后生效）
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={coverUrl}
                alt="封面预览"
                style={{ maxWidth: 260, width: '100%', height: 'auto', borderRadius: 8, display: 'block' }}
              />
            </div>
          ) : null}

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
            placeholder={'支持 Markdown。\n\n用「导入 Markdown」可把 .md 文件内容填进正文；用「插入图片」可上传 PNG/JPEG/WebP（≤10MB），成功后会把图片语法插到光标处。'}
            style={{ ...inputStyle, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 14, lineHeight: 1.6 }}
          />
        </div>

        <div className="panel" ref={verdictPanelRef}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>结论</h2>

          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            先选择本次测评的档位（对齐 dsh-bench 规范）：快测只做安装／功能点／卸载，不进能力榜；
            标准测评出五状态；深度审计 = 标准测评 + 安全审计；仅安全审计不产出能力结论。
          </p>
          {assessmentHint ? (
            <div className="notice warn" role="alert" style={{ fontSize: 14, margin: '0 0 10px' }}>
              {assessmentHint}
            </div>
          ) : null}
          {ASSESSMENTS.map((a) => (
            <label
              key={a.key}
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 14, marginBottom: 8, fontSize: 14 }}
            >
              <input
                type="radio"
                name="assessmentLevel"
                checked={assessmentLevel === a.key}
                onChange={() => {
                  setAssessmentLevel(a.key);
                  setAssessmentHint(null);
                }}
              />
              {a.label}
              {a.security ? <span className="muted" style={{ fontSize: 12 }}>（含安全审计）</span> : null}
            </label>
          ))}

          <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0' }} />

          {verdictHint ? (
            <div className="notice warn" role="alert" style={{ fontSize: 14, margin: '0 0 10px' }}>
              {verdictHint}
            </div>
          ) : null}
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            一篇评测只给一个判定（对齐 dsh-bench 测评规范：五状态、不给总分、不用星级）。
            「真有用／帮倒忙／没啥差别」必须附证据链；「还说不准／没法测」可以没有。
            {' '}
            <Link href="/spec" target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>
              规则说明：测评规范 ↗
            </Link>
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
                onChange={() => {
                  setVerdict(v.key);
                  setVerdictHint(null);
                }}
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
          {/* 删除草稿放最右：与保存/提交拉开距离，避免误点；语义是删除，不再是"放弃改动"。 */}
          <span style={{ marginLeft: 'auto' }}>
            <DeleteDraftButton draftId={draftId} redirectTo="/me" />
          </span>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          「提交审核」会先保存、再生成不可变快照并进入待检查状态；提交后的正文不能在草稿里改写。
        </p>
      </div>
    </div>
  );
}

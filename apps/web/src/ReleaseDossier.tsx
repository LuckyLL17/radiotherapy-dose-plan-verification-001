import { useCallback, useEffect, useRef, useState } from 'react';

type Check = {
  structureId: string; name: string; metric: string;
  value: number; limit: number; unit: string; pass: boolean; delta: number;
};
type QaRun = {
  id: string; method: 'independent_mu' | 'gamma' | 'image_guidance';
  status: 'pass' | 'warn' | 'fail'; score: number; detail: string; createdAt: string;
};
type ChecklistEntry = { item: string; checked: boolean; reviewer: string; at: string };
type FractionRecord = {
  fraction: number; deliveredGy: number;
  setupShift: { x: number; y: number; z: number }; at: string;
};
type OpenDeviation = {
  id: string; severity: 'low' | 'medium' | 'high'; category: string;
  detail: string; state: 'open' | 'resolved'; createdAt: string; blocksRelease: boolean;
};
type Blocker = { category: string; code: string; message: string; ref?: string };
type Dossier = {
  plan: { id: string; label: string; status: 'draft' | 'review' | 'approved' };
  checks: Check[];
  qa: QaRun[];
  checklist: ChecklistEntry[];
  requiredChecklist: string[];
  fractions: FractionRecord[];
  openDeviations: OpenDeviation[];
  deliverySummary: { fractions: number; prescriptionFractions: number; cumulativeDose: number; prescriptionDose: number };
  gate: 'ready' | 'blocked';
  blockers: Blocker[];
  riskEstimate: { lungPneumonitis: number; heartEvent: number };
};
type AuditRow = { at: string; action: string; planId: string; [k: string]: unknown };

const BLOCKER_LABEL: Record<string, string> = {
  constraint: '剂量约束',
  qa: 'QA 验证',
  checklist: '同行复核',
  delivery: '治疗分次',
  deviation: '偏差管理',
};
const QA_LABEL: Record<string, string> = {
  independent_mu: '独立 MU 复算',
  gamma: '3%/3mm Gamma 验证',
  image_guidance: '影像引导核查',
};
const ACTION_LABEL: Record<string, string> = {
  plan_released: '计划放行签发',
  plan_approved: '计划签发（旧入口）',
  peer_review: '同行复核备注',
  peer_checklist: '复核清单项保存',
  independent_check: 'QA 执行',
  fraction_delivered: '治疗分次登记',
  deviation_resolved: '偏差关闭',
  adaptive_evaluation: '自适应评估',
};

async function postJson(url: string, body?: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

export default function ReleaseDossier({ planId, onPlanChanged }: { planId: string; onPlanChanged?: () => void }) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [savingItem, setSavingItem] = useState<string | null>(null);
  const [itemError, setItemError] = useState('');
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  // 服务端返回的最近一次阻断原因：失败后持续保留，直到刷新/放行成功
  const [serverBlockers, setServerBlockers] = useState<Blocker[] | null>(null);
  const [qaBusy, setQaBusy] = useState('');
  const [fractionForm, setFractionForm] = useState({ fraction: 1, deliveredGy: 2, x: 0, y: 0, z: 0 });
  const [fractionBusy, setFractionBusy] = useState(false);
  const [fractionError, setFractionError] = useState('');
  const [resolving, setResolving] = useState('');
  const reqSeq = useRef(0);

  const refresh = useCallback(async (id: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setLoadError('');
    try {
      const [dRes, aRes] = await Promise.all([
        fetch(`/api/plans/${id}/verification-dossier`).then(r => r.json()),
        fetch(`/api/audit?planId=${id}&limit=30`).then(r => r.json()),
      ]);
      if (seq !== reqSeq.current) return; // 已切换到其他计划，丢弃过期响应
      if (dRes.error) { setLoadError(dRes.error === 'plan_not_found' ? '计划不存在' : '档案加载失败'); return; }
      setDossier(dRes as Dossier);
      setServerBlockers(dRes.gate === 'blocked' ? dRes.blockers : null);
      setReleaseError(null);
      setAudit(aRes.audit ?? []);
    } catch {
      if (seq === reqSeq.current) setLoadError('档案加载失败，请检查后端服务');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(planId); }, [planId, refresh]);

  if (loading && !dossier) {
    return <section className="panel dossier"><div className="dossierLoading">正在加载计划放行档案…</div></section>;
  }
  if (loadError || !dossier) {
    return <section className="panel dossier"><div className="dossierError">{loadError || '档案不可用'}</div></section>;
  }

  const isApproved = dossier.plan.status === 'approved';
  const shownBlockers = serverBlockers ?? dossier.blockers;
  const checkedCount = dossier.requiredChecklist.filter(item =>
    dossier.checklist.some(c => c.item === item && c.checked)).length;

  async function toggleItem(item: string, next: boolean) {
    if (!reviewer.trim()) {
      setItemError('请先填写复核人姓名，清单项需逐项留痕保存');
      return;
    }
    setItemError('');
    setSavingItem(item);
    const previous = dossier!.checklist;
    // 乐观更新；保存失败立即回滚，状态始终以服务端为准
    setDossier(d => d ? {
      ...d,
      checklist: d.checklist.some(c => c.item === item)
        ? d.checklist.map(c => c.item === item ? { ...c, checked: next } : c)
        : [...d.checklist, { item, checked: next, reviewer: reviewer.trim(), at: new Date().toISOString() }],
    } : d);
    const { ok, data } = await postJson(`/api/plans/${planId}/peer-checklist`, {
      item, checked: next, reviewer: reviewer.trim(),
    });
    setSavingItem(null);
    if (ok) {
      await refresh(planId); // 从服务端恢复权威状态
    } else {
      setDossier(d => d ? { ...d, checklist: previous } : d);
      setItemError(data?.error === 'reviewer_required' ? '复核人姓名不能为空' : `清单项保存失败：${data?.error ?? '网络错误'}`);
    }
  }

  async function runQa(method: 'independent_mu' | 'gamma', failCase: boolean) {
    setQaBusy(method + (failCase ? '-fail' : '-pass'));
    const score = method === 'gamma' ? (failCase ? 88.2 : 97.6) : (failCase ? 6.4 : 1.9);
    await postJson(`/api/plans/${planId}/independent-check`, { method, score });
    setQaBusy('');
    await refresh(planId);
  }

  async function addFraction() {
    setFractionError('');
    setFractionBusy(true);
    const { ok, data } = await postJson(`/api/plans/${planId}/delivery/fractions`, {
      fraction: fractionForm.fraction,
      deliveredGy: fractionForm.deliveredGy,
      setupShift: { x: fractionForm.x, y: fractionForm.y, z: fractionForm.z },
    });
    setFractionBusy(false);
    if (ok) {
      const nextNo = dossier!.fractions.length + 1;
      setFractionForm(f => ({ ...f, fraction: nextNo }));
      await refresh(planId);
    } else {
      setFractionError(data?.error === 'duplicate_fraction' ? `第 ${fractionForm.fraction} 次已登记，不能重复提交` : '分次登记失败');
    }
  }

  async function resolveDeviation(id: string) {
    setResolving(id);
    await postJson(`/api/plans/${planId}/deviations/${id}/resolve`);
    setResolving('');
    await refresh(planId);
  }

  async function release() {
    if (releasing || isApproved) return; // 前端防抖；最终判断仍在服务端
    setReleasing(true);
    setReleaseError(null);
    try {
      const { ok, data } = await postJson(`/api/plans/${planId}/release`);
      if (ok && data.released) {
        await refresh(planId);
        onPlanChanged?.();
      } else if (data?.error === 'release_in_progress') {
        setReleaseError('放行正在处理中，请勿重复提交');
      } else {
        // 放行失败：原样保留服务端给出的待处理原因
        if (Array.isArray(data?.blockers)) setServerBlockers(data.blockers);
        setReleaseError(`放行被服务端拒绝，仍有 ${data?.blockers?.length ?? ''} 项阻断原因待处理`);
        setDossier(d => d ? { ...d, gate: 'blocked', blockers: data?.blockers ?? d.blockers } : d);
      }
    } catch {
      setReleaseError('放行请求失败，请重试');
    } finally {
      setReleasing(false);
    }
  }

  return (
    <div className="dossier">
      <div className="dossierHead">
        <div>
          <h2>计划放行档案</h2>
          <p>{dossier.plan.label}（{dossier.plan.id}）· 物理师签发前须在此页看齐全部放行依据</p>
        </div>
        <div className="dossierHeadRight">
          <span className={`planStatus ${dossier.gate}`}>{dossier.gate === 'ready' ? '全部门禁通过' : '存在放行阻断'}</span>
          <span className={`approvedTag ${isApproved ? 'yes' : ''}`}>{isApproved ? '计划状态：已放行 approved' : '计划状态：待放行'}</span>
        </div>
      </div>

      {shownBlockers.length > 0 && (
        <section className="blockerBox">
          <h3>阻断原因（{shownBlockers.length}）— 全部清除后方可放行</h3>
          <ol>
            {shownBlockers.map((b, i) => (
              <li key={`${b.category}-${b.code}-${b.ref ?? i}`}>
                <span className={`blockerCat cat-${b.category}`}>{BLOCKER_LABEL[b.category] ?? b.category}</span>
                {b.message}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="dossierGrid">
        <section className="panel">
          <div className="panelHead">
            <h2>剂量约束结果</h2>
            <span>{dossier.checks.filter(c => c.pass).length}/{dossier.checks.length} 通过</span>
          </div>
          {dossier.checks.map(x => (
            <div className="constraint" key={x.structureId}>
              <div>
                <b>{x.name}</b>
                <small>{x.metric} · 限值 {x.limit}{x.unit}</small>
              </div>
              <strong className={x.pass ? 'pass' : 'fail'}>{x.value}{x.unit}</strong>
              <span className={x.pass ? 'chipPass' : 'chipFail'}>{x.pass ? 'PASS' : 'FAIL'}</span>
            </div>
          ))}
        </section>

        <section className="panel">
          <div className="panelHead">
            <h2>QA 验证</h2>
            <span>以每个项目最新一次结果为准</span>
          </div>
          {dossier.qa.length === 0 && <div className="emptyNote">尚无 QA 记录，缺少必需 QA 项目将阻断放行。</div>}
          {dossier.qa.map(q => (
            <div className="qaRow" key={q.id}>
              <div>
                <b>{QA_LABEL[q.method] ?? q.method}</b>
                <small>{q.detail} · {fmtTime(q.createdAt)}</small>
              </div>
              <span className={`qaStatus ${q.status}`}>{q.status.toUpperCase()}</span>
            </div>
          ))}
          <div className="qaActions">
            <button disabled={!!qaBusy} onClick={() => runQa('independent_mu', false)}>
              {qaBusy === 'independent_mu-pass' ? '执行中…' : '复算 MU（通过样例）'}
            </button>
            <button className="dangerOutline" disabled={!!qaBusy} onClick={() => runQa('independent_mu', true)}>
              {qaBusy === 'independent_mu-fail' ? '执行中…' : '复算 MU（失败样例）'}
            </button>
            <button disabled={!!qaBusy} onClick={() => runQa('gamma', false)}>
              {qaBusy === 'gamma-pass' ? '执行中…' : 'Gamma（通过样例）'}
            </button>
            <button className="dangerOutline" disabled={!!qaBusy} onClick={() => runQa('gamma', true)}>
              {qaBusy === 'gamma-fail' ? '执行中…' : 'Gamma（失败样例）'}
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panelHead">
            <h2>同行复核清单</h2>
            <span>{checkedCount}/{dossier.requiredChecklist.length} 项完成 · 逐项保存并留痕</span>
          </div>
          <div className="reviewerLine">
            <input
              placeholder="复核人姓名（保存清单项前必填）"
              value={reviewer}
              onChange={e => { setReviewer(e.target.value); setItemError(''); }}
            />
          </div>
          {dossier.requiredChecklist.map(item => {
            const saved = dossier.checklist.find(c => c.item === item);
            const busy = savingItem === item;
            return (
              <label className={`checkItem ${saved?.checked ? 'done' : ''}`} key={item}>
                <input
                  type="checkbox"
                  checked={!!saved?.checked}
                  disabled={busy}
                  onChange={e => toggleItem(item, e.target.checked)}
                />
                <span className="checkText">
                  <b>{item}</b>
                  <small>{saved ? `${saved.checked ? '已完成' : '已取消'} · ${saved.reviewer} · ${fmtTime(saved.at)}` : '尚未保存（刷新后仍以服务端记录为准）'}</small>
                </span>
                {busy && <span className="savingTag">保存中…</span>}
              </label>
            );
          })}
          {itemError && <div className="inlineError">{itemError}</div>}
        </section>

        <section className="panel">
          <div className="panelHead">
            <h2>治疗分次</h2>
            <span>已记录 {dossier.deliverySummary.fractions} 次 · 累计 {dossier.deliverySummary.cumulativeDose}/{dossier.deliverySummary.prescriptionDose} Gy</span>
          </div>
          {dossier.fractions.length === 0
            ? <div className="emptyNote">没有分次记录，放行将被阻断。请登记至少一次治疗分次。</div>
            : (
              <table className="fractionTable">
                <thead><tr><th>#</th><th>剂量 Gy</th><th>摆位偏移 mm (x,y,z)</th><th>时间</th></tr></thead>
                <tbody>
                  {dossier.fractions.map(f => (
                    <tr key={f.fraction}>
                      <td>{f.fraction}</td><td>{f.deliveredGy}</td>
                      <td>{f.setupShift.x}, {f.setupShift.y}, {f.setupShift.z}</td>
                      <td>{fmtTime(f.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <div className="fractionForm">
            <label>分次<input type="number" min={1} value={fractionForm.fraction}
              onChange={e => setFractionForm(f => ({ ...f, fraction: Number(e.target.value) }))} /></label>
            <label>剂量 Gy<input type="number" step="0.1" value={fractionForm.deliveredGy}
              onChange={e => setFractionForm(f => ({ ...f, deliveredGy: Number(e.target.value) }))} /></label>
            <label>x<input type="number" step="0.1" value={fractionForm.x}
              onChange={e => setFractionForm(f => ({ ...f, x: Number(e.target.value) }))} /></label>
            <label>y<input type="number" step="0.1" value={fractionForm.y}
              onChange={e => setFractionForm(f => ({ ...f, y: Number(e.target.value) }))} /></label>
            <label>z<input type="number" step="0.1" value={fractionForm.z}
              onChange={e => setFractionForm(f => ({ ...f, z: Number(e.target.value) }))} /></label>
            <button disabled={fractionBusy} onClick={addFraction}>{fractionBusy ? '登记中…' : '登记分次'}</button>
          </div>
          {fractionError && <div className="inlineError">{fractionError}</div>}
          <div className="hint">提示：任一方向导致偏移模长 &gt; 5 mm 时会自动产生高等级未关闭偏差。</div>
        </section>

        <section className="panel">
          <div className="panelHead">
            <h2>未关闭偏差</h2>
            <span>{dossier.openDeviations.filter(d => d.blocksRelease).length} 项高等级偏差阻断放行</span>
          </div>
          {dossier.openDeviations.length === 0 && <div className="emptyNote">没有未关闭偏差。</div>}
          {dossier.openDeviations.map(d => (
            <div className={`devRow sev-${d.severity}`} key={d.id}>
              <div>
                <b><span className={`sevTag ${d.severity}`}>{d.severity.toUpperCase()}</span> {d.category} · {d.id}</b>
                <small>{d.detail} · {fmtTime(d.createdAt)}</small>
              </div>
              {d.blocksRelease
                ? <button className="dangerOutline" disabled={resolving === d.id} onClick={() => resolveDeviation(d.id)}>
                    {resolving === d.id ? '关闭中…' : '关闭偏差'}
                  </button>
                : <span className="mutedTag">不阻断放行</span>}
            </div>
          ))}
        </section>

        <section className="panel">
          <div className="panelHead"><h2>风险估计</h2><span>基于当前计划剂量指标</span></div>
          <div className="riskGrid">
            <div>
              <strong>{dossier.riskEstimate.lungPneumonitis}%</strong>
              <span>放射性肺炎风险（NTCP 估计）</span>
            </div>
            <div>
              <strong>{dossier.riskEstimate.heartEvent}%</strong>
              <span>心脏事件风险（NTCP 估计）</span>
            </div>
          </div>
          <div className="callout">风险估计仅供物理师与医师综合研判，不替代放行门禁；门禁以服务端判定的阻断原因为准。</div>
        </section>
      </div>

      <section className={`releaseBar ${dossier.gate === 'ready' ? 'ready' : 'blocked'}`}>
        <div className="releaseInfo">
          {isApproved
            ? <b>该计划已放行，计划状态已同步为 approved。</b>
            : dossier.gate === 'ready'
              ? <b>全部门禁依据齐备，可以放行签发。</b>
              : <b>不可放行：请逐条处理上方 {shownBlockers.length} 项阻断原因（失败原因由服务端判定并保留）。</b>}
        </div>
        <button
          className="releaseBtn"
          disabled={dossier.gate !== 'ready' || releasing || isApproved}
          onClick={release}
        >
          {isApproved ? '已放行' : releasing ? '放行处理中…' : '放行计划'}
        </button>
      </section>
      {releaseError && <div className="releaseFail">{releaseError}</div>}

      <section className="panel auditPanel">
        <div className="panelHead"><h2>审计记录</h2><span>放行成功后同步展示本计划全部操作留痕</span></div>
        {audit.length === 0
          ? <div className="emptyNote">暂无审计记录。</div>
          : <ul className="auditList">
              {audit.map((a, i) => (
                <li key={i}>
                  <span className="auditTime">{fmtTime(a.at as string)}</span>
                  <span className="auditAction">{ACTION_LABEL[a.action as string] ?? a.action}</span>
                  <span className="auditMeta">
                    {typeof a.item === 'string' ? `清单项：${a.item}${a.checked === false ? '（取消勾选）' : ''}` : ''}
                    {typeof a.fraction === 'number' ? `第 ${a.fraction} 次` : ''}
                    {typeof a.reviewer === 'string' ? `复核人：${a.reviewer}` : ''}
                    {a.action === 'plan_released' ? '计划状态 → approved' : ''}
                  </span>
                </li>
              ))}
            </ul>}
      </section>
    </div>
  );
}

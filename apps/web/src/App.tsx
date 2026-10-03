import { useCallback, useEffect, useState } from 'react';
import './styles.css';

const api = (u: string) => fetch(u).then((r) => r.json());
const post = (u: string, body?: unknown) =>
  fetch(u, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json() }));
const del = (u: string) => fetch(u, { method: 'DELETE' }).then((r) => r.json());

type Blocker = { code: string; message: string; detail?: string[] };
type Dossier = {
  plan: { id: string; label: string; status: 'draft' | 'review' | 'approved' };
  gate: 'released' | 'blocked' | 'ready';
  blockers: Blocker[];
  checks: Array<{ structureId: string; name: string; metric: string; value: number; limit: number; unit: string; pass: boolean; delta: number }>;
  qa: {
    runs: Array<{ id: string; method: string; status: 'pass' | 'warn' | 'fail'; score: number; detail: string; createdAt: string }>;
    latest: Array<{ id: string; method: string; status: 'pass' | 'warn' | 'fail'; score: number; detail: string; createdAt: string }>;
    summary: { pass: number; warn: number; fail: number };
  };
  checklist: { required: string[]; items: Array<{ item: string; checked: boolean; reviewer: string; at: string }>; checkedCount: number; requiredCount: number; complete: boolean };
  delivery: { fractions: Array<{ fraction: number; deliveredGy: number; setupShift: { x: number; y: number; z: number }; at: string }>; count: number; plannedFractions: number; cumulativeDose: number; prescriptionDose: number };
  deviations: { openHigh: Array<{ id: string; category: string; detail: string; severity: string; createdAt: string }>; openCount: number };
  risk: { lungPneumonitis: number; cardiacEvent: number; cordMargin: number };
};

type AuditRecord = {
  at: string;
  action: string;
  [key: string]: unknown;
};

const QA_METHOD_LABEL: Record<string, string> = {
  independent_mu: '独立 MU 复算',
  gamma: 'γ 通过率 (3%/3mm)',
  image_guidance: '影像引导核查',
};

const AUDIT_ACTION_LABEL: Record<string, string> = {
  plan_released: '计划放行',
  peer_checklist: '同行复核清单',
  independent_check: 'QA 验证',
  fraction_delivered: '治疗分次登记',
  deviation_opened: '偏差登记',
  deviation_resolved: '偏差关闭',
  adaptive_evaluation: '自适应评估',
};

const BLOCKER_LABEL: Record<string, string> = {
  constraint_failed: '剂量约束',
  qa_failed: 'QA 验证',
  checklist_incomplete: '同行复核清单',
  open_high_deviation: '高等级偏差',
  no_fractions: '治疗分次记录',
};

const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/* ---------------- 计划放行档案页 ---------------- */

function ReleaseDossier({ planId, onReleased }: { planId: string; onReleased: () => void }) {
  const [dossier, setDossier] = useState<Dossier>();
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 放行操作状态
  const [releasing, setReleasing] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<{ ok: boolean; at: string; blockers?: Blocker[]; message?: string }>();

  // 清单逐项保存
  const [reviewer, setReviewer] = useState('');
  const [savingItem, setSavingItem] = useState('');
  const [itemError, setItemError] = useState('');

  // QA 录入
  const [qaMethod, setQaMethod] = useState<'gamma' | 'independent_mu'>('gamma');
  const [qaScore, setQaScore] = useState<number | ''>('');
  const [qaBusy, setQaBusy] = useState(false);

  // 分次登记
  const [fractionNo, setFractionNo] = useState<number | ''>(1);
  const [fractionDose, setFractionDose] = useState<number | ''>(2);
  const [shiftX, setShiftX] = useState<number | ''>(0);
  const [shiftY, setShiftY] = useState<number | ''>(0);
  const [shiftZ, setShiftZ] = useState<number | ''>(0);
  const [fractionBusy, setFractionBusy] = useState(false);
  const [fractionError, setFractionError] = useState('');

  // 切换计划时清掉所有本地状态，一切以服务端返回为准
  const reload = useCallback(async () => {
    setLoadError('');
    setLoading(true);
    try {
      const [d, a] = await Promise.all([
        api(`/api/plans/${planId}/verification-dossier`),
        api(`/api/plans/${planId}/audit`),
      ]);
      if (d.error) throw new Error(d.error);
      setDossier(d);
      setAudits(a.records ?? []);
    } catch {
      setLoadError('档案加载失败，请检查服务端后重试');
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    setDossier(undefined);
    setLastAttempt(undefined);
    setItemError('');
    setFractionError('');
    setFractionNo(1);
    setFractionDose(2);
    reload();
  }, [reload]);

  const gateBlocked = dossier?.gate === 'blocked';
  const released = dossier?.gate === 'released';

  const toggleItem = async (item: string, checked: boolean) => {
    if (!reviewer.trim() && checked) {
      setItemError('请先填写复核人姓名，再勾选清单项');
      return;
    }
    setItemError('');
    setSavingItem(item);
    try {
      const r = await post(`/api/plans/${planId}/peer-checklist`, { item, checked, reviewer: reviewer.trim() });
      if (!r.ok) {
        setItemError(r.data?.error === 'reviewer_required' ? '该清单项必须记录复核人' : '清单保存失败');
        return;
      }
      await reload(); // 从服务端恢复清单与门禁结果
    } finally {
      setSavingItem('');
    }
  };

  const submitQa = async () => {
    setQaBusy(true);
    try {
      await post(`/api/plans/${planId}/independent-check`, {
        method: qaMethod,
        score: qaScore === '' ? undefined : Number(qaScore),
      });
      setQaScore('');
      await reload();
    } finally {
      setQaBusy(false);
    }
  };

  const submitFraction = async () => {
    setFractionError('');
    if (fractionNo === '' || fractionDose === '') {
      setFractionError('请填写分次编号与本次剂量');
      return;
    }
    setFractionBusy(true);
    try {
      const r = await post(`/api/plans/${planId}/delivery/fractions`, {
        fraction: Number(fractionNo),
        deliveredGy: Number(fractionDose),
        setupShift: { x: Number(shiftX || 0), y: Number(shiftY || 0), z: Number(shiftZ || 0) },
      });
      if (!r.ok) {
        setFractionError(r.data?.error === 'duplicate_fraction' ? `第 ${fractionNo} 次已登记，请勿重复提交` : '分次登记失败');
        return;
      }
      setFractionNo(Number(fractionNo) + 1);
      await reload();
    } finally {
      setFractionBusy(false);
    }
  };

  const resolveDeviation = async (devId: string) => {
    await del(`/api/plans/${planId}/deviations/${devId}`);
    await reload();
  };

  // 放行：唯一入口，门禁由服务端逐项重新计算；这里只负责防重复点击与展示结果
  const release = async () => {
    if (releasing || released) return;
    setReleasing(true);
    try {
      const r = await post(`/api/plans/${planId}/release`);
      await reload();
      if (r.data?.released) {
        setLastAttempt({ ok: true, at: new Date().toISOString() });
        onReleased();
      } else {
        // 失败时保留服务端给出的全部待处理原因，不随后续刷新清除
        setLastAttempt({
          ok: false,
          at: new Date().toISOString(),
          blockers: r.data?.blockers ?? [],
          message: r.data?.reason === 'already_released' ? '计划已被放行，无需重复操作' : '服务端门禁未通过，请逐项处理后重试',
        });
      }
    } catch {
      setLastAttempt({ ok: false, at: new Date().toISOString(), message: '放行请求失败，请稍后重试' });
    } finally {
      setReleasing(false);
    }
  };

  if (loading) return <section className="panel dossierLoading">档案加载中…</section>;
  if (loadError) {
    return (
      <section className="panel dossierLoading">
        {loadError}
        <button onClick={reload}>重新加载</button>
      </section>
    );
  }
  if (!dossier) return null;

  const isChecked = (item: string) => dossier.checklist.items.some((x) => x.item === item && x.checked);
  const itemState = (item: string) => dossier.checklist.items.find((x) => x.item === item);

  return (
    <div className="dossier">
      {/* 门禁总览 */}
      <section className={`gateBanner ${dossier.gate}`}>
        <div>
          <h2>{released ? '计划已放行（治疗执行中）' : gateBlocked ? `放行门禁未通过 · ${dossier.blockers.length} 类阻断原因` : '全部门禁通过，可以放行'}</h2>
          <p>
            {released
              ? '计划状态已同步为 approved，后续审计记录持续追加。'
              : gateBlocked
                ? '以下每一阻断项都由服务端按计划实时计算，前端隐藏或修改均不会影响判断。'
                : '约束、QA、同行复核、治疗分次、偏差与风险估计均已满足放行要求。'}
          </p>
        </div>
        <div className="gateStats">
          <span><b>{dossier.checks.filter((x) => x.pass).length}</b>/{dossier.checks.length} 约束</span>
          <span><b>{dossier.qa.summary.pass}</b> 通过 QA</span>
          <span><b>{dossier.checklist.checkedCount}</b>/{dossier.checklist.requiredCount} 复核项</span>
          <span><b>{dossier.delivery.count}</b> 分次</span>
        </div>
      </section>

      {/* 上一次放行尝试：失败原因持续保留，直到放行成功 */}
      {lastAttempt && (
        <section className={`attemptBox ${lastAttempt.ok ? 'ok' : 'fail'}`}>
          <strong>{lastAttempt.ok ? '✓ 放行成功' : '✗ 放行被拒绝'}</strong>
          <span>最近尝试：{fmtTime(lastAttempt.at)}</span>
          {!lastAttempt.ok && <p>{lastAttempt.message}</p>}
          {!lastAttempt.ok && lastAttempt.blockers?.length ? (
            <ul>
              {lastAttempt.blockers.map((b, i) => (
                <li key={`${b.code}-${i}`}>
                  [{BLOCKER_LABEL[b.code] ?? b.code}] {b.message}
                  {b.detail?.length ? <em>（{b.detail.join('；')}）</em> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {lastAttempt.ok && <p>计划状态已更新，审计记录已追加 plan_released 条目。</p>}
        </section>
      )}

      <div className="dossierGrid">
        {/* 阻断原因 */}
        <section className="panel">
          <div className="panelHead"><h2>阻断原因清单</h2><span>服务端门禁</span></div>
          {dossier.blockers.length === 0 ? (
            <div className="emptyState okState">当前没有阻断项</div>
          ) : (
            dossier.blockers.map((b, i) => (
              <div className="blockerCard" key={`${b.code}-${i}`}>
                <div className="blockerHead"><span className="blockerTag">{BLOCKER_LABEL[b.code] ?? b.code}</span><strong>{b.message}</strong></div>
                {b.detail?.length ? (
                  <ul>{b.detail.map((d, j) => <li key={j}>{d}</li>)}</ul>
                ) : null}
              </div>
            ))
          )}
        </section>

        {/* 约束结果 */}
        <section className="panel">
          <div className="panelHead"><h2>剂量约束结果</h2><span>DVH 指标自动计算</span></div>
          {dossier.checks.map((x) => (
            <div className="constraint" key={x.structureId}>
              <div><b>{x.name}</b><small>{x.metric} · 限值 {x.limit}{x.unit} · 偏差 {x.delta > 0 ? '+' : ''}{x.delta}{x.unit}</small></div>
              <strong className={x.pass ? 'pass' : 'fail'}>{x.value}{x.unit}</strong>
              <span className={x.pass ? 'chipPass' : 'chipFail'}>{x.pass ? 'PASS' : 'FAIL'}</span>
            </div>
          ))}
        </section>

        {/* QA */}
        <section className="panel">
          <div className="panelHead">
            <h2>QA 验证</h2>
            <span>最新有效：{dossier.qa.summary.pass} 通过 / {dossier.qa.summary.warn} 警告 / <b className={dossier.qa.summary.fail ? 'fail' : 'pass'}>{dossier.qa.summary.fail} 失败</b></span>
          </div>
          {dossier.qa.runs.length === 0 && <div className="emptyState">暂无 QA 记录</div>}
          {dossier.qa.runs.map((run, idx) => {
            const isLatest = dossier.qa.latest.some((x) => x.id === run.id);
            return (
              <div className={`qaRow status-${run.status}`} key={run.id}>
                <div>
                  <b>{QA_METHOD_LABEL[run.method] ?? run.method}</b>
                  {!isLatest && <em className="superseded">已被新结果覆盖</em>}
                  <small>{run.detail} · {fmtTime(run.createdAt)}</small>
                </div>
                <span className={run.status === 'pass' ? 'chipPass' : run.status === 'fail' ? 'chipFail' : 'chipWarn'}>
                  {run.status === 'pass' ? 'PASS' : run.status === 'fail' ? 'FAIL' : 'WARN'}
                </span>
              </div>
            );
          })}
          <div className="inlineForm">
            <label>方法
              <select value={qaMethod} onChange={(e) => setQaMethod(e.target.value as 'gamma' | 'independent_mu')}>
                <option value="gamma">γ 通过率（%）</option>
                <option value="independent_mu">独立 MU 差异（%）</option>
              </select>
            </label>
            <label>数值
              <input value={qaScore} type="number" step="0.1" placeholder={qaMethod === 'gamma' ? '默认 97.1' : '默认 2.2'} onChange={(e) => setQaScore(e.target.value === '' ? '' : Number(e.target.value))} />
            </label>
            <button disabled={qaBusy} onClick={submitQa}>{qaBusy ? '提交中…' : '登记一次 QA'}</button>
            <small className="formHint">γ &lt;95% 或 MU 差异 &gt;3% 记为失败；同方法以最新结果为准</small>
          </div>
        </section>

        {/* 同行复核清单：逐项保存，刷新/切换计划后从服务端恢复 */}
        <section className="panel">
          <div className="panelHead"><h2>同行复核清单</h2><span>{dossier.checklist.checkedCount}/{dossier.checklist.requiredCount} 已完成</span></div>
          <div className="reviewerRow">
            <input placeholder="复核人姓名（勾选前必填）" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
          </div>
          {itemError && <div className="formError">{itemError}</div>}
          {dossier.checklist.required.map((item) => {
            const checked = isChecked(item);
            const state = itemState(item);
            return (
              <label className={`checkRow ${checked ? 'checked' : ''}`} key={item}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={savingItem === item}
                  onChange={(e) => toggleItem(item, e.target.checked)}
                />
                <span>
                  <b>{item}</b>
                  {state && <small>{state.checked ? `${state.reviewer || '未署名'} · ${fmtTime(state.at)}` : '已取消勾选'}</small>}
                  {savingItem === item && <small className="saving">保存中…</small>}
                </span>
              </label>
            );
          })}
        </section>

        {/* 治疗分次 */}
        <section className="panel">
          <div className="panelHead"><h2>治疗分次记录</h2><span>{dossier.delivery.count}/{dossier.delivery.plannedFractions} 次 · 累计 {dossier.delivery.cumulativeDose}/{dossier.delivery.prescriptionDose} Gy</span></div>
          {dossier.delivery.count === 0 && (
            <div className="emptyState dangerState">没有任何分次记录——这是当前放行阻断项之一</div>
          )}
          {dossier.delivery.fractions.map((f) => {
            const mag = Math.hypot(f.setupShift.x, f.setupShift.y, f.setupShift.z);
            return (
              <div className="fractionRow" key={f.fraction}>
                <b>第 {f.fraction} 次</b>
                <span>{f.deliveredGy} Gy</span>
                <small>摆位偏移 ({f.setupShift.x}, {f.setupShift.y}, {f.setupShift.z}) mm · 合位移 {mag.toFixed(1)} mm</small>
                <small>{fmtTime(f.at)}</small>
              </div>
            );
          })}
          <div className="inlineForm fractionForm">
            <label>第 <input type="number" value={fractionNo} onChange={(e) => setFractionNo(e.target.value === '' ? '' : Number(e.target.value))} /> 次</label>
            <label>剂量 <input type="number" step="0.1" value={fractionDose} onChange={(e) => setFractionDose(e.target.value === '' ? '' : Number(e.target.value))} /> Gy</label>
            <label>X <input type="number" step="0.1" value={shiftX} onChange={(e) => setShiftX(e.target.value === '' ? '' : Number(e.target.value))} /></label>
            <label>Y <input type="number" step="0.1" value={shiftY} onChange={(e) => setShiftY(e.target.value === '' ? '' : Number(e.target.value))} /></label>
            <label>Z <input type="number" step="0.1" value={shiftZ} onChange={(e) => setShiftZ(e.target.value === '' ? '' : Number(e.target.value))} /></label>
            <button disabled={fractionBusy} onClick={submitFraction}>{fractionBusy ? '提交中…' : '登记分次'}</button>
            {fractionError && <small className="formError">{fractionError}</small>}
            <small className="formHint">摆位合位移 &gt;5 mm 会自动生成一条高等级偏差</small>
          </div>
        </section>

        {/* 未关闭高等级偏差 */}
        <section className="panel">
          <div className="panelHead"><h2>未关闭高等级偏差</h2><span>{dossier.deviations.openCount} 条未关闭</span></div>
          {dossier.deviations.openHigh.length === 0 ? (
            <div className="emptyState okState">没有未关闭的高等级偏差</div>
          ) : (
            dossier.deviations.openHigh.map((d) => (
              <div className="deviationCard" key={d.id}>
                <div className="blockerHead"><span className="blockerTag danger">HIGH</span><strong>{d.category}</strong></div>
                <p>{d.detail}</p>
                <small>{d.id} · {fmtTime(d.createdAt)}</small>
                <button className="resolveBtn" onClick={() => resolveDeviation(d.id)}>确认并关闭偏差</button>
              </div>
            ))
          )}
        </section>

        {/* 风险估计 */}
        <section className="panel">
          <div className="panelHead"><h2>正常组织并发症风险估计</h2><span>基于当前计划剂量学结果</span></div>
          <div className="riskGrid">
            <div className="riskCard"><b>{dossier.risk.lungPneumonitis}%</b><span>放射性肺炎 (NTCP)</span><small>双肺-PTV V20 驱动</small></div>
            <div className="riskCard"><b>{dossier.risk.cardiacEvent}%</b><span>心脏事件 10 年风险</span><small>心脏 V20 驱动</small></div>
            <div className={`riskCard ${dossier.risk.cordMargin < 3 ? 'riskHigh' : ''}`}><b>{dossier.risk.cordMargin} Gy</b><span>脊髓 Dmax 安全余量</span><small>限值 45 Gy</small></div>
          </div>
        </section>

        {/* 放行操作 */}
        <section className="panel releasePanel">
          <div className="panelHead"><h2>放行签发</h2><span>唯一签发入口</span></div>
          <p className="releaseNote">
            放行请求由服务端重新校验全部门禁（约束 / QA / 同行复核清单 / 高等级偏差 / 分次记录）。
            即使通过浏览器篡改本页面，任何未满足的门禁仍会被服务端拒绝并返回待处理原因。
          </p>
          <button className="releaseBtn" disabled={releasing || released} onClick={release}>
            {released ? '✓ 已放行' : releasing ? '正在提交放行…' : '确认放行计划'}
          </button>
          {!released && !gateBlocked && <small className="formHint okState">门禁全绿，可提交；提交期间按钮锁定防止重复点击。</small>}
        </section>

        {/* 审计记录 */}
        <section className="panel auditPanel">
          <div className="panelHead"><h2>审计记录</h2><span>{audits.length} 条</span></div>
          {audits.length === 0 ? (
            <div className="emptyState">该计划暂无操作记录</div>
          ) : (
            audits.map((a, i) => (
              <div className={`auditRow ${a.action === 'plan_released' ? 'auditRelease' : ''}`} key={`${a.at}-${i}`}>
                <span className="auditAction">{AUDIT_ACTION_LABEL[a.action] ?? a.action}</span>
                <small>{fmtTime(a.at)}</small>
                <AuditDetail record={a} />
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function AuditDetail({ record }: { record: AuditRecord }) {
  const extra = Object.entries(record).filter(([k]) => !['at', 'action', 'planId'].includes(k));
  if (!extra.length) return null;
  return (
    <em className="auditDetail">
      {extra
        .map(([k, v]) => (typeof v === 'object' ? `${k}: ${JSON.stringify(v)}` : `${k}: ${String(v)}`))
        .join(' · ')}
    </em>
  );
}

/* ---------------- 其余既有页面（只读，不再承担放行） ---------------- */

export default function App() {
  const [tab, setTab] = useState('dose');
  const [patient, setPatient] = useState<any>();
  const [plans, setPlans] = useState<any[]>([]);
  const [active, setActive] = useState('PLAN-A');
  const [constraints, setConstraints] = useState<any>();
  const [compare, setCompare] = useState<any>();
  const [slice, setSlice] = useState<any>();

  useEffect(() => {
    api('/api/patient/current').then(setPatient);
    api('/api/plans').then(setPlans);
    api('/api/compare').then(setCompare);
  }, []);

  useEffect(() => {
    if (active) {
      api(`/api/plans/${active}/constraints`).then(setConstraints);
      api(`/api/plans/${active}/dose-slice?index=12`).then(setSlice);
    }
  }, [active]);

  const activePlan = plans.find((p) => p.id === active);

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">RADIATION ONCOLOGY / PLAN QA</span>
          <h1>放射治疗剂量计划验证与器官风险评估系统</h1>
          <p>{patient?.patient?.id} · {patient?.patient?.diagnosis} · 处方 {patient?.patient?.rxDose} Gy / {patient?.patient?.fractions} 次</p>
        </div>
        <div className="badge">物理师复核模式</div>
      </header>
      <nav>
        {([['dose', '剂量阅片'], ['constraints', '约束校验'], ['compare', '计划对比'], ['release', '计划放行档案']] as Array<[string, string]>).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {id === 'release' && <span className="navIcon">▤</span>}
            {label}
          </button>
        ))}
      </nav>
      <section className="toolbar">
        <label>当前计划
          <select value={active} onChange={(e) => setActive(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <span className={`planStatus status-${activePlan?.status ?? 'draft'}`}>
          计划状态：{activePlan?.status === 'approved' ? '已放行 approved' : activePlan?.status === 'review' ? '复核中 review' : '草稿 draft'}
        </span>
      </section>

      {tab === 'dose' && (
        <section className="grid">
          <div className="panel imagePanel">
            <div className="panelHead"><h2>断层切片剂量叠加</h2><span>切片 12 / 32 · 等剂量线：20 / 50 / 95%</span></div>
            <div className="slice">{slice?.data.map((row: number[], y: number) => row.map((v: number, x: number) => <span key={`${x}-${y}`} style={{ background: `hsl(${Math.max(0, 240 - v * 2.2)},${v > 80 ? 88 : 55}%,${25 + v * 0.45}%)` }} />))}</div>
            <div className="doseLegend"><span style={{ background: '#244bd5' }} />低剂量 <span style={{ background: '#f3bb35' }} />中剂量 <span style={{ background: '#ef555b' }} />高剂量</div>
          </div>
          <div className="panel">
            <div className="panelHead"><h2>计划参数</h2><span>{active}</span></div>
            {activePlan && Object.entries(activePlan).filter(([k]) => !['id', 'status'].includes(k)).map(([k, v]) => (
              <div className="kv" key={k}><span>{k}</span><b>{String(v)}</b></div>
            ))}
            <div className="callout">剂量验证不是单一通过/失败判断，需要同时审查靶区覆盖、危及器官受量、机器跳数和算法版本。签发请前往「计划放行档案」。</div>
          </div>
        </section>
      )}

      {tab === 'constraints' && (
        <section className="grid">
          <div className="panel">
            <div className="panelHead"><h2>结构约束校验</h2><span>DVH 指标自动计算（只读）</span></div>
            {constraints?.checks.map((x: any) => (
              <div className="constraint" key={x.structureId}>
                <div><b>{x.name}</b><small>{x.metric} · 限值 {x.limit}{x.unit}</small></div>
                <strong className={x.pass ? 'pass' : 'fail'}>{x.value}{x.unit}</strong>
                <span className={x.pass ? 'chipPass' : 'chipFail'}>{x.pass ? 'PASS' : 'FAIL'}</span>
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="panelHead"><h2>DVH 曲线摘要</h2><span>体积-剂量关系</span></div>
            {patient?.structures.map((s: any) => (
              <div className="bar" key={s.id}>
                <span>{s.name}</span>
                <div><i style={{ width: `${Math.min(100, constraints?.checks.find((x: any) => x.structureId === s.id)?.value ?? 0)}%` }} /></div>
                <b>{constraints?.checks.find((x: any) => x.structureId === s.id)?.value}</b>
              </div>
            ))}
            <div className="callout">本页仅展示约束计算结果。放行需要在「计划放行档案」中同时通过约束、QA、同行复核、分次与偏差全部门禁。</div>
          </div>
        </section>
      )}

      {tab === 'compare' && (
        <section className="panel">
          <div className="panelHead"><h2>计划对比与选择</h2><span>同一患者、不同照射技术</span></div>
          <div className="compareGrid">
            {compare?.plans.map((p: any) => (
              <div key={p.id} className={`compareCard ${p.id === active ? 'selected' : ''}`} onClick={() => setActive(p.id)}>
                <h3>{p.label}</h3>
                <strong>{p.targetCoverage}%</strong>
                <small>PTV D95 覆盖</small>
                <p>MU {p.mu} · 约束失败 {p.checks.filter((x: any) => !x.pass).length} 项</p>
                {p.checks.map((x: any) => (
                  <div key={x.structureId} className={x.pass ? 'tinyPass' : 'tinyFail'}>{x.name}: {x.value}{x.unit}</div>
                ))}
              </div>
            ))}
          </div>
          <div className="recommend">系统建议：{compare?.recommendation}。选定后请到「计划放行档案」完成签发。</div>
        </section>
      )}

      {tab === 'release' && (
        <ReleaseDossier
          key={active}
          planId={active}
          onReleased={() => {
            api('/api/plans').then(setPlans);
            api(`/api/plans/${active}/constraints`).then(setConstraints);
          }}
        />
      )}
    </main>
  );
}

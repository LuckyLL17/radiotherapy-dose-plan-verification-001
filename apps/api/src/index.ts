import Fastify from 'fastify';
import cors from '@fastify/cors';

type Structure = {
  id: string; name: string; type: 'target' | 'organ'; volume: number;
  priority: 'high' | 'medium' | 'low';
  constraint: { metric: 'D95' | 'Dmax' | 'V20'; limit: number; unit: string };
};
type Plan = {
  id: string; label: string; beamCount: number; energy: string;
  algorithm: string; mu: number; createdAt: string;
  status: 'draft' | 'review' | 'approved';
};
type QaRun = {
  id: string; planId: string;
  method: 'independent_mu' | 'gamma' | 'image_guidance';
  status: 'pass' | 'warn' | 'fail'; score: number; detail: string; createdAt: string;
};
type ChecklistItem = { item: string; checked: boolean; reviewer: string; at: string };
type FractionRecord = {
  fraction: number; deliveredGy: number;
  setupShift: { x: number; y: number; z: number }; at: string;
};
type Deviation = {
  id: string; planId: string; severity: 'low' | 'medium' | 'high';
  category: string; detail: string; state: 'open' | 'resolved'; createdAt: string;
};
type BlockerCategory = 'constraint' | 'qa' | 'checklist' | 'delivery' | 'deviation';
type Blocker = { category: BlockerCategory; code: string; message: string; ref?: string };

const patient = {
  id: 'PT-2026-0917', name: '示例患者', diagnosis: '肺部肿瘤（演示数据）',
  site: '右肺下叶', fractions: 30, rxDose: 60,
};
const structures: Structure[] = [
  { id: 'PTV', name: 'PTV-60', type: 'target', volume: 84, priority: 'high', constraint: { metric: 'D95', limit: 95, unit: '%' } },
  { id: 'LUNG', name: '双肺-PTV', type: 'organ', volume: 4200, priority: 'high', constraint: { metric: 'V20', limit: 25, unit: '%' } },
  { id: 'HEART', name: '心脏', type: 'organ', volume: 720, priority: 'high', constraint: { metric: 'V20', limit: 15, unit: '%' } },
  { id: 'CORD', name: '脊髓', type: 'organ', volume: 58, priority: 'high', constraint: { metric: 'Dmax', limit: 45, unit: 'Gy' } },
  { id: 'ESOPH', name: '食管', type: 'organ', volume: 88, priority: 'medium', constraint: { metric: 'Dmax', limit: 50, unit: 'Gy' } },
];
const plans: Plan[] = [
  { id: 'PLAN-A', label: 'VMAT 主计划', beamCount: 2, energy: '6MV FFF', algorithm: 'Acuros XB 18.0', mu: 634, createdAt: '2026-09-30T08:20:00Z', status: 'review' },
  { id: 'PLAN-B', label: 'IMRT 对照计划', beamCount: 7, energy: '6MV', algorithm: 'AAA 16.1', mu: 712, createdAt: '2026-09-29T16:40:00Z', status: 'draft' },
];
const audits: Array<Record<string, unknown>> = [];

// 放行进行中的计划：服务端防重复点击 / 并发重复提交
const releasing = new Set<string>();

const REQUIRED_CHECKLIST = [
  '靶区轮廓与处方一致性',
  '危及器官约束复核',
  '束角与碰撞检查',
  '独立剂量验证',
];
// 放行前必须有最新“通过”结果的 QA 项目
const REQUIRED_QA: Array<{ method: QaRun['method']; label: string }> = [
  { method: 'independent_mu', label: '独立 MU 复算' },
  { method: 'gamma', label: '3%/3mm Gamma 验证' },
];

const qaRuns: QaRun[] = [
  { id: 'QA-071', planId: 'PLAN-A', method: 'independent_mu', status: 'pass', score: 1.7, detail: '独立 MU 复算差异 1.7%，低于 3% 阈值', createdAt: '2026-09-30T09:16:00Z' },
  { id: 'QA-072', planId: 'PLAN-A', method: 'gamma', status: 'pass', score: 98.4, detail: '3%/3mm γ 通过率 98.4%，高于 95% 阈值', createdAt: '2026-09-30T09:23:00Z' },
];
const peerChecklist = new Map<string, ChecklistItem[]>();
const deliveries = new Map<string, FractionRecord[]>();
const deviations: Deviation[] = [];

function metrics(plan: Plan) {
  const bias = plan.id === 'PLAN-A' ? 0 : 3;
  return structures.map(s => {
    const value = s.type === 'target' ? 96.4 - bias
      : s.id === 'LUNG' ? 21.3 + bias
      : s.id === 'HEART' ? 10.2 + bias * .7
      : s.id === 'CORD' ? 42.1 + bias * 1.1
      : 46.8 + bias;
    return {
      structureId: s.id, name: s.name, metric: s.constraint.metric,
      value: +value.toFixed(2), limit: s.constraint.limit, unit: s.constraint.unit,
      pass: value <= s.constraint.limit || s.type === 'target',
      delta: +(value - s.constraint.limit).toFixed(2), doseVolume: s.volume,
    };
  });
}
function dvh(plan: Plan) {
  return structures.map(s => ({
    structureId: s.id, name: s.name,
    points: Array.from({ length: 11 }, (_, i) => ({
      dose: +(i * plan.mu / 110).toFixed(1),
      volume: +(100 - i * (s.type === 'target' ? 8.3 : 10.6)).toFixed(1),
    })),
  }));
}
function slice(index: number) {
  return Array.from({ length: 32 }, (_, y) =>
    Array.from({ length: 32 }, (_, x) => {
      const lung = Math.pow(x - 11, 2) + Math.pow(y - 16, 2) < 105 || Math.pow(x - 23, 2) + Math.pow(y - 15, 2) < 90;
      const tumor = Math.pow(x - 22, 2) + Math.pow(y - 18, 2) < 12;
      const dose = tumor ? 95 : lung ? 48 + Math.max(0, 25 - Math.abs(x - 18)) * 1.4 : 10;
      return Math.round(dose + Math.sin((x + index) * .7) * 3);
    }));
}

// 每个 QA 项目只取最新一次结果作为门禁依据
function latestQaByMethod(planId: string) {
  const map = new Map<QaRun['method'], QaRun>();
  qaRuns
    .filter(q => q.planId === planId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .forEach(q => { if (!map.has(q.method)) map.set(q.method, q); });
  return map;
}

// 计划放行档案：所有门禁判断唯一来源（前端任何隐藏都无法绕过）
function releaseDossier(planId: string) {
  const plan = plans.find(p => p.id === planId);
  if (!plan) return { error: 'plan_not_found' };

  const checks = metrics(plan);
  const qa = qaRuns.filter(x => x.planId === planId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const latestQa = latestQaByMethod(planId);
  const checklist = peerChecklist.get(planId) ?? [];
  const fractions = (deliveries.get(planId) ?? [])
    .slice()
    .sort((a, b) => a.fraction - b.fraction);
  const openDeviations = deviations
    .filter(d => d.planId === planId && d.state === 'open')
    .map(d => ({ ...d, blocksRelease: d.severity === 'high' }));

  const blockers: Blocker[] = [];

  for (const c of checks.filter(x => !x.pass)) {
    blockers.push({
      category: 'constraint', code: 'constraint_failed', ref: c.structureId,
      message: `${c.name} ${c.metric} = ${c.value}${c.unit}，超出限值 ${c.limit}${c.unit}`,
    });
  }
  for (const spec of REQUIRED_QA) {
    const run = latestQa.get(spec.method);
    if (!run) {
      blockers.push({ category: 'qa', code: 'qa_missing', ref: spec.method, message: `缺少 QA 结果：${spec.label}` });
    } else if (run.status === 'fail') {
      blockers.push({ category: 'qa', code: 'qa_failed', ref: run.id, message: `${spec.label} 未通过：${run.detail}` });
    }
  }
  for (const item of REQUIRED_CHECKLIST) {
    const saved = checklist.find(x => x.item === item);
    if (!saved?.checked) {
      blockers.push({ category: 'checklist', code: 'checklist_unchecked', ref: item, message: `同行复核未完成：${item}` });
    }
  }
  if (fractions.length === 0) {
    blockers.push({ category: 'delivery', code: 'no_fractions', message: '没有治疗分次记录，无法确认计划已进入可放行治疗流程' });
  }
  for (const d of openDeviations.filter(x => x.blocksRelease)) {
    blockers.push({ category: 'deviation', code: 'open_high_deviation', ref: d.id, message: `未关闭高等级偏差：${d.detail}` });
  }

  const lung = checks.find(x => x.structureId === 'LUNG')!;
  const heart = checks.find(x => x.structureId === 'HEART')!;

  return {
    plan,
    checks,
    qa,
    checklist,
    requiredChecklist: REQUIRED_CHECKLIST,
    fractions,
    openDeviations,
    deliverySummary: {
      fractions: fractions.length,
      prescriptionFractions: patient.fractions,
      cumulativeDose: +fractions.reduce((s, x) => s + x.deliveredGy, 0).toFixed(2),
      prescriptionDose: patient.rxDose,
    },
    gate: blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
    riskEstimate: {
      lungPneumonitis: +Math.max(1, Math.min(35, lung.value * 1.08)).toFixed(1),
      heartEvent: +Math.max(.2, Math.min(20, heart.value * .46)).toFixed(1),
    },
  };
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

const findPlan = (id: string) => plans.find(p => p.id === id);

app.get('/api/health', async () => ({ status: 'ok', service: 'radiotherapy-dose-plan-verification' }));
app.get('/api/patient/current', async () => ({ patient, structures }));
app.get('/api/plans', async () => plans);
app.get('/api/plans/:id/dose-slice', async (req) => {
  const id = (req.params as { id: string }).id;
  if (!findPlan(id)) return { error: 'plan_not_found' };
  const q = req.query as { index?: string };
  const index = Number(q.index ?? 12);
  return { planId: id, index, size: 32, data: slice(index) };
});
app.get('/api/plans/:id/dvh', async (req) => {
  const p = findPlan((req.params as { id: string }).id);
  return p ? dvh(p) : { error: 'plan_not_found' };
});
app.get('/api/plans/:id/constraints', async (req) => {
  const p = findPlan((req.params as { id: string }).id);
  if (!p) return { error: 'plan_not_found' };
  const checks = metrics(p);
  return { plan: p, checks, gate: checks.every(x => x.pass) ? 'ready' : 'blocked' };
});
app.get('/api/compare', async () => ({
  plans: plans.map(p => ({
    id: p.id, label: p.label, checks: metrics(p),
    targetCoverage: metrics(p)[0].value, mu: p.mu,
  })),
  recommendation: 'PLAN-A 在靶区覆盖和危及器官约束之间取得更优平衡',
}));

// 旧的直接签发入口：同样以完整放行档案门禁为准，禁止绕过
app.post('/api/plans/:id/approve', async (req, reply) => {
  const p = findPlan((req.params as { id: string }).id);
  if (!p) { reply.code(404); return { error: 'plan_not_found' }; }
  const dossier = releaseDossier(p.id);
  if (dossier.gate === 'blocked') {
    reply.code(409);
    return { approved: false, gate: 'blocked', blockers: dossier.blockers, note: '请在“计划放行档案”页面查看并处理全部阻断原因' };
  }
  p.status = 'approved';
  audits.unshift({ at: new Date().toISOString(), action: 'plan_approved', planId: p.id });
  return { approved: true, plan: p };
});
app.post('/api/plans/:id/peer-review', async (req, reply) => {
  const p = findPlan((req.params as { id: string }).id);
  if (!p) { reply.code(404); return { error: 'plan_not_found' }; }
  const body = req.body as { reviewer?: string; note?: string };
  if (!body?.reviewer || !body?.note) { reply.code(400); return { error: 'reviewer_and_note_required' }; }
  audits.unshift({ at: new Date().toISOString(), action: 'peer_review', planId: p.id, ...body });
  return { ok: true, planId: p.id, reviewer: body.reviewer };
});
app.get('/api/audit', async (req) => {
  const q = req.query as { planId?: string; limit?: string };
  let rows = audits;
  if (q.planId) rows = rows.filter(a => a.planId === q.planId);
  const limit = Number(q.limit ?? 50);
  return { audit: rows.slice(0, Number.isFinite(limit) ? limit : 50) };
});

// 计划放行档案
app.get('/api/plans/:id/verification-dossier', async (req, reply) => {
  const dossier = releaseDossier((req.params as { id: string }).id);
  if ('error' in dossier) { reply.code(404); return dossier; }
  return dossier;
});

// QA 执行
app.post('/api/plans/:id/independent-check', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!findPlan(id)) { reply.code(404); return { error: 'plan_not_found' }; }
  const body = (req.body ?? {}) as { method?: QaRun['method']; score?: number };
  const method = body.method ?? 'independent_mu';
  const score = body.score ?? (method === 'gamma' ? 97.1 : 2.2);
  const status: QaRun['status'] = method === 'gamma'
    ? (score >= 95 ? 'pass' : score >= 90 ? 'warn' : 'fail')
    : (score <= 3 ? 'pass' : score <= 5 ? 'warn' : 'fail');
  const run: QaRun = {
    id: `QA-${String(qaRuns.length + 71).padStart(3, '0')}`, planId: id, method, status, score,
    detail: method === 'gamma' ? `3%/3mm γ 通过率 ${score}%` : `独立 MU 差异 ${score}%`,
    createdAt: new Date().toISOString(),
  };
  qaRuns.unshift(run);
  audits.unshift({ at: run.createdAt, action: 'independent_check', ...run });
  return run;
});

// 同行复核清单：逐项保存（服务端持久化，刷新/切换计划后从服务端恢复）
app.post('/api/plans/:id/peer-checklist', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!findPlan(id)) { reply.code(404); return { error: 'plan_not_found' }; }
  const body = req.body as { item?: unknown; checked?: unknown; reviewer?: unknown };
  if (typeof body?.item !== 'string' || !REQUIRED_CHECKLIST.includes(body.item)) {
    reply.code(400); return { error: 'invalid_checklist_item' };
  }
  if (typeof body.checked !== 'boolean') { reply.code(400); return { error: 'checked_must_be_boolean' }; }
  if (typeof body.reviewer !== 'string' || !body.reviewer.trim()) {
    reply.code(400); return { error: 'reviewer_required' };
  }
  const list = peerChecklist.get(id) ?? [];
  const existing = list.find(x => x.item === body.item);
  const at = new Date().toISOString();
  if (existing) {
    existing.checked = body.checked;
    existing.reviewer = body.reviewer.trim();
    existing.at = at;
  } else {
    list.push({ item: body.item, checked: body.checked, reviewer: body.reviewer.trim(), at });
  }
  peerChecklist.set(id, list);
  audits.unshift({ at, action: 'peer_checklist', planId: id, item: body.item, checked: body.checked, reviewer: body.reviewer.trim() });
  return { planId: id, items: list, required: REQUIRED_CHECKLIST };
});

app.post('/api/plans/:id/adaptive-evaluation', async (req) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { weightChange?: number; tumorShift?: number; lungDensityChange?: number };
  const shift = Math.abs(body.tumorShift ?? 0);
  const weight = Math.abs(body.weightChange ?? 0);
  const density = Math.abs(body.lungDensityChange ?? 0);
  const coverage = +(96.4 - shift * .7 - weight * .18).toFixed(2);
  const lungV20 = +(21.3 + density * .8 + shift * .12).toFixed(2);
  const recommendation = coverage < 95 || lungV20 > 25 ? '需要自适应重计划评估' : '可按原计划继续治疗';
  const event = {
    id: `ADP-${Date.now()}`, planId: id, coverage, lungV20,
    anatomyChange: { weight, shift, density }, recommendation,
    createdAt: new Date().toISOString(),
  };
  audits.unshift({ at: event.createdAt, action: 'adaptive_evaluation', ...event });
  return event;
});

// 治疗分次登记（摆位偏移 >5mm 自动产生高等级未关闭偏差）
app.post('/api/plans/:id/delivery/fractions', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!findPlan(id)) { reply.code(404); return { error: 'plan_not_found' }; }
  const body = req.body as { fraction?: number; deliveredGy?: number; setupShift?: { x: number; y: number; z: number } };
  const shift = body?.setupShift;
  const fraction = body?.fraction;
  const deliveredGy = body?.deliveredGy;
  if (typeof fraction !== 'number' || typeof deliveredGy !== 'number' ||
      !shift || ![shift.x, shift.y, shift.z].every(Number.isFinite)) {
    reply.code(400); return { error: 'invalid_fraction_payload' };
  }
  const list = deliveries.get(id) ?? [];
  if (list.some(x => x.fraction === fraction)) {
    reply.code(409); return { ok: false, error: 'duplicate_fraction' };
  }
  const record: FractionRecord = {
    fraction, deliveredGy,
    setupShift: { x: shift.x, y: shift.y, z: shift.z }, at: new Date().toISOString(),
  };
  list.push(record);
  deliveries.set(id, list);
  const magnitude = Math.hypot(shift.x, shift.y, shift.z);
  if (magnitude > 5) {
    deviations.unshift({
      id: `DEV-${deviations.length + 1}`, planId: id, severity: 'high', category: 'setup_shift',
      detail: `第 ${fraction} 次摆位偏移 ${magnitude.toFixed(1)} mm`, state: 'open',
      createdAt: new Date().toISOString(),
    });
  }
  audits.unshift({ at: record.at, action: 'fraction_delivered', planId: id, fraction });
  return releaseDossier(id);
});

app.post('/api/plans/:id/deviations', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!findPlan(id)) { reply.code(404); return { error: 'plan_not_found' }; }
  const body = req.body as { severity?: Deviation['severity']; category?: string; detail?: string };
  const severity = body?.severity;
  if (!body || !severity || !['low', 'medium', 'high'].includes(severity) || !body.category || !body.detail) {
    reply.code(400); return { error: 'invalid_deviation_payload' };
  }
  const event: Deviation = {
    id: `DEV-${deviations.length + 1}`, planId: id,
    severity, category: body.category, detail: body.detail,
    state: 'open', createdAt: new Date().toISOString(),
  };
  deviations.unshift(event);
  return event;
});

// 偏差关闭（档案页演示阻断解除流程）
app.post('/api/plans/:id/deviations/:devId/resolve', async (req, reply) => {
  const { id, devId } = req.params as { id: string; devId: string };
  if (!findPlan(id)) { reply.code(404); return { error: 'plan_not_found' }; }
  const dev = deviations.find(d => d.id === devId && d.planId === id);
  if (!dev) { reply.code(404); return { error: 'deviation_not_found' }; }
  if (dev.state === 'open') {
    dev.state = 'resolved';
    audits.unshift({ at: new Date().toISOString(), action: 'deviation_resolved', planId: id, deviationId: dev.id });
  }
  return releaseDossier(id);
});

// 计划放行：唯一正式放行入口。门禁完全由服务端 releaseDossier 决定；
// 重复点击/并发提交在服务端串行化，已放行计划幂等返回，不重复写审计。
app.post('/api/plans/:id/release', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const p = findPlan(id);
  if (!p) { reply.code(404); return { error: 'plan_not_found' }; }

  if (p.status === 'approved') {
    const audit = audits.filter(a => a.planId === id).slice(0, 50);
    return { released: true, alreadyReleased: true, ...releaseDossier(id), audit };
  }
  if (releasing.has(id)) {
    reply.code(409);
    return { released: false, error: 'release_in_progress', message: '放行正在处理中，请勿重复提交' };
  }

  releasing.add(id);
  try {
    // 服务端复核全部门禁：前端隐藏阻断项无法绕过
    const dossier = releaseDossier(id);
    if (dossier.gate === 'blocked') {
      reply.code(409);
      // 失败响应完整保留待处理原因，供前端原样展示
      return { released: false, ...dossier };
    }
    p.status = 'approved';
    audits.unshift({ at: new Date().toISOString(), action: 'plan_released', planId: id });
    const fresh = releaseDossier(id);
    const audit = audits.filter(a => a.planId === id).slice(0, 50);
    return { released: true, ...fresh, audit };
  } finally {
    releasing.delete(id);
  }
});

await app.listen({ host: '127.0.0.1', port: 6202 });

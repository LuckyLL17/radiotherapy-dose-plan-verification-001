import Fastify from 'fastify';
import cors from '@fastify/cors';

type Structure = {
  id: string;
  name: string;
  type: 'target' | 'organ';
  volume: number;
  priority: 'high' | 'medium' | 'low';
  constraint: { metric: 'D95' | 'Dmax' | 'V20'; limit: number; unit: string };
};

type PlanStatus = 'draft' | 'review' | 'approved';
type Plan = {
  id: string;
  label: string;
  beamCount: number;
  energy: string;
  algorithm: string;
  mu: number;
  createdAt: string;
  status: PlanStatus;
};

type QaMethod = 'independent_mu' | 'gamma' | 'image_guidance';
type QaRun = {
  id: string;
  planId: string;
  method: QaMethod;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  detail: string;
  createdAt: string;
};

type ChecklistItem = { item: string; checked: boolean; reviewer: string; at: string };
type Fraction = { fraction: number; deliveredGy: number; setupShift: { x: number; y: number; z: number }; at: string };
type Deviation = {
  id: string;
  planId: string;
  severity: 'low' | 'medium' | 'high';
  category: string;
  detail: string;
  state: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
};
type Audit = { at: string; action: string; planId?: string } & Record<string, unknown>;

type BlockerCode =
  | 'constraint_failed'
  | 'qa_failed'
  | 'checklist_incomplete'
  | 'open_high_deviation'
  | 'no_fractions';

type Blocker = { code: BlockerCode; message: string; detail?: string[] };

const patient = {
  id: 'PT-2026-0917',
  name: '示例患者',
  diagnosis: '肺部肿瘤（演示数据）',
  site: '右肺下叶',
  fractions: 30,
  rxDose: 60,
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

const audits: Audit[] = [];

const qaRuns: QaRun[] = [
  { id: 'QA-071', planId: 'PLAN-A', method: 'independent_mu', status: 'pass', score: 1.7, detail: '独立 MU 复算差异 1.7%，低于 3% 阈值', createdAt: '2026-09-30T09:16:00Z' },
  { id: 'QA-072', planId: 'PLAN-A', method: 'gamma', status: 'pass', score: 98.4, detail: '3%/3mm γ 通过率 98.4%，高于 95% 阈值', createdAt: '2026-09-30T09:23:00Z' },
];

const peerChecklist = new Map<string, ChecklistItem[]>();
const deliveries = new Map<string, Fraction[]>();

// 种子一条未关闭的高等级偏差，物理师必须在档案中处理后才能放行
const deviations: Deviation[] = [
  {
    id: 'DEV-1',
    planId: 'PLAN-A',
    severity: 'high',
    category: 'contour_change',
    detail: 'CBCT 影像复核提示右肺下叶靶区与近期勾画存在差异，需物理师确认关闭',
    state: 'open',
    createdAt: '2026-09-30T10:05:00Z',
  },
];

const REQUIRED_CHECKLIST = ['靶区轮廓与处方一致性', '危及器官约束复核', '束角与碰撞检查', '独立剂量验证'];

function logAudit(entry: Omit<Audit, 'at'>) {
  audits.unshift({ at: new Date().toISOString(), ...(entry as Record<string, unknown>) } as Audit);
}

function metrics(plan: Plan) {
  const bias = plan.id === 'PLAN-A' ? 0 : 3;
  return structures.map((s) => {
    let value =
      s.type === 'target'
        ? 96.4 - bias
        : s.id === 'LUNG'
          ? 21.3 + bias
          : s.id === 'HEART'
            ? 10.2 + bias * 0.7
            : s.id === 'CORD'
              ? 42.1 + bias * 1.1
              : 46.8 + bias;
    value = +value.toFixed(2);
    const pass = s.type === 'target' ? value >= s.constraint.limit : value <= s.constraint.limit;
    return {
      structureId: s.id,
      name: s.name,
      metric: s.constraint.metric,
      value,
      limit: s.constraint.limit,
      unit: s.constraint.unit,
      pass,
      delta: +(value - s.constraint.limit).toFixed(2),
      doseVolume: s.volume,
    };
  });
}

function dvh(plan: Plan) {
  return structures.map((s) => ({
    structureId: s.id,
    name: s.name,
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
      return Math.round(dose + Math.sin((x + index) * 0.7) * 3);
    }),
  );
}

/**
 * 计划放行档案：按计划汇总全部放行依据。
 * 门禁判断只在服务端计算，客户端无法通过隐藏阻断项改变 gate / blockers。
 */
function releaseDossier(planId: string) {
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return { error: 'plan_not_found' as const };

  const checks = metrics(plan);
  const planQa = qaRuns.filter((x) => x.planId === planId);

  // 同一方法只看最新一次结果：后续补做的通过 QA 可以覆盖早先的失败
  const latestByMethod = new Map<QaMethod, QaRun>();
  [...planQa].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((run) => latestByMethod.set(run.method, run));
  const activeQa = [...latestByMethod.values()];
  const failedQa = activeQa.filter((x) => x.status === 'fail');

  const checklist = peerChecklist.get(planId) ?? [];
  const missingItems = REQUIRED_CHECKLIST.filter(
    (item) => !checklist.some((x) => x.item === item && x.checked),
  );

  const fractions = deliveries.get(planId) ?? [];
  const openHigh = deviations.filter((d) => d.planId === planId && d.state === 'open' && d.severity === 'high');

  const blockers: Blocker[] = [];
  const failedChecks = checks.filter((x) => !x.pass);
  if (failedChecks.length) {
    blockers.push({
      code: 'constraint_failed',
      message: `${failedChecks.length} 项剂量约束未通过`,
      detail: failedChecks.map((x) => `${x.name} ${x.metric} = ${x.value}${x.unit}，限值 ${x.limit}${x.unit}`),
    });
  }
  if (failedQa.length) {
    blockers.push({
      code: 'qa_failed',
      message: `${failedQa.length} 项 QA 最新结果为失败，需补做合格验证`,
      detail: failedQa.map((x) => x.detail),
    });
  }
  if (missingItems.length) {
    blockers.push({
      code: 'checklist_incomplete',
      message: `同行复核清单尚有 ${missingItems.length} 项未完成`,
      detail: missingItems,
    });
  }
  if (openHigh.length) {
    blockers.push({
      code: 'open_high_deviation',
      message: `${openHigh.length} 条高等级偏差未关闭`,
      detail: openHigh.map((x) => `${x.category}：${x.detail}`),
    });
  }
  if (fractions.length === 0) {
    blockers.push({
      code: 'no_fractions',
      message: '尚无任何治疗分次记录，无法确认计划已进入可放行治疗状态',
    });
  }

  const cumulativeDose = +fractions.reduce((s, x) => s + x.deliveredGy, 0).toFixed(2);
  const lungV20 = checks.find((x) => x.structureId === 'LUNG')!.value;
  const heartV20 = checks.find((x) => x.structureId === 'HEART')!.value;
  const cordDmax = checks.find((x) => x.structureId === 'CORD')!.value;

  return {
    plan,
    gate: (plan.status === 'approved' ? 'released' : blockers.length ? 'blocked' : 'ready') as 'released' | 'blocked' | 'ready',
    blockers,
    checks,
    qa: {
      runs: planQa,
      latest: activeQa,
      summary: {
        pass: activeQa.filter((x) => x.status === 'pass').length,
        warn: activeQa.filter((x) => x.status === 'warn').length,
        fail: failedQa.length,
      },
    },
    checklist: {
      required: REQUIRED_CHECKLIST,
      items: checklist,
      checkedCount: REQUIRED_CHECKLIST.length - missingItems.length,
      requiredCount: REQUIRED_CHECKLIST.length,
      complete: missingItems.length === 0,
    },
    delivery: {
      fractions,
      count: fractions.length,
      plannedFractions: patient.fractions,
      cumulativeDose,
      prescriptionDose: patient.rxDose,
    },
    deviations: {
      openHigh,
      openCount: deviations.filter((d) => d.planId === planId && d.state === 'open').length,
    },
    risk: {
      lungPneumonitis: +Math.max(1, Math.min(35, lungV20 * 1.08)).toFixed(1),
      cardiacEvent: +Math.max(0.2, Math.min(20, heartV20 * 0.46)).toFixed(1),
      cordMargin: +(45 - cordDmax).toFixed(2),
    },
  };
}

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ status: 'ok', service: 'radiotherapy-dose-plan-verification' }));
app.get('/api/patient/current', async () => ({ patient, structures }));
app.get('/api/plans', async () => plans);

app.get('/api/plans/:id/dose-slice', async (req) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some((p) => p.id === id)) return { error: 'plan_not_found' };
  const q = req.query as { index?: string };
  const index = Number(q.index ?? 12);
  return { planId: id, index, size: 32, data: slice(index) };
});

app.get('/api/plans/:id/dvh', async (req) => {
  const p = plans.find((x) => x.id === (req.params as { id: string }).id);
  return p ? dvh(p) : { error: 'plan_not_found' };
});

app.get('/api/plans/:id/constraints', async (req) => {
  const p = plans.find((x) => x.id === (req.params as { id: string }).id);
  return p ? { plan: p, checks: metrics(p), gate: metrics(p).every((x) => x.pass) ? 'ready' : 'blocked' } : { error: 'plan_not_found' };
});

app.get('/api/compare', async () => ({
  plans: plans.map((p) => ({ id: p.id, label: p.label, checks: metrics(p), targetCoverage: metrics(p)[0].value, mu: p.mu })),
  recommendation: 'PLAN-A 在靶区覆盖和危及器官约束之间取得更优平衡',
}));

// ---- 计划放行档案 ----------------------------------------------------------

app.get('/api/plans/:id/verification-dossier', async (req, reply) => {
  const dossier = releaseDossier((req.params as { id: string }).id);
  if ('error' in dossier) return reply.status(404).send(dossier);
  return dossier;
});

app.get('/api/plans/:id/audit', async (req) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some((p) => p.id === id)) return { error: 'plan_not_found' };
  return { planId: id, records: audits.filter((a) => a.planId === id) };
});

app.post('/api/plans/:id/peer-checklist', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some((p) => p.id === id)) return reply.status(404).send({ error: 'plan_not_found' });

  const body = (req.body ?? {}) as Partial<ChecklistItem>;
  if (!body.item || !REQUIRED_CHECKLIST.includes(body.item)) {
    return reply.status(400).send({ error: 'unknown_checklist_item', required: REQUIRED_CHECKLIST });
  }
  const checked = body.checked !== false;
  const reviewer = (body.reviewer ?? '').trim();
  if (checked && !reviewer) {
    return reply.status(400).send({ error: 'reviewer_required' });
  }

  const list = peerChecklist.get(id) ?? [];
  const existing = list.find((x) => x.item === body.item);
  if (existing) {
    existing.checked = checked;
    existing.reviewer = reviewer;
    existing.at = new Date().toISOString();
  } else {
    list.push({ item: body.item, checked, reviewer, at: new Date().toISOString() });
  }
  peerChecklist.set(id, list);
  logAudit({ action: 'peer_checklist', planId: id, item: body.item, checked, reviewer });
  return { planId: id, items: list };
});

app.post('/api/plans/:id/independent-check', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some((p) => p.id === id)) return reply.status(404).send({ error: 'plan_not_found' });

  const body = (req.body ?? {}) as { method?: QaMethod; score?: number };
  const method = body.method ?? 'independent_mu';
  const score = body.score ?? (method === 'gamma' ? 97.1 : 2.2);
  const status = method === 'gamma' ? (score >= 95 ? 'pass' : score >= 90 ? 'warn' : 'fail') : score <= 3 ? 'pass' : score <= 5 ? 'warn' : 'fail';
  const run: QaRun = {
    id: `QA-${String(qaRuns.length + 71).padStart(3, '0')}`,
    planId: id,
    method,
    status,
    score,
    detail: method === 'gamma' ? `3%/3mm γ 通过率 ${score}%（阈值 95%）` : `独立 MU 差异 ${score}%（阈值 3%）`,
    createdAt: new Date().toISOString(),
  };
  qaRuns.unshift(run);
  logAudit({ action: 'independent_check', ...run });
  return run;
});

app.post('/api/plans/:id/delivery/fractions', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some((p) => p.id === id)) return reply.status(404).send({ error: 'plan_not_found' });

  const body = (req.body ?? {}) as Partial<Fraction>;
  const fraction = Number(body.fraction);
  const deliveredGy = Number(body.deliveredGy);
  const shift = body.setupShift ?? { x: 0, y: 0, z: 0 };
  if (!Number.isInteger(fraction) || fraction < 1) {
    return reply.status(400).send({ error: 'invalid_fraction' });
  }
  if (!Number.isFinite(deliveredGy) || deliveredGy <= 0) {
    return reply.status(400).send({ error: 'invalid_dose' });
  }

  const list = deliveries.get(id) ?? [];
  if (list.some((x) => x.fraction === fraction)) {
    return reply.status(409).send({ error: 'duplicate_fraction' });
  }
  list.push({ fraction, deliveredGy, setupShift: shift, at: new Date().toISOString() });
  deliveries.set(id, list);

  const magnitude = Math.hypot(shift.x, shift.y, shift.z);
  if (magnitude > 5) {
    deviations.unshift({
      id: `DEV-${deviations.length + 1}`,
      planId: id,
      severity: 'high',
      category: 'setup_shift',
      detail: `第 ${fraction} 次治疗摆位偏移 ${magnitude.toFixed(1)} mm，超过 5 mm 阈值`,
      state: 'open',
      createdAt: new Date().toISOString(),
    });
  }
  logAudit({ action: 'fraction_delivered', planId: id, fraction, deliveredGy });
  return releaseDossier(id);
});

app.post('/api/plans/:id/deviations', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!plans.some((p) => p.id === id)) return reply.status(404).send({ error: 'plan_not_found' });

  const body = (req.body ?? {}) as { severity?: Deviation['severity']; category?: string; detail?: string };
  if (!body.severity || !body.category || !body.detail) {
    return reply.status(400).send({ error: 'invalid_deviation' });
  }
  const event: Deviation = {
    id: `DEV-${deviations.length + 1}`,
    planId: id,
    severity: body.severity,
    category: body.category,
    detail: body.detail,
    state: 'open',
    createdAt: new Date().toISOString(),
  };
  deviations.unshift(event);
  logAudit({ action: 'deviation_opened', ...event });
  return event;
});

app.delete('/api/plans/:id/deviations/:devId', async (req, reply) => {
  const { id, devId } = req.params as { id: string; devId: string };
  if (!plans.some((p) => p.id === id)) return reply.status(404).send({ error: 'plan_not_found' });

  const deviation = deviations.find((d) => d.id === devId && d.planId === id);
  if (!deviation) return reply.status(404).send({ error: 'deviation_not_found' });
  if (deviation.state === 'resolved') return { ok: true, deviation };

  deviation.state = 'resolved';
  deviation.resolvedAt = new Date().toISOString();
  logAudit({ action: 'deviation_resolved', planId: id, deviationId: deviation.id, category: deviation.category });
  return { ok: true, deviation };
});

/**
 * 放行：唯一的计划批准入口。
 * 每次请求都在服务端重新计算全部门禁，前端隐藏/篡改任何数据都无法绕过；
 * Node 单线程内状态翻转是原子的，重复点击第二次起得到 already_released。
 */
app.post('/api/plans/:id/release', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const plan = plans.find((p) => p.id === id);
  if (!plan) return reply.status(404).send({ error: 'plan_not_found' });

  if (plan.status === 'approved') {
    return reply.status(409).send({ released: false, reason: 'already_released', ...releaseDossier(id) });
  }

  const dossier = releaseDossier(id);
  if ('error' in dossier) return reply.status(404).send(dossier);
  if (dossier.gate === 'blocked') {
    return reply.status(409).send({ released: false, reason: 'gate_blocked', ...dossier });
  }

  plan.status = 'approved';
  logAudit({ action: 'plan_released', planId: id });
  return reply.send({ released: true, ...releaseDossier(id) });
});

app.post('/api/plans/:id/adaptive-evaluation', async (req) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { weightChange?: number; tumorShift?: number; lungDensityChange?: number };
  const shift = Math.abs(body.tumorShift ?? 0);
  const weight = Math.abs(body.weightChange ?? 0);
  const density = Math.abs(body.lungDensityChange ?? 0);
  const coverage = +(96.4 - shift * 0.7 - weight * 0.18).toFixed(2);
  const lungV20 = +(21.3 + density * 0.8 + shift * 0.12).toFixed(2);
  const recommendation = coverage < 95 || lungV20 > 25 ? '需要自适应重计划评估' : '可按原计划继续治疗';
  const event = {
    id: `ADP-${Date.now()}`,
    planId: id,
    coverage,
    lungV20,
    anatomyChange: { weight, shift, density },
    recommendation,
    createdAt: new Date().toISOString(),
  };
  logAudit({ action: 'adaptive_evaluation', ...event });
  return event;
});

app.get('/api/audit', async () => audits);

await app.listen({ host: '127.0.0.1', port: 6202 });

import {useEffect,useState,useCallback} from 'react';
import './styles.css';
import ReleaseDossier from './ReleaseDossier';

const api=(u:string)=>fetch(u).then(r=>r.json());

export default function App(){
  const [tab,setTab]=useState('dose');
  const [patient,setPatient]=useState<any>();
  const [plans,setPlans]=useState<any[]>([]);
  const [active,setActive]=useState('PLAN-A');
  const [constraints,setConstraints]=useState<any>();
  const [compare,setCompare]=useState<any>();
  const [slice,setSlice]=useState<any>();
  const [reviewer,setReviewer]=useState('');

  useEffect(()=>{
    api('/api/patient/current').then(setPatient);
    api('/api/compare').then(setCompare);
  },[]);

  const loadPlans=useCallback(()=>{api('/api/plans').then(setPlans)},[]);
  useEffect(()=>{loadPlans()},[loadPlans]);

  useEffect(()=>{
    if(active){
      api(`/api/plans/${active}/constraints`).then(setConstraints);
      api(`/api/plans/${active}/dose-slice?index=12`).then(setSlice);
    }
  },[active]);

  const recordPeerReview=()=>{
    fetch(`/api/plans/${active}/peer-review`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({reviewer,note:'已完成剂量约束复核'}),
    });
  };

  return <main>
    <header>
      <div>
        <span className="eyebrow">RADIATION ONCOLOGY / PLAN QA</span>
        <h1>放射治疗剂量计划验证与器官风险评估系统</h1>
        <p>{patient?.patient?.id} · {patient?.patient?.diagnosis} · 处方 {patient?.patient?.rxDose} Gy / {patient?.patient?.fractions} 次</p>
      </div>
      <div className="badge">物理师复核模式</div>
    </header>
    <nav>{[
      ['dose','剂量阅片'],
      ['constraints','约束校验'],
      ['compare','计划对比'],
      ['release','计划放行档案'],
    ].map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    <section className="toolbar">
      <label>当前计划<select value={active} onChange={e=>setActive(e.target.value)}>{plans.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <span className={`planStatus ${constraints?.gate}`}>{constraints?.gate==='ready'?'约束校验通过':'存在约束风险'}</span>
    </section>

    {tab==='dose'&&<section className="grid">
      <div className="panel imagePanel">
        <div className="panelHead"><h2>断层切片剂量叠加</h2><span>切片 12 / 32 · 等剂量线：20 / 50 / 95%</span></div>
        <div className="slice">{slice?.data.map((row:number[],y:number)=>row.map((v:number,x:number)=><span key={`${x}-${y}`} style={{background:`hsl(${Math.max(0,240-v*2.2)},${v>80?88:55}%,${25+v*.45}%)`}}/>))}</div>
        <div className="doseLegend"><span style={{background:'#244bd5'}}/>低剂量 <span style={{background:'#f3bb35'}}/>中剂量 <span style={{background:'#ef555b'}}/>高剂量</div>
      </div>
      <div className="panel">
        <div className="panelHead"><h2>计划参数</h2><span>{active}</span></div>
        {plans.find(p=>p.id===active)&&Object.entries(plans.find(p=>p.id===active)).filter(([k])=>!['id','status'].includes(k)).map(([k,v])=><div className="kv" key={k}><span>{k}</span><b>{String(v)}</b></div>)}
        <div className="callout">剂量验证不是单一通过/失败判断，需要同时审查靶区覆盖、危及器官受量、机器跳数和算法版本。</div>
      </div>
    </section>}

    {tab==='constraints'&&<section className="grid">
      <div className="panel">
        <div className="panelHead"><h2>结构约束校验</h2><span>DVH 指标自动计算</span></div>
        {constraints?.checks.map((x:any)=><div className="constraint" key={x.structureId}><div><b>{x.name}</b><small>{x.metric} · 限值 {x.limit}{x.unit}</small></div><strong className={x.pass?'pass':'fail'}>{x.value}{x.unit}</strong><span className={x.pass?'chipPass':'chipFail'}>{x.pass?'PASS':'FAIL'}</span></div>)}
      </div>
      <div className="panel">
        <div className="panelHead"><h2>DVH 曲线摘要</h2><span>体积-剂量关系</span></div>
        {patient?.structures.map((s:any)=><div className="bar" key={s.id}><span>{s.name}</span><div><i style={{width:`${Math.min(100,(constraints?.checks.find((x:any)=>x.structureId===s.id)?.value??0))}%`}}/></div><b>{constraints?.checks.find((x:any)=>x.structureId===s.id)?.value}</b></div>)}
        <div className="review"><input placeholder="复核人姓名" value={reviewer} onChange={e=>setReviewer(e.target.value)}/><button onClick={recordPeerReview}>记录同行复核</button></div>
        <div className="releaseHint">本页仅展示剂量约束校验结果，不能在此直接放行。<b>请前往「计划放行档案」</b>看齐约束、QA、同行复核、分次与偏差等全部依据后签发。
          <button onClick={()=>setTab('release')}>前往计划放行档案 →</button>
        </div>
      </div>
    </section>}

    {tab==='compare'&&<section className="panel">
      <div className="panelHead"><h2>计划对比与选择</h2><span>同一患者、不同照射技术</span></div>
      <div className="compareGrid">{compare?.plans.map((p:any)=><div className={`compareCard ${p.id===active?'selected':''}`} key={p.id} onClick={()=>setActive(p.id)}><h3>{p.label}</h3><strong>{p.targetCoverage}%</strong><small>PTV D95 覆盖</small><p>MU {p.mu} · 约束失败 {p.checks.filter((x:any)=>!x.pass).length} 项</p>{p.checks.map((x:any)=><div className={x.pass?'tinyPass':'tinyFail'} key={x.structureId}>{x.name}: {x.value}{x.unit}</div>)}</div>)}</div>
      <div className="recommend">系统建议：{compare?.recommendation}</div>
    </section>}

    {tab==='release'&&<ReleaseDossier planId={active} onPlanChanged={()=>{loadPlans();api(`/api/plans/${active}/constraints`).then(setConstraints)}}/>}
  </main>;
}

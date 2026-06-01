import { useState, useEffect, useCallback } from "react";



// ── API ───────────────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const res = await fetch(`/api/tradier?endpoint=markets/quotes&symbols=${symbol}&greeks=true`);
  const data = await res.json();
  return data?.quotes?.quote;
}
async function fetchOptionChain(symbol, expiration) {
  const res = await fetch(`/api/tradier?endpoint=markets/options/chains&symbol=${symbol}&expiration=${expiration}&greeks=true`);
  const data = await res.json();
  return data?.options?.option || [];
}
async function fetchExpirations(symbol) {
  const res = await fetch(`/api/tradier?endpoint=markets/options/expirations&symbol=${symbol}`);
  const data = await res.json();
  return data?.expirations?.date || [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n, d=2) => Number(n||0).toFixed(d);
const pct = n => (n*100).toFixed(2)+"%";
const COLORS = ["#00d4aa","#f5c842","#3a8fff","#ff6b9d","#a78bfa","#fb923c"];

const exportCSV = (trades, ticker) => {
  const header = "Data,Ação,Strike,Vencimento,Prêmio,Contratos,Valor $,Status\n";
  const rows = trades.map(t =>
    `${t.date},${t.action},${t.strike},${t.expiration},${t.premium},${t.contracts||1},${(t.premium*(t.contracts||1)*100).toFixed(2)},${t.status}`
  ).join("\n");
  const blob = new Blob([header+rows], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${ticker}_trades.csv`;
  a.click();
};

// ── Initial Data ──────────────────────────────────────────────────────────────
const INITIAL_ASSETS = [
  { id:"IBIT", ticker:"IBIT", color:"#00d4aa", leapStrike:37, leapExpiration:"Jan 2027", leapCost:10.12, leapDelta:0.71, initialPrice:41.55, active:true,
    trades:[
      {id:1,date:"2026-05-26",action:"SELL",strike:43.5,expiration:"2026-05-29",premium:0.32,contracts:1,status:"closed"},
      {id:2,date:"2026-05-28",action:"BUY", strike:43.5,expiration:"2026-05-29",premium:0.02,contracts:1,status:"closed"},
      {id:3,date:"2026-05-28",action:"SELL",strike:41.5,expiration:"2026-05-29",premium:0.23,contracts:1,status:"closed"},
      {id:4,date:"2026-05-28",action:"BUY", strike:42.0,expiration:"2026-05-29",premium:0.13,contracts:1,status:"closed"},
      {id:5,date:"2026-05-29",action:"SELL",strike:42.0,expiration:"2026-05-29",premium:0.15,contracts:1,status:"closed"},
      {id:6,date:"2026-05-29",action:"BUY", strike:41.5,expiration:"2026-05-29",premium:0.44,contracts:1,status:"closed"},
      {id:7,date:"2026-05-29",action:"SELL",strike:41.5,expiration:"2026-06-01",premium:0.66,contracts:1,status:"open"},
    ]
  },
  { id:"EWZ", ticker:"EWZ", color:"#f5c842", leapStrike:29, leapExpiration:"Nov 2026", leapCost:9.34, leapDelta:0.65, initialPrice:33.5, active:true,
    trades:[
      {id:1,date:"2026-05-14",action:"SELL",strike:38.0,expiration:"2026-05-22",premium:0.34,contracts:1,status:"closed"},
      {id:2,date:"2026-05-19",action:"BUY", strike:38.0,expiration:"2026-05-22",premium:0.03,contracts:1,status:"closed"},
      {id:3,date:"2026-05-19",action:"SELL",strike:37.0,expiration:"2026-05-22",premium:0.13,contracts:1,status:"closed"},
      {id:4,date:"2026-05-21",action:"BUY", strike:37.0,expiration:"2026-05-22",premium:0.24,contracts:1,status:"closed"},
      {id:5,date:"2026-05-21",action:"SELL",strike:37.5,expiration:"2026-05-29",premium:0.37,contracts:1,status:"closed"},
      {id:6,date:"2026-05-27",action:"BUY", strike:37.5,expiration:"2026-05-29",premium:0.07,contracts:1,status:"closed"},
      {id:7,date:"2026-05-27",action:"SELL",strike:37.0,expiration:"2026-06-05",premium:0.42,contracts:1,status:"open"},
    ]
  },
];

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#080c10}::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px}
.hdr{border-bottom:1px solid #1a2a3a;padding:13px 24px;display:flex;align-items:center;justify-content:space-between;background:rgba(10,20,35,0.97);position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
.logo{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:#fff;cursor:pointer;user-select:none}
.logo span{color:#00d4aa}
.badge{font-size:10px;background:#0a2a1a;color:#00d4aa;border:1px solid #00d4aa33;padding:3px 8px;border-radius:3px;letter-spacing:1px;text-transform:uppercase}
.home-btn{background:#1a2a3a;border:1px solid #2a3a4a;color:#8aaac8;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:11px;transition:all 0.2s}
.home-btn:hover{background:#2a3a4a;color:#c8d8e8}
.tabs{display:flex;border-bottom:1px solid #1a2a3a;padding:0 24px;background:#0a1520;overflow-x:auto}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:#5a7a9a;padding:10px 16px;cursor:pointer;font-family:'DM Mono',monospace;font-size:12px;font-weight:500;transition:all 0.2s;margin-bottom:-1px;white-space:nowrap}
.tab:hover{color:#c8d8e8}
.tab.active{color:var(--tc);border-bottom-color:var(--tc)}
.add-tab{background:none;border:none;color:#3a5a7a;padding:10px 12px;cursor:pointer;font-size:18px;transition:color 0.2s;margin-bottom:-1px}
.add-tab:hover{color:#00d4aa}
.subnav{display:flex;gap:4px;padding:12px 24px 0}
.snbtn{background:none;border:none;color:#5a7a9a;padding:7px 12px;cursor:pointer;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.5px;border-radius:4px;transition:all 0.2s;text-transform:uppercase}
.snbtn:hover{color:#c8d8e8;background:#1a2a3a}
.snbtn.active{color:var(--ac,#00d4aa);background:#0a2a1a;border:1px solid #00d4aa33}
.main{padding:18px 24px;max-width:1300px;margin:0 auto}
.pbar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#0d1821;border:1px solid #1a2a3a;border-radius:8px;margin:14px 24px 0;flex-wrap:wrap}
.tlbl{font-family:'Syne',sans-serif;font-size:15px;font-weight:700}
.pinput{background:#080c10;border:1px solid #1a2a3a;font-family:'DM Mono',monospace;font-size:18px;font-weight:500;padding:4px 10px;border-radius:4px;width:100px;text-align:right}
.pinput:focus{outline:none;border-color:#00d4aa66}
.dvdr{width:1px;height:18px;background:#1a2a3a;flex-shrink:0}
.sml{font-size:11px;color:#5a7a9a;white-space:nowrap}
.sml span{color:#c8d8e8;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.card{background:#0d1821;border:1px solid #1a2a3a;border-radius:8px;padding:16px;position:relative;overflow:hidden;transition:border-color 0.2s}
.card:hover{border-color:#2a4a6a}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--top,#1a3a5a)}
.clbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#5a7a9a;margin-bottom:7px}
.cval{font-family:'Syne',sans-serif;font-size:22px;font-weight:700;color:#fff;line-height:1;margin-bottom:5px}
.csub{font-size:11px;color:#5a7a9a}
.sec{background:#0d1821;border:1px solid #1a2a3a;border-radius:8px;margin-bottom:16px}
.sechdr{padding:12px 16px;border-bottom:1px solid #1a2a3a;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sectitle{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a7a9a}
.btn{background:#00d4aa15;border:1px solid #00d4aa44;color:#00d4aa;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.5px;transition:all 0.2s}
.btn:hover{opacity:0.8}
.btn:disabled{opacity:0.4;cursor:not-allowed}
.bsm{padding:3px 9px;font-size:10px}
.bdanger{background:#ff4d6a10;border-color:#ff4d6a44;color:#ff4d6a}
.bneutral{background:#1a2a3a;border-color:#2a3a4a;color:#8aaac8}
.bwarn{background:#f5c84215;border-color:#f5c84244;color:#f5c842}
.ptrack{height:6px;background:#1a2a3a;border-radius:3px;overflow:hidden}
.pfill{height:100%;border-radius:3px;transition:width 0.5s ease}
table{width:100%;border-collapse:collapse}
th{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#3a5a7a;padding:9px 16px;text-align:left;border-bottom:1px solid #1a2a3a}
td{padding:10px 16px;font-size:12px;border-bottom:1px solid #0f1e2e;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#101e2c}
.stopen{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.stclosed{display:inline-block;padding:2px 8px;background:#1a2a3a;border:1px solid #2a3a4a;color:#5a7a9a;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:200}
.fbox{background:#0d1821;border:1px solid #1a2a3a;border-radius:12px;padding:24px;width:420px;max-width:95vw;box-shadow:0 40px 80px rgba(0,0,0,0.6);max-height:90vh;overflow-y:auto}
.ftitle{font-family:'Syne',sans-serif;font-size:16px;font-weight:700;color:#fff;margin-bottom:16px}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.fgrp{display:flex;flex-direction:column;gap:4px}
.flbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#5a7a9a}
.finput,.fsel{background:#080c10;border:1px solid #1a2a3a;color:#c8d8e8;font-family:'DM Mono',monospace;font-size:13px;padding:7px 11px;border-radius:4px;width:100%;transition:border-color 0.2s}
.finput:focus,.fsel:focus{outline:none;border-color:#00d4aa66}
.fsel option{background:#0d1821}
.factions{display:flex;gap:10px;margin-top:16px}
.bfull{flex:1;padding:9px;font-size:12px}
.lgrid{display:grid;grid-template-columns:repeat(3,1fr)}
.litem{padding:12px 16px;border-right:1px solid #1a2a3a;border-bottom:1px solid #1a2a3a}
.litem:nth-child(3n){border-right:none}
.litem:nth-last-child(-n+3){border-bottom:none}
.llbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#3a5a7a;margin-bottom:3px}
.lval{font-size:14px;color:#c8d8e8;font-weight:500}
.empty{padding:32px;text-align:center;color:#3a5a7a;font-size:12px}
.toggle-group{display:flex;background:#0d1821;border:1px solid #1a2a3a;border-radius:10px;padding:3px;gap:2px}
.tgl{background:none;border:none;padding:7px 18px;border-radius:7px;cursor:pointer;font-family:'DM Mono',monospace;font-size:11px;font-weight:600;transition:all 0.2s;color:#5a7a9a}
.green{color:#00d4aa!important}
.red{color:#ff4d6a!important}
.yellow{color:#f5c842!important}
`;

// ── Market Tab ────────────────────────────────────────────────────────────────
function MarketTab({ defaultSymbol, color }) {
  const [searchInput, setSearchInput] = useState("");
  const [sym, setSym] = useState(defaultSymbol);
  const [optType, setOptType] = useState("call");
  const [exps, setExps] = useState([]);
  const [selExp, setSelExp] = useState("");
  const [chain, setChain] = useState([]);
  const [price, setPrice] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadSym = useCallback(async (s) => {
    setLoading(true); setError(null); setChain([]);
    try {
      const e = await fetchExpirations(s);
      if (!e||!e.length) { setError(`Sem opções para "${s}"`); setLoading(false); return; }
      setExps(e); setSelExp(e[0]);
      const [q, ch] = await Promise.all([fetchQuote(s), fetchOptionChain(s, e[0])]);
      if (q?.last) setPrice(q.last);
      setChain(ch);
    } catch { setError("Erro ao buscar."); }
    setLoading(false);
  }, []);

  useEffect(() => { loadSym(defaultSymbol); }, [defaultSymbol]);

  const loadChain = async (exp) => {
    setSelExp(exp); setLoading(true);
    try { const ch = await fetchOptionChain(sym, exp); setChain(ch); } catch {}
    setLoading(false);
  };

  const search = () => { const s = searchInput.trim().toUpperCase(); if (!s) return; setSym(s); loadSym(s); };
  const filtered = chain.filter(o => o.option_type===optType).filter(o => price>0?(o.strike>=price*0.85&&o.strike<=price*1.25):true).sort((a,b)=>a.strike-b.strike);

  return (
    <div className="main">
      <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
        <input className="finput" style={{maxWidth:160,fontSize:14,letterSpacing:1,textTransform:"uppercase"}} placeholder="AAPL, TSLA..."
          value={searchInput} onChange={e=>setSearchInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&search()}/>
        <button className="btn" onClick={search} disabled={loading} style={{color,borderColor:color+"44",background:color+"15"}}>{loading?"...":"Buscar"}</button>
        {error&&<span style={{fontSize:11,color:"#ff4d6a"}}>{error}</span>}
      </div>
      <div className="sec">
        <div className="sechdr">
          <div className="sectitle">Cadeia {optType==="call"?"Calls":"Puts"} — {sym}</div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            <div className="toggle-group">
              {["call","put"].map(t=>(
                <button key={t} className="tgl" onClick={()=>setOptType(t)} style={{background:optType===t?color:"transparent",color:optType===t?"#080c10":"#5a7a9a"}}>{t==="call"?"Call":"Put"}</button>
              ))}
            </div>
            <select className="fsel" style={{width:"auto",padding:"4px 8px",fontSize:11}} value={selExp} onChange={e=>loadChain(e.target.value)}>
              {exps.map(e=><option key={e} value={e}>{e}</option>)}
            </select>
            <button className="btn bsm" onClick={()=>loadSym(sym)} disabled={loading} style={{color,borderColor:color+"44",background:color+"15"}}>↻</button>
          </div>
        </div>
        {loading?<div className="empty">Carregando...</div>:filtered.length===0?<div className="empty">Nenhum dado</div>:(
          <table>
            <thead><tr><th>Strike</th><th>Último</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th><th>Delta</th><th>Theta</th><th>Gamma</th></tr></thead>
            <tbody>
              {filtered.map(o=>{
                const isATM=price>0&&Math.abs(o.strike-price)<0.5;
                return (<tr key={o.symbol} style={{background:isATM?color+"10":undefined}}>
                  <td><span style={{color:isATM?color:"#f5c842",fontWeight:isATM?700:400}}>${o.strike}{isATM&&" ◀"}</span></td>
                  <td>${fmt(o.last||0)}</td><td style={{color:"#00d4aa"}}>${fmt(o.bid||0)}</td><td style={{color:"#ff4d6a"}}>${fmt(o.ask||0)}</td>
                  <td style={{color:"#5a7a9a"}}>{(o.volume||0).toLocaleString()}</td><td style={{color:"#5a7a9a"}}>{(o.open_interest||0).toLocaleString()}</td>
                  <td style={{color:"#f5c842"}}>{o.greeks?.smv_vol?pct(o.greeks.smv_vol):"—"}</td>
                  <td style={{color:"#3a8fff"}}>{o.greeks?.delta?fmt(o.greeks.delta,3):"—"}</td>
                  <td style={{color:"#ff4d6a"}}>{o.greeks?.theta?fmt(o.greeks.theta,3):"—"}</td>
                  <td style={{color:"#8aaac8"}}>{o.greeks?.gamma?fmt(o.greeks.gamma,4):"—"}</td>
                </tr>);
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Calculator ────────────────────────────────────────────────────────────────
function Calculator({ asset, totalCollected, etfPrice }) {
  const [sellStrike, setSellStrike] = useState(asset.leapStrike+5);
  const [sellPrem, setSellPrem] = useState(0.50);
  const [buyPrem, setBuyPrem] = useState(0);
  const [weeks, setWeeks] = useState(16);
  const color = asset.color;
  const net = sellPrem-buyPrem;
  const basis = asset.leapCost-totalCollected;
  const spread = sellStrike-asset.leapStrike;
  const projW = basis/Math.max(net,0.01);
  const wpct = net/basis;
  const proj = totalCollected+net*weeks;
  return (
    <div>
      <div className="sec" style={{marginBottom:16}}>
        <div className="sechdr"><div className="sectitle">Calculadora de Roll</div></div>
        <div style={{padding:"16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[["Strike vendida ($)",sellStrike,setSellStrike,0.5],["Prêmio recebido ($)",sellPrem,setSellPrem,0.01],["Prêmio pago p/ fechar ($)",buyPrem,setBuyPrem,0.01],["Semanas projetadas",weeks,setWeeks,1]].map(([l,v,s,st])=>(
            <div className="fgrp" key={l}><label className="flbl">{l}</label><input className="finput" type="number" step={st} value={v} onChange={e=>s(parseFloat(e.target.value)||0)}/></div>
          ))}
        </div>
        <div style={{padding:"0 16px 16px",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[["Crédito líquido",`$${fmt(net)}`,net>=0?color:"#ff4d6a"],["Valor/contrato",`$${fmt(net*100)}`,net>=0?color:"#ff4d6a"],["Retorno s/ LEAP",`${(wpct*100).toFixed(2)}%`,"#3a8fff"],["Spread",`$${fmt(spread)}`,"#f5c842"],["Semanas p/ gratuita",`~${Math.ceil(projW)}`,"#c8d8e8"],["Projeção acumulada",`$${fmt(proj*100)}`,color]].map(([l,v,c])=>(
            <div key={l} style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"12px 14px"}}>
              <div style={{fontSize:10,letterSpacing:"1.5px",textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>{l}</div>
              <div style={{fontSize:17,fontFamily:"Syne",fontWeight:700,color:c}}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="sec">
        <div className="sechdr"><div className="sectitle">Cenários</div></div>
        <table>
          <thead><tr><th>Cenário</th><th>Preço {asset.ticker}</th><th>Resultado</th><th>P&L est.</th></tr></thead>
          <tbody>
            {[["Queda forte",etfPrice*0.7,"Expira sem valor ✓",(asset.leapCost-totalCollected)*-100],["Queda moderada",etfPrice*0.85,"Expira sem valor ✓",(basis-sellPrem)*-50],["Lateral",etfPrice,"Perto do ATM",net*100],["Alta moderada",etfPrice*1.1,"ITM — rolar",(spread+net)*100],["Alta forte",etfPrice*1.25,"Deep ITM",(spread+net)*100]].map(([l,p,o,pnl])=>(
              <tr key={l}><td style={{color:"#c8d8e8"}}>{l}</td><td style={{color:"#f5c842"}}>${fmt(p)}</td><td style={{color:"#8aaac8",fontSize:11}}>{o}</td><td style={{color:pnl>=0?color:"#ff4d6a"}}>{pnl>=0?"+":""}${fmt(pnl)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Asset Dashboard ───────────────────────────────────────────────────────────
function AssetDashboard({ asset, onUpdate, onClose }) {
  const [trades, setTrades] = useState(asset.trades);
  const [etfPrice, setEtfPrice] = useState(asset.initialPrice||0);
  const [liveData, setLiveData] = useState(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const [liveErr, setLiveErr] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [showCR, setShowCR] = useState(null);
  const [showClose, setShowClose] = useState(false);
  const [crForm, setCrForm] = useState({mode:"close",closePrem:"",newStrike:"",newExp:"",newPrem:"",contracts:1});
  const [closeForm, setCloseForm] = useState({mode:"close",closePrem:"",newStrike:"",newExp:"",newPrem:""});
  const ef = {date:new Date().toISOString().slice(0,10),action:"SELL",strike:"",expiration:"",premium:"",contracts:"1",status:"open"};
  const [form, setForm] = useState(ef);
  const color = asset.color;

  const fetchLive = useCallback(async()=>{
    setLoadingLive(true);setLiveErr(null);
    try{const q=await fetchQuote(asset.ticker);if(q?.last)setEtfPrice(q.last);setLiveData(q);}catch{setLiveErr("Erro ao buscar.");}
    setLoadingLive(false);
  },[asset.ticker]);
  useEffect(()=>{fetchLive();},[fetchLive]);

  const totalCollected = trades.reduce((a,t)=>t.action==="SELL"?a+parseFloat(t.premium||0)*parseInt(t.contracts||1):a-parseFloat(t.premium||0)*parseInt(t.contracts||1),0);
  const totalDollar = totalCollected*100;
  const costBasis = asset.leapCost-totalCollected;
  const recovPct = Math.min(totalCollected/asset.leapCost,1);
  const openTrades = trades.filter(t=>t.status==="open").sort((a,b)=>new Date(a.expiration)-new Date(b.expiration));
  const closedTrades = trades.filter(t=>t.status==="closed").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const filteredTrades = (statusFilter==="open"?openTrades:statusFilter==="closed"?closedTrades:trades).sort((a,b)=>new Date(b.date)-new Date(a.date));

  function openAdd(){setEditId(null);setForm(ef);setShowForm(true);}
  function openEdit(t){setEditId(t.id);setForm({...t,contracts:t.contracts||1});setShowForm(true);}
  function saveTrade(){
    if(!form.strike||!form.expiration||!form.premium)return;
    const upd=editId?trades.map(t=>t.id===editId?{...t,...form,strike:parseFloat(form.strike),premium:parseFloat(form.premium),contracts:parseInt(form.contracts||1)}:t):[...trades,{id:Date.now(),...form,strike:parseFloat(form.strike),premium:parseFloat(form.premium),contracts:parseInt(form.contracts||1)}];
    setTrades(upd);setShowForm(false);
  }
  function openCR(t){setShowCR(t);setCrForm({mode:"close",closePrem:"",newStrike:t.strike,newExp:"",newPrem:"",contracts:t.contracts||1});}
  function confirmCR(){
    if(!crForm.closePrem)return;
    const today=new Date().toISOString().slice(0,10);
    const c=parseInt(showCR.contracts||1);
    let upd=trades.map(t=>t.id===showCR.id?{...t,status:"closed"}:t);
    upd=[...upd,{id:Date.now(),date:today,action:"BUY",strike:showCR.strike,expiration:showCR.expiration,premium:parseFloat(crForm.closePrem),contracts:c,status:"closed"}];
    if(crForm.mode==="roll"&&crForm.newExp&&crForm.newPrem){
      upd=[...upd,{id:Date.now()+1,date:today,action:"SELL",strike:parseFloat(crForm.newStrike||showCR.strike),expiration:crForm.newExp,premium:parseFloat(crForm.newPrem),contracts:c,status:"open"}];
    }
    setTrades(upd);setShowCR(null);
  }
  function confirmClose(){
    if(!closeForm.closePrem)return;
    const today=new Date().toISOString().slice(0,10);
    let upd=[...trades];
    // close all open trades
    upd=upd.map(t=>t.status==="open"?{...t,status:"closed"}:t);
    // add buy record for closing cost
    upd=[...upd,{id:Date.now(),date:today,action:"BUY",strike:0,expiration:today,premium:parseFloat(closeForm.closePrem),contracts:1,status:"closed",note:"Encerramento LEAP"}];
    if(closeForm.mode==="roll"&&closeForm.newExp&&closeForm.newPrem){
      // This would be handled as a new asset
    }
    setTrades(upd);
    onClose(asset.id,upd,parseFloat(closeForm.closePrem));
    setShowClose(false);
  }
  function removeTrade(id){setTrades(trades.filter(t=>t.id!==id));}

  return (
    <div>
      {/* Price Bar */}
      <div className="pbar">
        <div className="tlbl" style={{color}}>{asset.ticker}</div>
        <div className="dvdr"/>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:"#5a7a9a"}}>ETF $</span>
          <input className="pinput" type="number" step="0.01" value={etfPrice} onChange={e=>setEtfPrice(parseFloat(e.target.value)||0)} style={{color}}/>
        </div>
        {liveData&&<><div className="dvdr"/><div className="sml">abertura <span>${liveData.open||"—"}</span></div><div className="dvdr"/><div className="sml">máx <span style={{color:"#00d4aa"}}>${liveData.high||"—"}</span></div><div className="dvdr"/><div className="sml">mín <span style={{color:"#ff4d6a"}}>${liveData.low||"—"}</span></div><div className="dvdr"/><div className="sml">vol <span>{liveData.volume?.toLocaleString()||"—"}</span></div></>}
        <div className="dvdr"/><div className="sml">LEAP <span>${asset.leapStrike}</span></div>
        <div className="dvdr"/><div className="sml">distância <span className={etfPrice>=asset.leapStrike?"green":"red"}>{etfPrice>=asset.leapStrike?"+":""}{fmt(etfPrice-asset.leapStrike)}</span></div>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button className="btn bsm" onClick={fetchLive} disabled={loadingLive} style={{color,borderColor:color+"44",background:color+"15"}}>{loadingLive?"...":"↻"}</button>
          <button className="btn bsm bdanger" onClick={()=>setShowClose(true)}>Encerrar estratégia</button>
        </div>
        {liveErr&&<div style={{fontSize:11,color:"#ff4d6a"}}>{liveErr}</div>}
      </div>

      {/* Sub Nav */}
      <div className="subnav">
        {["dashboard","trades","calculator","mercado"].map(t=>(
          <button key={t} className={`snbtn ${tab===t?"active":""}`} onClick={()=>setTab(t)} style={{"--ac":color}}>{t}</button>
        ))}
      </div>

      <div className="main">
        {tab==="dashboard"&&(
          <>
            <div className="cards">
              {[[color,"Prêmio coletado",`$${fmt(totalDollar)}`,`${pct(recovPct)} do custo`],["#3a8fff","Custo base atual",`$${fmt(costBasis)}`,`era $${asset.leapCost}`],["#f5c842","Ops abertas",openTrades.length,`${closedTrades.length} fechadas`],["#ff4d6a","P&L acumulado",`${totalDollar>=0?"+":""}$${fmt(totalDollar)}`,`${fmt(totalCollected/asset.leapCost*100)}% retorno`]].map(([c,l,v,s])=>(
                <div className="card" key={l} style={{"--top":c}}>
                  <div className="clbl">{l}</div>
                  <div className="cval">{v}</div>
                  <div className="csub" style={{color:l==="Prêmio coletado"?c:undefined}}>{s}</div>
                </div>
              ))}
            </div>
            <div className="sec">
              <div className="sechdr"><div className="sectitle">Recuperação do custo da LEAP</div><div style={{fontSize:11,color:"#5a7a9a"}}>meta: <span style={{color:"#c8d8e8"}}>${fmt(asset.leapCost*100)}</span></div></div>
              <div style={{padding:"14px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a7a9a",marginBottom:8}}><span>$0</span><span style={{color}}>${fmt(totalDollar)} coletado</span><span>${fmt(asset.leapCost*100)}</span></div>
                <div className="ptrack"><div className="pfill" style={{width:`${recovPct*100}%`,background:`linear-gradient(90deg,${color},#3a8fff)`}}/></div>
                <div style={{fontSize:11,color:"#5a7a9a",marginTop:6}}>faltam <span style={{color:"#f5c842"}}>${fmt(Math.max(asset.leapCost*100-totalDollar,0))}</span> para LEAP gratuita</div>
              </div>
            </div>
            <div className="sec">
              <div className="sechdr"><div className="sectitle">Posição LEAP</div><div className="badge" style={{color,borderColor:color+"44",background:color+"15"}}>COMPRADO</div></div>
              <div className="lgrid">
                {[["Ativo",asset.ticker],["Strike",`$${asset.leapStrike}`],["Vencimento",asset.leapExpiration],["Custo original",`$${asset.leapCost}`],["Custo atual",`$${fmt(costBasis)}`],["Delta",asset.leapDelta]].map(([l,v])=>(
                  <div className="litem" key={l}><div className="llbl">{l}</div><div className="lval">{v}</div></div>
                ))}
              </div>
            </div>
            <div className="sec">
              <div className="sechdr"><div className="sectitle">Calls vendidas abertas</div><button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>+ Registrar</button></div>
              {openTrades.length===0?<div className="empty">Nenhuma posição aberta</div>:(
                <table>
                  <thead><tr><th>Data</th><th>Strike</th><th>Prêmio</th><th>Contratos</th><th>Valor $</th><th>Prazo</th><th></th></tr></thead>
                  <tbody>
                    {openTrades.map(t=>{
                      const dl=Math.ceil((new Date(t.expiration)-new Date())/(1000*60*60*24));
                      const bc=dl<=7?"#E24B4A":dl<=14?"#BA7517":"#1D9E75";
                      const bw=Math.min(Math.max((dl/21)*100,4),100);
                      return (<tr key={t.id}>
                        <td style={{color:"#5a7a9a"}}>{t.date}</td>
                        <td><span style={{color:"#f5c842"}}>${t.strike}</span></td>
                        <td style={{color}}>${fmt(t.premium)}</td>
                        <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                        <td style={{color}}>${fmt(t.premium*(t.contracts||1)*100)}</td>
                        <td style={{minWidth:130}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <div style={{flex:1,height:5,background:"#1a2a3a",borderRadius:3}}><div style={{height:"100%",width:`${bw}%`,background:bc,borderRadius:3}}/></div>
                            <span style={{fontSize:11,color:bc,whiteSpace:"nowrap"}}>{dl<=0?"Vencida!":`${dl}d`}</span>
                          </div>
                        </td>
                        <td><div style={{display:"flex",gap:5}}>
                          <button className="btn bsm bneutral" onClick={()=>openEdit(t)}>Editar</button>
                          <button className="btn bsm bwarn" onClick={()=>openCR(t)}>Fechar/Rolar</button>
                          <button className="btn bsm bdanger" onClick={()=>removeTrade(t.id)}>✕</button>
                        </div></td>
                      </tr>);
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {tab==="trades"&&(
          <div className="sec">
            <div className="sechdr">
              <div className="sectitle">Histórico completo</div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{display:"flex",background:"#1a2a3a",borderRadius:6,padding:3,gap:2}}>
                  {[["all","Todos"],["open","Abertos"],["closed","Fechados"]].map(([v,l])=>(
                    <button key={v} onClick={()=>setStatusFilter(v)} style={{padding:"4px 10px",borderRadius:4,border:"none",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:10,background:statusFilter===v?color:"transparent",color:statusFilter===v?"#080c10":"#5a7a9a"}}>{l}</button>
                  ))}
                </div>
                <button className="btn bsm" onClick={()=>exportCSV(trades,asset.ticker)} style={{color,borderColor:color+"44",background:color+"15"}}>↓ CSV</button>
                <button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>+ Registrar</button>
              </div>
            </div>
            {filteredTrades.length===0?<div className="empty">Nenhuma operação</div>:(
              <table>
                <thead><tr><th>Data</th><th>Ação</th><th>Strike</th><th>Vencimento</th><th>Prêmio</th><th>Contratos</th><th>Valor $</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {filteredTrades.map(t=>(
                    <tr key={t.id}>
                      <td style={{color:"#5a7a9a"}}>{t.date}</td>
                      <td><span style={{color:t.action==="SELL"?color:"#ff4d6a"}}>{t.action==="SELL"?"VENDA":"COMPRA"}</span></td>
                      <td><span style={{color:"#f5c842"}}>${t.strike}</span></td>
                      <td>{t.expiration}</td>
                      <td style={{color:t.action==="SELL"?color:"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium)}</td>
                      <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                      <td style={{color:t.action==="SELL"?color:"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium*(t.contracts||1)*100)}</td>
                      <td>{t.status==="open"?<span className="stopen" style={{color,borderColor:color+"44",background:color+"15"}}>Aberta</span>:<span className="stclosed">Fechada</span>}</td>
                      <td><div style={{display:"flex",gap:5}}>
                        <button className="btn bsm bneutral" onClick={()=>openEdit(t)}>Editar</button>
                        <button className="btn bsm bdanger" onClick={()=>removeTrade(t.id)}>✕</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{padding:"10px 16px",borderTop:"1px solid #1a2a3a",display:"flex",justifyContent:"flex-end",gap:20,fontSize:13}}>
              <span style={{color:"#5a7a9a"}}>Total líquido:</span>
              <span style={{fontFamily:"Syne",fontSize:15,fontWeight:700,color:totalDollar>=0?color:"#ff4d6a"}}>${fmt(totalDollar)}</span>
            </div>
          </div>
        )}

        {tab==="calculator"&&<Calculator asset={asset} totalCollected={totalCollected} etfPrice={etfPrice}/>}
        {tab==="mercado"&&<MarketTab defaultSymbol={asset.ticker} color={color}/>}
      </div>

      {/* Fechar/Rolar Modal */}
      {showCR&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowCR(null)}>
          <div className="fbox">
            <div className="ftitle">Fechar ou Rolar posição</div>
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              <span style={{color:"#f5c842"}}>${showCR.strike}</span> · prêmio <span style={{color}}>${fmt(showCR.premium)}</span> · venc. {showCR.expiration}
            </div>
            <div className="toggle-group" style={{marginBottom:14}}>
              {[["close","Só fechar"],["roll","Rolar"]].map(([m,l])=>(
                <button key={m} className="tgl" onClick={()=>setCrForm({...crForm,mode:m})} style={{flex:1,background:crForm.mode===m?color:"transparent",color:crForm.mode===m?"#080c10":"#5a7a9a"}}>{l}</button>
              ))}
            </div>
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Preço pago pra fechar ($)</label>
              <input className="finput" type="number" step="0.01" placeholder="0.05" value={crForm.closePrem} onChange={e=>setCrForm({...crForm,closePrem:e.target.value})}/>
            </div>
            {crForm.mode==="roll"&&(
              <>
                <div style={{borderTop:"1px solid #1a2a3a",paddingTop:12,marginBottom:10,fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>Nova posição</div>
                <div className="frow">
                  <div className="fgrp"><label className="flbl">Novo strike ($)</label><input className="finput" type="number" step="0.5" value={crForm.newStrike} onChange={e=>setCrForm({...crForm,newStrike:e.target.value})}/></div>
                  <div className="fgrp"><label className="flbl">Prêmio recebido ($)</label><input className="finput" type="number" step="0.01" placeholder="0.55" value={crForm.newPrem} onChange={e=>setCrForm({...crForm,newPrem:e.target.value})}/></div>
                </div>
                <div className="fgrp" style={{marginBottom:12}}>
                  <label className="flbl">Novo vencimento</label>
                  <input className="finput" type="date" value={crForm.newExp} onChange={e=>setCrForm({...crForm,newExp:e.target.value})}/>
                </div>
                {crForm.closePrem&&crForm.newPrem&&(
                  <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:12,fontSize:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#5a7a9a"}}>Pago:</span><span style={{color:"#ff4d6a"}}>-${fmt(parseFloat(crForm.closePrem)*100)}</span></div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#5a7a9a"}}>Recebido:</span><span style={{color}}>${fmt(parseFloat(crForm.newPrem)*100)}</span></div>
                    <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #1a2a3a",paddingTop:6,marginTop:4}}>
                      <span style={{color:"#5a7a9a"}}>Crédito líquido:</span>
                      <span style={{fontWeight:700,color:(parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))>=0?color:"#ff4d6a"}}>
                        {(parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))>=0?"+":""}${fmt((parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))*100)}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowCR(null)}>Cancelar</button>
              <button className="btn bfull" onClick={confirmCR} style={{color,borderColor:color+"44",background:color+"15"}}>{crForm.mode==="roll"?"Confirmar Roll":"Confirmar Fechamento"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Encerrar Estratégia Modal */}
      {showClose&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowClose(false)}>
          <div className="fbox">
            <div className="ftitle">Encerrar estratégia {asset.ticker}</div>
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              Isso vai fechar todas as posições abertas e remover <span style={{color}}>{asset.ticker}</span> do dashboard ativo.
            </div>
            <div className="toggle-group" style={{marginBottom:14}}>
              {[["close","Encerrar"],["roll","Rolar LEAP"]].map(([m,l])=>(
                <button key={m} className="tgl" onClick={()=>setCloseForm({...closeForm,mode:m})} style={{flex:1,background:closeForm.mode===m?"#ff4d6a":"transparent",color:closeForm.mode===m?"#fff":"#5a7a9a"}}>{l}</button>
              ))}
            </div>
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Preço pago pra fechar a LEAP ($)</label>
              <input className="finput" type="number" step="0.01" placeholder="0.00" value={closeForm.closePrem} onChange={e=>setCloseForm({...closeForm,closePrem:e.target.value})}/>
            </div>
            {closeForm.mode==="roll"&&(
              <>
                <div style={{borderTop:"1px solid #1a2a3a",paddingTop:12,marginBottom:10,fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>Nova LEAP</div>
                <div className="frow">
                  <div className="fgrp"><label className="flbl">Novo strike ($)</label><input className="finput" type="number" step="0.5" placeholder={asset.leapStrike} value={closeForm.newStrike} onChange={e=>setCloseForm({...closeForm,newStrike:e.target.value})}/></div>
                  <div className="fgrp"><label className="flbl">Prêmio pago ($)</label><input className="finput" type="number" step="0.01" placeholder="8.50" value={closeForm.newPrem} onChange={e=>setCloseForm({...closeForm,newPrem:e.target.value})}/></div>
                </div>
                <div className="fgrp" style={{marginBottom:12}}>
                  <label className="flbl">Novo vencimento</label>
                  <input className="finput" placeholder="Ex: Jan 2028" value={closeForm.newExp} onChange={e=>setCloseForm({...closeForm,newExp:e.target.value})}/>
                </div>
              </>
            )}
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowClose(false)}>Cancelar</button>
              <button className="btn bfull bdanger" onClick={confirmClose}>Confirmar Encerramento</button>
            </div>
          </div>
        </div>
      )}

      {/* Trade Form */}
      {showForm&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
          <div className="fbox">
            <div className="ftitle">{editId?"Editar operação":"Registrar operação"}</div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Data</label><input className="finput" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></div>
              <div className="fgrp"><label className="flbl">Ação</label><select className="fsel" value={form.action} onChange={e=>setForm({...form,action:e.target.value})}><option value="SELL">VENDA</option><option value="BUY">COMPRA</option></select></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Strike ($)</label><input className="finput" type="number" step="0.5" value={form.strike} onChange={e=>setForm({...form,strike:e.target.value})}/></div>
              <div className="fgrp"><label className="flbl">Prêmio ($)</label><input className="finput" type="number" step="0.01" value={form.premium} onChange={e=>setForm({...form,premium:e.target.value})}/></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Vencimento</label><input className="finput" type="date" value={form.expiration} onChange={e=>setForm({...form,expiration:e.target.value})}/></div>
              <div className="fgrp"><label className="flbl">Contratos</label><input className="finput" type="number" step="1" min="1" value={form.contracts} onChange={e=>setForm({...form,contracts:e.target.value})}/></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Status</label><select className="fsel" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="open">Aberta</option><option value="closed">Fechada</option></select></div>
            </div>
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowForm(false)}>Cancelar</button>
              <button className="btn bfull" onClick={saveTrade} style={{color,borderColor:color+"44",background:color+"15"}}>{editId?"Salvar":"Confirmar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Simulator Home ────────────────────────────────────────────────────────────
function SimulatorHome({ assets }) {
  const [searchInput, setSearchInput] = useState("");
  const [sym, setSym] = useState("");
  const [quote, setQuote] = useState(null);
  const [exps, setExps] = useState([]);
  const [selExp, setSelExp] = useState("");
  const [chain, setChain] = useState([]);
  const [side, setSide] = useState("buy");
  const [optType, setOptType] = useState("call");
  const [strikeInput, setStrikeInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const totals = assets.filter(a=>a.active).map(a=>{
    const col=a.trades.reduce((acc,t)=>t.action==="SELL"?acc+parseFloat(t.premium||0)*parseInt(t.contracts||1):acc-parseFloat(t.premium||0)*parseInt(t.contracts||1),0);
    return {...a,col,colDollar:col*100,basis:a.leapCost-col};
  });
  const grandCol=totals.reduce((a,t)=>a+t.colDollar,0);
  const grandCost=totals.reduce((a,t)=>a+t.leapCost*100,0);
  const openTotal=totals.reduce((a,t)=>a+t.trades.filter(tr=>tr.status==="open").length,0);

  const doSearch=async()=>{
    const s=searchInput.trim().toUpperCase();if(!s)return;
    setLoading(true);setError(null);setSym(s);setQuote(null);setChain([]);
    try{
      const e=await fetchExpirations(s);
      if(!e||!e.length){setError(`Sem opções para "${s}"`);setLoading(false);return;}
      setExps(e);setSelExp(e[0]);
      const [q,ch]=await Promise.all([fetchQuote(s),fetchOptionChain(s,e[0])]);
      setQuote(q);setChain(ch);
      if(q?.last)setStrikeInput(q.last.toFixed(1));
    }catch{setError("Erro ao buscar.");}
    setLoading(false);
  };

  const loadChain=async(exp)=>{setSelExp(exp);setLoading(true);try{const ch=await fetchOptionChain(sym,exp);setChain(ch);}catch{}setLoading(false);};

  const etfPrice=quote?.last||0;
  const strike=parseFloat(strikeInput)||etfPrice;
  const filtered=chain.filter(o=>o.option_type===optType).sort((a,b)=>a.strike-b.strike);
  const closestOpt=filtered.reduce((a,b)=>Math.abs(b.strike-strike)<Math.abs(a.strike-strike)?b:a,filtered[0]||{});
  const premium=closestOpt?.ask||closestOpt?.last||0;
  const breakeven=optType==="call"?(side==="buy"?strike+premium:strike-premium):(side==="buy"?strike-premium:strike+premium);
  const maxLoss=side==="buy"?("$"+(premium*100).toFixed(0)):optType==="call"?"Ilimitado":("$"+((strike-premium)*100).toFixed(0));
  const maxProfit=side==="buy"?(optType==="call"?"Ilimitado":("$"+((strike-premium)*100).toFixed(0))):("$"+(premium*100).toFixed(0));

  const priceRows=[];
  if(etfPrice>0){for(let p=etfPrice*1.15;p>=etfPrice*0.85;p-=etfPrice*0.025){priceRows.push(parseFloat(p.toFixed(2)));}}

  return (
    <div className="main">
      {/* Portfolio Summary */}
      <div className="cards" style={{gridTemplateColumns:"repeat(4,1fr)"}}>
        {[["#00d4aa","Total coletado",`$${fmt(grandCol)}`,`${pct(grandCol/Math.max(grandCost,1))} do capital`],["#3a8fff","Capital alocado",`$${fmt(grandCost)}`,`${assets.filter(a=>a.active).length} LEAPs`],["#f5c842","Custo base",`$${fmt(grandCost-grandCol)}`,"após prêmios"],["#ff4d6a","Posições abertas",openTotal,`em ${totals.length} ativos`]].map(([c,l,v,s])=>(
          <div className="card" key={l} style={{"--top":c}}><div className="clbl">{l}</div><div className="cval">{v}</div><div className="csub">{s}</div></div>
        ))}
      </div>

      {totals.length>0&&(
        <div className="sec" style={{marginBottom:24}}>
          <div className="sechdr"><div className="sectitle">Carteira ativa</div></div>
          <table>
            <thead><tr><th>Ativo</th><th>LEAP Strike</th><th>Vencimento</th><th>Custo</th><th>Coletado</th><th>Custo base</th><th>Recuperação</th><th>Abertas</th></tr></thead>
            <tbody>
              {totals.map(t=>(
                <tr key={t.id}>
                  <td><span style={{color:t.color,fontFamily:"Syne",fontWeight:700,fontSize:14}}>{t.ticker}</span></td>
                  <td style={{color:"#f5c842"}}>${t.leapStrike}</td>
                  <td style={{color:"#8aaac8"}}>{t.leapExpiration}</td>
                  <td>${fmt(t.leapCost*100)}</td>
                  <td style={{color:t.color}}>${fmt(t.colDollar)}</td>
                  <td>${fmt(t.basis*100)}</td>
                  <td><div style={{display:"flex",alignItems:"center",gap:8}}><div style={{flex:1,height:4,background:"#1a2a3a",borderRadius:2,minWidth:60}}><div style={{height:"100%",width:`${Math.min(t.col/Math.max(t.leapCost,0.01)*100,100)}%`,background:t.color,borderRadius:2}}/></div><span style={{fontSize:11,color:t.color}}>{pct(t.col/Math.max(t.leapCost,0.01))}</span></div></td>
                  <td style={{color:"#8aaac8"}}>{t.trades.filter(tr=>tr.status==="open").length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Simulator */}
      <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
        <div style={{fontSize:11,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>Simulador</div>
        <div style={{flex:1,height:1,background:"#1a2a3a"}}/>
      </div>

      {/* Search + Controls */}
      <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
        <input className="finput" style={{maxWidth:150,fontSize:14,letterSpacing:1,textTransform:"uppercase"}} placeholder="AAPL, TSLA..."
          value={searchInput} onChange={e=>setSearchInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&doSearch()}/>
        <button className="btn" onClick={doSearch} disabled={loading} style={{padding:"8px 18px"}}>{loading?"Buscando...":"Buscar"}</button>
        <div className="toggle-group">
          <button className="tgl" onClick={()=>setSide("buy")} style={{background:side==="buy"?"#00d4aa":"transparent",color:side==="buy"?"#080c10":"#5a7a9a"}}>Buy</button>
          <button className="tgl" onClick={()=>setSide("sell")} style={{background:side==="sell"?"#ff4d6a":"transparent",color:side==="sell"?"#fff":"#5a7a9a"}}>Sell</button>
        </div>
        <div className="toggle-group">
          <button className="tgl" onClick={()=>setOptType("call")} style={{background:optType==="call"?"#3a8fff":"transparent",color:optType==="call"?"#fff":"#5a7a9a"}}>Call</button>
          <button className="tgl" onClick={()=>setOptType("put")} style={{background:optType==="put"?"#a78bfa":"transparent",color:optType==="put"?"#fff":"#5a7a9a"}}>Put</button>
        </div>
        {error&&<span style={{fontSize:11,color:"#ff4d6a"}}>{error}</span>}
      </div>

      {sym&&(
        <>
          {quote&&(
            <div className="pbar" style={{marginBottom:14,marginLeft:0,marginRight:0}}>
              <div className="tlbl" style={{color:"#00d4aa"}}>{sym}</div>
              <div className="dvdr"/>
              <div style={{fontFamily:"Syne",fontSize:24,fontWeight:800,color:"#fff"}}>${fmt(quote.last||0)}</div>
              <div className="dvdr"/>
              <div className="sml">abertura <span>${quote.open||"—"}</span></div>
              <div className="dvdr"/>
              <div className="sml">máx <span style={{color:"#00d4aa"}}>${quote.high||"—"}</span></div>
              <div className="dvdr"/>
              <div className="sml">mín <span style={{color:"#ff4d6a"}}>${quote.low||"—"}</span></div>
              <div className="dvdr"/>
              <div className="sml">vol <span>{quote.volume?.toLocaleString()||"—"}</span></div>
            </div>
          )}

          {/* Strike + Expiration */}
          <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{fontSize:11,letterSpacing:1.5,textTransform:"uppercase",color:"#5a7a9a"}}>Strike:</div>
            <input className="finput" type="number" step="0.5" style={{width:120,fontSize:18,fontFamily:"Syne",fontWeight:700,color:"#f5c842",textAlign:"center"}}
              value={strikeInput} onChange={e=>setStrikeInput(e.target.value)}/>
            <div style={{fontFamily:"Syne",fontSize:16,fontWeight:700,color:optType==="call"?"#3a8fff":"#a78bfa"}}>
              ${strike.toFixed(1)}{optType==="call"?"C":"P"}
            </div>
            <div style={{fontSize:12,color:"#5a7a9a"}}>Prêmio: <span style={{color:"#00d4aa",fontWeight:600}}>${fmt(premium)}</span></div>
            <div style={{marginLeft:"auto",display:"flex",gap:6,flexWrap:"wrap"}}>
              {exps.slice(0,6).map((e,i)=>(
                <button key={e} onClick={()=>loadChain(e)} style={{background:selExp===e?"#00d4aa":"#0d1821",border:`1px solid ${selExp===e?"#00d4aa":"#1a2a3a"}`,color:selExp===e?"#080c10":"#5a7a9a",padding:"5px 12px",borderRadius:20,cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:11,whiteSpace:"nowrap"}}>{e}</button>
              ))}
            </div>
          </div>

          {/* Stats */}
          <div className="cards" style={{gridTemplateColumns:"repeat(4,1fr)",marginBottom:16}}>
            {[[side==="buy"?"Net Debit":"Net Credit",side==="buy"?`-$${(premium*100).toFixed(0)}`:`+$${(premium*100).toFixed(0)}`,side==="buy"?"#ff4d6a":"#00d4aa"],["Max Loss",maxLoss,"#ff4d6a"],["Max Profit",maxProfit,"#00d4aa"],["Breakeven",`$${fmt(breakeven)}`,"#f5c842"]].map(([l,v,c])=>(
              <div className="card" key={l} style={{"--top":c}}><div className="clbl">{l}</div><div className="cval" style={{color:c,fontSize:18}}>{v}</div></div>
            ))}
          </div>

          {/* P&L Table */}
          {priceRows.length>0&&(
            <div className="sec">
              <div className="sechdr">
                <div className="sectitle">P&L por preço e vencimento</div>
                <button className="btn">+ Adicionar à carteira</button>
              </div>
              <div style={{overflowX:"auto"}}>
                <table>
                  <thead>
                    <tr>
                      <th>Preço</th><th>%</th>
                      {exps.slice(0,6).map(e=><th key={e} style={{textAlign:"center"}}>{e}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {priceRows.map(price=>{
                      const ppct=((price-etfPrice)/etfPrice*100).toFixed(1);
                      const isCur=Math.abs(price-etfPrice)<etfPrice*0.013;
                      return (
                        <tr key={price} style={{background:isCur?"#ffffff08":undefined}}>
                          <td style={{color:isCur?"#fff":"#c8d8e8",fontWeight:isCur?700:400}}>
                            ${price.toFixed(2)}{isCur&&<span style={{marginLeft:5,fontSize:9,color:"#00d4aa"}}>▲</span>}
                          </td>
                          <td style={{color:parseFloat(ppct)>=0?"#00d4aa":"#ff4d6a",fontSize:11}}>{parseFloat(ppct)>=0?"+":""}{ppct}%</td>
                          {exps.slice(0,6).map((e,ei)=>{
                            const opt=chain.filter(o=>o.option_type===optType).find(o=>Math.abs(o.strike-strike)<0.26);
                            const prem=opt?.ask||premium;
                            const days=ei*7+1;
                            const intrinsic=optType==="call"?Math.max(price-strike,0):Math.max(strike-price,0);
                            const tv=Math.max(prem*(1-ei/7),0);
                            const optVal=Math.max(intrinsic,tv*0.2);
                            const pnl=side==="buy"?Math.round((optVal-prem)*100):Math.round((prem-optVal)*100);
                            const intensity=Math.min(Math.abs(pnl)/300,1);
                            const bg=pnl>0?`rgba(0,212,170,${intensity*0.35})`:pnl<0?`rgba(226,75,74,${intensity*0.35})`:"transparent";
                            return <td key={e} style={{textAlign:"center",background:bg,color:pnl>0?"#00d4aa":pnl<0?"#ff6b6b":"#5a7a9a",fontWeight:Math.abs(pnl)>100?600:400}}>{pnl>0?"+":""}{pnl}</td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!sym&&(
        <div style={{textAlign:"center",padding:"48px 0",color:"#3a5a7a",fontSize:12,letterSpacing:0.5}}>
          Digite um ticker acima pra simular uma estratégia
        </div>
      )}
    </div>
  );
}

// ── Closed Strategies ─────────────────────────────────────────────────────────
function ClosedStrategies({ closedAssets }) {
  return (
    <div className="main">
      {closedAssets.length===0?(
        <div style={{textAlign:"center",padding:"60px 0",color:"#3a5a7a",fontSize:12}}>
          Nenhuma estratégia encerrada ainda
        </div>
      ):(
        closedAssets.map(a=>{
          const total=a.trades.reduce((acc,t)=>t.action==="SELL"?acc+parseFloat(t.premium||0)*parseInt(t.contracts||1):acc-parseFloat(t.premium||0)*parseInt(t.contracts||1),0);
          return (
            <div key={a.id} className="sec" style={{marginBottom:16}}>
              <div className="sechdr">
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{color:a.color,fontFamily:"Syne",fontWeight:700,fontSize:16}}>{a.ticker}</span>
                  <span className="stclosed">Encerrada</span>
                  <span style={{fontSize:11,color:"#5a7a9a"}}>{a.closedAt}</span>
                </div>
                <div style={{display:"flex",gap:16,fontSize:12}}>
                  <span style={{color:"#5a7a9a"}}>LEAP: <span style={{color:"#c8d8e8"}}>${a.leapStrike} {a.leapExpiration}</span></span>
                  <span style={{color:"#5a7a9a"}}>Total coletado: <span style={{color:total>=0?"#00d4aa":"#ff4d6a"}}>${fmt(total*100)}</span></span>
                </div>
              </div>
              <table>
                <thead><tr><th>Data</th><th>Ação</th><th>Strike</th><th>Vencimento</th><th>Prêmio</th><th>Contratos</th><th>Valor $</th></tr></thead>
                <tbody>
                  {a.trades.sort((x,y)=>new Date(y.date)-new Date(x.date)).map(t=>(
                    <tr key={t.id}>
                      <td style={{color:"#5a7a9a"}}>{t.date}</td>
                      <td><span style={{color:t.action==="SELL"?a.color:"#ff4d6a"}}>{t.action==="SELL"?"VENDA":"COMPRA"}</span></td>
                      <td><span style={{color:"#f5c842"}}>${t.strike}</span></td>
                      <td>{t.expiration}</td>
                      <td style={{color:t.action==="SELL"?a.color:"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium)}</td>
                      <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                      <td style={{color:t.action==="SELL"?a.color:"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium*(t.contracts||1)*100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Add Asset Modal ───────────────────────────────────────────────────────────
function AddAssetModal({ onAdd, onClose, usedColors }) {
  const [form, setForm] = useState({ticker:"",leapStrike:"",leapExpiration:"",leapCost:"",leapDelta:""});
  const avColor=COLORS.find(c=>!usedColors.includes(c))||"#a78bfa";
  const submit=()=>{
    if(!form.ticker||!form.leapStrike||!form.leapCost)return;
    onAdd({id:form.ticker.toUpperCase(),ticker:form.ticker.toUpperCase(),color:avColor,leapStrike:parseFloat(form.leapStrike),leapExpiration:form.leapExpiration,leapCost:parseFloat(form.leapCost),leapDelta:parseFloat(form.leapDelta)||0.70,initialPrice:0,active:true,trades:[]});
    onClose();
  };
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="fbox">
        <div className="ftitle">Adicionar novo ativo</div>
        <div className="frow">
          <div className="fgrp"><label className="flbl">Ticker</label><input className="finput" placeholder="KO, AAPL" style={{textTransform:"uppercase"}} value={form.ticker} onChange={e=>setForm({...form,ticker:e.target.value.toUpperCase()})}/></div>
          <div className="fgrp"><label className="flbl">Strike LEAP ($)</label><input className="finput" type="number" step="0.5" value={form.leapStrike} onChange={e=>setForm({...form,leapStrike:e.target.value})}/></div>
        </div>
        <div className="frow">
          <div className="fgrp"><label className="flbl">Custo LEAP ($)</label><input className="finput" type="number" step="0.01" value={form.leapCost} onChange={e=>setForm({...form,leapCost:e.target.value})}/></div>
          <div className="fgrp"><label className="flbl">Delta LEAP</label><input className="finput" type="number" step="0.01" placeholder="0.70" value={form.leapDelta} onChange={e=>setForm({...form,leapDelta:e.target.value})}/></div>
        </div>
        <div className="fgrp" style={{marginBottom:10}}>
          <label className="flbl">Vencimento LEAP</label>
          <input className="finput" placeholder="Ex: Jan 2027" value={form.leapExpiration} onChange={e=>setForm({...form,leapExpiration:e.target.value})}/>
        </div>
        <div style={{fontSize:11,color:"#5a7a9a",marginBottom:4}}>Cor: <span style={{color:avColor}}>●</span> {avColor}</div>
        <div className="factions">
          <button className="btn bneutral bfull" onClick={onClose}>Cancelar</button>
          <button className="btn bfull" onClick={submit} style={{color:avColor,borderColor:avColor+"44",background:avColor+"15"}}>Adicionar</button>
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [assets, setAssets] = useState(INITIAL_ASSETS);
  const [closedAssets, setClosedAssets] = useState([]);
  const [active, setActive] = useState("home");
  const [showAdd, setShowAdd] = useState(false);

  const addAsset = a => { setAssets(p=>[...p,a]); setActive(a.id); };

  const closeAsset = (id, finalTrades, closePremium) => {
    const a = assets.find(x=>x.id===id);
    setClosedAssets(p=>[...p,{...a,trades:finalTrades,active:false,closedAt:new Date().toLocaleDateString("pt-BR")}]);
    setAssets(p=>p.filter(x=>x.id!==id));
    setActive("home");
  };

  return (
    <div style={{minHeight:"100vh",background:"#080c10",color:"#c8d8e8"}}>
      <style>{CSS}</style>
      <div className="hdr">
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div className="logo" onClick={()=>setActive("home")}>Option<span>Desk</span></div>
          <div className="badge">Beta</div>
          {active!=="home"&&<button className="home-btn" onClick={()=>setActive("home")}>← Home</button>}
        </div>
        <div style={{fontSize:11,color:"#3a5a7a"}}>{new Date().toLocaleDateString("pt-BR",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</div>
      </div>

      <div className="tabs">
        <button className={`tab ${active==="home"?"active":""}`} onClick={()=>setActive("home")} style={{"--tc":"#00d4aa"}}>⌂ Home</button>
        {assets.filter(a=>a.active).map(a=>(
          <button key={a.id} className={`tab ${active===a.id?"active":""}`} onClick={()=>setActive(a.id)} style={{"--tc":a.color}}>{a.ticker}</button>
        ))}
        <button className="add-tab" onClick={()=>setShowAdd(true)} title="Adicionar ativo">+</button>
        {closedAssets.length>0&&(
          <button className={`tab ${active==="closed"?"active":""}`} onClick={()=>setActive("closed")} style={{"--tc":"#5a7a9a",marginLeft:"auto"}}>Encerradas ({closedAssets.length})</button>
        )}
      </div>

      {active==="home"&&<SimulatorHome assets={assets}/>}
      {assets.filter(a=>a.active).map(a=>active===a.id&&(
        <AssetDashboard key={a.id} asset={a} onClose={closeAsset} onUpdate={upd=>setAssets(p=>p.map(x=>x.id===a.id?upd:x))}/>
      ))}
      {active==="closed"&&<ClosedStrategies closedAssets={closedAssets}/>}

      {showAdd&&<AddAssetModal onAdd={addAsset} onClose={()=>setShowAdd(false)} usedColors={assets.map(a=>a.color)}/>}
    </div>
  );
}

const root=ReactDOM.createRoot(document.getElementById("root"));
root.render(<App/>);

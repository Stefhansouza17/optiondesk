import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchAssets, addAsset as dbAddAsset, addLeap, addTrade, updateTrade, deleteTrade, deleteLeap, fetchOpenTrades, closeAsset as dbCloseAsset } from "./supabase";

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
const COLORS = ["#00d4aa","#f5c842","#3a8fff","#ff6b9d","#a78bfa","#fb923c"];

const STRATEGIES = {
  INCOME: [
    { id:"PMCC", label:"PMCC", desc:"Buy a LEAP, sell short calls to collect premium and reduce cost basis.", tracks:["Premium collected","Cost basis recovery bar","Roll / close workflow"], no:["P&L unrealized"] },
    { id:"Covered Call", label:"Covered Call", desc:"Own 100 shares and sell a call against them. Generates income, caps upside.", tracks:["Premium collected","Roll / close workflow"], no:["LEAP tracking"] },
    { id:"Cash Secured Put", label:"Cash Secured Put", desc:"Sell a put with enough cash to buy shares if assigned.", tracks:["Premium collected","Assignment tracking"], no:["Recovery bar"] },
  ],
  DIRECTIONAL: [
    { id:"Long Call", label:"Long Call", desc:"Buy a call for directional upside with limited risk.", tracks:["P&L unrealized","Expiration countdown"], no:["Premium collected","Recovery bar"] },
    { id:"Long Put", label:"Long Put", desc:"Buy a put for directional downside or as a hedge.", tracks:["P&L unrealized","Expiration countdown"], no:["Premium collected","Recovery bar"] },
    { id:"Bull Call Spread", label:"Bull Call Spread", desc:"Buy lower strike call, sell higher strike call. Bullish with defined risk.", tracks:["P&L unrealized","Max profit / max loss"], no:["Premium collected"] },
    { id:"Bear Put Spread", label:"Bear Put Spread", desc:"Buy higher strike put, sell lower strike put. Bearish with defined risk.", tracks:["P&L unrealized","Max profit / max loss"], no:["Premium collected"] },
  ],
  NEUTRAL: [
    { id:"Iron Condor", label:"Iron Condor", desc:"Sell a call spread and put spread. Profits when price stays in range.", tracks:["Premium collected","Breakeven range"], no:["Recovery bar"] },
    { id:"Straddle", label:"Straddle", desc:"Buy a call and put at the same strike. Profits from big moves.", tracks:["P&L unrealized","Breakeven points"], no:["Premium collected"] },
    { id:"Strangle", label:"Strangle", desc:"Buy OTM call and put. Cheaper than straddle, needs bigger move.", tracks:["P&L unrealized","Breakeven points"], no:["Premium collected"] },
  ],
};

const isPremiumStrategy = (s) => ["PMCC","Covered Call","Cash Secured Put","Iron Condor"].includes(s);

const exportCSV = (trades, ticker) => {
  const header = "Date,Action,Strike,Expiration,Premium,Contracts,Value $,Status\n";
  const rows = trades.map(t =>
    `${t.date},${t.action},${t.strike},${t.expiration},${t.premium},${t.contracts||1},${(t.premium*(t.contracts||1)*100).toFixed(2)},${t.status}`
  ).join("\n");
  const blob = new Blob([header+rows], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${ticker}_trades.csv`;
  a.click();
};

const exportJSON = (assets, closedAssets) => {
  const data = JSON.stringify({ assets, closedAssets, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `optiondesk_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
};

const importJSON = (onSuccess) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.assets && Array.isArray(data.assets)) {
          onSuccess(data.assets, data.closedAssets || []);
        } else {
          alert("Invalid backup file.");
        }
      } catch { alert("Error reading file."); }
    };
    reader.readAsText(file);
  };
  input.click();
};


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
.card{background:#0d1821;border:1px solid #1a2a3a;border-radius:8px;padding:16px;position:relative;overflow:visible;transition:border-color 0.2s}
.card:hover{border-color:#2a4a6a}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--top,#1a3a5a);border-radius:8px 8px 0 0}
.clbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#5a7a9a;margin-bottom:7px;display:flex;align-items:center;gap:4px}
.cval{font-family:'Syne',sans-serif;font-size:22px;font-weight:700;color:#fff;line-height:1;margin-bottom:5px}
.csub{font-size:11px;color:#5a7a9a}
.sec{background:#0d1821;border:1px solid #1a2a3a;border-radius:8px;margin-bottom:16px}
.sechdr{padding:12px 16px;border-bottom:1px solid #1a2a3a;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sectitle{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a7a9a;display:flex;align-items:center;gap:4px}
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
th{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#3a5a7a;padding:9px 16px;text-align:left;border-bottom:1px solid #1a2a3a;font-weight:400}
td{padding:10px 16px;font-size:12px;border-bottom:1px solid #0f1e2e;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#101e2c}
.stopen{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.stclosed{display:inline-block;padding:2px 8px;background:#1a2a3a;border:1px solid #2a3a4a;color:#5a7a9a;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.stexpired{display:inline-block;padding:2px 8px;background:#a78bfa15;border:1px solid #a78bfa44;color:#a78bfa;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:200}
.fbox{background:#0d1821;border:1px solid #1a2a3a;border-radius:12px;padding:24px;width:480px;max-width:95vw;box-shadow:0 40px 80px rgba(0,0,0,0.6);max-height:90vh;overflow-y:auto}
.ftitle{font-family:'Syne',sans-serif;font-size:16px;font-weight:700;color:#fff;margin-bottom:16px}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.fgrp{display:flex;flex-direction:column;gap:4px}
.flbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#5a7a9a}
.finput,.fsel{background:#080c10;border:1px solid #1a2a3a;color:#c8d8e8;font-family:'DM Mono',monospace;font-size:13px;padding:7px 11px;border-radius:4px;width:100%;transition:border-color 0.2s}
.finput:focus,.fsel:focus{outline:none;border-color:#00d4aa66}
.fsel option{background:#0d1821}
.fsel.sm{font-size:11px;padding:4px 8px;width:auto}
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
.strat-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.strat-chip{border:1px solid #1a2a3a;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:'DM Mono',monospace;font-size:12px;color:#c8d8e8;transition:all 0.2s;background:transparent}
.strat-chip:hover{border-color:#3a5a7a}
.strat-chip.active{border-color:#00d4aa;background:#00d4aa15;color:#00d4aa}
.tooltip-wrap{position:relative;display:inline-flex;align-items:center}
.tooltip-icon{cursor:help;font-size:10px;color:#3a5a7a;background:#1a2a3a;border:1px solid #2a3a4a;border-radius:50%;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:600;margin-left:4px;flex-shrink:0}
.tooltip-box{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#1a2a3a;border:1px solid #2a3a4a;border-radius:6px;padding:8px 12px;font-size:11px;color:#c8d8e8;z-index:999;box-shadow:0 4px 20px rgba(0,0,0,0.4);width:200px;line-height:1.5;pointer-events:none}
.tooltip-box.below{bottom:auto;top:calc(100% + 6px)}
.fade-in{animation:fadeIn 0.3s ease-in}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#00d4aa;margin-right:6px;animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(0,212,170,0.5)}70%{box-shadow:0 0 0 7px rgba(0,212,170,0)}100%{box-shadow:0 0 0 0 rgba(0,212,170,0)}}
`;

// ── Tooltip ───────────────────────────────────────────────────────────────────
function Tooltip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span className="tooltip-wrap">
      <span className="tooltip-icon" onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>?</span>
      {show && (
        <div style={{
          position:"absolute",
          top:"calc(100% + 6px)",
          left:0,
          transform:"none",
          background:"#1a2a3a",
          border:"1px solid #2a3a4a",
          borderRadius:6,
          padding:"8px 12px",
          fontSize:11,
          color:"#c8d8e8",
          zIndex:999,
          boxShadow:"0 4px 20px rgba(0,0,0,0.4)",
          width:200,
          lineHeight:1.5,
          pointerEvents:"none",
        }}>{text}</div>
      )}
    </span>
  );
}

// ── Strategy Badge ────────────────────────────────────────────────────────────
function StratBadge({ strategy }) {
  const colors = { PMCC:"#3a8fff", "Covered Call":"#f5c842", "Cash Secured Put":"#fb923c", "Long Call":"#00d4aa", "Long Put":"#ff6b9d", "Bull Call Spread":"#a78bfa", "Bear Put Spread":"#ff4d6a", "Iron Condor":"#00d4aa", Straddle:"#f5c842", Strangle:"#5a7a9a" };
  const c = colors[strategy] || "#5a7a9a";
  return <span style={{fontSize:11,padding:"2px 8px",borderRadius:4,background:c+"20",color:c,border:`1px solid ${c}44`}}>{strategy||"PMCC"}</span>;
}

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
      if (!e||!e.length) { setError(`No options found for "${s}"`); setLoading(false); return; }
      setExps(e); setSelExp(e[0]);
      const [q, ch] = await Promise.all([fetchQuote(s), fetchOptionChain(s, e[0])]);
      if (q?.last) setPrice(q.last);
      setChain(ch);
    } catch { setError("Error fetching data."); }
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
        <button className="btn" onClick={search} disabled={loading} style={{color,borderColor:color+"44",background:color+"15"}}>{loading?"...":"Search"}</button>
        {error&&<span style={{fontSize:11,color:"#ff4d6a"}}>{error}</span>}
      </div>
      <div className="sec">
        <div className="sechdr">
          <div className="sectitle">Option chain — {optType==="call"?"Calls":"Puts"} {sym}</div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            <div className="toggle-group">
              {["call","put"].map(t=>(
                <button key={t} className="tgl" onClick={()=>setOptType(t)} style={{background:optType===t?color:"transparent",color:optType===t?"#080c10":"#5a7a9a"}}>{t==="call"?"Call":"Put"}</button>
              ))}
            </div>
            <select className="fsel sm" value={selExp} onChange={e=>loadChain(e.target.value)}>
              {exps.map(e=><option key={e} value={e}>{e}</option>)}
            </select>
            <button className="btn bsm" onClick={()=>loadSym(sym)} disabled={loading} style={{color,borderColor:color+"44",background:color+"15"}}>↻</button>
          </div>
        </div>
        {loading?<div className="empty">Loading...</div>:filtered.length===0?<div className="empty">No data available</div>:(
          <table>
            <thead><tr><th>Strike</th><th>Last</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th><th>Delta</th><th>Theta</th><th>Gamma</th></tr></thead>
            <tbody>
              {filtered.map(o=>{
                const isATM=price>0&&Math.abs(o.strike-price)<0.5;
                return (<tr key={o.symbol} style={{background:isATM?color+"10":undefined}}>
                  <td><span style={{color:isATM?color:"#f5c842",fontWeight:isATM?700:400}}>${o.strike}{isATM&&" ◀"}</span></td>
                  <td>${fmt(o.last||0)}</td><td style={{color:"#00d4aa"}}>${fmt(o.bid||0)}</td><td style={{color:"#ff4d6a"}}>${fmt(o.ask||0)}</td>
                  <td style={{color:"#5a7a9a"}}>{(o.volume||0).toLocaleString()}</td><td style={{color:"#5a7a9a"}}>{(o.open_interest||0).toLocaleString()}</td>
                  <td style={{color:"#f5c842"}}>{o.greeks?.smv_vol?((o.greeks.smv_vol)*100).toFixed(2)+"%":"—"}</td>
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
        <div className="sechdr"><div className="sectitle">Roll Calculator</div></div>
        <div style={{padding:"16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[["Short strike ($)",sellStrike,setSellStrike,0.5],["Premium received ($)",sellPrem,setSellPrem,0.01],["Premium paid to close ($)",buyPrem,setBuyPrem,0.01],["Weeks projected",weeks,setWeeks,1]].map(([l,v,s,st])=>(
            <div className="fgrp" key={l}><label className="flbl">{l}</label><input className="finput" type="number" step={st} value={v} onChange={e=>s(parseFloat(e.target.value)||0)}/></div>
          ))}
        </div>
        <div style={{padding:"0 16px 16px",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[["Net credit",`$${fmt(net)}`,net>=0?color:"#ff4d6a"],["Per contract",`$${fmt(net*100)}`,net>=0?color:"#ff4d6a"],["Return on LEAP",`${(wpct*100).toFixed(2)}%`,"#3a8fff"],["Spread",`$${fmt(spread)}`,"#f5c842"],["Weeks to free LEAP",`~${Math.ceil(projW)}`,"#c8d8e8"],["Projected total",`$${fmt(proj*100)}`,color]].map(([l,v,c])=>(
            <div key={l} style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"12px 14px"}}>
              <div style={{fontSize:10,letterSpacing:"1.5px",textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>{l}</div>
              <div style={{fontSize:17,fontFamily:"Syne",fontWeight:700,color:c}}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="sec">
        <div className="sechdr"><div className="sectitle">Exit scenarios</div></div>
        <table>
          <thead><tr><th>Scenario</th><th>{asset.ticker} price</th><th>Result</th><th>Est. P&L</th></tr></thead>
          <tbody>
            {[["Strong drop",etfPrice*0.7,"Expires worthless ✓",(asset.leapCost-totalCollected)*-100],["Moderate drop",etfPrice*0.85,"Expires worthless ✓",(basis-sellPrem)*-50],["Sideways",etfPrice,"Near ATM",net*100],["Moderate rally",etfPrice*1.1,"ITM — roll",(spread+net)*100],["Strong rally",etfPrice*1.25,"Deep ITM",(spread+net)*100]].map(([l,p,o,pnl])=>(
              <tr key={l}><td style={{color:"#c8d8e8"}}>{l}</td><td style={{color:"#f5c842"}}>${fmt(p)}</td><td style={{color:"#8aaac8",fontSize:11}}>{o}</td><td style={{color:pnl>=0?color:"#ff4d6a"}}>{pnl>=0?"+":""}${fmt(pnl)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Asset Dashboard ───────────────────────────────────────────────────────────
function AssetDashboard({ asset, onClose, onSaveTrade, onUpdateTrade, onDeleteTrade, onDeleteLeap, onDeleteAsset }) {
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
  const [showDelete, setShowDelete] = useState(false);
  const [closeLeap, setCloseLeap] = useState(null);
  const [closeLeapPrem, setCloseLeapPrem] = useState("");
  const [crForm, setCrForm] = useState({mode:"close",closePrem:"",newStrike:"",newExp:"",newPrem:"",contracts:1});
  const [closeForm, setCloseForm] = useState({mode:"close",closePrem:"",newStrike:"",newExp:"",newPrem:""});
  const ef = {date:new Date().toISOString().slice(0,10),action:"SELL",strike:"",expiration:"",premium:"",contracts:"1",status:"open"};
  const [form, setForm] = useState(ef);
  const color = asset.color;
  const strategy = asset.strategy || "PMCC";
  const isPremium = isPremiumStrategy(strategy);

  const fetchLive = useCallback(async()=>{
    setLoadingLive(true);setLiveErr(null);
    try{const q=await fetchQuote(asset.ticker);if(q?.last)setEtfPrice(q.last);setLiveData(q);}catch{setLiveErr("Error fetching data.");}
    setLoadingLive(false);
  },[asset.ticker]);
  useEffect(()=>{fetchLive();},[fetchLive]);

  const leaps = asset.leaps||[];
  const totalLeapCost = leaps.reduce((s,l)=>s+l.cost*l.contracts*100,0);
  const leapContracts = leaps.reduce((s,l)=>s+l.contracts,0);
  const leapAvg = leapContracts>0 ? totalLeapCost/leapContracts : 0; // dollars per contract
  const leapAvgPerShare = leapContracts>0 ? leaps.reduce((s,l)=>s+l.cost*l.contracts,0)/leapContracts : 0;

  const totalCollected = trades.reduce((a,t)=>{
    if(t.status==="expired") return a; // expired worthless — no cost, keep full premium
    return t.action==="SELL"?a+parseFloat(t.premium||0)*parseInt(t.contracts||1):a-parseFloat(t.premium||0)*parseInt(t.contracts||1);
  },0);
  const totalDollar = totalCollected*100;
  const costBasis = leapAvg - totalDollar;
  const recovPct = Math.min(totalLeapCost>0?totalDollar/totalLeapCost:0,1);
  const openTrades = trades.filter(t=>t.status==="open").sort((a,b)=>new Date(a.expiration)-new Date(b.expiration));
  const closedTrades = trades.filter(t=>t.status==="closed").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const expiredTrades = trades.filter(t=>t.status==="expired").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const filteredTrades = (statusFilter==="open"?openTrades:statusFilter==="closed"?closedTrades:statusFilter==="expired"?expiredTrades:trades).sort((a,b)=>new Date(b.date)-new Date(a.date));

  function openAdd(){setEditId(null);setForm(ef);setShowForm(true);}
  function openEdit(t){setEditId(t.id);setForm({...t,contracts:t.contracts||1});setShowForm(true);}
  async function saveTrade(){
    if(!form.strike||!form.expiration||!form.premium)return;
    const tradeData={...form,strike:parseFloat(form.strike),premium:parseFloat(form.premium),contracts:parseInt(form.contracts||1)};
    if(editId){
      await onUpdateTrade(editId,tradeData);
      setTrades(p=>p.map(t=>t.id===editId?{...t,...tradeData}:t));
    } else {
      const saved=await onSaveTrade(tradeData);
      if(saved){
        if(tradeData.action==="BUY"){
          const toClose=trades.filter(t=>t.status==="open"&&t.action==="SELL"&&parseFloat(t.strike)===parseFloat(tradeData.strike));
          setTrades(p=>[...p.map(t=>toClose.some(c=>c.id===t.id)?{...t,status:"closed"}:t),saved]);
        } else {
          setTrades(p=>[...p,saved]);
        }
      }
    }
    setShowForm(false);
  }
  async function removeTrade(id){
    await onDeleteTrade(id);
    setTrades(p=>p.filter(t=>t.id!==id));
  }
  function openCR(t){setShowCR(t);setCrForm({mode:"close",closePrem:"",newStrike:t.strike,newExp:"",newPrem:"",contracts:t.contracts||1});}
  async function confirmCR(){
    if(crForm.mode!=="expired"&&!crForm.closePrem)return;
    const today=new Date().toISOString().slice(0,10);
    const c=parseInt(showCR.contracts||1);

    if(crForm.mode==="expired"){
      // Mark as expired — no BUY needed, full premium kept
      await onUpdateTrade(showCR.id,{status:"expired"});
      setTrades(p=>p.map(t=>t.id===showCR.id?{...t,status:"expired"}:t));
      setShowCR(null);
      return;
    }

    // Close existing
    await onUpdateTrade(showCR.id,{status:"closed"});
    setTrades(p=>p.map(t=>t.id===showCR.id?{...t,status:"closed"}:t));
    // Add buy to close
    const buyClose={date:today,action:"BUY",strike:showCR.strike,expiration:showCR.expiration,premium:parseFloat(crForm.closePrem),contracts:c,status:"closed"};
    const savedBuy=await onSaveTrade(buyClose);
    if(savedBuy) setTrades(p=>[...p,savedBuy]);
    // Add roll if needed
    if(crForm.mode==="roll"&&crForm.newExp&&crForm.newPrem){
      const newTrade={date:today,action:"SELL",strike:parseFloat(crForm.newStrike||showCR.strike),expiration:crForm.newExp,premium:parseFloat(crForm.newPrem),contracts:c,status:"open"};
      const savedRoll=await onSaveTrade(newTrade);
      if(savedRoll) setTrades(p=>[...p,savedRoll]);
    }
    setShowCR(null);
  }
  async function confirmCloseLeap(){
    if(!closeLeapPrem||!closeLeap) return;
    const today = new Date().toISOString().slice(0,10);
    const saved = await onSaveTrade({
      date:today, action:"SELL", strike:closeLeap.strike,
      expiration:closeLeap.expiration, premium:parseFloat(closeLeapPrem),
      contracts:closeLeap.contracts||1, status:"closed"
    });
    if(saved) setTrades(p=>[...p,saved]);
    await onDeleteLeap(closeLeap.id);
    setCloseLeap(null);
    setCloseLeapPrem("");
  }
  async function confirmClose(){
    if(!closeForm.closePrem)return;
    const today=new Date().toISOString().slice(0,10);
    // Close all open trades
    for(const t of trades.filter(t=>t.status==="open")){
      await onUpdateTrade(t.id,{status:"closed"});
    }
    const upd=trades.map(t=>t.status==="open"?{...t,status:"closed"}:t);
    setTrades(upd);
    onClose(asset.id,upd,parseFloat(closeForm.closePrem));
    setShowClose(false);
  }

  return (
    <div>
      {/* Price Bar */}
      <div className="pbar">
        <div className="tlbl" style={{color}}>{asset.ticker}</div>
        <div style={{marginLeft:4}}><StratBadge strategy={strategy}/></div>
        <div className="dvdr"/>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:"#5a7a9a"}}>Price $</span>
          <input className="pinput" type="number" step="0.01" value={etfPrice} onChange={e=>setEtfPrice(parseFloat(e.target.value)||0)} style={{color}}/>
        </div>
        {liveData&&<><div className="dvdr"/><div className="sml">open <span>${liveData.open||"—"}</span></div><div className="dvdr"/><div className="sml">high <span style={{color:"#00d4aa"}}>${liveData.high||"—"}</span></div><div className="dvdr"/><div className="sml">low <span style={{color:"#ff4d6a"}}>${liveData.low||"—"}</span></div><div className="dvdr"/><div className="sml">vol <span>{liveData.volume?.toLocaleString()||"—"}</span></div></>}
        {isPremium&&<><div className="dvdr"/><div className="sml">LEAP <span>${asset.leapStrike}</span></div><div className="dvdr"/><div className="sml">distance <span className={etfPrice>=asset.leapStrike?"green":"red"}>{etfPrice>=asset.leapStrike?"+":""}{fmt(etfPrice-asset.leapStrike)}</span></div><div className="dvdr"/><div className="sml">avg cost <span style={{color}}>${fmt(leapAvg)}</span></div></>}
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button className="btn bsm" onClick={fetchLive} disabled={loadingLive} style={{color,borderColor:color+"44",background:color+"15"}}>{loadingLive?"...":"↻"}</button>
          <button className="btn bsm bneutral" onClick={()=>setShowDelete(true)}>✕ Delete</button>
          <button className="btn bsm bdanger" onClick={()=>setShowClose(true)}>Close strategy</button>
        </div>
        {liveErr&&<div style={{fontSize:11,color:"#ff4d6a"}}>{liveErr}</div>}
      </div>

      {/* Sub Nav */}
      <div className="subnav">
        {["dashboard","trades","calculator","market"].map(t=>(
          <button key={t} className={`snbtn ${tab===t?"active":""}`} onClick={()=>setTab(t)} style={{"--ac":color}}>{t}</button>
        ))}
      </div>

      <div className="main">
        {tab==="dashboard"&&(
          <>
            <div className="cards">
              {(isPremium?[
                [color,"Premium collected",`$${fmt(totalDollar)}`,`${(recovPct*100).toFixed(2)}% of LEAP cost`],
                ["#3a8fff","Current cost basis",`$${fmt(costBasis)}`,`avg was $${fmt(leapAvg)}`],
                ["#f5c842","Open positions",openTrades.filter(t=>t.action==="SELL").length,`${closedTrades.length} closed`],
                ["#ff4d6a","Accumulated P&L",`${totalDollar>=0?"+":""}$${fmt(totalDollar)}`,`${fmt(totalCollected/leapAvg*100)}% return`],
              ]:[
                [color,"Open P&L","—","mark to market"],
                ["#3a8fff","Cost basis",`$${fmt(asset.leapCost*100)}`,`${strategy}`],
                ["#f5c842","Open positions",openTrades.length,`${closedTrades.length} closed`],
                ["#ff4d6a","Realized P&L",`${totalDollar>=0?"+":""}$${fmt(totalDollar)}`,`from closed trades`],
              ]).map(([c,l,v,s])=>(
                <div className="card" key={l} style={{"--top":c}}>
                  <div className="clbl">{l}</div><div className="cval">{v}</div><div className="csub">{s}</div>
                </div>
              ))}
            </div>

            {isPremium&&(
              <>
                <div className="sec">
                  <div className="sechdr">
                    <div className="sectitle">Cost basis recovery</div>
                    <div style={{fontSize:11,color:"#5a7a9a"}}>target: <span style={{color:"#c8d8e8"}}>${fmt(totalLeapCost*100)}</span></div>
                  </div>
                  <div style={{padding:"14px 16px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a7a9a",marginBottom:8}}>
                      <span>$0</span>
                      <span style={{color}}>${fmt(totalDollar)} collected</span>
                      <span>${fmt(totalLeapCost)} target</span>
                    </div>
                    <div className="ptrack"><div className="pfill" style={{width:`${recovPct*100}%`,background:`linear-gradient(90deg,${color},#3a8fff)`}}/></div>
                    <div style={{fontSize:11,color:"#5a7a9a",marginTop:6}}>$<span style={{color:"#f5c842"}}>{fmt(Math.max(totalLeapCost-totalDollar,0))}</span> remaining to free LEAP</div>
                  </div>
                </div>
                <div className="sec">
                  <div className="sechdr">
                    <div className="sectitle">LEAP positions</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      {leapContracts>1&&<span style={{fontSize:11,color:"#f5c842"}}>{leapContracts} contracts · avg ${fmt(leapAvg)}</span>}
                      <div className="badge" style={{color,borderColor:color+"44",background:color+"15"}}>LONG</div>
                    </div>
                  </div>
                  <table>
                    <thead><tr><th>Date</th><th>Strike</th><th>Expiration</th><th>Cost</th><th>Contracts</th><th>Total</th><th></th></tr></thead>
                    <tbody>
                      {leaps.map((l,i)=>(
                        <tr key={l.id||i}>
                          <td style={{color:"#5a7a9a"}}>{l.date}</td>
                          <td style={{color:"#f5c842"}}>${l.strike}</td>
                          <td>{l.expiration}</td>
                          <td style={{color}}>${fmt(l.cost)}</td>
                          <td style={{color:"#8aaac8"}}>{l.contracts}</td>
                          <td style={{color}}>${fmt(l.cost*l.contracts*100)}</td>
                          <td><button className="btn bsm bdanger" onClick={()=>{setCloseLeap(l);setCloseLeapPrem("");}}>Close</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{padding:"10px 16px",borderTop:"1px solid #1a2a3a",display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a7a9a"}}>
                    <span>Total cost: <span style={{color:"#c8d8e8"}}>${fmt(totalLeapCost)}</span></span>
                    <span>Avg cost/contract: <span style={{color}}>${fmt(leapAvg)}</span></span>
                  </div>
                </div>
              </>
            )}

            <div className="sec">
              <div className="sechdr">
                <div className="sectitle">{isPremium?"Short calls open":"Open positions"}</div>
                <button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>+ Add trade</button>
              </div>
              {openTrades.length===0?<div className="empty">No open positions</div>:(
                <table>
                  <thead><tr><th>Date</th><th>Strike</th><th>Premium</th><th>Contracts</th><th>Value $</th><th>Expiration</th><th></th></tr></thead>
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
                            <span style={{fontSize:11,color:bc,whiteSpace:"nowrap"}}>{dl<=0?"Expired!":dl+"d"}</span>
                          </div>
                        </td>
                        <td><div style={{display:"flex",gap:5}}>
                          <button className="btn bsm bneutral" onClick={()=>openEdit(t)}>Edit</button>
                          {isPremium&&<button className="btn bsm bwarn" onClick={()=>openCR(t)}>Close/Roll</button>}
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
              <div className="sectitle">Trade history</div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{display:"flex",background:"#1a2a3a",borderRadius:6,padding:3,gap:2}}>
                  {[["all","All"],["open","Open"],["closed","Closed"],["expired","Expired"]].map(([v,l])=>(
                    <button key={v} onClick={()=>setStatusFilter(v)} style={{padding:"4px 10px",borderRadius:4,border:"none",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:10,background:statusFilter===v?color:"transparent",color:statusFilter===v?"#080c10":"#5a7a9a"}}>{l}</button>
                  ))}
                </div>
                <button className="btn bsm" onClick={()=>exportCSV(trades,asset.ticker)} style={{color,borderColor:color+"44",background:color+"15"}}>↓ CSV</button>
                <button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>+ Add trade</button>
              </div>
            </div>
            {filteredTrades.length===0?<div className="empty">No trades found</div>:(
              <table>
                <thead><tr><th>Date</th><th>Action</th><th>Strike</th><th>Expiration</th><th>Premium</th><th>Contracts</th><th>Value $</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {filteredTrades.map(t=>(
                    <tr key={t.id}>
                      <td style={{color:"#5a7a9a"}}>{t.date}</td>
                      <td><span style={{color:t.action==="SELL"?color:"#ff4d6a"}}>{t.action==="SELL"?"SELL":"BUY"}</span></td>
                      <td><span style={{color:"#f5c842"}}>${t.strike}</span></td>
                      <td>{t.expiration}</td>
                      <td style={{color:t.action==="SELL"?color:"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium)}</td>
                      <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                      <td style={{color:t.action==="SELL"?color:"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium*(t.contracts||1)*100)}</td>
                      <td>{t.status==="open"?<span className="stopen" style={{color,borderColor:color+"44",background:color+"15"}}>Open</span>:t.status==="expired"?<span className="stexpired">Expired</span>:<span className="stclosed">Closed</span>}</td>
                      <td><div style={{display:"flex",gap:5}}>
                        <button className="btn bsm bneutral" onClick={()=>openEdit(t)}>Edit</button>
                        <button className="btn bsm bdanger" onClick={()=>removeTrade(t.id)}>✕</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{padding:"10px 16px",borderTop:"1px solid #1a2a3a",display:"flex",justifyContent:"flex-end",gap:20,fontSize:13}}>
              <span style={{color:"#5a7a9a"}}>Net total:</span>
              <span style={{fontFamily:"Syne",fontSize:15,fontWeight:700,color:totalDollar>=0?color:"#ff4d6a"}}>${fmt(totalDollar)}</span>
            </div>
          </div>
        )}

        {tab==="calculator"&&isPremium&&<Calculator asset={asset} totalCollected={totalCollected} etfPrice={etfPrice}/>}
        {tab==="calculator"&&!isPremium&&<div className="empty" style={{padding:48}}>Calculator available for PMCC and premium strategies only.</div>}
        {tab==="market"&&<MarketTab defaultSymbol={asset.ticker} color={color}/>}
      </div>

      {/* Close/Roll Modal */}
      {showCR&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowCR(null)}>
          <div className="fbox">
            <div className="ftitle">Close or Roll position</div>
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              <span style={{color:"#f5c842"}}>${showCR.strike}</span> · premium <span style={{color}}>${fmt(showCR.premium)}</span> · exp. {showCR.expiration}
            </div>
            <div className="toggle-group" style={{marginBottom:14}}>
              {[["close","Close only"],["roll","Roll"],["expired","Expired worthless"]].map(([m,l])=>(
                <button key={m} className="tgl" onClick={()=>setCrForm({...crForm,mode:m})} style={{flex:1,background:crForm.mode===m?color:"transparent",color:crForm.mode===m?"#080c10":"#5a7a9a"}}>{l}</button>
              ))}
            </div>
            {crForm.mode!=="expired"&&(
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Price paid to close ($)</label>
              <input className="finput" type="number" step="0.01" placeholder="0.05" value={crForm.closePrem} onChange={e=>setCrForm({...crForm,closePrem:e.target.value})}/>
            </div>
            )}
            {crForm.mode==="expired"&&(
              <div style={{background:"#a78bfa10",border:"1px solid #a78bfa33",borderRadius:6,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#a78bfa"}}>
                Option expired worthless — full premium kept, no cost to close. ✅
              </div>
            )}
            {crForm.mode==="roll"&&(
              <>
                <div style={{borderTop:"1px solid #1a2a3a",paddingTop:12,marginBottom:10,fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>New position</div>
                <div className="frow">
                  <div className="fgrp"><label className="flbl">New strike ($)</label><input className="finput" type="number" step="0.5" value={crForm.newStrike} onChange={e=>setCrForm({...crForm,newStrike:e.target.value})}/></div>
                  <div className="fgrp"><label className="flbl">Premium received ($)</label><input className="finput" type="number" step="0.01" placeholder="0.55" value={crForm.newPrem} onChange={e=>setCrForm({...crForm,newPrem:e.target.value})}/></div>
                </div>
                <div className="fgrp" style={{marginBottom:12}}>
                  <label className="flbl">New expiration</label>
                  <input className="finput" type="date" value={crForm.newExp} onChange={e=>setCrForm({...crForm,newExp:e.target.value})}/>
                </div>
                {crForm.closePrem&&crForm.newPrem&&(
                  <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:12,fontSize:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#5a7a9a"}}>Paid:</span><span style={{color:"#ff4d6a"}}>-${fmt(parseFloat(crForm.closePrem)*100)}</span></div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#5a7a9a"}}>Received:</span><span style={{color}}>${fmt(parseFloat(crForm.newPrem)*100)}</span></div>
                    <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #1a2a3a",paddingTop:6,marginTop:4}}>
                      <span style={{color:"#5a7a9a"}}>Net credit:</span>
                      <span style={{fontWeight:700,color:(parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))>=0?color:"#ff4d6a"}}>
                        {(parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))>=0?"+":""}${fmt((parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))*100)}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowCR(null)}>Cancel</button>
              <button className="btn bfull" onClick={confirmCR} style={{color,borderColor:color+"44",background:color+"15"}}>{crForm.mode==="roll"?"Confirm Roll":"Confirm Close"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Close LEAP Modal */}
      {closeLeap&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setCloseLeap(null)}>
          <div className="fbox">
            <div className="ftitle">Close LEAP — {asset.ticker}</div>
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              <span style={{color:"#f5c842"}}>${closeLeap.strike}</span> · exp {closeLeap.expiration} · cost <span style={{color}}>${fmt(closeLeap.cost)}</span> · {closeLeap.contracts} contract{closeLeap.contracts>1?"s":""}
            </div>
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Price received to sell LEAP ($)</label>
              <input className="finput" type="number" step="0.01" placeholder="e.g. 5.50" value={closeLeapPrem}
                onChange={e=>setCloseLeapPrem(e.target.value)} autoFocus/>
            </div>
            {closeLeapPrem&&(
              <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:12,fontSize:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{color:"#5a7a9a"}}>Original cost:</span>
                  <span style={{color:"#ff4d6a"}}>-${fmt(closeLeap.cost*closeLeap.contracts*100)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{color:"#5a7a9a"}}>Sale price:</span>
                  <span style={{color:"#00d4aa"}}>+${fmt(parseFloat(closeLeapPrem)*closeLeap.contracts*100)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #1a2a3a",paddingTop:6,marginTop:4}}>
                  <span style={{color:"#5a7a9a"}}>Net P&L on LEAP:</span>
                  <span style={{fontWeight:700,color:(parseFloat(closeLeapPrem)-closeLeap.cost)>=0?"#00d4aa":"#ff4d6a"}}>
                    {(parseFloat(closeLeapPrem)-closeLeap.cost)>=0?"+":""}${fmt((parseFloat(closeLeapPrem)-closeLeap.cost)*closeLeap.contracts*100)}
                  </span>
                </div>
              </div>
            )}
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setCloseLeap(null)}>Cancel</button>
              <button className="btn bfull bdanger" onClick={confirmCloseLeap}>Confirm close LEAP</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Asset Modal */}
      {showDelete&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowDelete(false)}>
          <div className="fbox">
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <div style={{width:36,height:36,borderRadius:"50%",background:"#ff4d6a15",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <span style={{color:"#ff4d6a",fontSize:18}}>⚠</span>
              </div>
              <div className="ftitle" style={{margin:0}}>Remove {asset.ticker} from dashboard?</div>
            </div>
            <p style={{fontSize:14,color:"#8aaac8",lineHeight:1.6,marginBottom:20}}>
              This will permanently remove <span style={{color:"#fff",fontWeight:500}}>{asset.ticker}</span> and everything associated with it — all trades, LEAPs, and history. There's no way to undo this.
            </p>
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowDelete(false)}>Cancel</button>
              <button className="btn bfull bdanger" onClick={()=>{onDeleteAsset(asset.id);setShowDelete(false);}}>Yes, remove it</button>
            </div>
          </div>
        </div>
      )}

      {/* Close Strategy Modal */}
      {showClose&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowClose(false)}>
          <div className="fbox">
            <div className="ftitle">Close strategy — {asset.ticker}</div>
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              This will close all open positions and remove <span style={{color}}>{asset.ticker}</span> from the active dashboard.
            </div>
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Price paid to close LEAP ($)</label>
              <input className="finput" type="number" step="0.01" placeholder="0.00" value={closeForm.closePrem} onChange={e=>setCloseForm({...closeForm,closePrem:e.target.value})}/>
            </div>
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowClose(false)}>Cancel</button>
              <button className="btn bfull bdanger" onClick={confirmClose}>Confirm close</button>
            </div>
          </div>
        </div>
      )}

      {/* Trade Form */}
      {showForm&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowForm(false)}>
          <div className="fbox">
            <div className="ftitle">{editId?"Edit trade":"Add trade"}</div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Date</label><input className="finput" type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></div>
              <div className="fgrp"><label className="flbl">Action</label><select className="fsel" value={form.action} onChange={e=>setForm({...form,action:e.target.value})}><option value="SELL">SELL</option><option value="BUY">BUY</option></select></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Strike ($)</label><input className="finput" type="number" step="0.5" value={form.strike} onChange={e=>setForm({...form,strike:e.target.value})}/></div>
              <div className="fgrp"><label className="flbl">Premium ($)</label><input className="finput" type="number" step="0.01" value={form.premium} onChange={e=>setForm({...form,premium:e.target.value})}/></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Expiration</label><input className="finput" type="date" value={form.expiration} onChange={e=>setForm({...form,expiration:e.target.value})}/></div>
              <div className="fgrp"><label className="flbl">Contracts</label><input className="finput" type="number" step="1" min="1" value={form.contracts} onChange={e=>setForm({...form,contracts:e.target.value})}/></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Status</label><select className="fsel" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="open">Open</option><option value="closed">Closed</option><option value="expired">Expired (worthless)</option></select></div>
            </div>
            <div className="factions">
              <button className="btn bneutral bfull" onClick={()=>setShowForm(false)}>Cancel</button>
              <button className="btn bfull" onClick={saveTrade} style={{color,borderColor:color+"44",background:color+"15"}}>{editId?"Save":"Confirm"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Home ──────────────────────────────────────────────────────────────────────
function Home({ assets, onSelectAsset, onShowPositions }) {
  const [searchInput, setSearchInput] = useState("NDAQ");
  const [sym, setSym] = useState("NDAQ");
  const [quote, setQuote] = useState(null);
  const [exps, setExps] = useState([]);
  const [selExp, setSelExp] = useState("");
  const [chain, setChain] = useState([]);
  const [side, setSide] = useState("buy");
  const [optType, setOptType] = useState("call");
  const [strikeInput, setStrikeInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stratFilter, setStratFilter] = useState("all");
  const [sortBy, setSortBy] = useState("expiration");

  const totals = useMemo(()=>assets.filter(a=>a.active).map(a=>{
    const leaps = a.leaps||[];
    const leapCost = leaps.reduce((s,l)=>s+l.cost*l.contracts*100,0); // total cost in dollars
    const leapContracts = leaps.reduce((s,l)=>s+l.contracts,0);
    const leapAvg = leapContracts>0 ? leapCost/leapContracts : 0; // dollars per contract
    const col=a.trades.reduce((acc,t)=>{
      if(t.status==="expired") return acc;
      return t.action==="SELL"?acc+parseFloat(t.premium||0)*parseInt(t.contracts||1):acc-parseFloat(t.premium||0)*parseInt(t.contracts||1);
    },0);
    const openTrades=a.trades.filter(t=>t.status==="open");
    const openSells=openTrades.filter(t=>t.action==="SELL");
    const openPremium=openSells.reduce((acc,t)=>acc+parseFloat(t.premium||0)*parseInt(t.contracts||1),0);
    const nearestExp=[...openSells].sort((a,b)=>new Date(a.expiration)-new Date(b.expiration))[0];
    const daysLeft=nearestExp?Math.ceil((new Date(nearestExp.expiration)-new Date())/(1000*60*60*24)):null;
    return {...a,leaps,leapCost,leapContracts,leapAvg,col,colDollar:col*100,basis:leapAvg-col*100,openTrades,openSells,openPremium,nearestExp,daysLeft};
  }),[assets]);
  const grandCol=useMemo(()=>totals.reduce((a,t)=>a+t.colDollar,0),[totals]);
  const grandCost=useMemo(()=>totals.reduce((a,t)=>a+t.leapCost,0),[totals]);
  const openPositions=useMemo(()=>totals.reduce((a,t)=>a+t.openTrades.length,0)+totals.reduce((a,t)=>a+t.leapContracts,0),[totals]);
  const currentCycle=useMemo(()=>totals.reduce((a,t)=>a+t.openPremium*100,0),[totals]);
  const avgRecovery=useMemo(()=>grandCost>0?(grandCol/grandCost)*100:0,[grandCol,grandCost]);

  const filteredTotals=useMemo(()=>totals
    .filter(t=>stratFilter==="all"||(t.strategy||"PMCC")===stratFilter)
    .sort((a,b)=>{
      if(sortBy==="expiration")return(a.daysLeft||999)-(b.daysLeft||999);
      if(sortBy==="ticker")return a.ticker.localeCompare(b.ticker);
      if(sortBy==="recovery")return(b.col/b.leapAvg)-(a.col/a.leapAvg);
      return 0;
    }),[totals,stratFilter,sortBy]);

  const doSearch=useCallback(async(ticker)=>{
    const s=(ticker||searchInput).trim().toUpperCase();if(!s)return;
    setLoading(true);setError(null);setSym(s);setQuote(null);setChain([]);
    try{
      const e=await fetchExpirations(s);
      if(!e||!e.length){setError(`No options found for "${s}"`);setLoading(false);return;}
      setExps(e);setSelExp(e[0]);
      const [q,ch]=await Promise.all([fetchQuote(s),fetchOptionChain(s,e[0])]);
      setQuote(q);setChain(ch);
      if(q?.last)setStrikeInput(q.last.toFixed(1));
    }catch{setError("Error fetching data.");}
    setLoading(false);
  },[searchInput]);

  useEffect(()=>{ doSearch("NDAQ"); },[]);

  const loadChain=async(exp)=>{setSelExp(exp);setLoading(true);try{const ch=await fetchOptionChain(sym,exp);setChain(ch);}catch{}setLoading(false)};
  const etfPrice=quote?.last||0;
  const strike=parseFloat(strikeInput)||etfPrice;
  const filteredChain=chain.filter(o=>o.option_type===optType).sort((a,b)=>a.strike-b.strike);
  const closestOpt=filteredChain.reduce((a,b)=>Math.abs(b.strike-strike)<Math.abs(a.strike-strike)?b:a,filteredChain[0]||{});
  const premium=closestOpt?.ask||closestOpt?.last||0;
  const breakeven=optType==="call"?(side==="buy"?strike+premium:strike-premium):(side==="buy"?strike-premium:strike+premium);
  const maxLoss=side==="buy"?("$"+(premium*100).toFixed(0)):optType==="call"?"Unlimited":("$"+((strike-premium)*100).toFixed(0));
  const maxProfit=side==="buy"?(optType==="call"?"Unlimited":("$"+((strike-premium)*100).toFixed(0))):("$"+(premium*100).toFixed(0));
  const priceRows=filteredChain
    .filter(o=>etfPrice>0?o.strike>=etfPrice*0.85&&o.strike<=etfPrice*1.15:true)
    .map(o=>o.strike)
    .sort((a,b)=>b-a);
  return (
    <div className="main fade-in">
      {/* KPI Cards */}
      <div className="cards" style={{gridTemplateColumns:"repeat(4,1fr)"}}>
        <div className="card" style={{"--top":"#00d4aa",borderColor:"#00d4aa22"}}>
          <div className="clbl">Income Generated <Tooltip text="Total premium collected from all closed short calls across all cycles and assets."/></div>
          <div className="cval" style={{color:"#00d4aa",textShadow:"0 0 20px rgba(0,212,170,0.3)"}}>${fmt(grandCol)}</div>
          <div className="csub">{fmt(avgRecovery,1)}% avg recovered</div>
        </div>
        <div className="card" style={{"--top":"#a78bfa",borderColor:"#a78bfa22"}}>
          <div className="clbl">Engine Progress <Tooltip text="Average percentage of LEAP costs recovered through premium. At 100% your LEAPs are free."/></div>
          <div className="cval" style={{color:"#a78bfa",textShadow:"0 0 20px rgba(167,139,250,0.3)"}}>{fmt(avgRecovery,1)}%</div>
          <div className="csub">of LEAP cost recovered</div>
        </div>
        <div className="card" style={{"--top":"#3a8fff"}}>
          <div className="clbl">Capital at Risk <Tooltip text="Total cost of your active LEAPs — the maximum you could lose if all expire worthless."/></div>
          <div className="cval">${fmt(grandCost)}</div>
          <div className="csub">{assets.filter(a=>a.active).length} LEAPs active</div>
        </div>
        <div className="card" style={{"--top":"#f5c842"}}>
          <div className="clbl">Open Positions <Tooltip text="Total number of open orders across all active strategies — LEAPs, short calls, puts, etc."/></div>
          <div className="cval" style={{color:"#f5c842"}}>{openPositions}</div>
          <div className="csub" style={{cursor:"pointer",color:"#f5c84288",textDecoration:"underline",textDecorationStyle:"dotted"}} onClick={onShowPositions}>see all positions →</div>
        </div>
      </div>

      {/* Theta Engine */}
      {totals.length>0&&(
        <div className="sec" style={{marginBottom:18}}>
          <div className="sechdr">
            <div className="sectitle">Theta Engine <Tooltip text="Overall progress toward making all your LEAPs free through premium collection."/></div>
            <div style={{fontSize:11,color:"#5a7a9a"}}><span style={{color:"#00d4aa"}}>${fmt(grandCol)}</span> of <span style={{color:"#c8d8e8"}}>${fmt(grandCost)}</span> target</div>
          </div>
          <div style={{padding:"18px 20px"}}>
            {/* Bar */}
            <div style={{position:"relative",height:14,background:"#0a1520",borderRadius:7,overflow:"hidden",marginBottom:10,border:"1px solid #1a2a3a"}}>
              <div style={{
                height:"100%",
                width:`${Math.min(avgRecovery,100)}%`,
                background:"linear-gradient(90deg,#00d4aa,#3a8fff)",
                borderRadius:7,
                transition:"width 0.8s ease",
                boxShadow:"0 0 12px rgba(0,212,170,0.4)",
                position:"relative",
              }}>
                <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"linear-gradient(180deg,rgba(255,255,255,0.15) 0%,transparent 100%)",borderRadius:7}}/>
              </div>
              {/* Milestone markers */}
              {[25,50,75].map(m=>(
                <div key={m} style={{position:"absolute",top:0,bottom:0,left:`${m}%`,width:1,background:"#1a2a3a",zIndex:2}}/>
              ))}
            </div>
            {/* Milestone labels */}
            <div style={{position:"relative",height:16,marginBottom:8}}>
              {[25,50,75].map(m=>(
                <div key={m} style={{position:"absolute",left:`${m}%`,transform:"translateX(-50%)",fontSize:9,color:avgRecovery>=m?"#00d4aa44":"#1a2a3a",letterSpacing:0.5,textAlign:"center"}}>
                  {m}%
                </div>
              ))}
              <div style={{position:"absolute",right:0,fontSize:9,color:avgRecovery>=100?"#00d4aa":"#1a2a3a",letterSpacing:0.5,fontWeight:700}}>
                {avgRecovery>=100?"🎉 LEAP FREE!":"LEAP FREE"}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a7a9a"}}>
              <span>$0</span>
              <span style={{color:"#00d4aa"}}>${fmt(grandCol)} collected</span>
              <span>Target: LEAP fully paid</span>
            </div>

            {/* Velocity metrics */}
            {(()=>{
              const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate()-28);
              const recentPremium = totals.reduce((acc,t)=>{
                const recent = t.trades.filter(tr=>tr.action==="SELL"&&tr.status==="closed"&&new Date(tr.date)>=fourWeeksAgo);
                return acc + recent.reduce((s,tr)=>s+parseFloat(tr.premium||0)*parseInt(tr.contracts||1)*100,0);
              },0);
              const weeklyVelocity = recentPremium / 4;
              const remaining = Math.max(grandCost - grandCol, 0);
              const daysToFree = weeklyVelocity > 0 ? Math.ceil((remaining / weeklyVelocity) * 7) : null;
              const annualized = weeklyVelocity > 0 ? (weeklyVelocity * 52 / grandCost * 100) : 0;
              return (
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginTop:16,paddingTop:16,borderTop:"1px solid #1a2a3a"}}>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Theta Velocity <Tooltip text="Average weekly premium collected over the last 4 weeks."/></div>
                    <div style={{fontFamily:"Syne,sans-serif",fontSize:18,fontWeight:700,color:"#00d4aa"}}>${fmt(weeklyVelocity)}<span style={{fontSize:11,color:"#5a7a9a"}}>/wk</span></div>
                  </div>
                  <div style={{textAlign:"center",borderLeft:"1px solid #1a2a3a",borderRight:"1px solid #1a2a3a"}}>
                    <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Days to Free LEAP <Tooltip text="Estimated days to recover the full LEAP cost at current collection velocity."/></div>
                    <div style={{fontFamily:"Syne,sans-serif",fontSize:18,fontWeight:700,color:"#f5c842"}}>{daysToFree?`~${daysToFree}d`:"—"}</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Annualized Recovery <Tooltip text="Projected annual LEAP recovery rate based on current weekly velocity."/></div>
                    <div style={{fontFamily:"Syne,sans-serif",fontSize:18,fontWeight:700,color:"#a78bfa"}}>{fmt(annualized,1)}%<span style={{fontSize:11,color:"#5a7a9a"}}>/yr</span></div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Active Positions */}
      {totals.length>0&&(
        <div className="sec" style={{marginBottom:24}}>
          <div className="sechdr">
            <div className="sectitle">Active positions</div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <select className="fsel sm" value={stratFilter} onChange={e=>setStratFilter(e.target.value)}>
                <option value="all">All strategies</option>
                <option value="PMCC">PMCC</option>
                <option value="Long Call">Long Call</option>
                <option value="Covered Call">Covered Call</option>
              </select>
              <select className="fsel sm" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
                <option value="expiration">Sort: expiration</option>
                <option value="ticker">Sort: ticker</option>
                <option value="recovery">Sort: recovery</option>
              </select>
            </div>
          </div>
          <table>
            <thead><tr><th>Ticker</th><th>Strategy</th><th>Short Strike</th><th>Premium</th><th>Expiration</th><th>Recovery</th><th>Status</th></tr></thead>
            <tbody>
              {filteredTotals.map(t=>{
                const recPct=Math.min(t.col/Math.max(t.leapCost,0.01)*100,100);
                const recColor=recPct<10?"#BA7517":recPct<25?"#f5c842":"#00d4aa";
                const openSell=t.openSells[0];
                const bc=t.daysLeft!=null?(t.daysLeft<=3?"#E24B4A":t.daysLeft<=7?"#BA7517":"#1D9E75"):"#3a5a7a";
                return (
                  <tr key={t.id} onClick={()=>onSelectAsset&&onSelectAsset(t.id)} style={{cursor:"pointer"}}>
                    <td><span style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:14,color:"#fff"}}>{t.ticker}</span></td>
                    <td><StratBadge strategy={t.strategy||"PMCC"}/></td>
                    <td style={{color:"#f5c842"}}>{openSell?`$${openSell.strike}`:<span style={{fontSize:11,color:"#3a5a7a",fontStyle:"italic"}}>no open call</span>}</td>
                    <td style={{color:"#00d4aa"}}>{openSell?`+$${fmt(openSell.premium*100)}`:<span style={{color:"#3a5a7a"}}>—</span>}</td>
                    <td>{t.daysLeft!=null?(<div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:48,height:4,background:"#1a2a3a",borderRadius:2}}><div style={{height:"100%",width:`${Math.min(Math.max((t.daysLeft/21)*100,4),100)}%`,background:bc,borderRadius:2}}/></div><span style={{fontSize:11,color:bc}}>{t.daysLeft<=0?"exp!":t.daysLeft+"d"}</span></div>):<span style={{fontSize:11,color:"#3a5a7a",fontStyle:"italic"}}>—</span>}</td>
                    <td>{isPremiumStrategy(t.strategy||"PMCC")?(<div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:60,height:4,background:"#1a2a3a",borderRadius:2}}><div style={{height:"100%",width:`${recPct}%`,background:recColor,borderRadius:2}}/></div><span style={{fontSize:11,color:recColor}}>{fmt(recPct,1)}%</span></div>):<span style={{color:"#3a5a7a",fontSize:12}}>—</span>}</td>
                    <td>{t.openTrades.length>0?<span style={{display:"flex",alignItems:"center"}}><span className="pulse"/><span style={{fontSize:10,padding:"2px 8px",borderRadius:3,background:"#00d4aa15",border:"1px solid #00d4aa44",color:"#00d4aa",letterSpacing:1,textTransform:"uppercase"}}>open</span></span>:<span style={{fontSize:10,padding:"2px 8px",borderRadius:3,background:"#f5c84210",border:"1px solid #f5c84244",color:"#f5c842",letterSpacing:1,textTransform:"uppercase"}}>no call</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Simulator */}
      <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
        <div style={{fontSize:11,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>Simulator</div>
        <div style={{flex:1,height:1,background:"#1a2a3a"}}/>
      </div>
      <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
        <input className="finput" style={{maxWidth:150,fontSize:14,letterSpacing:1,textTransform:"uppercase"}} placeholder="AAPL, TSLA..."
          value={searchInput} onChange={e=>setSearchInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&doSearch()}/>
        <button className="btn" onClick={()=>doSearch()} disabled={loading} style={{padding:"8px 18px"}}>{loading?"Searching...":"Search"}</button>
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
              <div className="sml">open <span>${quote.open||"—"}</span></div>
              <div className="dvdr"/>
              <div className="sml">high <span style={{color:"#00d4aa"}}>${quote.high||"—"}</span></div>
              <div className="dvdr"/>
              <div className="sml">low <span style={{color:"#ff4d6a"}}>${quote.low||"—"}</span></div>
              <div className="dvdr"/>
              <div className="sml">vol <span>{quote.volume?.toLocaleString()||"—"}</span></div>
            </div>
          )}
          <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{fontSize:11,letterSpacing:1.5,textTransform:"uppercase",color:"#5a7a9a"}}>Strike:</div>
            <input className="finput" type="number" step="0.5" style={{width:120,fontSize:18,fontFamily:"Syne",fontWeight:700,color:"#f5c842",textAlign:"center"}}
              value={strikeInput} onChange={e=>setStrikeInput(e.target.value)}/>
            <div style={{fontSize:12,color:"#5a7a9a"}}>Premium: <span style={{color:"#00d4aa",fontWeight:600}}>${fmt(premium)}</span></div>
            <div style={{marginLeft:"auto",display:"flex",gap:6,flexWrap:"wrap"}}>
              {exps.slice(0,6).map((e)=>(
                <button key={e} onClick={()=>loadChain(e)} style={{background:selExp===e?"#00d4aa":"#0d1821",border:`1px solid ${selExp===e?"#00d4aa":"#1a2a3a"}`,color:selExp===e?"#080c10":"#5a7a9a",padding:"5px 12px",borderRadius:20,cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:11,whiteSpace:"nowrap"}}>{e}</button>
              ))}
            </div>
          </div>
          <div className="cards" style={{gridTemplateColumns:"repeat(4,1fr)",marginBottom:16}}>
            {[[side==="buy"?"Net Debit":"Net Credit",side==="buy"?`-$${(premium*100).toFixed(0)}`:`+$${(premium*100).toFixed(0)}`,side==="buy"?"#ff4d6a":"#00d4aa"],["Max Loss",maxLoss,"#ff4d6a"],["Max Profit",maxProfit,"#00d4aa"],["Breakeven",`$${fmt(breakeven)}`,"#f5c842"]].map(([l,v,c])=>(
              <div className="card" key={l} style={{"--top":c}}><div className="clbl">{l}</div><div className="cval" style={{color:c,fontSize:18}}>{v}</div></div>
            ))}
          </div>
          {priceRows.length>0&&(
            <div className="sec">
              <div className="sechdr"><div className="sectitle">P&L by price and expiration</div><button className="btn">+ Add to portfolio</button></div>
              <div style={{overflowX:"auto"}}>
                <table>
                  <thead><tr><th>Price</th><th>%</th>{exps.slice(0,6).map(e=><th key={e} style={{textAlign:"center"}}>{e}</th>)}</tr></thead>
                  <tbody>
                    {priceRows.map(price=>{
                      const ppct=((price-etfPrice)/etfPrice*100).toFixed(1);
                      const isCur=price===filteredChain.reduce((a,b)=>Math.abs(b.strike-etfPrice)<Math.abs(a.strike-etfPrice)?b:a,filteredChain[0]||{strike:0}).strike;
                      // Get real option data for this strike
                      const rowOpt=chain.filter(o=>o.option_type===optType).find(o=>o.strike===price);
                      const rowPrem=rowOpt?.ask||rowOpt?.last||0;
                      return (
                        <tr key={price} style={{background:isCur?"#ffffff08":undefined}}>
                          <td style={{color:isCur?"#fff":"#c8d8e8",fontWeight:isCur?700:400}}>${price.toFixed(2)}{isCur&&<span style={{marginLeft:5,fontSize:9,color:"#00d4aa"}}>◀ ATM</span>}</td>
                          <td style={{color:parseFloat(ppct)>=0?"#00d4aa":"#ff4d6a",fontSize:11}}>{parseFloat(ppct)>=0?"+":""}{ppct}%</td>
                          {exps.slice(0,6).map((e,ei)=>{
                            const intrinsic=optType==="call"?Math.max(price-price,0):Math.max(price-price,0);
                            const tv=Math.max(rowPrem*(1-ei/7),0);
                            const optVal=Math.max(intrinsic,tv*0.2);
                            const pnl=side==="buy"?Math.round((optVal-rowPrem)*100):Math.round((rowPrem-optVal)*100);
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
      {!sym&&loading&&(<div style={{textAlign:"center",padding:"20px 0",color:"#3a5a7a",fontSize:12}}>Loading...</div>)}
    </div>
  );
}

// ── Closed Strategies ─────────────────────────────────────────────────────────
function ClosedStrategies({ closedAssets }) {
  return (
    <div className="main">
      {closedAssets.length===0?(
        <div style={{textAlign:"center",padding:"60px 0",color:"#3a5a7a",fontSize:12}}>No closed strategies yet</div>
      ):(
        closedAssets.map(a=>{
          const total=a.trades.reduce((acc,t)=>{
            if(t.status==="expired") return acc;
            return t.action==="SELL"?acc+parseFloat(t.premium||0)*parseInt(t.contracts||1):acc-parseFloat(t.premium||0)*parseInt(t.contracts||1);
          },0);
          return (
            <div key={a.id} className="sec" style={{marginBottom:16}}>
              <div className="sechdr">
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontFamily:"Syne",fontWeight:700,fontSize:16,color:"#c8d8e8"}}>{a.ticker}</span>
                  <StratBadge strategy={a.strategy||"PMCC"}/>
                  <span className="stclosed">Closed</span>
                  <span style={{fontSize:11,color:"#5a7a9a"}}>{a.closedAt}</span>
                </div>
                <div style={{display:"flex",gap:16,fontSize:12}}>
                  <span style={{color:"#5a7a9a"}}>LEAP: <span style={{color:"#c8d8e8"}}>${a.leapStrike} {a.leapExpiration}</span></span>
                  <span style={{color:"#5a7a9a"}}>Total collected: <span style={{color:total>=0?"#00d4aa":"#ff4d6a"}}>${fmt(total*100)}</span></span>
                </div>
              </div>
              <table>
                <thead><tr><th>Date</th><th>Action</th><th>Strike</th><th>Expiration</th><th>Premium</th><th>Contracts</th><th>Value $</th></tr></thead>
                <tbody>
                  {a.trades.sort((x,y)=>new Date(y.date)-new Date(x.date)).map(t=>(
                    <tr key={t.id}>
                      <td style={{color:"#5a7a9a"}}>{t.date}</td>
                      <td><span style={{color:t.action==="SELL"?"#00d4aa":"#ff4d6a"}}>{t.action}</span></td>
                      <td><span style={{color:"#f5c842"}}>${t.strike}</span></td>
                      <td>{t.expiration}</td>
                      <td style={{color:t.action==="SELL"?"#00d4aa":"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium)}</td>
                      <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                      <td style={{color:t.action==="SELL"?"#00d4aa":"#ff4d6a"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium*(t.contracts||1)*100)}</td>
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
  const [ticker, setTicker] = useState("");
  const [selectedStrategy, setSelectedStrategy] = useState("");
  const [leapStrike, setLeapStrike] = useState("");
  const [leapExp, setLeapExp] = useState("");
  const [leapCost, setLeapCost] = useState("");
  const [leapDelta, setLeapDelta] = useState("");
  const avColor=COLORS.find(c=>!usedColors.includes(c))||"#a78bfa";
  const needsLeap = isPremiumStrategy(selectedStrategy) || selectedStrategy==="PMCC" || selectedStrategy==="";
  const stratInfo = Object.values(STRATEGIES).flat().find(s=>s.id===selectedStrategy);

  const submit=()=>{
    if(!ticker)return;
    onAdd({
      id:ticker.toUpperCase(),
      ticker:ticker.toUpperCase(),
      strategy:selectedStrategy||"PMCC",
      color:avColor,
      leapStrike:parseFloat(leapStrike)||0,
      leapExpiration:leapExp,
      leapCost:parseFloat(leapCost)||0,
      leapDelta:parseFloat(leapDelta)||0.70,
      initialPrice:0,
      active:true,
      trades:[],
    });
    onClose();
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="fbox">
        <div className="ftitle">Add new position</div>
        <div className="fgrp" style={{marginBottom:14}}>
          <label className="flbl">Ticker</label>
          <input className="finput" placeholder="AAPL, NVDA, SPY..." style={{textTransform:"uppercase",fontSize:16,letterSpacing:2}}
            value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())}/>
        </div>

        <div className="fgrp" style={{marginBottom:14}}>
          <label className="flbl">Strategy</label>
          {Object.entries(STRATEGIES).map(([category, strats])=>(
            <div key={category} style={{marginBottom:10}}>
              <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:6,marginTop:4}}>{category}</div>
              <div className="strat-grid">
                {strats.map(s=>(
                  <button key={s.id} className={`strat-chip ${selectedStrategy===s.id?"active":""}`}
                    onClick={()=>setSelectedStrategy(selectedStrategy===s.id?"":s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {stratInfo&&(
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"10px 14px",marginTop:8,fontSize:12}}>
              <div style={{color:"#c8d8e8",marginBottom:6,fontWeight:500}}>{stratInfo.label}</div>
              <div style={{color:"#5a7a9a",lineHeight:1.5,marginBottom:8}}>{stratInfo.desc}</div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                <div>
                  {stratInfo.tracks.map(t=><div key={t} style={{fontSize:11,color:"#00d4aa",marginBottom:2}}>✓ {t}</div>)}
                </div>
                <div>
                  {stratInfo.no.map(t=><div key={t} style={{fontSize:11,color:"#3a5a7a",marginBottom:2}}>✕ {t}</div>)}
                </div>
              </div>
            </div>
          )}
          {!selectedStrategy&&<div style={{fontSize:11,color:"#3a5a7a",marginTop:6}}>No strategy selected — will be tracked as free entry</div>}
        </div>

        {(needsLeap||isPremiumStrategy(selectedStrategy))&&(
          <>
            <div style={{borderTop:"1px solid #1a2a3a",paddingTop:12,marginBottom:10,fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>LEAP details</div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Strike ($)</label><input className="finput" type="number" step="0.5" value={leapStrike} onChange={e=>setLeapStrike(e.target.value)}/></div>
              <div className="fgrp"><label className="flbl">Cost per share ($)</label><input className="finput" type="number" step="0.01" placeholder="e.g. 10.12" value={leapCost} onChange={e=>setLeapCost(e.target.value)}/></div>
            </div>
            <div className="frow">
              <div className="fgrp"><label className="flbl">Expiration</label><input className="finput" placeholder="Jan 2027" value={leapExp} onChange={e=>setLeapExp(e.target.value)}/></div>
              <div className="fgrp"><label className="flbl">Delta</label><input className="finput" type="number" step="0.01" placeholder="0.70" value={leapDelta} onChange={e=>setLeapDelta(e.target.value)}/></div>
            </div>
          </>
        )}

        <div style={{fontSize:11,color:"#5a7a9a",marginBottom:4,marginTop:4}}>Color: <span style={{color:avColor}}>●</span> {avColor}</div>
        <div className="factions">
          <button className="btn bneutral bfull" onClick={onClose}>Cancel</button>
          <button className="btn bfull" onClick={submit} style={{color:avColor,borderColor:avColor+"44",background:avColor+"15"}}>Add position</button>
        </div>
      </div>
    </div>
  );
}

// ── All Positions Modal ───────────────────────────────────────────────────────
function AllPositionsModal({ assets, onClose }) {
  const allOpen = assets.filter(a=>a.active).flatMap(a=>{
    const rows = [];
    // LEAPs — one row per contract with individual cost
    const leaps = a.leaps||[];
    leaps.forEach((l,i)=>{
      for(let c=0;c<l.contracts;c++){
        rows.push({
          type:"LEAP", ticker:a.ticker, color:a.color,
          strike:`$${l.strike}`, expiration:l.expiration,
          cost:`$${fmt(l.cost)}`, contracts:1,
          action:"BUY", status:"open", date:l.date,
        });
      }
    });
    // Open short calls
    a.trades.filter(t=>t.status==="open").forEach(t=>{
      const dl=Math.ceil((new Date(t.expiration)-new Date())/(1000*60*60*24));
      const bc=dl<=3?"#E24B4A":dl<=7?"#BA7517":"#1D9E75";
      rows.push({
        type:"Short Call", ticker:a.ticker, color:a.color,
        strike:`$${t.strike}`, expiration:t.expiration,
        cost:`$${fmt(t.premium)}`, contracts:t.contracts||1,
        action:"SELL", status:"open", premium:`$${fmt(t.premium*100)}`,
        daysLeft:dl, daysColor:bc,
      });
    });
    return rows;
  });

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="fbox" style={{width:640,maxWidth:"95vw"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div className="ftitle" style={{marginBottom:0}}>All open positions</div>
          <button className="btn bsm bneutral" onClick={onClose}>✕</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Ticker</th><th>Type</th><th>Action</th><th>Strike</th>
              <th>Expiration</th><th>Cost / Premium</th><th>Contracts</th>
            </tr>
          </thead>
          <tbody>
            {allOpen.map((p,i)=>(
              <tr key={i}>
                <td><span style={{fontFamily:"Syne,sans-serif",fontWeight:700,color:p.color}}>{p.ticker}</span></td>
                <td><span style={{fontSize:11,padding:"2px 8px",borderRadius:4,background:p.type==="LEAP"?"#3a8fff20":"#00d4aa15",color:p.type==="LEAP"?"#3a8fff":"#00d4aa",border:`1px solid ${p.type==="LEAP"?"#3a8fff44":"#00d4aa44"}`}}>{p.type}</span></td>
                <td><span style={{color:p.action==="SELL"?"#00d4aa":"#3a8fff"}}>{p.action}</span></td>
                <td style={{color:"#f5c842"}}>{p.strike}</td>
                <td>
                  {p.daysLeft!=null?(
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:36,height:3,background:"#1a2a3a",borderRadius:2}}>
                        <div style={{height:"100%",width:`${Math.min(Math.max((p.daysLeft/21)*100,4),100)}%`,background:p.daysColor,borderRadius:2}}/>
                      </div>
                      <span style={{fontSize:11,color:p.daysColor}}>{p.daysLeft<=0?"exp!":p.daysLeft+"d"}</span>
                    </div>
                  ):<span style={{color:"#5a7a9a",fontSize:12}}>{p.expiration}</span>}
                </td>
                <td style={{color:p.action==="SELL"?"#00d4aa":"#c8d8e8"}}>{p.cost}</td>
                <td style={{color:"#8aaac8"}}>{p.contracts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{marginTop:12,padding:"10px 0",borderTop:"1px solid #1a2a3a",display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a7a9a"}}>
          <span>{allOpen.length} total positions open</span>
          <span>{allOpen.filter(p=>p.type==="LEAP").length} LEAPs · {allOpen.filter(p=>p.type==="Short Call").length} short calls</span>
        </div>
      </div>
    </div>
  );
}
function App() {
  const [assets, setAssets] = useState([]);
  const [closedAssets, setClosedAssets] = useState([]);
  const [active, setActive] = useState("home");
  const [showAdd, setShowAdd] = useState(false);
  const [showPositions, setShowPositions] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(()=>{
    const today=new Date().toISOString().slice(0,10);
    fetchAssets()
      .then(async data=>{
        const expireIds=data.flatMap(a=>a.trades.filter(t=>t.status==="open"&&t.expiration<today).map(t=>t.id));
        if(expireIds.length) await Promise.all(expireIds.map(id=>updateTrade(id,{status:"expired"})));
        const updated=data.map(a=>({...a,trades:a.trades.map(t=>expireIds.includes(t.id)?{...t,status:"expired"}:t)}));
        setAssets(updated);
        setLoading(false);
      })
      .catch(err=>{ console.error(err); setLoading(false); });
  },[]);

  const addAsset = async (a) => {
    try {
      await dbAddAsset(a);
      // If LEAP data provided in old format, create a leaps entry
      if(a.leapCost && a.leapCost>0 && a.leapStrike){
        const leap = {
          id: `${a.id}_L${Date.now()}`,
          date: new Date().toISOString().slice(0,10),
          strike: a.leapStrike,
          expiration: a.leapExpiration||"",
          cost: a.leapCost,
          contracts: 1,
        };
        await addLeap(a.id, leap);
      }
      if(a.leaps) for(const l of a.leaps) await addLeap(a.id, l);
      const fresh = await fetchAssets();
      setAssets(fresh);
      setActive(a.id);
    } catch(e){ console.error(e); }
  };

  const addAssetSilent = async (a) => {
    try {
      await dbAddAsset(a);
      setAssets(p=>[...p,{...a, leaps:[], trades:[]}]);
      return true;
    } catch(e){
      // If duplicate key, asset already exists — still ok
      if(e.code==="23505"||e.message?.includes("duplicate")) return true;
      console.error("addAssetSilent error:", e);
      return false;
    }
  };

  const handleDeleteAsset = async (id) => {
    try {
      await dbCloseAsset(id);
      setAssets(p=>p.filter(x=>x.id!==id));
      setActive("home");
    } catch(e){ console.error(e); }
  };

  const closeAsset = async (id, finalTrades) => {
    try {
      await dbCloseAsset(id);
      const a = assets.find(x=>x.id===id);
      setClosedAssets(p=>[...p,{...a,trades:finalTrades,active:false,closedAt:new Date().toLocaleDateString("en-US")}]);
      setAssets(p=>p.filter(x=>x.id!==id));
      setActive("home");
    } catch(e){ console.error(e); }
  };

  const handleSaveLeap = async (assetId, leap) => {
    try {
      await addLeap(assetId, leap);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,leaps:[...a.leaps,leap]}:a));
    } catch(e){ console.error(e); }
  };

  const handleSaveTrade = async (assetId, trade) => {
    try {
      const saved = await addTrade(assetId, trade);
      if(trade.action==="BUY"){
        const asset = assets.find(a=>a.id===assetId);
        const toClose = (asset?.trades||[]).filter(t=>t.status==="open"&&t.action==="SELL"&&parseFloat(t.strike)===parseFloat(trade.strike));
        if(toClose.length) await Promise.all(toClose.map(t=>updateTrade(t.id,{status:"closed"})));
        setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:[...a.trades.map(t=>toClose.some(c=>c.id===t.id)?{...t,status:"closed"}:t),saved]}:a));
      } else {
        setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:[...a.trades,saved]}:a));
      }
      return saved;
    } catch(e){ console.error(e); }
  };

  const handleUpdateTrade = async (assetId, tradeId, changes) => {
    try {
      await updateTrade(tradeId, changes);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:a.trades.map(t=>t.id===tradeId?{...t,...changes}:t)}:a));
    } catch(e){ console.error(e); }
  };

  const handleDeleteLeap = async (assetId, leapId) => {
    try {
      await deleteLeap(leapId);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,leaps:a.leaps.filter(l=>l.id!==leapId)}:a));
    } catch(e){ console.error(e); }
  };

  const handleDeleteTrade = async (assetId, tradeId) => {
    try {
      await deleteTrade(tradeId);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:a.trades.filter(t=>t.id!==tradeId)}:a));
    } catch(e){ console.error(e); }
  };

  if(loading) return (
    <div style={{minHeight:"100vh",background:"#080c10",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{CSS}</style>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"Syne,sans-serif",fontSize:28,fontWeight:800,color:"#fff",marginBottom:12}}>Option<span style={{color:"#00d4aa"}}>Desk</span></div>
        <div style={{fontSize:12,color:"#3a5a7a",letterSpacing:1}}>Loading your portfolio...</div>
      </div>
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:"#080c10",color:"#c8d8e8"}}>
      <style>{CSS}</style>
      <div className="hdr">
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div className="logo" onClick={()=>setActive("home")}>Option<span>Desk</span></div>
          <div className="badge">Beta</div>
          {active!=="home"&&<button className="home-btn" onClick={()=>setActive("home")}>← Home</button>}
        </div>
        <div style={{fontSize:11,color:"#3a5a7a"}}>{new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</div>
      </div>

      <div className="tabs">
        <button className={`tab ${active==="home"?"active":""}`} onClick={()=>setActive("home")} style={{"--tc":"#00d4aa"}}>⌂ Home</button>
        {assets.filter(a=>a.active).map(a=>(
          <button key={a.id} className={`tab ${active===a.id?"active":""}`} onClick={()=>setActive(a.id)} style={{"--tc":a.color}}>{a.ticker}</button>
        ))}
        <button className="add-tab" onClick={()=>setShowAdd(true)} title="Add position">+</button>
        {closedAssets.length>0&&(
          <button className={`tab ${active==="closed"?"active":""}`} onClick={()=>setActive("closed")} style={{"--tc":"#5a7a9a",marginLeft:"auto"}}>Closed ({closedAssets.length})</button>
        )}
      </div>

      {active==="home"&&<Home assets={assets} onSelectAsset={id=>setActive(id)} onShowPositions={()=>setShowPositions(true)}/>}
      {assets.filter(a=>a.active).map(a=>active===a.id&&(
        <AssetDashboard key={a.id} asset={a} onClose={closeAsset}
          onSaveTrade={(t)=>handleSaveTrade(a.id,t)}
          onUpdateTrade={(id,c)=>handleUpdateTrade(a.id,id,c)}
          onDeleteTrade={(id)=>handleDeleteTrade(a.id,id)}
          onDeleteLeap={(id)=>handleDeleteLeap(a.id,id)}
          onDeleteAsset={handleDeleteAsset}
        />
      ))}
      {active==="closed"&&<ClosedStrategies closedAssets={closedAssets}/>}
      {showAdd&&<AddAssetModal onAdd={addAsset} onClose={()=>setShowAdd(false)} usedColors={assets.map(a=>a.color)}/>}
      {showPositions&&<AllPositionsModal assets={assets} onClose={()=>setShowPositions(false)}/>}
      <ClaudeChat assets={assets} onSaveTrade={handleSaveTrade} onUpdateTrade={handleUpdateTrade} onSaveLeap={handleSaveLeap} onAddAsset={addAssetSilent}/>
    </div>
  );
}

// ── Claude Chat ───────────────────────────────────────────────────────────────
function ClaudeChat({ assets, onSaveTrade, onUpdateTrade, onSaveLeap, onAddAsset }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{role:"assistant",content:"Hey! Send me a trade confirmation or describe your trade and I'll register it automatically. You can also upload a photo of your Robinhood confirmation! 📸"}]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingTrades, setPendingTrades] = useState([]);
  const [missingField, setMissingField] = useState(null);
  const [missingInput, setMissingInput] = useState("");
  const fileRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(()=>{ if(open&&bottomRef.current) bottomRef.current.scrollIntoView({behavior:"smooth"}); },[messages,open]);

  const sendMessage = async (text, imageData, mediaType="image/jpeg") => {
    if(!text&&!imageData)return;
    const userMsg = {role:"user", content: imageData
      ? [{type:"image",source:{type:"base64",media_type:mediaType,data:imageData}},{type:"text",text:text||"What trades are in this confirmation?"}]
      : text
    };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);

    try {
      // Only send last image in context — don't accumulate images
      const apiMessages = newMsgs
        .filter(m=>!(m.role==="assistant"&&m===messages[0]))
        .map((m,i,arr)=>({
          role:m.role,
          content: Array.isArray(m.content)
            ? (i===arr.length-1 ? m.content : [{type:"text",text:"[image sent]"}])
            : m.content
        }));

      const res = await fetch("/api/claude", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({messages:apiMessages})
      });
      const data = await res.json();
      if(data.error){
        setMessages(p=>[...p,{role:"assistant",content:"API Error: "+data.error}]);
        setLoading(false);
        return;
      }
      const text = data.content?.[0]?.text||"No response";

      try {
        const clean = text.replace(/```json|```/g,"").trim();
        const parsed = JSON.parse(clean);
        if(parsed.trades&&parsed.trades.length>0){
          // Check for missing required fields
          const missing = parsed.trades.find(t=>!t.expiration||t.expiration==="unknown"||t.expiration==="");
          if(missing){
            setPendingTrades(parsed.trades);
            setMissingField("expiration");
            setMessages(p=>[...p,{role:"assistant",content:`${parsed.message}\n\n⚠️ I couldn't find the expiration date. What's the expiration for this trade?`}]);
          } else {
            setPendingTrades(parsed.trades);
            setMissingField(null);
            setMessages(p=>[...p,{role:"assistant",content:parsed.message+"\n\nConfirm to save these trades?"}]);
          }
        } else {
          setMessages(p=>[...p,{role:"assistant",content:parsed.message||text}]);
        }
      } catch {
        setMessages(p=>[...p,{role:"assistant",content:text}]);
      }
    } catch(e){
      setMessages(p=>[...p,{role:"assistant",content:"Error connecting. Please try again."}]);
    }
    setLoading(false);
  };

  const applyMissingField = () => {
    if(!missingInput.trim()) return;
    let value = missingInput.trim();
    // Normalize date format
    if(missingField==="expiration"){
      // Accept YYYY-MM-DD, MM/DD/YYYY, MM/DD/YY, MM-DD-YYYY
      if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)){
        const [m,d,y]=value.split("/");
        value=`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
      } else if(/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(value)){
        const [m,d,y]=value.split("/");
        value=`20${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
      } else if(/^\d{1,2}-\d{1,2}-\d{4}$/.test(value)){
        const [m,d,y]=value.split("-");
        value=`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
      }
    }
    const updated = pendingTrades.map(t=>({...t,[missingField]:value}));
    setPendingTrades(updated);
    setMissingField(null);
    setMissingInput("");
    setMessages(p=>[...p,{role:"assistant",content:`Got it! Expiration set to ${value}. Confirm to save?`}]);
  };

  const confirmTrades = async () => {
    let saved = 0;
    let notFound = [];
    let closed = 0;
    const createdAssets = {}; // track assets created during this loop

    for(const t of pendingTrades){
      const assetId = (t.asset_id||"").toUpperCase();
      let asset = assets.find(a=>a.id===assetId) || createdAssets[assetId];

      if(!asset){
        // Auto-create the asset
        const newAsset = {
          id: assetId,
          ticker: assetId,
          strategy: "PMCC",
          color: "#00d4aa",
          leapStrike: null,
          leapExpiration: null,
          leapDelta: null,
          initialPrice: 0,
          active: true,
          leaps: [],
          trades: []
        };
        await onAddAsset(newAsset);
        createdAssets[assetId] = {...newAsset};
        asset = createdAssets[assetId];
      }

      // Normalize premium — Robinhood shows per-share price AND total in parentheses
      // The Claude API sometimes returns the total instead of per-share
      // Anything over 50 is definitely a total cost, not per-share premium
      const rawPremium = parseFloat(t.premium||0);
      const normalizedPremium = rawPremium > 50 ? rawPremium/100 : rawPremium;

      // Validate trade date only — if year is in the past, fix to current year
      const tradeDate = t.date||new Date().toISOString().slice(0,10);
      const tradeYear = parseInt(tradeDate.slice(0,4));
      const currentYear = new Date().getFullYear();
      const fixedDate = tradeYear < currentYear
        ? tradeDate.replace(String(tradeYear), String(currentYear))
        : tradeDate;

      // Expiration — only fix if clearly wrong (past year for short-term options)
      // Don't fix if expiration is more than 1 year out (could be a LEAP)
      const expYear = parseInt((t.expiration||"").slice(0,4));
      const expDate = new Date(t.expiration);
      const fixedExp = (t.expiration && expYear < currentYear && expDate < new Date())
        ? t.expiration.replace(String(expYear), String(currentYear))
        : t.expiration;

      // Check if this is a LEAP — BTO with expiration > 180 days
      const isLeap = t.action==="BUY" && t.status==="open" &&
        fixedExp && (new Date(fixedExp) - new Date()) > 180*24*60*60*1000;

      if(isLeap){
        // Save as LEAP instead of trade
        await onSaveLeap(assetId, {
          id: `${assetId}_${Date.now()}`,
          date: fixedDate,
          strike: parseFloat(t.strike),
          expiration: fixedExp,
          cost: normalizedPremium,
          contracts: parseInt(t.contracts||1),
        });
        saved++;
        continue;
      }

      // If BUY (and not a LEAP) — close matching open SELL with same strike
      if(t.action==="BUY"){
        try {
          const openTrades = await fetchOpenTrades(assetId);
          const openSell = openTrades.find(tr=>
            tr.action==="SELL" &&
            tr.status==="open" &&
            Math.abs(parseFloat(tr.strike)-parseFloat(t.strike))<0.01
          );
          if(openSell){
            const sellContracts = parseInt(openSell.contracts||1);
            const buyContracts = parseInt(t.contracts||1);
            if(buyContracts>=sellContracts){
              await onUpdateTrade(assetId, openSell.id, {status:"closed"});
            } else {
              await onUpdateTrade(assetId, openSell.id, {contracts: sellContracts-buyContracts});
            }
            closed++;
          }
        } catch(e){ console.error("Error matching open sell:", e); }
      }

      // Save the new trade — use status from Claude response, not assumed
      await onSaveTrade(assetId, {
        date:fixedDate, action:t.action, strike:t.strike,
        expiration:fixedExp, premium:normalizedPremium,
        contracts:t.contracts||1, status: t.status||"open"
      });
      saved++;
    }

    setPendingTrades([]);
    let msg = `✅ ${saved} trade${saved>1?"s":""} saved!`;
    if(closed>0) msg += ` ${closed} open position${closed>1?"s":""} closed.`;
    const newAssetNames = Object.keys(createdAssets);
    if(newAssetNames.length>0) msg += ` Created: ${newAssetNames.join(", ")}.`;
    if(notFound.length>0) msg += ` ⚠️ Asset not found: ${notFound.join(", ")}`;
    setMessages(p=>[...p,{role:"assistant",content:msg}]);
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if(!file)return;

    // PDF not supported
    if(file.type==="application/pdf"){
      setMessages(p=>[...p,{role:"assistant",content:"PDFs não são suportados ainda. Por favor envie uma foto (PNG ou JPEG) da confirmação! 📸"}]);
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      // Resize image before sending to avoid token limits
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxSize = 1000;
        let w = img.width, h = img.height;
        if(w>maxSize||h>maxSize){
          if(w>h){ h=Math.round(h*maxSize/w); w=maxSize; }
          else { w=Math.round(w*maxSize/h); h=maxSize; }
        }
        canvas.width=w; canvas.height=h;
        canvas.getContext("2d").drawImage(img,0,0,w,h);
        const base64 = canvas.toDataURL("image/jpeg",0.85).split(",")[1];
        sendMessage("", base64, "image/jpeg");
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  // Reset file input after each use
  const handleFileClick = () => {
    if(fileRef.current) fileRef.current.value = "";
    fileRef.current?.click();
  };

  return (
    <>
      {/* Floating button */}
      <button onClick={()=>setOpen(p=>!p)} style={{
        position:"fixed",bottom:24,right:24,width:52,height:52,
        borderRadius:"50%",background:"linear-gradient(135deg,#00d4aa,#3a8fff)",
        border:"none",cursor:"pointer",zIndex:300,
        boxShadow:"0 4px 20px rgba(0,212,170,0.4)",
        display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:22,transition:"transform 0.2s",
      }}
        onMouseEnter={e=>e.target.style.transform="scale(1.1)"}
        onMouseLeave={e=>e.target.style.transform="scale(1)"}
      >{open?"✕":"🤖"}</button>

      {/* Chat window */}
      {open&&(
        <div style={{
          position:"fixed",bottom:88,right:24,width:340,height:480,
          background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:12,
          boxShadow:"0 20px 60px rgba(0,0,0,0.6)",zIndex:300,
          display:"flex",flexDirection:"column",overflow:"hidden",
        }}>
          {/* Header */}
          <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2a3a",display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:"#00d4aa",animation:"pulse 1.8s infinite"}}/>
            <div style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:14,color:"#fff"}}>Claude</div>
            <div style={{fontSize:11,color:"#3a5a7a"}}>trade assistant</div>
          </div>

          {/* Messages */}
          <div style={{flex:1,overflowY:"auto",padding:12,display:"flex",flexDirection:"column",gap:8}}>
            {messages.map((m,i)=>(
              <div key={i} style={{
                display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",
              }}>
                <div style={{
                  maxWidth:"85%",padding:"8px 12px",borderRadius:10,fontSize:12,lineHeight:1.5,
                  background:m.role==="user"?"#00d4aa20":"#1a2a3a",
                  color:m.role==="user"?"#00d4aa":"#c8d8e8",
                  border:`1px solid ${m.role==="user"?"#00d4aa44":"#2a3a4a"}`,
                  whiteSpace:"pre-wrap",
                }}>{typeof m.content==="string"?m.content:"📸 Image sent"}</div>
              </div>
            ))}
            {loading&&(
              <div style={{display:"flex",justifyContent:"flex-start"}}>
                <div style={{padding:"8px 12px",borderRadius:10,background:"#1a2a3a",border:"1px solid #2a3a4a",fontSize:12,color:"#5a7a9a"}}>
                  thinking...
                </div>
              </div>
            )}
            {pendingTrades.length>0&&!missingField&&(
              <div style={{background:"#080c10",border:"1px solid #00d4aa33",borderRadius:8,padding:10}}>
                <div style={{fontSize:10,letterSpacing:2,color:"#5a7a9a",textTransform:"uppercase",marginBottom:8}}>Review & edit before saving</div>
                {pendingTrades.map((t,i)=>(
                  <div key={i} style={{background:"#0a1520",border:"1px solid #1a2a3a",borderRadius:6,padding:8,marginBottom:8}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
                      <div>
                        <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>ASSET</div>
                        <input style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#fff",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.asset_id||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],asset_id:e.target.value.toUpperCase()};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>ACTION</div>
                        <select style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:t.action==="SELL"?"#00d4aa":"#ff4d6a",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none"}}
                          value={t.action||"SELL"} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],action:e.target.value};setPendingTrades(v);}}>
                          <option value="SELL">SELL</option>
                          <option value="BUY">BUY</option>
                        </select>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>STRIKE</div>
                        <input type="number" style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#f5c842",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.strike||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],strike:e.target.value};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>EXPIRATION</div>
                        <input style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#c8d8e8",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          placeholder="YYYY-MM-DD" value={t.expiration||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],expiration:e.target.value};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>PRICE/SHARE ($)</div>
                        <input type="number" style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#00d4aa",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.premium||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],premium:e.target.value};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>CONTRACTS</div>
                        <input type="number" style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#8aaac8",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.contracts||1} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],contracts:e.target.value};setPendingTrades(v);}}/>
                      </div>
                    </div>
                    <div style={{fontSize:10,color:"#5a7a9a",textAlign:"right"}}>
                      Total: <span style={{color:"#fff",fontWeight:600}}>${((parseFloat(t.premium)||0)*(parseInt(t.contracts)||1)*100).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  <button className="btn bsm" onClick={confirmTrades} style={{flex:1}}>✅ Confirm</button>
                  <button className="btn bsm bdanger" onClick={()=>{setPendingTrades([]);setMissingField(null);}} style={{flex:1}}>✕ Cancel</button>
                </div>
              </div>
            )}
            {pendingTrades.length>0&&missingField&&(
              <div style={{background:"#f5c84210",border:"1px solid #f5c84233",borderRadius:8,padding:10}}>
                <div style={{fontSize:11,color:"#f5c842",marginBottom:8}}>⚠️ Missing: {missingField}</div>
                <input
                  style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#c8d8e8",fontFamily:"DM Mono,monospace",fontSize:12,padding:"6px 10px",borderRadius:6,outline:"none",marginBottom:8}}
                  placeholder={missingField==="expiration"?"YYYY-MM-DD (e.g. 2027-01-15)":"Enter value..."}
                  value={missingInput}
                  onChange={e=>setMissingInput(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&applyMissingField()}
                />
                <div style={{display:"flex",gap:8}}>
                  <button className="btn bsm bwarn" onClick={applyMissingField} style={{flex:1}}>Apply & Confirm</button>
                  <button className="btn bsm bdanger" onClick={()=>{setPendingTrades([]);setMissingField(null);setMissingInput("");}} style={{flex:1}}>✕ Cancel</button>
                </div>
              </div>
            )}
            <div ref={bottomRef}/>
          </div>

          {/* Input */}
          <div style={{padding:"10px 12px",borderTop:"1px solid #1a2a3a",display:"flex",gap:8,alignItems:"center"}}>
            <button className="btn bsm bneutral" onClick={handleFileClick} title="Upload photo">📸</button>
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleFile}/>
            <input
              style={{flex:1,background:"#080c10",border:"1px solid #1a2a3a",color:"#c8d8e8",fontFamily:"DM Mono,monospace",fontSize:12,padding:"6px 10px",borderRadius:6,outline:"none"}}
              placeholder="Describe a trade..."
              value={input} onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&!loading&&sendMessage(input)}
            />
            <button className="btn bsm" onClick={()=>sendMessage(input)} disabled={loading||!input}>→</button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;

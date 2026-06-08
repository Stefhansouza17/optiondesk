import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchAssets, addAsset as dbAddAsset, addLeap, addTrade, updateTrade, deleteTrade, updateLeap, deleteLeap, fetchOpenTrades, closeAsset as dbCloseAsset } from "./supabase";

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
async function fetchSymbolSearch(query) {
  const res = await fetch(`/api/tradier?endpoint=markets/search&q=${encodeURIComponent(query)}&indexes=false`);
  const data = await res.json();
  const raw = data?.securities?.security;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).slice(0, 8);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n, d=2) => Number(n||0).toFixed(d);
const COLORS = ["#00d4aa","#f5c842","#3a8fff","#ff6b9d","#a78bfa","#fb923c"];

// ── Black-Scholes ─────────────────────────────────────────────────────────────
function normCDF(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign=x<0?-1:1;
  const t=1/(1+p*Math.abs(x)/Math.sqrt(2));
  const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-(x*x)/2);
  return 0.5*(1+sign*y);
}
function bsPrice(S,K,T,r,sigma,type){
  if(T<=0) return type==="call"?Math.max(S-K,0):Math.max(K-S,0);
  const d1=(Math.log(S/K)+(r+sigma*sigma/2)*T)/(sigma*Math.sqrt(T));
  const d2=d1-sigma*Math.sqrt(T);
  if(type==="call") return S*normCDF(d1)-K*Math.exp(-r*T)*normCDF(d2);
  return K*Math.exp(-r*T)*normCDF(-d2)-S*normCDF(-d1);
}

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
const SIM_STRATEGIES = ["Long Call","Long Put","Covered Call","Cash Secured Put","PMCC","Bull Call Spread","Bear Put Spread","Bull Put Spread","Bear Call Spread","Iron Condor","Straddle","Strangle"];

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
/* ── Simulator ── */
.sim-wrap{display:flex;border:1px solid #1a2a3a;border-radius:8px;overflow:hidden;margin-top:0}
.sim-left{width:262px;flex-shrink:0;border-right:1px solid #1a2a3a;background:#0a1520;overflow-y:auto;padding:13px 11px;display:flex;flex-direction:column;gap:11px}
.sim-right{flex:1;overflow:hidden;display:flex;flex-direction:column;min-width:0}
.sim-slbl{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#3a5a7a;margin-bottom:5px}
.sim-strike-box{background:#080c10;border:1px solid #1a2a3a;border-radius:7px;padding:10px 11px}
.sim-strike-big{font-family:'Syne',sans-serif;font-size:23px;font-weight:800;color:#f5c842;flex:1}
.sim-strike-input{background:#0d1821;border:1px solid #f5c84244;color:#f5c842;font-family:'DM Mono',monospace;font-size:12px;padding:4px 8px;border-radius:4px;width:76px;text-align:center}
.sim-strike-input:focus{outline:none;border-color:#f5c842aa}
.sim-chip{background:none;border:1px solid #1a2a3a;color:#5a7a9a;padding:3px 7px;border-radius:13px;cursor:pointer;font-family:'DM Mono',monospace;font-size:10px;white-space:nowrap;flex-shrink:0;transition:all .12s}
.sim-chip:hover{border-color:#3a5a7a;color:#c8d8e8}
.sim-chip.sel{background:#f5c842;border-color:#f5c842;color:#080c10;font-weight:700}
.sim-chip.atm{border-color:#00d4aa55;color:#00d4aa}
.sim-metric{background:#080c10;border:1px solid #1a2a3a;border-radius:6px;padding:8px 10px;position:relative;overflow:hidden}
.sim-metric::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--mt);border-radius:6px 6px 0 0}
.sim-metric-lbl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#3a5a7a;margin-bottom:3px}
.sim-metric-val{font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:var(--mc)}
.sim-timeline{border-bottom:1px solid #1a2a3a;background:#0a1520;padding:8px 13px 0;flex-shrink:0;overflow-x:auto}
.sim-exp-btn{background:none;border:1px solid #1a2a3a;color:#5a7a9a;padding:4px 9px;border-radius:15px;cursor:pointer;font-family:'DM Mono',monospace;font-size:10px;white-space:nowrap;flex-shrink:0;transition:all .12s}
.sim-exp-btn.sel{background:#00d4aa;border-color:#00d4aa;color:#080c10;font-weight:700}
.sim-dir-row{display:flex;gap:6px}
.sim-toolbar{display:flex;align-items:center;gap:10px;padding:7px 13px;border-bottom:1px solid #1a2a3a;background:#090f18;flex-shrink:0;flex-wrap:wrap}
.sim-view-group{display:flex;background:#0d1821;border:1px solid #1a2a3a;border-radius:7px;padding:2px;gap:2px}
.sim-view-btn{background:none;border:none;padding:4px 11px;border-radius:5px;cursor:pointer;font-family:'DM Mono',monospace;font-size:10px;font-weight:600;color:#5a7a9a;letter-spacing:.5px;transition:all .12s}
.sim-view-btn.sel{background:#1a2a3a;color:#c8d8e8}
.sim-matrix{flex:1;overflow:auto}
.sim-th{position:sticky;top:0;z-index:10;background:#0a1520;font-size:9px;letter-spacing:1px;color:#3a5a7a;padding:6px 9px;text-align:center;border-bottom:1px solid #1a2a3a;border-right:1px solid #0d1821;white-space:nowrap;font-weight:400;font-family:'DM Mono',monospace}
.sim-th.sp1{position:sticky;left:0;z-index:15;text-align:left;padding-left:13px;min-width:84px;background:#0a1520;border-right:1px solid #1a2a3a}
.sim-th.sp2{position:sticky;left:84px;z-index:15;min-width:46px;background:#0a1520;border-right:1px solid #1a2a3a}
.sim-th.sel-exp{color:#00d4aa}
.sim-td{padding:6px 9px;text-align:center;font-size:12px;font-weight:500;border-bottom:1px solid #0a1218;border-right:1px solid #0a1218;white-space:nowrap}
.sim-td-price{text-align:left;padding-left:13px;font-size:12px;background:#0a1520!important;position:sticky;left:0;z-index:5;border-right:1px solid #1a2a3a;border-bottom:1px solid #0a1218;white-space:nowrap}
.sim-td-pct{font-size:11px;background:#0a1520!important;position:sticky;left:84px;z-index:5;border-right:1px solid #1a2a3a;border-bottom:1px solid #0a1218;text-align:center;padding:6px 9px}
.sim-row-atm .sim-td-price{color:#fff!important;font-weight:700;background:linear-gradient(90deg,#00d4aa08,transparent)!important;box-shadow:inset 3px 0 0 #00d4aa}
.sim-row-atm .sim-td-pct{background:linear-gradient(90deg,#00d4aa05,transparent)!important}
.sim-row-atm{border-top:1px solid #00d4aa22!important;border-bottom:1px solid #00d4aa22!important}
.sim-row-be{border-top:1px dashed #f5c84244!important}
tr:hover .sim-td,.sim-row-atm:hover .sim-td-price,.sim-row-atm:hover .sim-td-pct{filter:brightness(1.15)}
@media(max-width:768px){
  html,body{overflow-x:hidden;max-width:100%}
  .hdr{padding:10px 12px;flex-wrap:wrap;gap:6px}
  .hdr>div:last-child{display:none}
  .tabs{padding:0 8px}
  .main{padding:14px 12px;box-sizing:border-box;max-width:100%;overflow-x:hidden}
  .pbar{margin:10px 8px 0;padding:8px 12px;box-sizing:border-box}
  .cards{grid-template-columns:1fr 1fr}
  .lgrid{grid-template-columns:1fr 1fr}
  .sec table{display:block;overflow-x:auto;width:100%;-webkit-overflow-scrolling:touch}
  .sim-wrap{flex-direction:column;overflow-x:hidden;max-width:100%}
  .sim-left{width:100%!important;flex-shrink:unset;border-right:none!important;border-bottom:1px solid #1a2a3a;box-sizing:border-box;max-width:100%}
  .sim-right{width:100%;max-width:100%;overflow-x:hidden;box-sizing:border-box}
  .sim-timeline{overflow-x:auto;max-width:100%}
  .sim-toolbar{flex-wrap:wrap;max-width:100%;overflow-x:hidden}
  .sim-matrix{overflow-x:auto;max-width:100%}
  .sim-dir-row{flex-wrap:wrap}
  .sim-dir-row .toggle-group{flex:1 1 calc(50% - 3px);min-width:0}
  .tgl{padding:7px 10px;font-size:10px}
  .toggle-group{min-width:0}
}
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
  const [sellStrike, setSellStrike] = useState(String(asset.leapStrike+5));
  const [sellPrem, setSellPrem] = useState("0.50");
  const [buyPrem, setBuyPrem] = useState("0");
  const [weeks, setWeeks] = useState("16");
  const color = asset.color;
  const net = (parseFloat(sellPrem)||0)-(parseFloat(buyPrem)||0);
  const basis = asset.leapCost-totalCollected;
  const spread = (parseFloat(sellStrike)||0)-asset.leapStrike;
  const projW = basis/Math.max(net,0.01);
  const wpct = net/basis;
  const proj = totalCollected+net*(parseFloat(weeks)||0);
  return (
    <div>
      <div className="sec" style={{marginBottom:16}}>
        <div className="sechdr"><div className="sectitle">Roll Calculator</div></div>
        <div style={{padding:"16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[["Short strike ($)",sellStrike,setSellStrike,0.5],["Premium received ($)",sellPrem,setSellPrem,0.01],["Premium paid to close ($)",buyPrem,setBuyPrem,0.01],["Weeks projected",weeks,setWeeks,1]].map(([l,v,s,st])=>(
            <div className="fgrp" key={l}><label className="flbl">{l}</label><input className="finput" type="number" step={st} value={v} onChange={e=>s(e.target.value)}/></div>
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
            {[["Strong drop",etfPrice*0.7,"Expires worthless ✓",(asset.leapCost-totalCollected)*-100],["Moderate drop",etfPrice*0.85,"Expires worthless ✓",(basis-(parseFloat(sellPrem)||0))*-50],["Sideways",etfPrice,"Near ATM",net*100],["Moderate rally",etfPrice*1.1,"ITM — roll",(spread+net)*100],["Strong rally",etfPrice*1.25,"Deep ITM",(spread+net)*100]].map(([l,p,o,pnl])=>(
              <tr key={l}><td style={{color:"#c8d8e8"}}>{l}</td><td style={{color:"#f5c842"}}>${fmt(p)}</td><td style={{color:"#8aaac8",fontSize:11}}>{o}</td><td style={{color:pnl>=0?color:"#ff4d6a"}}>{pnl>=0?"+":""}${fmt(pnl)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Unified Trade Modal ───────────────────────────────────────────────────────
function UnifiedTradeModal({ title="Add Trade", initial={}, asset=null, isEdit=false, onSave, onSaveLeap, onClose }) {
  const [form, setForm] = useState({
    date:new Date().toISOString().slice(0,10), action:"SELL", option_type:"call",
    strategy:"", strike:"", expiration:"", premium:"", contracts:1,
    fees:"", notes:"", status:"open", ...initial,
  });
  const upd = (k,v) => setForm(p=>({...p,[k]:v}));
  const leaps = asset?.leaps||[];
  const color = asset?.color||"#00d4aa";
  const TYPES = ["Long Call","Long Put","Short Call","Short Put"];
  const typeToForm = t=>t==="Long Call"?{action:"BUY",option_type:"call"}:t==="Long Put"?{action:"BUY",option_type:"put"}:t==="Short Call"?{action:"SELL",option_type:"call"}:{action:"SELL",option_type:"put"};
  const currentType = form.action==="BUY"&&form.option_type==="call"?"Long Call":form.action==="BUY"&&form.option_type==="put"?"Long Put":form.action==="SELL"&&form.option_type==="call"?"Short Call":"Short Put";
  const showLeapSelector = form.action==="SELL" && leaps.length>0;
  const isLeapEntry = !isEdit && form.action==="BUY" && form.expiration && form.date &&
    (new Date(form.expiration)-new Date(form.date))>180*24*60*60*1000;

  const totalVal = ((parseFloat(form.premium)||0)*(parseInt(form.contracts)||1)*100);

  async function handleSave(){
    if(!form.strike||!form.expiration||!form.premium) return;
    const d={...form,strike:parseFloat(form.strike),premium:parseFloat(form.premium),
      contracts:Math.max(1,parseInt(form.contracts)||1),fees:parseFloat(form.fees)||0,
      trade_group:form.action==="SELL"?(form.trade_group||null):null};
    if(isLeapEntry&&onSaveLeap){
      await onSaveLeap({id:`${asset?.id||"t"}_${Date.now()}`,date:d.date,strike:d.strike,expiration:d.expiration,cost:d.premium,contracts:d.contracts});
      onClose(); return;
    }
    await onSave(d);
    onClose();
  }

  const inp={background:"#080c10",border:"1px solid #1a2a3a",color:"#c8d8e8",fontFamily:"DM Mono,monospace",fontSize:12,padding:"7px 10px",borderRadius:5,outline:"none",width:"100%",boxSizing:"border-box"};
  const lbl={fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4,display:"block"};
  const g2={display:"grid",gridTemplateColumns:"1fr 1fr",gap:10};
  const col={display:"flex",flexDirection:"column"};

  return(
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:12,padding:"22px 24px",width:380,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontFamily:"Syne,sans-serif",fontSize:15,fontWeight:800,color:"#fff"}}>{title}</div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {isLeapEntry&&<span style={{fontSize:9,background:"#00d4aa15",border:"1px solid #00d4aa44",color:"#00d4aa",padding:"2px 7px",borderRadius:4}}>→ LEAP</span>}
            <button onClick={onClose} style={{background:"none",border:"none",color:"#3a5a7a",fontSize:16,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>

          <div style={g2}>
            <div style={col}><label style={lbl}>Date</label><input style={inp} type="date" value={form.date} onChange={e=>upd("date",e.target.value)}/></div>
            <div style={col}><label style={lbl}>Trade Type</label>
              <select style={inp} value={currentType} onChange={e=>{
                const {action,option_type}=typeToForm(e.target.value);
                setForm(p=>({...p,action,option_type,trade_group:action==="BUY"?null:p.trade_group}));
              }}>
                {TYPES.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div style={g2}>
            <div style={col}><label style={lbl}>Strike ($)</label><input style={inp} type="number" step="0.5" value={form.strike} onChange={e=>upd("strike",e.target.value)}/></div>
            <div style={col}><label style={lbl}>Premium / share ($)</label><input style={inp} type="number" step="0.01" value={form.premium} onChange={e=>upd("premium",e.target.value)}/></div>
          </div>

          <div style={g2}>
            <div style={col}><label style={lbl}>Expiration</label><input style={inp} type="date" value={form.expiration} onChange={e=>upd("expiration",e.target.value)}/></div>
            <div style={col}><label style={lbl}>Contracts</label>
              <div style={{display:"flex",alignItems:"center",gap:5,background:"#080c10",border:"1px solid #1a2a3a",borderRadius:5,padding:"4px 8px"}}>
                <button onClick={()=>upd("contracts",Math.max(1,(parseInt(form.contracts)||1)-1))} style={{background:"#1a2a3a",border:"none",color:"#c8d8e8",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>−</button>
                <input value={form.contracts} onChange={e=>upd("contracts",Math.max(1,parseInt(e.target.value)||1))} style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#fff",fontFamily:"DM Mono,monospace",fontSize:14,fontWeight:600,textAlign:"center"}}/>
                <button onClick={()=>upd("contracts",(parseInt(form.contracts)||1)+1)} style={{background:"#1a2a3a",border:"none",color:"#c8d8e8",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>+</button>
              </div>
            </div>
          </div>

          {showLeapSelector&&(
            <div style={col}>
              <label style={{...lbl,color:"#f5c842"}}>Associated LEAP <span style={{opacity:.4,fontWeight:400}}>optional</span></label>
              <select style={{...inp,borderColor:"#f5c84244",color:"#f5c842"}} value={form.trade_group||"none"} onChange={e=>upd("trade_group",e.target.value==="none"?null:e.target.value)}>
                <option value="none">— None —</option>
                {leaps.map(l=><option key={l.id} value={l.id}>${l.strike} · {l.expiration} · {l.contracts} contract{l.contracts!==1?"s":""}</option>)}
              </select>
            </div>
          )}

          <div style={g2}>
            <div style={col}><label style={lbl}>Fees ($) <span style={{opacity:.4}}>optional</span></label><input style={inp} type="number" step="0.01" placeholder="0.00" value={form.fees} onChange={e=>upd("fees",e.target.value)}/></div>
            <div style={col}><label style={lbl}>Status</label>
              <select style={inp} value={form.status} onChange={e=>upd("status",e.target.value)}>
                <option value="open">Open</option><option value="closed">Closed</option><option value="expired">Expired</option>
              </select>
            </div>
          </div>

          <div style={col}>
            <label style={lbl}>Notes <span style={{opacity:.4}}>optional</span></label>
            <textarea style={{...inp,resize:"vertical",minHeight:52,lineHeight:1.5}} placeholder="e.g. earnings play, hedge, rolling from Jul…" value={form.notes||""} onChange={e=>upd("notes",e.target.value)}/>
          </div>

          {form.premium&&form.contracts&&(
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"9px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:10,color:"#3a5a7a"}}>Total value</span>
              <span style={{fontFamily:"DM Mono,monospace",fontSize:15,fontWeight:700,color:form.action==="SELL"?"#00d4aa":"#ff4d6a"}}>
                {form.action==="SELL"?"+":"-"}${totalVal.toFixed(0)}
              </span>
            </div>
          )}
        </div>

        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button className="btn bneutral" style={{flex:1,padding:"10px 0"}} onClick={onClose}>Cancel</button>
          <button className="btn" style={{flex:2,padding:"10px 0",fontWeight:700,color,borderColor:color+"44",background:color+"15",opacity:(!form.strike||!form.expiration||!form.premium)?0.4:1}}
            disabled={!form.strike||!form.expiration||!form.premium}
            onClick={handleSave}>
            {isEdit?"Save Changes":isLeapEntry?"Save as LEAP →":"Add Trade →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Asset Dashboard ───────────────────────────────────────────────────────────
function AssetDashboard({ asset, onClose, onSaveTrade, onUpdateTrade, onDeleteTrade, onDeleteLeap, onUpdateLeap, onDeleteAsset, onSaveLeap }) {
  const trades = asset.trades;
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
  const [editLeapData, setEditLeapData] = useState(null);
  const [crForm, setCrForm] = useState({mode:"close",closePrem:"",newStrike:"",newExp:"",newPrem:"",contracts:1});
  const [crGroup, setCrGroup] = useState([]);
  const [closeForm, setCloseForm] = useState({mode:"close",closePrem:"",newStrike:"",newExp:"",newPrem:""});
  const color = asset.color;
  const strategy = asset.strategy || "PMCC";
  const isPremium = isPremiumStrategy(strategy);
  const ef = {date:new Date().toISOString().slice(0,10),action:"SELL",option_type:"call",strategy:strategy,strike:"",expiration:"",premium:"",contracts:1,fees:"",notes:"",status:"open"};
  const [form, setForm] = useState(ef);

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
    if(t.action==="SELL") return a+parseFloat(t.premium||0)*parseInt(t.contracts||1);
    if(t.action==="BUY"&&t.status!=="open") return a-parseFloat(t.premium||0)*parseInt(t.contracts||1);
    return a;
  },0);
  const totalDollar = totalCollected*100;
  const costBasis = leapAvg - totalDollar;
  const recovPct = Math.min(totalLeapCost>0?totalDollar/totalLeapCost:0,1);
  const openTrades = trades.filter(t=>t.status==="open").sort((a,b)=>new Date(a.expiration)-new Date(b.expiration));
  const closedTrades = trades.filter(t=>t.status==="closed").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const expiredTrades = trades.filter(t=>t.status==="expired").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const filteredTrades = (statusFilter==="open"?openTrades:statusFilter==="closed"?closedTrades:statusFilter==="expired"?expiredTrades:trades).sort((a,b)=>new Date(b.date)-new Date(a.date));

  function openAdd(){setEditId(null);setForm({...ef,strategy});setShowForm(true);}
  function openEdit(t){setEditId(t.id);setForm({...ef,...t,contracts:t.contracts||1,fees:t.fees||"",notes:t.notes||""});setShowForm(true);}
  async function saveTrade(tradeData){
    if(editId){
      await onUpdateTrade(editId,tradeData);
    } else {
      await onSaveTrade(tradeData);
    }
    setShowForm(false);
  }
  async function removeTrade(id){
    await onDeleteTrade(id);
  }
  function openCR(t){
    const group=openTrades.filter(o=>parseFloat(o.strike)===parseFloat(t.strike)&&o.expiration===t.expiration);
    const total=group.reduce((s,o)=>s+parseInt(o.contracts||1),0);
    setCrGroup(group);
    setShowCR(t);
    setCrForm({mode:"close",closePrem:"",newStrike:t.strike,newExp:"",newPrem:"",contracts:total});
  }
  async function confirmCR(){
    if(crForm.mode!=="expired"&&!crForm.closePrem)return;
    const today=new Date().toISOString().slice(0,10);
    const groupTotal=crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0);
    let rem=Math.max(1,Math.min(parseInt(crForm.contracts)||1,groupTotal));
    const closingTotal=rem;

    for(const trade of crGroup){
      if(rem<=0)break;
      const tc=parseInt(trade.contracts||1);
      const closing=Math.min(rem,tc);
      const keeping=tc-closing;
      rem-=closing;
      if(crForm.mode==="expired"){
        if(keeping>0){
          await onUpdateTrade(trade.id,{contracts:keeping});
          await onSaveTrade({date:trade.date||today,action:"SELL",strike:trade.strike,expiration:trade.expiration,premium:trade.premium,contracts:closing,status:"expired"});
        }else{
          await onUpdateTrade(trade.id,{status:"expired"});
        }
      }else{
        if(keeping>0){
          await onUpdateTrade(trade.id,{contracts:keeping});
          await onSaveTrade({date:trade.date||today,action:"SELL",strike:trade.strike,expiration:trade.expiration,premium:trade.premium,contracts:closing,status:"closed"});
        }else{
          await onUpdateTrade(trade.id,{status:"closed"});
        }
      }
    }
    if(crForm.mode!=="expired"){
      await onSaveTrade({date:today,action:"BUY",strike:showCR.strike,expiration:showCR.expiration,premium:parseFloat(crForm.closePrem),contracts:closingTotal,status:"closed"});
      if(crForm.mode==="roll"&&crForm.newExp&&crForm.newPrem){
        await onSaveTrade({date:today,action:"SELL",strike:parseFloat(crForm.newStrike||showCR.strike),expiration:crForm.newExp,premium:parseFloat(crForm.newPrem),contracts:closingTotal,status:"open"});
      }
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
                          <td><div style={{display:"flex",gap:5}}>
                            <button className="btn bsm bneutral" onClick={()=>setEditLeapData(l)}>Edit</button>
                            <button className="btn bsm bdanger" onClick={()=>{setCloseLeap(l);setCloseLeapPrem("");}}>Close</button>
                          </div></td>
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

            {!isPremium&&leaps.length>0&&(
              <div className="sec">
                <div className="sechdr">
                  <div className="sectitle">Long positions</div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {leapContracts>1&&<span style={{fontSize:11,color:"#f5c842"}}>{leapContracts} contracts</span>}
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
                        <td><div style={{display:"flex",gap:5}}>
                          <button className="btn bsm bneutral" onClick={()=>setEditLeapData(l)}>Edit</button>
                          <button className="btn bsm bdanger" onClick={()=>onDeleteLeap(l.id)}>✕</button>
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
              {(()=>{const tot=crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0);return(<><span style={{color:"#f5c842"}}>${showCR.strike}</span> · exp. {showCR.expiration} · <span style={{color:"#c8d8e8"}}>{tot} contract{tot>1?"s":""}</span>{crGroup.length>1&&<span style={{color:"#5a7a9a",marginLeft:4}}>({crGroup.length} orders)</span>}</>);})()}
            </div>
            <div className="toggle-group" style={{marginBottom:14}}>
              {[["close","Close only"],["roll","Roll"],["expired","Expired worthless"]].map(([m,l])=>(
                <button key={m} className="tgl" onClick={()=>setCrForm({...crForm,mode:m})} style={{flex:1,background:crForm.mode===m?color:"transparent",color:crForm.mode===m?"#080c10":"#5a7a9a"}}>{l}</button>
              ))}
            </div>
            {crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0)>1&&(
            <div className="fgrp" style={{marginBottom:12}}>
              {(()=>{const tot=crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0);return(<>
              <label className="flbl">
                Contracts to {crForm.mode==="roll"?"roll":crForm.mode==="expired"?"expire":"close"}
                <span style={{color:"#3a5a7a",marginLeft:6,fontSize:11}}>(max {tot}{crGroup.length>1?`, ${crGroup.length} orders`:""})</span>
              </label>
              <input className="finput" type="number" min="1" max={tot} step="1"
                placeholder={tot}
                value={crForm.contracts}
                onChange={e=>setCrForm({...crForm,contracts:Math.max(1,Math.min(parseInt(e.target.value)||1,tot))})}/>
              </>);})()}
            </div>
            )}
            {crForm.mode!=="expired"&&(
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Price paid to close ($)</label>
              <input className="finput" type="number" min="0" step="0.01" placeholder="0.05" value={crForm.closePrem} onChange={e=>setCrForm({...crForm,closePrem:e.target.value})} />
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
                  <div className="fgrp"><label className="flbl">Premium received ($)</label><input className="finput" type="number" min="0" step="0.01" placeholder="0.55" value={crForm.newPrem} onChange={e=>setCrForm({...crForm,newPrem:e.target.value})}/></div>
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

      {/* Edit LEAP Modal */}
      {editLeapData&&(
        <UnifiedTradeModal
          title="Edit LEAP"
          isEdit={true}
          asset={asset}
          initial={{
            date: editLeapData.date,
            action: "BUY",
            option_type: "call",
            strike: String(editLeapData.strike),
            expiration: editLeapData.expiration,
            premium: String(editLeapData.cost),
            contracts: editLeapData.contracts,
          }}
          onSave={async (d)=>{
            await onUpdateLeap(editLeapData.id, {
              date: d.date,
              strike: parseFloat(d.strike),
              expiration: d.expiration,
              cost: parseFloat(d.premium),
              contracts: parseInt(d.contracts||1),
            });
            setEditLeapData(null);
          }}
          onClose={()=>setEditLeapData(null)}
        />
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
        <UnifiedTradeModal
          title={editId?"Edit Trade":"Add Trade"}
          initial={form}
          asset={asset}
          isEdit={!!editId}
          onSave={saveTrade}
          onSaveLeap={onSaveLeap}
          onClose={()=>setShowForm(false)}
        />
      )}
    </div>
  );
}

// ── Payoff Chart ─────────────────────────────────────────────────────────────
function PayoffChart({ spot, strike, premium, breakeven, optType, side }) {
  if (!spot || !strike || premium <= 0) return null;
  const W = 600, H = 185;
  const PAD = { l: 44, r: 18, t: 28, b: 26 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const pMin = spot * 0.76, pMax = spot * 1.24;

  const pnlAt = p => {
    const intr = optType === "call" ? Math.max(p - strike, 0) : Math.max(strike - p, 0);
    const raw = (intr - premium) * 100;
    return side === "buy" ? raw : -raw;
  };

  const absMax = Math.max(Math.abs(pnlAt(pMax)), Math.abs(pnlAt(pMin)), premium * 100) * 1.3;
  const yMin = -absMax, yMax = absMax;
  const xOf = p => PAD.l + ((p - pMin) / (pMax - pMin)) * cW;
  const yOf = v => PAD.t + ((yMax - v) / (yMax - yMin)) * cH;
  const yZero = yOf(0);

  const N = 80;
  const pts = Array.from({ length: N + 1 }, (_, i) => pMin + (i / N) * (pMax - pMin));
  const curvePts = pts.map(p => `${xOf(p).toFixed(1)},${yOf(pnlAt(p)).toFixed(1)}`).join(" ");
  const polyPts = `${PAD.l},${yZero} ${curvePts} ${W - PAD.r},${yZero}`;

  const rawStep = (yMax - yMin) / 5;
  const step = Math.max(Math.pow(10, Math.floor(Math.log10(rawStep))), 5);
  const gridVals = [];
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 0.01; v += step) gridVals.push(Math.round(v));

  const xLabels = Array.from({ length: 7 }, (_, i) => pMin + (i / 6) * (pMax - pMin));
  const uid = strike + "-" + premium.toFixed(2);
  const beVisible = breakeven > pMin && breakeven < pMax;
  const isUnlimited = optType === "call" && side === "buy";
  const isUnlimitedLoss = optType === "call" && side === "sell";

  const clampLabel = (x, w) => Math.min(Math.max(x, PAD.l + w / 2), W - PAD.r - w / 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} preserveAspectRatio="none">
      <defs>
        <clipPath id={`above-${uid}`}><rect x={PAD.l} y={PAD.t} width={cW} height={Math.max(yZero - PAD.t, 0)} /></clipPath>
        <clipPath id={`below-${uid}`}><rect x={PAD.l} y={yZero} width={cW} height={Math.max(H - PAD.b - yZero, 0)} /></clipPath>
      </defs>

      {/* Zone backgrounds */}
      <rect x={PAD.l} y={PAD.t} width={cW} height={Math.max(yZero - PAD.t, 0)} fill="rgba(0,212,170,.06)" />
      <rect x={PAD.l} y={yZero} width={cW} height={Math.max(H - PAD.b - yZero, 0)} fill="rgba(226,75,74,.10)" />

      {/* Grid */}
      {gridVals.map(v => (
        <g key={v}>
          <line x1={PAD.l} y1={yOf(v)} x2={W - PAD.r} y2={yOf(v)} stroke={v === 0 ? "#2a4a6a" : "#151f2e"} strokeWidth={v === 0 ? 1 : 0.5} />
          <text x={PAD.l - 4} y={yOf(v) + 3.5} textAnchor="end" fontSize={8} fill="#3a5a7a" fontFamily="DM Mono,monospace">{v > 0 ? "+" : ""}{v}</text>
        </g>
      ))}

      {/* Filled areas */}
      <polygon points={polyPts} fill="rgba(0,212,170,.18)" clipPath={`url(#above-${uid})`} />
      <polygon points={polyPts} fill="rgba(226,75,74,.20)" clipPath={`url(#below-${uid})`} />

      {/* ATM vertical */}
      <line x1={xOf(spot)} y1={PAD.t} x2={xOf(spot)} y2={H - PAD.b} stroke="#3a8fff" strokeWidth={1} strokeDasharray="4,3" />

      {/* Breakeven vertical */}
      {beVisible && <>
        <line x1={xOf(breakeven)} y1={PAD.t} x2={xOf(breakeven)} y2={H - PAD.b} stroke="#00d4aa" strokeWidth={1} strokeDasharray="4,3" />
        <circle cx={xOf(breakeven)} cy={yZero} r={4} fill="#00d4aa" stroke="#080c10" strokeWidth={1.5} />
        <rect x={clampLabel(xOf(breakeven), 80) - 40} y={PAD.t} width={80} height={16} rx={3} fill="#00d4aa18" stroke="#00d4aa55" />
        <text x={clampLabel(xOf(breakeven), 80)} y={PAD.t + 11} textAnchor="middle" fontSize={8.5} fill="#00d4aa" fontFamily="DM Mono,monospace">BE ${breakeven.toFixed(2)}</text>
      </>}

      {/* Strike dot */}
      <circle cx={xOf(strike)} cy={yOf(pnlAt(strike))} r={4} fill="#3a8fff" stroke="#080c10" strokeWidth={1.5} />

      {/* ATM label */}
      <rect x={clampLabel(xOf(spot), 80) - 40} y={PAD.t} width={80} height={16} rx={3} fill="#3a8fff18" stroke="#3a8fff44" />
      <text x={clampLabel(xOf(spot), 80)} y={PAD.t + 11} textAnchor="middle" fontSize={8.5} fill="#3a8fff" fontFamily="DM Mono,monospace">ATM ${spot.toFixed(2)}</text>

      {/* Payoff line */}
      <polyline points={curvePts} fill="none" stroke="#00d4aa" strokeWidth={2} strokeLinejoin="round" />

      {/* Annotations */}
      {side === "buy" && <text x={PAD.l + 8} y={Math.min(yOf(-premium * 100) - 5, H - PAD.b - 4)} fontSize={8.5} fill="#ff6b6b99" fontFamily="DM Mono,monospace">Max loss: -${(premium * 100).toFixed(0)}</text>}
      {isUnlimited && <text x={W - PAD.r - 6} y={PAD.t + 18} textAnchor="end" fontSize={9} fill="#00d4aa66" fontFamily="DM Mono,monospace">Unlimited profit ↗</text>}
      {isUnlimitedLoss && <text x={W - PAD.r - 6} y={PAD.t + 18} textAnchor="end" fontSize={9} fill="#ff6b6b66" fontFamily="DM Mono,monospace">Unlimited risk ↗</text>}

      {/* X axis */}
      {xLabels.map((p, i) => (
        <text key={i} x={xOf(p)} y={H - PAD.b + 15} textAnchor="middle" fontSize={8} fill="#3a5a7a" fontFamily="DM Mono,monospace">${p.toFixed(0)}</text>
      ))}
      <text x={10} y={H / 2} textAnchor="middle" fontSize={8} fill="#3a5a7a" transform={`rotate(-90,10,${H / 2})`} fontFamily="DM Mono,monospace">P&L ($)</text>
    </svg>
  );
}

// ── Simulator Panel ───────────────────────────────────────────────────────────
function SimulatorPanel({ onSaveManualTrade }) {
  const [searchInput, setSearchInput] = useState("IBIT");
  const [sym, setSym]         = useState("");
  const [side, setSide]       = useState("buy");
  const [optType, setOptType] = useState("call");
  const [strategy, setStrategy] = useState("");
  const [exps, setExps]       = useState([]);
  const [selExp, setSelExp]   = useState("");
  const [chain, setChain]     = useState([]);
  const [quote, setQuote]     = useState(null);
  const [selStrike, setSelStrike] = useState(null);
  const [strikeInputVal, setStrikeInputVal] = useState("");
  const [viewMode, setViewMode] = useState("dollar");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [qaContracts, setQaContracts]   = useState(1);
  const [qaPremium,   setQaPremium]     = useState("");
  const [qaStrike,    setQaStrike]      = useState(null);
  const [qaExp,       setQaExp]         = useState("");
  const [tooltip, setTooltip] = useState(null);
  const [tipPos, setTipPos]   = useState({x:0,y:0});
  const [customPremium, setCustomPremium] = useState(null);
  const [premiumInput, setPremiumInput]   = useState("");

  const spot = quote?.last || 0;

  const filteredChain = useMemo(()=>
    chain.filter(o=>o.option_type===optType).sort((a,b)=>a.strike-b.strike),
    [chain, optType]
  );
  const availableStrikes = useMemo(()=>filteredChain.map(o=>o.strike),[filteredChain]);

  // Auto-select ATM when chain changes
  useEffect(()=>{
    if(!filteredChain.length||!spot) return;
    if(selStrike&&availableStrikes.includes(selStrike)) return;
    const atm=filteredChain.reduce((a,b)=>Math.abs(b.strike-spot)<Math.abs(a.strike-spot)?b:a);
    setSelStrike(atm.strike);
    setStrikeInputVal(atm.strike.toFixed(2));
  },[filteredChain, spot]);

  const selOption = useMemo(()=>filteredChain.find(o=>o.strike===selStrike),[filteredChain,selStrike]);

  const premium  = selOption?.ask||selOption?.last||0;
  const activePremium = customPremium !== null ? customPremium : premium;

  // Sync premium input when market price changes (new chain load)
  useEffect(()=>{ if(premium>0) setPremiumInput(premium.toFixed(2)); },[premium]);

  // Populate Add Trade modal fields when opened
  useEffect(()=>{
    if(showQuickAdd){ setQaContracts(1); setQaPremium(activePremium.toFixed(2)); setQaStrike(selStrike); setQaExp(selExp); }
  },[showQuickAdd]);
  const iv       = Math.max(selOption?.greeks?.smv_vol||0.3, 0.05);
  const delta    = selOption?.greeks?.delta||0;
  const theta    = selOption?.greeks?.theta||0;
  const gamma    = selOption?.greeks?.gamma||0;
  const vega     = selOption?.greeks?.vega||0;

  const breakeven = useMemo(()=>{
    if(!selStrike||!activePremium) return 0;
    if(optType==="call") return side==="buy"?selStrike+activePremium:selStrike-activePremium;
    return side==="buy"?selStrike-activePremium:selStrike+activePremium;
  },[selStrike,activePremium,optType,side]);

  const maxLoss   = side==="buy"?activePremium*100:(optType==="call"?Infinity:(selStrike-activePremium)*100);
  const maxProfit = side==="buy"?(optType==="call"?Infinity:(selStrike-activePremium)*100):activePremium*100;
  const probITM   = Math.abs(delta);
  const probTouch = Math.min(probITM*2,0.99);
  const chanceOfProfit = side==="buy"?probITM:(1-probITM);

  const loadSym = useCallback(async(s)=>{
    setLoading(true); setError(null); setChain([]); setQuote(null); setSelStrike(null); setCustomPremium(null);
    try{
      const e=await fetchExpirations(s);
      if(!e?.length){setError(`No options for "${s}"`);setLoading(false);return;}
      const defaultExp=e[Math.min(11,e.length-1)];
      setExps(e); setSelExp(defaultExp); setSym(s);
      const[q,ch]=await Promise.all([fetchQuote(s),fetchOptionChain(s,defaultExp)]);
      setQuote(q); setChain(ch);
    }catch{setError("Error fetching data.");}
    setLoading(false);
  },[]);

  const loadChain = useCallback(async(exp)=>{
    setSelExp(exp); setLoading(true); setCustomPremium(null);
    try{const ch=await fetchOptionChain(sym,exp);setChain(ch);}catch{}
    setLoading(false);
  },[sym]);

  // Auto-load default symbol on mount
  useEffect(()=>{ loadSym("IBIT"); },[]);

  // Group expirations by month for timeline
  const groupedExps = useMemo(()=>{
    const g={};
    exps.forEach(exp=>{
      const d=new Date(exp+"T12:00:00");
      const key=d.toLocaleString("en-US",{month:"short",year:"numeric"});
      if(!g[key])g[key]=[];
      g[key].push(exp);
    });
    return g;
  },[exps]);

  // Columns: smart selection — weeklies if ≤180d, monthly opex + selExp if >180d
  const colExps = useMemo(()=>{
    if(!exps.length||!selExp) return [];
    const upToSel = exps.filter(e=>e<=selExp);
    const dteSelExp = Math.ceil((new Date(selExp+"T12:00:00")-new Date())/(1000*60*60*24));
    if(dteSelExp<=180){
      return upToSel.slice(0,12);
    }
    // Far-term: keep last expiration of each month (monthly opex), then append selExp
    const byMonth={};
    upToSel.forEach(exp=>{
      const d=new Date(exp+"T12:00:00");
      const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      byMonth[key]=exp; // overwrite keeps last of month
    });
    const monthly=Object.values(byMonth).filter(e=>e!==selExp);
    return [...monthly.slice(0,11), selExp];
  },[exps,selExp]);

  // P&L matrix using Black-Scholes
  const matrixRows = useMemo(()=>{
    if(!availableStrikes.length||!selExp||!selStrike||activePremium<=0) return [];
    const K=selStrike, sigma=iv, r=0.05;
    const expDate=new Date(selExp+"T16:00:00");
    const priceRows=availableStrikes
      .filter(s=>spot>0?(s>=spot*0.78&&s<=spot*1.22):true)
      .slice().reverse();
    return priceRows.map(rowPrice=>{
      const pct=spot>0?((rowPrice-spot)/spot*100).toFixed(1):"0.0";
      const cols=colExps.map(exp=>{
        const colDate=new Date(exp+"T16:00:00");
        const T=Math.max((expDate-colDate)/(365*24*3600*1000),0);
        const optVal=bsPrice(rowPrice,K,T,r,sigma,optType);
        const raw=side==="buy"?(optVal-activePremium)*100:(activePremium-optVal)*100;
        return Math.round(raw);
      });
      return{price:rowPrice,pct:parseFloat(pct),cols};
    });
  },[availableStrikes,colExps,selExp,selStrike,activePremium,iv,optType,side,spot]);

  const atmRowIdx = useMemo(()=>{
    if(!matrixRows.length||!spot) return -1;
    let best=0,bestD=Infinity;
    matrixRows.forEach((r,i)=>{const d=Math.abs(r.price-spot);if(d<bestD){bestD=d;best=i;}});
    return best;
  },[matrixRows,spot]);

  const beRowIdx = useMemo(()=>{
    if(!matrixRows.length||!breakeven) return -1;
    let best=0,bestD=Infinity;
    matrixRows.forEach((r,i)=>{const d=Math.abs(r.price-breakeven);if(d<bestD){bestD=d;best=i;}});
    return best;
  },[matrixRows,breakeven]);

  const selExpColIdx = useMemo(()=>colExps.findIndex(e=>e===selExp),[colExps,selExp]);

  // Snap typed strike to nearest valid
  const snapStrike = (val)=>{
    const n=parseFloat(val);
    if(isNaN(n)||!availableStrikes.length) return;
    const closest=availableStrikes.reduce((a,b)=>Math.abs(b-n)<Math.abs(a-n)?b:a);
    setSelStrike(closest);
    setStrikeInputVal(closest.toFixed(2));
  };

  const pnlBg = (v)=>{
    if(v>150) return"rgba(0,212,170,.40)";
    if(v>80)  return"rgba(0,212,170,.26)";
    if(v>20)  return"rgba(0,212,170,.16)";
    if(v>0)   return"rgba(0,212,170,.08)";
    if(v>=-5) return"transparent";
    if(v>-80) return"rgba(226,75,74,.10)";
    if(v>-150)return"rgba(226,75,74,.20)";
    if(v>-200)return"rgba(226,75,74,.32)";
    return"rgba(226,75,74,.46)";
  };
  const pnlColor=(v)=>v>0?"#00d4aa":v<-5?"#ff6b6b":"#2a3a4a";

  const fmtCell=(v,cost)=>{
    const c=cost||activePremium*100||1;
    if(viewMode==="dollar") return(v>0?"+":"")+v;
    if(viewMode==="pct")    return(v>0?"+":"")+(v/c*100).toFixed(0)+"%";
    return(1+v/c).toFixed(2)+"x";
  };

  const distFromATM = selStrike&&spot?(selStrike-spot).toFixed(2):"0.00";
  const dte = selExp?Math.max(Math.ceil((new Date(selExp)-new Date())/(1000*60*60*24)),0):0;

  return(
    <div className="sim-wrap">
      {/* ── LEFT PANEL ── */}
      <div className="sim-left">

        {/* Symbol search */}
        <div>
          <div className="sim-slbl">Symbol</div>
          <div style={{display:"flex",gap:6}}>
            <input className="finput" style={{textTransform:"uppercase",letterSpacing:1,fontSize:14,fontWeight:500,color:"#00d4aa"}}
              value={searchInput} onChange={e=>setSearchInput(e.target.value.toUpperCase())}
              onKeyDown={e=>e.key==="Enter"&&loadSym(searchInput)}
              placeholder="AAPL, TSLA..."/>
            <button className="btn bsm" onClick={()=>loadSym(searchInput)} disabled={loading} style={{flexShrink:0}}>{loading?"…":"↻"}</button>
          </div>
          {error&&<div style={{fontSize:10,color:"#ff4d6a",marginTop:4}}>{error}</div>}
        </div>


        {/* Buy/Sell + Call/Put */}
        <div>
          <div className="sim-slbl">Direction & Type</div>
          <div className="sim-dir-row">
            <div className="toggle-group" style={{flex:1}}>
              <button className="tgl" onClick={()=>setSide("buy")} style={{background:side==="buy"?"#00d4aa":"transparent",color:side==="buy"?"#080c10":"#5a7a9a",flex:1}}>Buy</button>
              <button className="tgl" onClick={()=>setSide("sell")} style={{background:side==="sell"?"#ff4d6a":"transparent",color:side==="sell"?"#fff":"#5a7a9a",flex:1}}>Sell</button>
            </div>
            <div className="toggle-group" style={{flex:1}}>
              <button className="tgl" onClick={()=>setOptType("call")} style={{background:optType==="call"?"#3a8fff":"transparent",color:optType==="call"?"#fff":"#5a7a9a",flex:1}}>Call</button>
              <button className="tgl" onClick={()=>setOptType("put")} style={{background:optType==="put"?"#a78bfa":"transparent",color:optType==="put"?"#fff":"#5a7a9a",flex:1}}>Put</button>
            </div>
          </div>
        </div>

        {/* Strike selector */}
        {availableStrikes.length>0&&(
          <div>
            <div className="sim-slbl">Strike</div>
            <div className="sim-strike-box">
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                <div className="sim-strike-big">${selStrike?.toFixed(2)||"—"}</div>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <div style={{fontSize:8,color:"#3a5a7a",letterSpacing:1,textTransform:"uppercase"}}>Type</div>
                  <input className="sim-strike-input" value={strikeInputVal}
                    onChange={e=>setStrikeInputVal(e.target.value)}
                    onBlur={e=>snapStrike(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&snapStrike(e.target.value)}/>
                </div>
              </div>
              <div style={{fontSize:8,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:5}}>Available strikes</div>
              <div style={{overflowX:"auto",paddingBottom:3}}>
                <div style={{display:"flex",gap:3,minWidth:"max-content"}}>
                  {availableStrikes.map(s=>{
                    const isAtm=spot>0&&s===availableStrikes.reduce((a,b)=>Math.abs(b-spot)<Math.abs(a-spot)?b:a);
                    const isSel=s===selStrike;
                    return(
                      <button key={s} className={`sim-chip${isSel?" sel":""}${isAtm&&!isSel?" atm":""}`}
                        onClick={()=>{setSelStrike(s);setStrikeInputVal(s.toFixed(2));}}>
                        {s.toFixed(2)}{isAtm&&!isSel?" ◀":""}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{display:"flex",gap:12,marginTop:8,paddingTop:7,borderTop:"1px solid #1a2a3a",fontSize:10}}>
                <span style={{color:"#3a5a7a"}}>ATM <span style={{color:"#c8d8e8"}}>${spot.toFixed(2)}</span></span>
                <span style={{color:"#3a5a7a"}}>Strike <span style={{color:"#f5c842"}}>${(selStrike||0).toFixed(2)}</span></span>
                <span style={{color:"#3a5a7a"}}>Dist <span style={{color:parseFloat(distFromATM)>=0?"#00d4aa":"#ff4d6a"}}>{parseFloat(distFromATM)>=0?"+":""}{distFromATM}</span></span>
              </div>
            </div>
          </div>
        )}

        {/* Premium editor */}
        {premium>0&&(
          <div>
            <div className="sim-slbl" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              Price Paid
              {customPremium!==null&&(
                <button onClick={()=>{setCustomPremium(null);setPremiumInput(premium.toFixed(2));}}
                  style={{fontSize:9,color:"#3a8fff",background:"none",border:"none",cursor:"pointer",padding:0,fontFamily:"DM Mono,monospace"}}>
                  ↺ use market (${premium.toFixed(2)})
                </button>
              )}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6,background:"#080c10",border:`1px solid ${customPremium!==null?"#f5c84266":"#1a2a3a"}`,borderRadius:6,padding:"7px 10px"}}>
              <span style={{color:"#5a7a9a",fontSize:12,fontFamily:"DM Mono,monospace"}}>$</span>
              <input value={premiumInput}
                onChange={e=>setPremiumInput(e.target.value)}
                onBlur={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>0){setCustomPremium(v);setPremiumInput(v.toFixed(2));}else{setCustomPremium(null);setPremiumInput(premium.toFixed(2));}}}
                onKeyDown={e=>{if(e.key==="Enter"){const v=parseFloat(premiumInput);if(!isNaN(v)&&v>0){setCustomPremium(v);setPremiumInput(v.toFixed(2));}}}}
                style={{background:"transparent",border:"none",outline:"none",color:customPremium!==null?"#f5c842":"#c8d8e8",fontFamily:"DM Mono,monospace",fontSize:16,fontWeight:600,width:"70px"}}/>
              {customPremium!==null&&<span style={{fontSize:8,color:"#f5c842",background:"#f5c84215",border:"1px solid #f5c84233",borderRadius:3,padding:"1px 5px",letterSpacing:.5}}>custom</span>}
              {customPremium===null&&<span style={{fontSize:9,color:"#3a5a7a",marginLeft:"auto"}}>ask</span>}
            </div>
          </div>
        )}

        {/* Summary metrics */}
        {activePremium>0&&(
          <div>
            <div className="sim-slbl">Summary</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {[
                ["Net "+(side==="buy"?"Debit":"Credit"),(side==="buy"?"-":"+")+`$${(activePremium*100).toFixed(0)}`,side==="buy"?"#ff4d6a":"#00d4aa"],
                ["Max Loss",maxLoss===Infinity?"Unlimited":"$"+maxLoss.toFixed(0),"#ff4d6a"],
                ["Max Profit",maxProfit===Infinity?"Unlimited":"$"+maxProfit.toFixed(0),"#00d4aa"],
                ["Breakeven",`$${breakeven.toFixed(2)}`,"#f5c842"],
              ].map(([l,v,c])=>(
                <div key={l} className="sim-metric" style={{"--mt":c,"--mc":c}}>
                  <div className="sim-metric-lbl">{l}</div>
                  <div className="sim-metric-val">{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Probabilities */}
        {selOption&&(
          <div>
            <div className="sim-slbl">Probabilities</div>
            <div style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"10px 11px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7}}>
                <div>
                  <div style={{fontSize:9,color:"#3a5a7a",marginBottom:2}}>Chance of Profit</div>
                  <div style={{fontFamily:"Syne,sans-serif",fontSize:18,fontWeight:800,color:"#3a8fff"}}>{(chanceOfProfit*100).toFixed(1)}%</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:9,color:"#3a5a7a",marginBottom:2}}>Delta</div>
                  <div style={{fontFamily:"Syne,sans-serif",fontSize:14,fontWeight:700,color:"#3a8fff"}}>{fmt(delta,3)}</div>
                </div>
              </div>
              <div style={{height:4,background:"#1a2a3a",borderRadius:2,overflow:"hidden",marginBottom:8}}>
                <div style={{height:"100%",width:`${chanceOfProfit*100}%`,background:"linear-gradient(90deg,#3a8fff,#00d4aa)",borderRadius:2}}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                {[["Prob ITM",(probITM*100).toFixed(1)+"%","#3a8fff"],["Prob Touch",(probTouch*100).toFixed(1)+"%","#a78bfa"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:5,padding:"6px 8px"}}>
                    <div style={{fontSize:9,color:"#3a5a7a",marginBottom:2,letterSpacing:1}}>{l}</div>
                    <div style={{fontSize:12,fontWeight:500,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Greeks */}
        {selOption&&(
          <div>
            <div className="sim-slbl" style={{display:"flex",alignItems:"center",gap:6}}>
              Greeks
              <span style={{fontSize:8,background:"#00d4aa15",border:"1px solid #00d4aa33",color:"#00d4aa",padding:"1px 5px",borderRadius:3,letterSpacing:.5}}>live</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
              {[["Δ","Delta",fmt(delta,3),"#3a8fff"],["Θ","Theta",fmt(theta,3),"#ff4d6a"],["Γ","Gamma",fmt(gamma,4),"#00d4aa"],["V","Vega",fmt(vega,3),"#a78bfa"]].map(([sym,name,val,c])=>(
                <div key={name} style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:5,padding:"6px 7px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:"#3a5a7a",marginBottom:2}}>{sym} {name}</div>
                  <div style={{fontSize:11,fontWeight:500,color:c}}>{val}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Selected expiration info */}
        {selExp&&activePremium>0&&(
          <div style={{background:"#080c10",border:"1px solid #00d4aa33",borderRadius:6,padding:"9px 11px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontFamily:"Syne,sans-serif",fontSize:13,fontWeight:700,color:"#00d4aa"}}>{selExp}</div>
              <div style={{fontSize:9,color:"#3a5a7a",background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:4,padding:"2px 6px"}}>{dte} DTE</div>
            </div>
            <div style={{fontSize:10,color:"#3a5a7a",marginTop:3}}>
              Premium: <span style={{color:"#c8d8e8"}}>${fmt(premium)} ask</span>
              {iv>0&&<> &nbsp;·&nbsp; IV: <span style={{color:"#f5c842"}}>{(iv*100).toFixed(1)}%</span></>}
            </div>
          </div>
        )}

        {activePremium>0&&(
          <button className="btn" style={{width:"100%",padding:9,fontSize:11,fontWeight:600}} onClick={()=>setShowQuickAdd(p=>!p)}>
            {showQuickAdd?"✕ Cancel":"+ Add Trade"}
          </button>
        )}
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="sim-right">

        {/* Expiration timeline */}
        {exps.length>0&&(
          <div className="sim-timeline">
            <div style={{display:"flex",gap:0}}>
              {Object.entries(groupedExps).map(([month,dates])=>(
                <div key={month} style={{flexShrink:0}}>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",textAlign:"center",borderRight:"1px solid #1a2a3a",padding:"0 10px 4px",marginBottom:4}}>{month}</div>
                  <div style={{display:"flex",gap:3,padding:"0 6px 8px"}}>
                    {dates.map(exp=>{
                      const d=new Date(exp+"T12:00:00");
                      const expDte=Math.max(Math.ceil((new Date(exp)-new Date())/(1000*60*60*24)),0);
                      return(
                        <button key={exp} className={`sim-exp-btn${selExp===exp?" sel":""}`} onClick={()=>loadChain(exp)}>
                          {d.getDate()}
                          <span style={{display:"block",fontSize:8,opacity:.7,marginTop:1,textAlign:"center"}}>{expDte}d</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Payoff Chart */}
        {selStrike&&activePremium>0&&(
          <div style={{padding:"10px 12px 0",borderBottom:"1px solid #1a2a3a"}}>
            <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:6}}>
              Payoff at Expiration — {strategy}
            </div>
            <PayoffChart spot={spot} strike={selStrike} premium={activePremium} breakeven={breakeven} optType={optType} side={side}/>
          </div>
        )}

        {/* Toolbar */}
        {matrixRows.length>0&&(
          <div className="sim-toolbar">
            <div style={{fontSize:9,color:"#3a5a7a",letterSpacing:1.5,textTransform:"uppercase"}}>View</div>
            <div className="sim-view-group">
              {[["dollar","P&L $"],["pct","P&L %"],["roi","ROI"]].map(([m,l])=>(
                <button key={m} className={`sim-view-btn${viewMode===m?" sel":""}`} onClick={()=>setViewMode(m)}>{l}</button>
              ))}
            </div>
            {breakeven>0&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#f5c842"}}>
              <div style={{width:20,height:0,borderTop:"1px dashed #f5c842"}}/> BE ${breakeven.toFixed(2)}
            </div>}
            <div style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#00d4aa"}}>
              <div style={{width:20,height:2,background:"#00d4aa33",boxShadow:"0 0 4px #00d4aa44"}}/> ATM ${spot.toFixed(2)}
            </div>
            <div style={{marginLeft:"auto",fontSize:9,color:"#3a5a7a"}}>Hover any cell for details</div>
          </div>
        )}

        {/* P&L Matrix */}
        {matrixRows.length>0?(
          <div className="sim-matrix">
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th className="sim-th sp1">Price</th>
                  <th className="sim-th sp2">Chg%</th>
                  {colExps.map((exp,ci)=>{
                    const d=new Date(exp+"T12:00:00");
                    const isSel=exp===selExp;
                    return(
                      <th key={exp} className={`sim-th${isSel?" sel-exp":""}`}>
                        {d.toLocaleDateString("en-US",{month:"short",day:"numeric"})}{isSel?" ★":""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((row,ri)=>{
                  const isAtm=ri===atmRowIdx;
                  const isBe=ri===beRowIdx&&ri!==atmRowIdx;
                  const cost=activePremium*100;
                  return(
                    <tr key={row.price}
                      className={isAtm?"sim-row-atm":isBe?"sim-row-be":""}
                      style={{borderTop:isAtm?"1px solid #00d4aa22":isBe?"1px dashed #f5c84244":undefined,
                              borderBottom:isAtm?"1px solid #00d4aa22":undefined}}>
                      <td className="sim-td-price" style={{color:isAtm?"#fff":"#c8d8e8",fontWeight:isAtm?700:400,
                          background:isAtm?"linear-gradient(90deg,#00d4aa08,transparent)":"",
                          boxShadow:isAtm?"inset 3px 0 0 #00d4aa":"none"}}>
                        ${row.price.toFixed(2)}
                        {isAtm&&<span style={{fontSize:9,color:"#00d4aa",marginLeft:4}}>◀ ATM</span>}
                        {isBe&&<span style={{fontSize:9,color:"#f5c842",background:"#f5c84215",border:"1px solid #f5c84244",borderRadius:3,padding:"1px 4px",marginLeft:4}}>BE</span>}
                      </td>
                      <td className="sim-td-pct" style={{color:row.pct>=0?"#00d4aa":"#ff4d6a"}}>
                        {row.pct>=0?"+":""}{row.pct}%
                      </td>
                      {row.cols.map((v,ci)=>{
                        const isSel=colExps[ci]===selExp;
                        const exp=colExps[ci];
                        const colLabel=new Date(exp+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"});
                        return(
                          <td key={ci} className="sim-td"
                            style={{background:pnlBg(v),color:pnlColor(v),
                              outline:isSel?"1px solid #00d4aa22":"none",outlineOffset:"-1px",
                              fontWeight:Math.abs(v)>100?600:400}}
                            onMouseEnter={e=>{
                              setTooltip({price:row.price,pct:row.pct,date:colLabel,dollar:v,
                                pctStr:(v/(activePremium*100)*100).toFixed(1),roi:(1+v/(activePremium*100)).toFixed(2)});
                              setTipPos({x:e.clientX,y:e.clientY});
                            }}
                            onMouseLeave={()=>setTooltip(null)}
                            onMouseMove={e=>setTipPos({x:e.clientX,y:e.clientY})}>
                            {fmtCell(v,cost)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ):(
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#3a5a7a",fontSize:12,flexDirection:"column",gap:8}}>
            {loading?"Loading data...":sym?"Select a strike to view the heatmap":"Enter a symbol and press ↻ to begin"}
          </div>
        )}
      </div>

      {/* Hover Tooltip */}
      {tooltip&&(
        <div style={{position:"fixed",
          left:tipPos.x+(tipPos.x>window.innerWidth-175?-170:14),
          top:tipPos.y+(tipPos.y>window.innerHeight-175?-165:14),
          zIndex:999,background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:8,
          padding:"10px 13px",boxShadow:"0 8px 32px rgba(0,0,0,.6)",
          pointerEvents:"none",minWidth:150,
        }}>
          <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:5}}>{tooltip.date} · ${tooltip.price.toFixed(2)}</div>
          <div style={{fontFamily:"Syne,sans-serif",fontSize:15,fontWeight:800,color:tooltip.dollar>=0?"#00d4aa":"#ff4d6a",marginBottom:6}}>
            {tooltip.dollar>=0?"+":""}{viewMode==="dollar"?`$${tooltip.dollar}`:viewMode==="pct"?`${tooltip.pctStr}%`:`${tooltip.roi}x`}
          </div>
          <div style={{height:1,background:"#1a2a3a",margin:"5px 0"}}/>
          {[["P&L $",(tooltip.dollar>=0?"+":"")+"$"+tooltip.dollar,tooltip.dollar>=0?"#00d4aa":"#ff4d6a"],
            ["Return",(parseFloat(tooltip.pctStr)>=0?"+":"")+tooltip.pctStr+"%","#c8d8e8"],
            ["ROI",tooltip.roi+"x","#c8d8e8"]].map(([l,v,c])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3,fontSize:11}}>
              <span style={{color:"#5a7a9a"}}>{l}</span><span style={{fontWeight:600,color:c}}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Add Trade Modal */}
      {showQuickAdd&&sym&&(()=>{
        const qaPrem = parseFloat(qaPremium)||0;
        const qaCont = Math.max(1, parseInt(qaContracts)||1);
        const totalCost = qaPrem * qaCont * 100;
        const qaBreakeven = qaStrike ? (optType==="call"
          ? (side==="buy"?qaStrike+qaPrem:qaStrike-qaPrem)
          : (side==="buy"?qaStrike-qaPrem:qaStrike+qaPrem)) : 0;
        return(
          <>
            {/* Backdrop */}
            <div onClick={()=>setShowQuickAdd(false)}
              style={{position:"fixed",inset:0,zIndex:300,background:"rgba(0,0,0,.55)"}}/>
            {/* Modal */}
            <div style={{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
              zIndex:301,background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:12,
              padding:"20px 22px",width:320,boxShadow:"0 16px 48px rgba(0,0,0,.7)"}}>

              {/* Header */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
                <div>
                  <div style={{fontFamily:"Syne,sans-serif",fontSize:15,fontWeight:800,color:"#fff"}}>{sym}</div>
                  <div style={{fontSize:10,color:"#00d4aa",letterSpacing:.5,marginTop:2}}>
                    {side==="buy"?"BUY":"SELL"} {optType.toUpperCase()} · {strategy}
                  </div>
                </div>
                <button onClick={()=>setShowQuickAdd(false)}
                  style={{background:"none",border:"none",color:"#3a5a7a",fontSize:16,cursor:"pointer",lineHeight:1}}>✕</button>
              </div>

              {/* Editable fields */}
              <div style={{display:"flex",flexDirection:"column",gap:10}}>

                {/* Contracts */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Contracts</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"7px 10px"}}>
                    <button onClick={()=>setQaContracts(c=>Math.max(1,c-1))}
                      style={{background:"#1a2a3a",border:"none",color:"#c8d8e8",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>−</button>
                    <input value={qaContracts} onChange={e=>setQaContracts(Math.max(1,parseInt(e.target.value)||1))}
                      style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#fff",fontFamily:"DM Mono,monospace",fontSize:15,fontWeight:600,textAlign:"center"}}/>
                    <button onClick={()=>setQaContracts(c=>c+1)}
                      style={{background:"#1a2a3a",border:"none",color:"#c8d8e8",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>+</button>
                  </div>
                </div>

                {/* Price per contract */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Price per Contract</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"7px 10px"}}>
                    <span style={{color:"#5a7a9a",fontFamily:"DM Mono,monospace"}}>$</span>
                    <input value={qaPremium} onChange={e=>setQaPremium(e.target.value)}
                      onBlur={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>0)setQaPremium(v.toFixed(2));}}
                      style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#f5c842",fontFamily:"DM Mono,monospace",fontSize:15,fontWeight:600}}/>
                    <span style={{fontSize:9,color:"#3a5a7a"}}>×100 = ${(qaPrem*100).toFixed(0)}</span>
                  </div>
                </div>

                {/* Strike */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Strike</div>
                  <select value={qaStrike||""} onChange={e=>setQaStrike(parseFloat(e.target.value))}
                    className="fsel" style={{width:"100%",fontSize:13}}>
                    {availableStrikes.map(s=><option key={s} value={s}>${s.toFixed(2)}</option>)}
                  </select>
                </div>

                {/* Expiration */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#3a5a7a",marginBottom:4}}>Expiration</div>
                  <select value={qaExp} onChange={e=>setQaExp(e.target.value)}
                    className="fsel" style={{width:"100%",fontSize:13}}>
                    {exps.map(e=><option key={e} value={e}>{e}</option>)}
                  </select>
                </div>

              </div>

              {/* Summary strip */}
              <div style={{marginTop:14,padding:"10px 12px",background:"#080c10",borderRadius:7,border:"1px solid #1a2a3a"}}>
                {[
                  ["Total Cost",(side==="buy"?"-":"+")+`$${totalCost.toFixed(0)}`],
                  ["Breakeven",`$${qaBreakeven.toFixed(2)}`],
                  ["Contracts",`${qaCont} × $${(qaPrem*100).toFixed(0)}`],
                ].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:11}}>
                    <span style={{color:"#5a7a9a"}}>{l}</span>
                    <span style={{color:"#c8d8e8",fontWeight:600,fontFamily:"DM Mono,monospace"}}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{display:"flex",gap:8,marginTop:14}}>
                <button className="btn bneutral" style={{flex:1,padding:"9px 0",fontSize:12}}
                  onClick={()=>setShowQuickAdd(false)}>Cancel</button>
                <button className="btn" style={{flex:2,padding:"9px 0",fontSize:12,fontWeight:700}}
                  disabled={!qaStrike||!qaExp||qaPrem<=0}
                  onClick={()=>{
                    setShowQuickAdd(false);
                    onSaveManualTrade&&onSaveManualTrade(sym,{
                      date:new Date().toISOString().slice(0,10),
                      action:side.toUpperCase(),
                      strike:qaStrike, expiration:qaExp,
                      premium:qaPrem, contracts:qaCont,
                      status:"open", option_type:optType,
                      strategy:strategy,
                    });
                  }}>Add Trade →</button>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ── Home ──────────────────────────────────────────────────────────────────────
function Home({ assets, onSelectAsset, onShowPositions, onSaveManualTrade, onEditTrade }) {
  const [stratFilter, setStratFilter] = useState("all");
  const [sortBy, setSortBy] = useState("expiration");

  const totals = useMemo(()=>assets.filter(a=>a.active).map(a=>{
    const leaps = a.leaps||[];
    const leapCost = leaps.reduce((s,l)=>s+l.cost*l.contracts*100,0); // total cost in dollars
    const leapContracts = leaps.reduce((s,l)=>s+l.contracts,0);
    const leapAvg = leapContracts>0 ? leapCost/leapContracts : 0; // dollars per contract
    const col=a.trades.reduce((acc,t)=>{
      if(t.action==="SELL") return acc+parseFloat(t.premium||0)*parseInt(t.contracts||1);
      if(t.action==="BUY"&&t.status!=="open") return acc-parseFloat(t.premium||0)*parseInt(t.contracts||1);
      return acc;
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

  const allOpenRows = useMemo(()=>totals.flatMap(t=>[
    ...(t.leaps||[]).map(l=>({
      ...l,
      ticker:t.ticker, color:t.color, assetId:t.id,
      isLeap:true, label:"LEAP", action:"BUY", premium:l.cost,
    })),
    ...t.openTrades.map(tr=>({
      ...tr,
      ticker:t.ticker, color:t.color, assetId:t.id,
      isLeap:false,
      label:tr.action==="BUY"?(tr.option_type==="put"?"Long Put":"Long Call"):(tr.option_type==="put"?"Short Put":"Short Call"),
      contracts:tr.contracts||1,
    })),
  ]).sort((a,b)=>new Date(a.expiration)-new Date(b.expiration)),[totals]);

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

      {/* Open Positions — flat per-trade table */}
      <div className="sec" style={{marginBottom:24}}>
        <div className="sechdr">
          <div className="sectitle">Open positions</div>
          <span style={{fontSize:11,color:"#5a7a9a"}}>{allOpenRows.length} position{allOpenRows.length!==1?"s":""}</span>
        </div>
        {allOpenRows.length===0?(
          <div className="empty">Nenhuma posição aberta — adicione um trade abaixo</div>
        ):(
          <table>
            <thead><tr><th>Ticker</th><th>Type</th><th>Action</th><th>Strike</th><th>Premium</th><th>Contracts</th><th>Expiration</th><th>Days</th><th></th></tr></thead>
            <tbody>
              {allOpenRows.map((r,i)=>{
                const dl=Math.ceil((new Date(r.expiration)-new Date())/(1000*60*60*24));
                const bc=dl<=3?"#E24B4A":dl<=7?"#BA7517":"#1D9E75";
                const isSell=r.action==="SELL";
                return(
                  <tr key={i} onClick={()=>onSelectAsset&&onSelectAsset(r.assetId)} style={{cursor:"pointer"}}>
                    <td><span style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:14,color:r.color}}>{r.ticker}</span></td>
                    <td><span style={{fontSize:10,padding:"2px 8px",borderRadius:3,background:isSell?"#00d4aa15":"#ff6b9d15",border:`1px solid ${isSell?"#00d4aa44":"#ff6b9d44"}`,color:isSell?"#00d4aa":"#ff6b9d"}}>{r.label}</span></td>
                    <td><span style={{color:isSell?"#00d4aa":"#ff6b9d",fontWeight:600}}>{r.action}</span></td>
                    <td style={{color:"#f5c842",fontWeight:600}}>${r.strike}</td>
                    <td style={{color:isSell?"#00d4aa":"#ff6b9d"}}>{isSell?"+":"-"}${fmt(r.premium*100)}</td>
                    <td style={{color:"#8aaac8"}}>{r.contracts}</td>
                    <td style={{color:"#c8d8e8"}}>{r.expiration}</td>
                    <td><span style={{fontSize:11,color:bc,fontWeight:600}}>{dl<=0?"Exp!":dl+"d"}</span></td>
                    <td onClick={e=>e.stopPropagation()}>
                      {r.isLeap
                        ? <button className="btn bsm bneutral" onClick={()=>onSelectAsset&&onSelectAsset(r.assetId)}>View →</button>
                        : <button className="btn bsm bneutral" onClick={()=>onEditTrade&&onEditTrade(r)}>Edit</button>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Simulator */}
      <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
        <div style={{fontSize:11,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a"}}>Simulator</div>
        <div style={{flex:1,height:1,background:"#1a2a3a"}}/>
      </div>
      <SimulatorPanel onSaveManualTrade={onSaveManualTrade}/>
    </div>
  );
}

// ── Expiration Alert Modal ────────────────────────────────────────────────────
function ExpirationAlertModal({ trades, onResolve }) {
  const [decisions, setDecisions] = useState(()=>Object.fromEntries(trades.map(t=>[t.id,"expired"])));
  const confirm = () => onResolve(trades.map(t=>({...t,decision:decisions[t.id]})));
  return (
    <div className="overlay">
      <div className="fbox" style={{width:540,maxWidth:"95vw"}}>
        <div className="ftitle">⚠️ Expired positions</div>
        <p style={{fontSize:12,color:"#8aaac8",lineHeight:1.6,marginBottom:14}}>
          The positions below have passed their expiration date. What happened to each one?
        </p>
        {trades.map(t=>(
          <div key={t.id} style={{background:"#080c10",border:"1px solid #1a2a3a",borderRadius:6,padding:"10px 14px",marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:13}}>
                <span style={{color:t.color||"#00d4aa",fontWeight:700,fontFamily:"Syne,sans-serif"}}>{t.ticker}</span>
                {" "}<span style={{color:"#f5c842"}}>${t.strike}</span>
                {" "}<span style={{color:"#5a7a9a"}}>{t.action}</span>
                {" · exp "}<span style={{color:"#5a7a9a"}}>{t.expiration}</span>
                {" · "}<span style={{color:"#00d4aa"}}>${fmt(parseFloat(t.premium||0)*(parseInt(t.contracts||1))*100)}</span>
              </div>
              <span style={{fontSize:10,color:"#ff4d6a",background:"#ff4d6a10",border:"1px solid #ff4d6a33",padding:"2px 8px",borderRadius:3,letterSpacing:1,textTransform:"uppercase"}}>expired</span>
            </div>
            <div className="toggle-group">
              <button className="tgl" style={{flex:1,background:decisions[t.id]==="expired"?"#a78bfa":"transparent",color:decisions[t.id]==="expired"?"#fff":"#5a7a9a"}}
                onClick={()=>setDecisions(p=>({...p,[t.id]:"expired"}))}>Expired worthless</button>
              <button className="tgl" style={{flex:1,background:decisions[t.id]==="closed"?"#f5c842":"transparent",color:decisions[t.id]==="closed"?"#080c10":"#5a7a9a"}}
                onClick={()=>setDecisions(p=>({...p,[t.id]:"closed"}))}>Closed / Rolled</button>
            </div>
          </div>
        ))}
        <button className="btn bfull" style={{marginTop:16,width:"100%"}} onClick={confirm}>Confirm</button>
      </div>
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
            if(t.action==="SELL") return acc+parseFloat(t.premium||0)*parseInt(t.contracts||1);
            if(t.action==="BUY"&&t.status!=="open") return acc-parseFloat(t.premium||0)*parseInt(t.contracts||1);
            return acc;
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
    // Open trades (calls, puts, any action)
    a.trades.filter(t=>t.status==="open").forEach(t=>{
      const dl=Math.ceil((new Date(t.expiration)-new Date())/(1000*60*60*24));
      const bc=dl<=3?"#E24B4A":dl<=7?"#BA7517":"#1D9E75";
      const isBuy=t.action==="BUY";
      const optKind=t.option_type==="put"?"Put":"Call";
      const typeLabel=isBuy?`Long ${optKind}`:`Short ${optKind}`;
      rows.push({
        type:typeLabel, ticker:a.ticker, color:a.color,
        strike:`$${t.strike}`, expiration:t.expiration,
        cost:`$${fmt(t.premium)}`, contracts:t.contracts||1,
        action:t.action, status:"open", premium:`$${fmt(t.premium*100)}`,
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
                <td><span style={{fontSize:11,padding:"2px 8px",borderRadius:4,background:p.type==="LEAP"?"#3a8fff20":p.action==="BUY"?"#3a8fff20":"#00d4aa15",color:p.type==="LEAP"?"#3a8fff":p.action==="BUY"?"#3a8fff":"#00d4aa",border:`1px solid ${p.type==="LEAP"?"#3a8fff44":p.action==="BUY"?"#3a8fff44":"#00d4aa44"}`}}>{p.type}</span></td>
                <td><span style={{color:p.action==="SELL"?"#00d4aa":"#ff4d6a"}}>{p.action}</span></td>
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

// ── Manual Trade Modal ───────────────────────────────────────────────────────
function ManualTradeModal({ onClose, onSave, defaultData }) {
  const today = new Date().toISOString().slice(0,10);
  const [form, setForm] = useState({
    symbol:     defaultData?.symbol     || "",
    assetName:  "",
    orderType:  defaultData?.side==="sell" ? "SELL" : "BUY",
    optionType: defaultData?.optType    || "call",
    quantity:   "1",
    strike:     defaultData?.strike     ? String(defaultData.strike)  : "",
    expiration: defaultData?.expiration || "",
    price:      defaultData?.premium    ? String(defaultData.premium) : "",
    fees:       "",
    strategy:   "",
    tags:       "",
    notes:      "",
    tradeGroup: "",
    date:       today,
  });
  const [showMore,  setShowMore]  = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [touched,   setTouch]     = useState({});

  // Symbol autocomplete state
  const [symbolValid, setSymbolValid] = useState(!!defaultData?.symbol);
  const [suggestions, setSuggestions] = useState([]);
  const [searching,   setSearching]   = useState(false);
  const [showDrop,    setShowDrop]    = useState(false);
  const debounceRef = useRef(null);

  const searchSymbols = useCallback(async (q) => {
    setSearching(true);
    try {
      const results = await fetchSymbolSearch(q);
      setSuggestions(results);
      setShowDrop(true);
    } catch { setSuggestions([]); setShowDrop(true); }
    setSearching(false);
  }, []);

  const handleSymbolChange = (val) => {
    const upper = val.toUpperCase();
    setForm(p=>({...p, symbol:upper}));
    setSymbolValid(false);
    clearTimeout(debounceRef.current);
    if (upper.length > 0) {
      debounceRef.current = setTimeout(() => searchSymbols(upper), 300);
    } else {
      setSuggestions([]);
      setShowDrop(false);
    }
  };

  const selectSuggestion = (s) => {
    setForm(p=>({...p, symbol:s.symbol, assetName:s.description||""}));
    setSymbolValid(true);
    setSuggestions([]);
    setShowDrop(false);
  };

  const touch = (field) => setTouch(p=>({...p,[field]:true}));

  const qty        = Math.max(1, parseInt(form.quantity)  || 1);
  const price      = Math.max(0, parseFloat(form.price)   || 0);
  const fees       = Math.max(0, parseFloat(form.fees)    || 0);
  const totalValue = qty * price * 100;                          // always positive
  const netAmount  = form.orderType==="BUY"                     // signed result
    ? -(totalValue + fees)
    :  (totalValue - fees);

  // Validation — only show errors after field has been touched or save attempted.
  const REQUIRED = { strike:"Strike", expiration:"Expiration", price:"Price" };
  const fieldErr = (f) => touched[f] && !form[f] ? `${REQUIRED[f]} is required` : null;
  const canSave   = symbolValid && form.symbol && form.strike && form.expiration && form.price
    && parseFloat(form.price) > 0 && parseFloat(form.strike) > 0;

  const handleSave = async () => {
    // Mark all required fields as touched to surface any errors.
    setTouch({ symbol:true, strike:true, expiration:true, price:true });
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const tradeData = {
        date:        form.date || today,
        action:      form.orderType,           // BUY | SELL  (matches trades.action)
        strike:      parseFloat(form.strike),
        expiration:  form.expiration,
        premium:     price,                    // price → premium  (matches trades.premium)
        contracts:   qty,                      // quantity → contracts
        status:      "open",
        // Extended fields — saved only when columns exist (supabase.js handles fallback)
        option_type: form.optionType,          // call | put
        fees:        fees || undefined,
        notes:       form.notes   || undefined,
        tags:        form.tags    || undefined,
        strategy:    form.strategy|| undefined,
        tradeGroup:  form.tradeGroup || undefined,
      };
      await onSave(form.symbol.toUpperCase(), tradeData);
      onClose();
    } catch(e) {
      setSaveError(e?.message || "Error saving trade. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const orderColor = form.orderType==="BUY" ? "#00d4aa" : "#ff4d6a";

  const summaryRows = [
    ["Asset",      form.symbol||"—",                                                                                                    "#c8d8e8"],
    ["Order",      `${form.orderType==="BUY"?"Buy":"Sell"} ${form.optionType==="call"?"Call":"Put"}`,                                   orderColor],
    ["Strike",     form.strike  ? `$${fmt(parseFloat(form.strike))}` : "—",                                                            "#f5c842"],
    ["Expiration", form.expiration || "—",                                                                                              "#c8d8e8"],
    ["Qty",        `${qty} contract${qty>1?"s":""}`,                                                                                    "#8aaac8"],
    ["Price",      price ? `$${fmt(price)}` : "—",                                                                                     "#c8d8e8"],
    ["Value",      totalValue>0 ? `${netAmount<0?"-":"+"}$${fmt(Math.abs(netAmount))}` : "—", netAmount<0 ? "#ff4d6a" : "#00d4aa"],
  ];

  const inputStyle = (field) => ({
    ...(touched[field] && !form[field] ? {borderColor:"#ff4d6a88"} : {}),
  });

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:12,width:880,maxWidth:"97vw",maxHeight:"92vh",boxShadow:"0 40px 80px rgba(0,0,0,0.7)",display:"flex",flexDirection:"column",overflowY:"auto"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"16px 24px",borderBottom:"1px solid #1a2a3a",flexShrink:0}}>
          <span style={{color:"#00d4aa",fontSize:16,fontWeight:700}}>+</span>
          <span style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:16,color:"#fff"}}>Register trade manually</span>
          <button onClick={onClose} style={{marginLeft:"auto",background:"none",border:"none",color:"#5a7a9a",cursor:"pointer",fontSize:20,lineHeight:1,padding:"0 4px"}}>✕</button>
        </div>

        {/* Body */}
        <div style={{display:"flex",flex:1,minHeight:0}}>

          {/* Left — Form */}
          <div style={{flex:1,padding:"20px 24px",overflowY:"auto"}}>

            {/* Asset */}
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a",marginBottom:10}}>Asset</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
              {/* Symbol — autocomplete from Tradier search */}
              <div className="fgrp">
                <label className="flbl">Symbol *</label>
                <div style={{position:"relative"}}>
                  <input className="finput"
                    style={{textTransform:"uppercase",letterSpacing:1,paddingRight:30,
                      ...(symbolValid?{borderColor:"#00d4aa66"}
                        :touched.symbol&&form.symbol?{borderColor:"#ff4d6a88"}
                        :touched.symbol&&!form.symbol?{borderColor:"#ff4d6a88"}:{})
                    }}
                    placeholder="AAPL, TSLA..."
                    value={form.symbol}
                    onBlur={()=>{touch("symbol"); setTimeout(()=>setShowDrop(false),160);}}
                    onFocus={()=>{if(suggestions.length>0) setShowDrop(true);}}
                    onChange={e=>handleSymbolChange(e.target.value)}/>
                  {symbolValid&&!searching&&
                    <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",color:"#00d4aa",fontSize:13,fontWeight:700,pointerEvents:"none"}}>✓</span>}
                  {searching&&
                    <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",color:"#3a5a7a",fontSize:11,pointerEvents:"none",animation:"pulse 1s infinite"}}>…</span>}
                  {showDrop&&(
                    <div style={{position:"absolute",top:"calc(100% + 2px)",left:0,right:0,background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:6,zIndex:400,boxShadow:"0 8px 24px rgba(0,0,0,0.6)",maxHeight:220,overflowY:"auto"}}>
                      {suggestions.length===0?(
                        <div style={{padding:"10px 14px",fontSize:12,color:"#3a5a7a"}}>No assets found</div>
                      ):(
                        suggestions.map(s=>(
                          <div key={s.symbol}
                            onMouseDown={()=>selectSuggestion(s)}
                            style={{padding:"9px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #0f1e2e",transition:"background 0.15s"}}
                            onMouseEnter={e=>e.currentTarget.style.background="#1a2a3a"}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <span style={{fontFamily:"DM Mono,monospace",fontWeight:700,fontSize:13,color:"#fff",minWidth:56}}>{s.symbol}</span>
                            <span style={{fontSize:11,color:"#8aaac8",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.description}</span>
                            <span style={{fontSize:10,color:"#3a5a7a",background:"#1a2a3a",padding:"2px 6px",borderRadius:3,flexShrink:0}}>{s.exchange}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {touched.symbol&&!form.symbol&&
                  <span style={{fontSize:10,color:"#ff4d6a",marginTop:2,display:"block"}}>Symbol is required</span>}
                {touched.symbol&&form.symbol&&!symbolValid&&
                  <span style={{fontSize:10,color:"#ff4d6a",marginTop:2,display:"block"}}>Select a valid asset from the list</span>}
              </div>
              <div className="fgrp">
                <label className="flbl">Asset name (optional)</label>
                <input className="finput" placeholder="Auto-filled from search"
                  value={form.assetName} onChange={e=>setForm(p=>({...p,assetName:e.target.value}))}/>
              </div>
            </div>

            {/* Trade Details */}
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a",marginBottom:10}}>Trade details</div>

            {/* Order type + Option type */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
              <div className="fgrp">
                <label className="flbl">Order type</label>
                <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1px solid #1a2a3a"}}>
                  {[["BUY","Buy","#00d4aa","#080c10"],["SELL","Sell","#ff4d6a","#fff"]].map(([val,label,col,tc])=>(
                    <button key={val} onClick={()=>setForm(p=>({...p,orderType:val}))}
                      style={{flex:1,padding:"10px 0",border:"none",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:13,fontWeight:700,transition:"all 0.2s",
                        background:form.orderType===val?col:"#080c10",
                        color:form.orderType===val?tc:"#5a7a9a",
                        letterSpacing:0.5}}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="fgrp">
                <label className="flbl">Option type</label>
                <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1px solid #1a2a3a"}}>
                  {[["call","Call","#3a8fff"],["put","Put","#a78bfa"]].map(([val,label,col])=>(
                    <button key={val} onClick={()=>setForm(p=>({...p,optionType:val}))}
                      style={{flex:1,padding:"10px 0",border:"none",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:13,fontWeight:700,transition:"all 0.2s",
                        background:form.optionType===val?col:"#080c10",
                        color:form.optionType===val?"#fff":"#5a7a9a",
                        letterSpacing:0.5}}>{label}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Qty / Strike / Expiration / Price */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:4}}>
              <div className="fgrp">
                <label className="flbl">Quantity</label>
                <input className="finput" type="number" min="1" step="1" value={form.quantity}
                  onChange={e=>setForm(p=>({...p,quantity:e.target.value}))}/>
              </div>
              <div className="fgrp">
                <label className="flbl">Strike *</label>
                <input className="finput" type="number" step="0.5" placeholder="17.50"
                  value={form.strike} style={inputStyle("strike")}
                  onBlur={()=>touch("strike")}
                  onChange={e=>setForm(p=>({...p,strike:e.target.value}))}/>
                {fieldErr("strike")&&<span style={{fontSize:10,color:"#ff4d6a",marginTop:2,display:"block"}}>{fieldErr("strike")}</span>}
              </div>
              <div className="fgrp">
                <label className="flbl">Expiration *</label>
                <input className="finput" type="date"
                  value={form.expiration} style={inputStyle("expiration")}
                  onBlur={()=>touch("expiration")}
                  onChange={e=>setForm(p=>({...p,expiration:e.target.value}))}/>
                {fieldErr("expiration")&&<span style={{fontSize:10,color:"#ff4d6a",marginTop:2,display:"block"}}>{fieldErr("expiration")}</span>}
              </div>
              <div className="fgrp">
                <label className="flbl">Price *</label>
                <div style={{position:"relative"}}>
                  <input className="finput" type="number" step="0.01" placeholder="0.23"
                    value={form.price} style={{paddingRight:38,...inputStyle("price")}}
                    onBlur={()=>touch("price")}
                    onChange={e=>setForm(p=>({...p,price:e.target.value}))}/>
                  <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#3a5a7a",pointerEvents:"none"}}>USD</span>
                </div>
                {fieldErr("price")&&<span style={{fontSize:10,color:"#ff4d6a",marginTop:2,display:"block"}}>{fieldErr("price")}</span>}
              </div>
            </div>
            <div style={{fontSize:10,color:"#3a5a7a",marginBottom:14,letterSpacing:0.5}}>contracts</div>

            {/* Debit / Credit — only active box is fully visible */}
            <div style={{marginBottom:16}}>
              {form.orderType==="BUY" ? (
                <div style={{background:"#ff4d6a12",border:"1px solid #ff4d6a55",borderRadius:8,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:"#ff4d6a",marginBottom:6,fontWeight:600,letterSpacing:0.5}}>You will pay (debit)</div>
                  <div style={{fontFamily:"Syne,sans-serif",fontSize:22,fontWeight:700,color:"#ff4d6a"}}>
                    -{totalValue>0?`$${fmt(totalValue)}`:"$—"}
                  </div>
                  <div style={{fontSize:11,color:"#5a7a9a",marginTop:4}}>
                    {qty} contract{qty>1?"s":""} × 100 shares × ${fmt(price)}
                    {fees>0 && <span style={{color:"#ff4d6a88"}}> + ${fmt(fees)} fees</span>}
                  </div>
                </div>
              ) : (
                <div style={{background:"#00d4aa12",border:"1px solid #00d4aa55",borderRadius:8,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:"#00d4aa",marginBottom:6,fontWeight:600,letterSpacing:0.5}}>You will receive (credit)</div>
                  <div style={{fontFamily:"Syne,sans-serif",fontSize:22,fontWeight:700,color:"#00d4aa"}}>
                    +{totalValue>0?`$${fmt(totalValue)}`:"$—"}
                  </div>
                  <div style={{fontSize:11,color:"#5a7a9a",marginTop:4}}>
                    {qty} contract{qty>1?"s":""} × 100 shares × ${fmt(price)}
                    {fees>0 && <span style={{color:"#5a7a9a88"}}> − ${fmt(fees)} fees</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Fees + Notes */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              <div className="fgrp">
                <label className="flbl">Fees / Commissions (optional)</label>
                <div style={{position:"relative"}}>
                  <input className="finput" type="number" step="0.01" placeholder="0.00"
                    value={form.fees} style={{paddingRight:38}}
                    onChange={e=>setForm(p=>({...p,fees:e.target.value}))}/>
                  <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#3a5a7a",pointerEvents:"none"}}>USD</span>
                </div>
              </div>
              <div className="fgrp">
                <label className="flbl">Notes (optional)</label>
                <input className="finput" placeholder="e.g. PMCC entry, first leg..."
                  value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))}/>
              </div>
            </div>

            {/* Strategy + Tags */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:0}}>
              <div className="fgrp">
                <label className="flbl">Strategy (optional)</label>
                <select className="fsel" value={form.strategy} onChange={e=>setForm(p=>({...p,strategy:e.target.value}))}>
                  <option value="">Select strategy</option>
                  {Object.values(STRATEGIES).flat().map(s=>(
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div className="fgrp">
                <label className="flbl">Tags (optional)</label>
                <input className="finput" placeholder="e.g. PMCC, long term, oil..."
                  value={form.tags} onChange={e=>setForm(p=>({...p,tags:e.target.value}))}/>
              </div>
            </div>

            {/* Show more */}
            <button onClick={()=>setShowMore(!showMore)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",background:"none",border:"none",borderTop:"1px solid #1a2a3a",color:"#5a7a9a",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:12,padding:"12px 0",marginTop:14}}>
              <span>Show more options</span>
              <span style={{fontSize:11}}>{showMore?"▲":"▼"}</span>
            </button>

            {showMore&&(
              <div style={{paddingTop:12,display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div className="fgrp">
                  <label className="flbl">Trade Group (free label)</label>
                  <input className="finput" placeholder="e.g. PMCC PBR 2026, IBIT CC..."
                    value={form.tradeGroup} onChange={e=>setForm(p=>({...p,tradeGroup:e.target.value}))}/>
                  <span style={{fontSize:10,color:"#3a5a7a",marginTop:3,display:"block"}}>Groups legs of the same strategy</span>
                </div>
                <div className="fgrp">
                  <label className="flbl">Trade date</label>
                  <input className="finput" type="date" value={form.date}
                    onChange={e=>setForm(p=>({...p,date:e.target.value}))}/>
                </div>
              </div>
            )}
          </div>

          {/* Right — Summary */}
          <div style={{width:196,background:"#080c10",borderLeft:"1px solid #1a2a3a",padding:"20px 16px",flexShrink:0,overflowY:"auto"}}>
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#3a5a7a",marginBottom:14}}>Trade summary</div>
            {summaryRows.map(([label,value,color])=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,paddingBottom:10,borderBottom:"1px solid #0f1e2e"}}>
                <span style={{fontSize:11,color:"#3a5a7a",flexShrink:0}}>{label}</span>
                <span style={{fontSize:12,fontWeight:600,color,textAlign:"right",marginLeft:6,wordBreak:"break-all"}}>{value}</span>
              </div>
            ))}
            <div style={{background:"#0d1821",border:"1px solid #1a2a3a",borderRadius:8,padding:"12px",marginTop:4}}>
              <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:6}}>
                <span style={{fontSize:13}}>💡</span>
                <span style={{fontSize:11,fontWeight:600,color:"#f5c842"}}>Tip</span>
              </div>
              <div style={{fontSize:11,color:"#5a7a9a",lineHeight:1.6}}>
                All registered trades will be added to your portfolio and used to calculate P&L and strategy performance.
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{padding:"14px 24px",borderTop:"1px solid #1a2a3a",flexShrink:0}}>
          {saveError&&(
            <div style={{background:"#ff4d6a10",border:"1px solid #ff4d6a44",borderRadius:6,padding:"8px 12px",marginBottom:10,fontSize:12,color:"#ff4d6a"}}>
              ⚠ {saveError}
            </div>
          )}
          <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
            <button className="btn bneutral" style={{padding:"9px 28px",fontSize:13}} onClick={onClose}>Cancel</button>
            <button className="btn" style={{padding:"9px 28px",fontSize:13,color:"#00d4aa",borderColor:"#00d4aa44",background:"#00d4aa15",opacity:canSave?1:0.5,cursor:canSave?"pointer":"not-allowed"}}
              onClick={handleSave} disabled={saving}>
              {saving?"Saving...":"Save trade"}
            </button>
          </div>
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
  const [expiredPending, setExpiredPending] = useState([]);
  const [toast, setToast] = useState(null);
  const showToast = (msg, ok=true) => { setToast({msg,ok}); setTimeout(()=>setToast(null),6000); };
  const [editTrade, setEditTrade] = useState(null);

  useEffect(()=>{
    const today=new Date().toISOString().slice(0,10);
    fetchAssets()
      .then(async data=>{
        let migrated=false;
        for(const a of data){
          for(const t of a.trades){
            if(t.action==="BUY"&&t.status==="open"&&t.expiration&&t.date&&
              (new Date(t.expiration)-new Date(t.date))>180*24*60*60*1000){
              await addLeap(a.id,{id:`${a.id}_${Date.now()}`,date:t.date,strike:parseFloat(t.strike),expiration:t.expiration,cost:parseFloat(t.premium),contracts:parseInt(t.contracts||1)});
              await deleteTrade(t.id);
              migrated=true;
            }
          }
        }
        const fresh=migrated?await fetchAssets():data;
        setAssets(fresh);
        const expired=fresh.flatMap(a=>
          a.trades
            .filter(t=>t.status==="open"&&t.expiration<today)
            .map(t=>({...t,ticker:a.ticker,assetId:a.id,color:a.color}))
        );
        if(expired.length) setExpiredPending(expired);
        setLoading(false);
      })
      .catch(err=>{ console.error(err); setLoading(false); });
  },[]);

  useEffect(()=>{
    if(active==="home"||active==="closed") return;
    fetchAssets().then(setAssets).catch(e=>console.error("nav reload:",e));
  },[active]);

  const handleExpiredResolution = async (resolvedTrades) => {
    await Promise.all(resolvedTrades.map(t=>updateTrade(t.id,{status:t.decision})));
    setAssets(p=>p.map(a=>({
      ...a,
      trades:a.trades.map(t=>{
        const r=resolvedTrades.find(x=>x.id===t.id);
        return r?{...t,status:r.decision}:t;
      })
    })));
    setExpiredPending([]);
  };

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
      showToast(`Erro ao criar ativo: ${e?.message||e?.code||"unknown"}`,false);
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
    } catch(e){ console.error(e); showToast(`Leap save error: ${e?.message||e?.code||"unknown"}`,false); }
  };

  const handleSaveTrade = async (assetId, trade) => {
    try {
      const saved = await addTrade(assetId, trade);
      const asset = assets.find(a=>a.id===assetId);
      const oppositeAction = trade.action==="BUY"?"SELL":"BUY";
      const toClose = (asset?.trades||[]).filter(t=>
        t.status==="open"&&t.action===oppositeAction&&
        parseFloat(t.strike)===parseFloat(trade.strike)&&
        t.expiration===trade.expiration
      );
      if(toClose.length) await Promise.all(toClose.map(t=>updateTrade(t.id,{status:"closed"})));
      setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:[...a.trades.map(t=>toClose.some(c=>c.id===t.id)?{...t,status:"closed"}:t),saved]}:a));
      return saved;
    } catch(e){ console.error("handleSaveTrade error:",e); showToast(`Trade save failed: ${e?.message||e?.code||"unknown"}`,false); }
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

  const handleUpdateLeap = async (assetId, leapId, changes) => {
    try {
      await updateLeap(leapId, changes);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,leaps:a.leaps.map(l=>l.id===leapId?{...l,...changes}:l)}:a));
    } catch(e){ console.error(e); }
  };

  const handleDeleteTrade = async (assetId, tradeId) => {
    try {
      await deleteTrade(tradeId);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:a.trades.filter(t=>t.id!==tradeId)}:a));
    } catch(e){ console.error(e); }
  };

  const reloadAssets = async () => {
    try { const fresh = await fetchAssets(); setAssets(fresh); } catch(e){ console.error("reloadAssets error:",e); }
  };

  const autoStrategy = (action, optType) => {
    if(action==="BUY"  && optType==="call") return "Long Call";
    if(action==="BUY"  && optType==="put")  return "Long Put";
    if(action==="SELL" && optType==="call") return "Short Call";
    if(action==="SELL" && optType==="put")  return "Short Put";
    return "Long Call";
  };

  const handleSaveManualTrade = async (symbol, trade) => {
    const ticker = symbol.toUpperCase();
    try {
      const existing = assets.find(a=>a.ticker===ticker);
      let assetId;
      const detectedStrategy = trade.strategy || autoStrategy(trade.action, trade.option_type);
      if (!existing) {
        const usedColors = assets.map(a=>a.color);
        const color = COLORS.find(c=>!usedColors.includes(c)) || "#a78bfa";
        const newAsset = {
          id:ticker, ticker, strategy:detectedStrategy, color,
          leapStrike:null, leapExpiration:null, leapCost:null, leapDelta:null,
          initialPrice:0, active:true, trades:[],
        };
        const ok = await addAssetSilent(newAsset);
        if(ok===false) { showToast(`Falha ao criar ativo ${ticker} no banco.`,false); return; }
        assetId = ticker;
      } else {
        assetId = existing.id;
      }
      const saved = await handleSaveTrade(assetId, {...trade, strategy: detectedStrategy});
      if(saved) {
        showToast(`Trade salvo: ${ticker} ${trade.action} $${trade.strike}`);
        await reloadAssets();
      }
    } catch(e) {
      console.error("handleSaveManualTrade error:", e);
      showToast(`Erro ao salvar: ${e?.message||e?.code||String(e)}`,false);
    }
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

      {active==="home"&&<Home assets={assets} onSelectAsset={id=>setActive(id)} onShowPositions={()=>setShowPositions(true)} onSaveManualTrade={handleSaveManualTrade} onEditTrade={r=>{const a=assets.find(x=>x.id===r.assetId);setEditTrade({r,asset:a});}}/>}
      {assets.filter(a=>a.active).map(a=>active===a.id&&(
        <AssetDashboard key={a.id} asset={a} onClose={closeAsset}
          onSaveTrade={(t)=>handleSaveTrade(a.id,t)}
          onUpdateTrade={(id,c)=>handleUpdateTrade(a.id,id,c)}
          onDeleteTrade={(id)=>handleDeleteTrade(a.id,id)}
          onDeleteLeap={(id)=>handleDeleteLeap(a.id,id)}
          onUpdateLeap={(leapId,changes)=>handleUpdateLeap(a.id,leapId,changes)}
          onSaveLeap={(l)=>handleSaveLeap(a.id,l)}
          onDeleteAsset={handleDeleteAsset}
        />
      ))}
      {active==="closed"&&<ClosedStrategies closedAssets={closedAssets}/>}
      {showAdd&&<AddAssetModal onAdd={addAsset} onClose={()=>setShowAdd(false)} usedColors={assets.map(a=>a.color)}/>}
      {showPositions&&<AllPositionsModal assets={assets} onClose={()=>setShowPositions(false)}/>}
      {expiredPending.length>0&&<ExpirationAlertModal trades={expiredPending} onResolve={handleExpiredResolution}/>}
      <ClaudeChat assets={assets} onSaveTrade={handleSaveTrade} onUpdateTrade={handleUpdateTrade} onSaveLeap={handleSaveLeap} onAddAsset={addAssetSilent} onRefresh={reloadAssets}/>
      {editTrade&&(
        <UnifiedTradeModal
          title={`Edit · ${editTrade.r.ticker} ${editTrade.r.label}`}
          initial={editTrade.r}
          asset={editTrade.asset}
          isEdit={true}
          onSave={async(changes)=>{
            await handleUpdateTrade(editTrade.r.assetId, editTrade.r.id, changes);
            showToast(`Trade updated: ${editTrade.r.ticker} ${changes.action} $${changes.strike}`);
            setEditTrade(null);
          }}
          onClose={()=>setEditTrade(null)}
        />
      )}
      {toast&&(
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          background:toast.ok?"#1D9E75":"#E24B4A",color:"#fff",borderRadius:8,padding:"12px 24px",
          fontFamily:"DM Mono,monospace",fontSize:13,maxWidth:"90vw",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",
          textAlign:"center",wordBreak:"break-word"}}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Claude Chat ───────────────────────────────────────────────────────────────
function ClaudeChat({ assets, onSaveTrade, onUpdateTrade, onSaveLeap, onAddAsset, onRefresh }) {
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
    if(loading) return;
    const trades = pendingTrades;
    if(!trades.length) return;
    setPendingTrades([]); // clear immediately to block double-click
    setLoading(true);

    let saved = 0;
    let notFound = [];
    let closed = 0;
    const createdAssets = {}; // track assets created during this loop

    for(const t of trades){
      const assetId = (t.asset_id||"").toUpperCase();
      let asset = assets.find(a=>a.id===assetId) || createdAssets[assetId];

      if(!asset){
        // Auto-create the asset with detected strategy
        const tStrat = t.action==="BUY" && t.option_type==="put" ? "Long Put"
          : t.action==="SELL" && t.option_type==="call" ? "Short Call"
          : t.action==="SELL" && t.option_type==="put"  ? "Short Put"
          : "Long Call";
        const newAsset = {
          id: assetId,
          ticker: assetId,
          strategy: tStrat,
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
      const isLeap = t.action==="BUY" &&
        fixedExp && fixedDate &&
        (new Date(fixedExp)-new Date(fixedDate))>180*24*60*60*1000;

      if(isLeap){
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

      // Close matching open position with opposite action, same strike and expiration
      try {
        const openTrades = await fetchOpenTrades(assetId);
        const oppositeAction = t.action==="BUY"?"SELL":"BUY";
        const match = openTrades.find(tr=>
          tr.action===oppositeAction &&
          tr.status==="open" &&
          Math.abs(parseFloat(tr.strike)-parseFloat(t.strike))<0.01 &&
          tr.expiration===fixedExp
        );
        if(match){
          const matchContracts = parseInt(match.contracts||1);
          const newContracts = parseInt(t.contracts||1);
          if(newContracts>=matchContracts){
            await onUpdateTrade(assetId, match.id, {status:"closed"});
          } else {
            await onUpdateTrade(assetId, match.id, {contracts: matchContracts-newContracts});
          }
          closed++;
        }
      } catch(e){ console.error("Error matching trade:", e); }

      // Save the new trade — auto-detect strategy from action+option_type if not set
      const detectedStrat = t.strategy || (
        t.action==="BUY"  && t.option_type==="put"  ? "Long Put"   :
        t.action==="SELL" && t.option_type==="call"  ? "Short Call" :
        t.action==="SELL" && t.option_type==="put"   ? "Short Put"  : "Long Call"
      );
      await onSaveTrade(assetId, {
        date:fixedDate, action:t.action, strike:t.strike,
        expiration:fixedExp, premium:normalizedPremium,
        contracts:t.contracts||1, status: t.status||"open",
        option_type: t.option_type||"call", strategy: detectedStrat,
      });
      saved++;
    }

    setLoading(false);
    let msg = `✅ ${saved} trade${saved>1?"s":""} saved!`;
    if(closed>0) msg += ` ${closed} open position${closed>1?"s":""} closed.`;
    const newAssetNames = Object.keys(createdAssets);
    if(newAssetNames.length>0) msg += ` Created: ${newAssetNames.join(", ")}.`;
    if(notFound.length>0) msg += ` ⚠️ Asset not found: ${notFound.join(", ")}`;
    setMessages(p=>[...p,{role:"assistant",content:msg}]);
    if(onRefresh) await onRefresh();
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if(!file)return;

    // PDF not supported
    if(file.type==="application/pdf"){
      setMessages(p=>[...p,{role:"assistant",content:"PDFs are not supported yet. Please send a photo (PNG or JPEG) of the confirmation! 📸"}]);
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
                    <div style={{marginTop:6}}>
                      <div style={{fontSize:9,color:"#5a7a9a",marginBottom:2}}>STRATEGY</div>
                      <select style={{width:"100%",background:"#080c10",border:"1px solid #1a2a3a",color:"#a78bfa",fontFamily:"DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none"}}
                        value={t.strategy||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],strategy:e.target.value};setPendingTrades(v);}}>
                        <option value="">— Auto-detect —</option>
                        {SIM_STRATEGIES.map(s=><option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div style={{fontSize:10,color:"#5a7a9a",textAlign:"right",marginTop:6}}>
                      Total: <span style={{color:"#fff",fontWeight:600}}>${((parseFloat(t.premium)||0)*(parseInt(t.contracts)||1)*100).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  <button className="btn bsm" onClick={confirmTrades} disabled={loading} style={{flex:1,opacity:loading?0.5:1}}>{loading?"Saving...":"✅ Confirm"}</button>
                  <button className="btn bsm bdanger" onClick={()=>{setPendingTrades([]);setMissingField(null);}} disabled={loading} style={{flex:1}}>✕ Cancel</button>
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

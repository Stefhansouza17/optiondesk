import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchAssets,
  addAsset as dbAddAsset,
  addLeap,
  addTrade,
  updateTrade,
  deleteTrade,
  updateLeap,
  deleteLeap,
  closeAsset as dbCloseAsset,
  fetchStrategies,
  createStrategy as dbCreateStrategy,
  linkTradeToStrategy,
  detachTradeFromStrategy,
  moveTradeToStrategy,
} from "./supabase";

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
  return (Array.isArray(raw) ? raw : [raw])
    .map((item) => ({
      ...item,
      symbol: String(item?.symbol || item?.root_symbol || "").toUpperCase(),
      description: item?.description || item?.name || "",
    }))
    .filter((item) => item.symbol)
    .slice(0, 8);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n, d=2) => Number(n||0).toLocaleString("en-US", {
  minimumFractionDigits: d,
  maximumFractionDigits: d,
});
const COLORS = ["#63E6BE","#FFD84D","#5B8CFF","#ff6b9d","#B37CFF","#fb923c"];

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
const LEAP_OPEN_STRATEGIES = new Set(["LEAP_OPEN","LEAP Open","LEAP open"]);
const LEAP_CLOSE_STRATEGIES = new Set(["LEAP_CLOSE","LEAP Close","LEAP close"]);
const THETA_EXCLUDED_STRATEGIES = new Set([...LEAP_OPEN_STRATEGIES,...LEAP_CLOSE_STRATEGIES]);
const STRATEGY_TYPES = ["Long Call","Long Put","Covered Call","Cash Secured Put","PMCC","Bull Call Spread","Bear Put Spread","Bull Put Spread","Bear Call Spread","Iron Condor","Straddle","Strangle"];
const SIM_STRATEGIES = STRATEGY_TYPES;

const tradeContracts = (trade) => Math.max(1, parseInt(trade?.contracts||1));
const tradePremium = (trade) => parseFloat(trade?.premium||0);
const roundMoney = (n) => Math.round((Number(n)||0)*100)/100;
const tradeDollarValue = (trade) => roundMoney(tradePremium(trade) * tradeContracts(trade) * 100);
const optionType = (trade) => trade?.option_type || "call";
const sameStrikeAndExpiration = (a,b) =>
  Math.abs(parseFloat(a?.strike)-parseFloat(b?.strike))<0.01
  && a?.expiration===b?.expiration;
const isTechnicalLeapTrade = (trade) =>
  THETA_EXCLUDED_STRATEGIES.has(trade?.strategy || "");
const isLeapCloseTrade = (trade, leaps=[]) => {
  const strategy = trade?.strategy || "";
  const notes = (trade?.notes||"").toLowerCase();
  const action = (trade?.action||"").toUpperCase();
  const closesMatchingLeap = action==="SELL"
    && optionType(trade)==="call"
    && trade?.status!=="open"
    && leaps.some(leap=>sameStrikeAndExpiration(trade, leap));
  return LEAP_CLOSE_STRATEGIES.has(strategy)
    || notes.includes("leap close")
    || notes.includes("closing leap")
    || closesMatchingLeap;
};
const hasLeapBacking = (leaps=[]) =>
  leaps.reduce((sum,leap)=>sum+tradeContracts(leap),0)>0;
const parsePositionDate = (value) => {
  if(!value) return NaN;
  return new Date(`${value}T12:00:00`).getTime();
};
const hasEligibleLeapForTrade = (trade, leaps=[]) => {
  const tradeDate = parsePositionDate(trade?.date);
  const tradeExpiration = parsePositionDate(trade?.expiration);
  if(!Number.isFinite(tradeDate) || !Number.isFinite(tradeExpiration)) return false;
  return leaps.some(leap=>{
    const leapDate = parsePositionDate(leap?.date);
    const leapExpiration = parsePositionDate(leap?.expiration);
    return Number.isFinite(leapDate)
      && Number.isFinite(leapExpiration)
      && tradeDate>=leapDate
      && tradeExpiration<leapExpiration;
  });
};
const isThetaShortCallTrade = (trade, leaps=[]) =>
  hasLeapBacking(leaps)
  &&
  (trade?.action||"").toUpperCase()==="SELL"
  && optionType(trade)==="call"
  && hasEligibleLeapForTrade(trade, leaps)
  && !isLeapCloseTrade(trade, leaps);
const sameOptionContract = (a,b) =>
  optionType(a)===optionType(b)
  && sameStrikeAndExpiration(a,b);
const hasOpeningThetaShortCallMatch = (buy, trades=[], leaps=[]) =>
  trades.some(t =>
    isThetaShortCallTrade(t, leaps)
    && sameOptionContract(t, buy)
    && new Date(t?.date||buy?.date||0) <= new Date(buy?.date||0)
  );
const isThetaClosingBuyTrade = (trade, trades=[], leaps=[]) =>
  (trade?.action||"").toUpperCase()==="BUY"
  && optionType(trade)==="call"
  && trade?.status!=="open"
  && !isLeapCloseTrade(trade, leaps)
  && hasOpeningThetaShortCallMatch(trade, trades, leaps);
const hasLeapContracts = (asset) =>
  (asset?.leaps||[]).reduce((sum,l)=>sum+tradeContracts(l),0)>0;
const isThetaEngineTrade = (trade, trades=[], leaps=[]) =>
  isThetaShortCallTrade(trade, leaps)
  || isThetaClosingBuyTrade(trade, trades, leaps);
const thetaEngineOpenCreditDollars = (trades=[], leaps=[]) =>
  trades.reduce((sum,t)=>
    t?.status==="open" && isThetaShortCallTrade(t, leaps) ? sum + tradeDollarValue(t) : sum
  ,0);

function closeTradeLots(lots, contracts, closePremium, multiplier, onClose) {
  let remaining = Math.max(1, parseInt(contracts||1));
  let realized = 0;
  while(remaining>0 && lots.length>0) {
    const lot = lots[0];
    const consumed = Math.min(remaining, lot.remaining);
    realized += onClose(lot.premium, closePremium, consumed, multiplier);
    lot.remaining -= consumed;
    remaining -= consumed;
    if(lot.remaining<=0) lots.shift();
  }
  return roundMoney(realized);
}

const realizedOptionPnLDollars = (trades=[], includeTrade=()=>true) => {
  const longLots = {};
  const shortLots = {};
  const sorted = [...trades]
    .filter(includeTrade)
    .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  return roundMoney(sorted.reduce((realized,t)=>{
    const action = (t?.action||"").toUpperCase();
    const status = t?.status || "open";
    const key = `${optionType(t)}|${parseFloat(t?.strike||0).toFixed(2)}|${t?.expiration||""}`;
    const premium = tradePremium(t);
    const contracts = tradeContracts(t);
    longLots[key] = longLots[key] || [];
    shortLots[key] = shortLots[key] || [];

    if(status==="expired") {
      if(action==="SELL") return realized + tradeDollarValue(t);
      if(action==="BUY") return realized - tradeDollarValue(t);
      return realized;
    }

    if(action==="BUY") {
      if(status!=="open" && shortLots[key].length>0) {
        return realized + closeTradeLots(
          shortLots[key], contracts, premium, 100,
          (openPremium, closePremium, qty, multiplier)=>(openPremium-closePremium)*qty*multiplier
        );
      }
      longLots[key].push({premium, remaining:contracts});
      return realized;
    }

    if(action==="SELL") {
      if(status!=="open" && longLots[key].length>0) {
        return realized + closeTradeLots(
          longLots[key], contracts, premium, 100,
          (openPremium, closePremium, qty, multiplier)=>(closePremium-openPremium)*qty*multiplier
        );
      }
      shortLots[key].push({premium, remaining:contracts});
      return realized;
    }

    return realized;
  },0));
};
const thetaEngineRealizedDollars = (trades=[], leaps=[]) =>
  realizedOptionPnLDollars(trades, t=>isThetaEngineTrade(t, trades, leaps));
const thetaEngineCashDollars = (trades=[], leaps=[]) =>
  roundMoney(thetaEngineRealizedDollars(trades, leaps) + thetaEngineOpenCreditDollars(trades, leaps));
const assetIncomeGeneratedDollars = (trades=[]) =>
  roundMoney(trades.reduce((sum,trade)=>{
    if(isTechnicalLeapTrade(trade) || isLeapCloseTrade(trade)) return sum;
    const action = (trade?.action||"").toUpperCase();
    if(action==="SELL") return sum + tradeDollarValue(trade);
    if(action==="BUY" && trade?.status!=="open") return sum - tradeDollarValue(trade);
    return sum;
  },0) + realizedOptionPnLDollars(trades, isTechnicalLeapTrade));

const strategyLabelForTrade = (trade) => {
  const action = (trade?.action||"").toUpperCase();
  const type = trade?.option_type || "call";
  if(action==="BUY" && type==="call") return "Long Call";
  if(action==="BUY" && type==="put") return "Long Put";
  if(action==="SELL" && type==="put") return "Cash Secured Put";
  if(action==="SELL" && type==="call") return "Covered Call";
  return "Long Call";
};

const activeStrategyLink = (trade) => trade?.strategyLink || null;

const getAssignedStrategy = (trade, strategies=[]) => {
  const link = activeStrategyLink(trade);
  return link ? strategies.find(s=>s.id===link.strategy_id) || link.strategy : null;
};

const withConfirmedStrategyLink = (strategies, strategyId, link, fallbackStrategy=null) => {
  if(!strategyId || !link) return strategies;
  const normalizedLink = {...link, strategy_id:strategyId, assignment_status:"confirmed", detached_at:null};
  const upsertLink = (strategy) => ({
    ...strategy,
    links:[
      ...((strategy.links||[]).filter(l=>l.trade_id!==normalizedLink.trade_id)),
      normalizedLink,
    ],
  });
  const found = strategies.some(s=>s.id===strategyId);
  if(found) return strategies.map(s=>s.id===strategyId ? upsertLink(s) : s);
  return fallbackStrategy ? [...strategies, upsertLink({...fallbackStrategy, links:[]})] : strategies;
};

const normalizeTicker = (v) => (v||"").toUpperCase();

function buildStrategySuggestions({ trade, asset, strategies=[] }) {
  const ticker = normalizeTicker(asset?.ticker || trade?.ticker || asset?.id);
  const action = (trade?.action||"").toUpperCase();
  const optType = trade?.option_type || "call";
  const existing = strategies
    .filter(s=>s.status!=="archived" && normalizeTicker(s.ticker)===ticker)
    .map(s=>({
      kind:"existing",
      strategy:s,
      title:s.name,
      strategyType:s.strategy_type,
      confidence:"Possible match",
      reason:`Existing ${s.strategy_type} for ${ticker}.`,
    }));

  const newTypes = [];
  const hasLeaps = (asset?.leaps||[]).length > 0;
  const openTrades = (asset?.trades||[]).filter(t=>t.status==="open" && t.id!==trade?.id);
  const sameExp = openTrades.filter(t=>t.expiration===trade?.expiration);
  const hasSameExpCall = sameExp.some(t=>(t.option_type||"call")==="call" && t.action!==action);
  const hasSameExpPut = sameExp.some(t=>(t.option_type||"call")==="put" && t.action!==action);
  const hasCallAndPut = sameExp.some(t=>(t.option_type||"call")==="call") && sameExp.some(t=>(t.option_type||"call")==="put");

  const pushNew = (strategyType, confidence, reason) => {
    if(!newTypes.some(s=>s.strategyType===strategyType)) {
      newTypes.push({kind:"new", strategyType, title:strategyType, confidence, reason});
    }
  };

  if(action==="BUY" && optType==="call") pushNew("Long Call","Strong match","Buying a call can be tracked as a Long Call.");
  if(action==="BUY" && optType==="put") pushNew("Long Put","Strong match","Buying a put can be tracked as a Long Put.");
  if(action==="SELL" && optType==="put") pushNew("Cash Secured Put","Strong match","Selling a put can be tracked as a Cash Secured Put.");
  if(action==="SELL" && optType==="call") {
    pushNew("Covered Call","Possible match","Use this if the short call is secured by shares.");
    pushNew("PMCC",hasLeaps?"Strong match":"Possible match",hasLeaps?"You have an open long-dated call/LEAP on this ticker.":"Use this if the short call belongs against a LEAP.");
  }
  if(optType==="call" && hasSameExpCall) {
    pushNew(action==="BUY" ? "Bull Call Spread" : "Bear Call Spread","Possible match","There is an open call with the same expiration.");
  }
  if(optType==="put" && hasSameExpPut) {
    pushNew(action==="BUY" ? "Bear Put Spread" : "Bull Put Spread","Possible match","There is an open put with the same expiration.");
  }
  if(hasCallAndPut) {
    pushNew("Straddle","Weak match","There are calls and puts with the same expiration.");
    pushNew("Strangle","Weak match","There are calls and puts with the same expiration.");
    pushNew("Iron Condor","Weak match","Multiple same-expiration option legs may form a defined-risk income strategy.");
  }
  if(!newTypes.length) pushNew(strategyLabelForTrade(trade),"Possible match","This is the closest single-leg strategy type.");

  return [...existing, ...newTypes].slice(0, 8);
}

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
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:'IBM Plex Mono','DM Mono',monospace;background:#050A0F;color:#D6E2F0;-webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#071019}::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px}
.hdr{border-bottom:1px solid #1B2A3A;padding:13px 24px;display:flex;align-items:center;justify-content:space-between;background:rgba(10,20,35,0.97);position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
.logo{display:inline-flex;align-items:center;gap:16px;font-family:'Syne',sans-serif;font-size:20px;font-weight:760;color:#fff;cursor:pointer;user-select:none;line-height:1.18}
.logo-mark{width:52px;height:52px;border-radius:0;object-fit:contain;filter:drop-shadow(0 6px 14px rgba(99,230,190,.16));flex-shrink:0}
.logo-lockup{display:inline-flex;align-items:center;gap:8px}
.logo-name{background:linear-gradient(105deg,#FFFFFF 0%,#F4FFFB 58%,#8EF0D0 100%);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;letter-spacing:0}
.beta-badge{font-family:'DM Mono','IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.8px;line-height:1;text-transform:uppercase;color:rgba(142,240,208,.68);background:rgba(99,230,190,.07);border:1px solid rgba(142,240,208,.16);border-radius:3px;padding:3px 6px}
.badge{font-size:10px;background:#0a2a1a;color:#63E6BE;border:1px solid #63E6BE33;padding:3px 8px;border-radius:3px;letter-spacing:1px;text-transform:uppercase}
.home-btn{background:#1B2A3A;border:1px solid #2a3a4a;color:#8aaac8;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:11px;transition:all 0.2s}
.home-btn:hover{background:#2a3a4a;color:#D6E2F0}
.tabs{display:flex;border-bottom:1px solid #1B2A3A;padding:0 24px;background:#071019;overflow-x:auto}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:#7D91AA;padding:10px 16px;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:12px;font-weight:500;transition:all 0.2s;margin-bottom:-1px;white-space:nowrap}
.tab:hover{color:#D6E2F0}
.tab.active{color:var(--tc);border-bottom-color:var(--tc)}
.add-tab{background:none;border:none;color:#4A6A8A;padding:10px 12px;cursor:pointer;font-size:18px;transition:color 0.2s;margin-bottom:-1px}
.add-tab:hover{color:#63E6BE}
.learn-nav{position:relative;margin-left:auto;display:flex}
.learn-tab{display:inline-flex;align-items:center;gap:6px}
.learn-chevron{font-size:9px;color:inherit;line-height:1;transform:translateY(-1px)}
.learn-menu{display:none;position:fixed;top:94px;right:24px;min-width:150px;background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:5px;z-index:500;box-shadow:0 18px 44px rgba(0,0,0,.42)}
.learn-menu::before{content:'';position:absolute;left:0;right:0;top:-8px;height:8px}
.learn-nav:hover .learn-menu,.learn-nav.open .learn-menu,.learn-menu:hover{display:block}
.learn-menu button{display:block;width:100%;background:none;border:none;border-radius:5px;color:#8aaac8;padding:8px 10px;text-align:left;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:11px;transition:all .15s}
.learn-menu button:hover,.learn-menu button.active{background:#071019;color:#D6E2F0}
.subnav{display:flex;gap:4px;padding:12px 24px 0}
.snbtn{background:none;border:none;color:#7D91AA;padding:7px 12px;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:11px;letter-spacing:0.5px;border-radius:4px;transition:all 0.2s;text-transform:uppercase}
.snbtn:hover{color:#D6E2F0;background:#1B2A3A}
.snbtn.active{color:var(--ac,#63E6BE);background:#0a2a1a;border:1px solid #63E6BE33}
.main{padding:12px 20px;max-width:1500px;margin:0 auto}
.pbar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;margin:14px 24px 0;flex-wrap:wrap}
.tlbl{font-family:'Syne',sans-serif;font-size:15px;font-weight:760;line-height:1.18}
.pinput{background:#071019;border:1px solid #1B2A3A;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:18px;font-weight:500;padding:4px 10px;border-radius:4px;width:100px;text-align:right}
.pinput:focus{outline:none;border-color:#63E6BE66}
.dvdr{width:1px;height:18px;background:#1B2A3A;flex-shrink:0}
.sml{font-size:11px;color:#7D91AA;white-space:nowrap}
.sml span{color:#D6E2F0;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px}
.card{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:12px 16px;position:relative;overflow:visible;transition:border-color 0.2s}
.card:hover{border-color:#2a4a6a}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--top,#1a3a5a);border-radius:8px 8px 0 0}
.clbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#7D91AA;margin-bottom:7px;display:flex;align-items:center;gap:4px}
.cval{font-family:'IBM Plex Mono','DM Mono',monospace;font-size:20px;font-weight:650;color:#fff;line-height:1.18;margin-bottom:4px;letter-spacing:0}
.csub{font-size:11px;color:#7D91AA}
.sec{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;margin-bottom:12px}
.sechdr{padding:12px 16px;border-bottom:1px solid #1B2A3A;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sectitle{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#7D91AA;display:flex;align-items:center;gap:4px}
.btn{background:#63E6BE15;border:1px solid #63E6BE44;color:#63E6BE;padding:6px 12px;border-radius:4px;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:11px;letter-spacing:0.5px;transition:all 0.2s}
.btn:hover{opacity:0.8}
.btn:disabled{opacity:0.4;cursor:not-allowed}
.bsm{padding:3px 9px;font-size:10px}
.bdanger{background:#FF4D6D10;border-color:#FF4D6D44;color:#FF4D6D}
.bneutral{background:#1B2A3A;border-color:#2a3a4a;color:#8aaac8}
.bwarn{background:#FFD84D15;border-color:#FFD84D44;color:#FFD84D}
.ptrack{height:6px;background:#1B2A3A;border-radius:3px;overflow:hidden}
.pfill{height:100%;border-radius:3px;transition:width 0.5s ease}
table{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono','DM Mono',monospace}
th{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#4A6A8A;padding:9px 16px;text-align:left;border-bottom:1px solid #1B2A3A;font-weight:400}
td{padding:10px 16px;font-size:12px;border-bottom:1px solid #0f1e2e;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#101e2c}
.stopen{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.stclosed{display:inline-block;padding:2px 8px;background:#1B2A3A;border:1px solid #2a3a4a;color:#7D91AA;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.stexpired{display:inline-block;padding:2px 8px;background:#B37CFF15;border:1px solid #B37CFF44;color:#B37CFF;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:200}
.fbox{background:#0B131D;border:1px solid #1B2A3A;border-radius:12px;padding:24px;width:480px;max-width:95vw;box-shadow:0 40px 80px rgba(0,0,0,0.6);max-height:90vh;overflow-y:auto}
.ftitle{font-family:'Syne',sans-serif;font-size:16px;font-weight:760;color:#fff;line-height:1.2;margin-bottom:16px}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.fgrp{display:flex;flex-direction:column;gap:4px}
.flbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#7D91AA}
.finput,.fsel{background:#071019;border:1px solid #1B2A3A;color:#D6E2F0;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:13px;padding:7px 11px;border-radius:4px;width:100%;transition:border-color 0.2s}
.finput:focus,.fsel:focus{outline:none;border-color:#63E6BE66}
.fsel option{background:#0B131D}
.fsel.sm{font-size:11px;padding:4px 8px;width:auto}
.factions{display:flex;gap:10px;margin-top:16px}
.bfull{flex:1;padding:9px;font-size:12px}
.lgrid{display:grid;grid-template-columns:repeat(3,1fr)}
.litem{padding:12px 16px;border-right:1px solid #1B2A3A;border-bottom:1px solid #1B2A3A}
.litem:nth-child(3n){border-right:none}
.litem:nth-last-child(-n+3){border-bottom:none}
.llbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#4A6A8A;margin-bottom:3px}
.lval{font-size:14px;color:#D6E2F0;font-weight:500}
.empty{padding:22px;text-align:center;color:#4A6A8A;font-size:12px}
.start-desk{background:linear-gradient(135deg,#0B131D,#071019);border:1px solid #1B2A3A;border-radius:8px;margin-bottom:12px;padding:18px;display:grid;grid-template-columns:minmax(260px,.95fr) 1.5fr;gap:18px;align-items:stretch}
.start-kicker,.priority-kicker{font-size:10px;letter-spacing:1.8px;text-transform:uppercase;color:#63E6BE;margin-bottom:7px}
.start-title{font-family:'Syne',sans-serif;font-size:26px;font-weight:760;color:#fff;line-height:1.18;margin-bottom:8px}
.start-copy{font-size:12px;color:#B7C9EA;line-height:1.65;max-width:420px}
.start-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.start-card{background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:14px;display:flex;flex-direction:column;justify-content:space-between;min-height:142px}
.start-step{font-size:10px;color:var(--accent,#63E6BE);letter-spacing:1.2px;text-transform:uppercase;margin-bottom:10px}
.start-card-title{font-family:'Syne',sans-serif;font-size:16px;font-weight:760;color:#fff;line-height:1.2;margin-bottom:6px}
.start-card-copy{font-size:11px;color:#8aaac8;line-height:1.45;margin-bottom:12px}
.start-action{align-self:flex-start;background:color-mix(in srgb,var(--accent,#63E6BE) 11%,transparent);border:1px solid color-mix(in srgb,var(--accent,#63E6BE) 35%,transparent);color:var(--accent,#63E6BE);border-radius:4px;padding:6px 9px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;cursor:pointer}
.priority-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:760;color:#fff;line-height:1.18}
.priority-copy{font-size:11px;color:#7D91AA;margin-top:7px;line-height:1.45}
.priority-label{font-size:9px;letter-spacing:1.3px;text-transform:uppercase;color:var(--pc,#63E6BE);margin-bottom:8px}
.priority-main{font-family:'Syne',sans-serif;font-size:15px;font-weight:760;color:#fff;line-height:1.18;margin-bottom:8px}
.priority-meta{font-size:11px;color:#8aaac8;line-height:1.45}
.priority-strip{display:grid;grid-template-columns:minmax(250px,.82fr) minmax(420px,1.65fr);align-items:center;gap:12px;width:100%}
.priority-strip-main{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.priority-strip-title{font-family:'Syne',sans-serif;font-size:15px;font-weight:760;color:#fff;line-height:1.18}
.priority-strip-copy{font-size:10px;color:#7D91AA;margin-top:3px;letter-spacing:0;text-transform:none}
.risk-legend{display:flex;align-items:center;justify-content:flex-start;gap:14px;flex-wrap:wrap}
.risk-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#8aaac8;white-space:nowrap}
.risk-dot{--risk:#63E6BE;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--risk);box-shadow:0 0 0 0 color-mix(in srgb,var(--risk) 42%,transparent);animation:riskPulse 1.55s infinite;flex-shrink:0}
.risk-dot.muted{opacity:.28;animation:none}
@keyframes riskPulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--risk) 48%,transparent)}70%{box-shadow:0 0 0 7px color-mix(in srgb,var(--risk) 0%,transparent)}100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--risk) 0%,transparent)}}
.empty-title{font-family:'Syne',sans-serif;font-size:16px;font-weight:760;color:#fff;line-height:1.2;margin-bottom:6px}
.empty-copy{color:#8aaac8;line-height:1.5;max-width:540px}
.empty-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px}
.toggle-group{display:flex;background:#0B131D;border:1px solid #1B2A3A;border-radius:12px;padding:3px;gap:2px}
.tgl{background:none;border:none;padding:7px 18px;border-radius:9px;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:11px;font-weight:600;transition:all 0.2s;color:#7D91AA}
.green{color:#63E6BE!important}
.red{color:#FF4D6D!important}
.yellow{color:#FFD84D!important}
.strat-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.strat-chip{border:1px solid #1B2A3A;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:12px;color:#D6E2F0;transition:all 0.2s;background:transparent}
.strat-chip:hover{border-color:#4A6A8A}
.strat-chip.active{border-color:#63E6BE;background:#63E6BE15;color:#63E6BE}
.tooltip-wrap{position:relative;display:inline-flex;align-items:center}
.tooltip-icon{cursor:help;font-size:10px;color:#4A6A8A;background:#1B2A3A;border:1px solid #2a3a4a;border-radius:50%;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:600;margin-left:4px;flex-shrink:0}
.tooltip-box{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#1B2A3A;border:1px solid #2a3a4a;border-radius:6px;padding:8px 12px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#D6E2F0;z-index:999;box-shadow:0 4px 20px rgba(0,0,0,0.4);width:200px;line-height:1.55;pointer-events:none}
.tooltip-box.below{bottom:auto;top:calc(100% + 6px)}
.fade-in{animation:fadeIn 0.3s ease-in}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#63E6BE;margin-right:6px;animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(0,212,170,0.5)}70%{box-shadow:0 0 0 7px rgba(0,212,170,0)}100%{box-shadow:0 0 0 0 rgba(0,212,170,0)}}
.learn-main{padding-top:34px;max-width:1180px}
.learn-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin:0 0 34px}
.learn-kicker{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#63E6BE;margin-bottom:9px}
.learn-title{font-family:'Syne',sans-serif;font-size:34px;font-weight:760;color:#fff;line-height:1.18}
.learn-copy{font-size:13px;color:#B7C9EA;line-height:1.7;max-width:420px}
.learn-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.learn-card{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:28px;position:relative;min-height:270px;display:flex;flex-direction:column;justify-content:space-between;transition:all .18s;cursor:pointer;overflow:hidden}
.learn-card:hover{border-color:var(--accent,#63E6BE);transform:translateY(-2px);box-shadow:0 22px 56px rgba(0,0,0,.32)}
.learn-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent,#63E6BE);opacity:.8}
.learn-icon{width:38px;height:38px;border-radius:8px;border:1px solid color-mix(in srgb,var(--accent,#63E6BE) 34%,transparent);background:color-mix(in srgb,var(--accent,#63E6BE) 10%,transparent);color:var(--accent,#63E6BE);display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:14px;font-weight:650;margin-bottom:26px}
.learn-card-title{font-family:'Syne',sans-serif;font-size:24px;font-weight:760;color:#fff;line-height:1.18;margin-bottom:10px}
.learn-card-copy{font-size:13px;color:#9EB9E9;line-height:1.55;max-width:220px}
.learn-card-action{align-self:flex-start;font-size:11px;color:var(--accent,#63E6BE);letter-spacing:.7px;margin-top:28px;padding:7px 12px;border:1px solid color-mix(in srgb,var(--accent,#63E6BE) 32%,transparent);border-radius:4px;background:color-mix(in srgb,var(--accent,#63E6BE) 8%,transparent)}
.learn-card.disabled{cursor:default;opacity:.72}
.learn-card.disabled:hover{transform:none;border-color:#1B2A3A;box-shadow:none}
.glossary-tools{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:12px;align-items:center;margin-bottom:16px}
.glossary-search{background:#071019;border:1px solid #1B2A3A;color:#D6E2F0;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:13px;padding:11px 13px;border-radius:6px;width:100%;min-width:0}
.glossary-search:focus{outline:none;border-color:#FFD84D88;box-shadow:0 0 0 2px #FFD84D12}
.glossary-filters{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.glossary-filter{background:#071019;border:1px solid #1B2A3A;color:#8aaac8;border-radius:5px;padding:8px 10px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;letter-spacing:.5px;cursor:pointer;transition:all .16s}
.glossary-filter:hover{border-color:#FFD84D55;color:#D6E2F0}
.glossary-filter.active{background:#FFD84D15;border-color:#FFD84D66;color:#FFD84D}
.glossary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.term-card{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:16px;text-align:left;cursor:pointer;transition:all .16s;min-height:148px;display:flex;flex-direction:column;gap:10px}
.term-card:hover{border-color:#FFD84D66;background:#101A27;transform:translateY(-1px)}
.term-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.term-name{font-family:'Syne',sans-serif;font-size:18px;font-weight:760;color:#fff;line-height:1.2}
.term-category{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#FFD84D;border:1px solid #FFD84D44;background:#FFD84D12;border-radius:4px;padding:3px 6px;white-space:nowrap}
.term-definition{font-size:12px;color:#9EB9E9;line-height:1.55}
.glossary-empty{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:26px;text-align:center;color:#7D91AA;font-size:12px}
.term-modal-section{background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:12px;margin-bottom:10px}
.term-modal-label{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#4A6A8A;margin-bottom:6px}
.term-modal-copy{font-size:12px;color:#D6E2F0;line-height:1.6}
.related-terms{display:flex;gap:6px;flex-wrap:wrap}
.related-term{border:1px solid #2a3a4a;background:#1B2A3A;color:#8aaac8;border-radius:4px;padding:5px 8px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;cursor:pointer;transition:all .16s}
.related-term:hover{border-color:#FFD84D66;color:#FFD84D;background:#FFD84D12}
.playbook-tools{display:flex;justify-content:flex-end;margin-bottom:16px}
.playbook-filters{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.playbook-filter{background:#071019;border:1px solid #1B2A3A;color:#8aaac8;border-radius:5px;padding:8px 10px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;letter-spacing:.5px;cursor:pointer;transition:all .16s}
.playbook-filter:hover{border-color:#5B8CFF66;color:#D6E2F0}
.playbook-filter.active{background:#5B8CFF15;border-color:#5B8CFF66;color:#9EB9E9}
.playbook-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.playbook-card{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:16px;text-align:left;cursor:pointer;transition:all .16s;min-height:168px;display:flex;flex-direction:column;justify-content:space-between;gap:14px}
.playbook-card:hover{border-color:#5B8CFF66;background:#101A27;transform:translateY(-1px)}
.playbook-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.playbook-title{font-family:'Syne',sans-serif;font-size:19px;font-weight:760;color:#fff;line-height:1.2}
.playbook-category{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#9EB9E9;border:1px solid #5B8CFF44;background:#5B8CFF12;border-radius:4px;padding:3px 6px;white-space:nowrap}
.playbook-summary{font-size:12px;color:#9EB9E9;line-height:1.5}
.playbook-action{font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;letter-spacing:.5px;color:#5B8CFF}
.playbook-modal-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:12px}
.playbook-section{background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:12px;min-width:0}
.playbook-label{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#4A6A8A;margin-bottom:6px}
.playbook-copy{font-size:12px;color:#D6E2F0;line-height:1.55}
.playbook-list{margin:0;padding-left:16px;color:#D6E2F0;font-size:12px;line-height:1.55}
.playbook-list li{margin:0 0 5px}
.playbook-related{display:flex;gap:6px;flex-wrap:wrap}
.playbook-related-btn{border:1px solid #2a3a4a;background:#1B2A3A;color:#8aaac8;border-radius:4px;padding:5px 8px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;cursor:pointer;transition:all .16s}
.playbook-related-btn:hover{border-color:#5B8CFF66;color:#9EB9E9;background:#5B8CFF12}
.calc-page{padding-top:28px;max-width:1180px}
.calc-page .learn-head{align-items:flex-start;margin-bottom:18px}
.calc-page .learn-title{font-size:clamp(23px,3vw,30px)}
.calc-subtitle{font-size:13px;color:#8aaac8;margin-top:8px}
.calc-head-kicker-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:9px}
.calc-head-kicker-row .learn-kicker{margin-bottom:0}
.calc-panel-cta{margin-top:2px;background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:14px}
.calc-panel-cta .calc-cta-title{font-size:14px;margin-bottom:6px}
.calc-panel-cta .calc-cta-copy{font-size:11px;line-height:1.55}
.calc-panel-cta .btn{margin-top:12px}
.calc-wrap{display:grid;grid-template-columns:minmax(320px,380px) 1fr;gap:18px;align-items:stretch}
.calc-panel{background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:22px;min-width:0}
.calc-form{display:grid;gap:14px}
.return-field-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.return-toggle{display:inline-flex;align-items:center;background:#071019;border:1px solid #1B2A3A;border-radius:6px;padding:2px;flex-shrink:0}
.return-toggle button{border:0;background:transparent;color:#7D91AA;border-radius:4px;padding:4px 7px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:9px;letter-spacing:.4px;cursor:pointer;text-transform:uppercase}
.return-toggle button.active{background:#132033;color:#D6E2F0}
.calc-results{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px}
.calc-result{background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:16px;min-width:0;overflow:hidden}
.calc-result-label{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#7D91AA;margin-bottom:9px}
.calc-result-value{font-family:'IBM Plex Mono','DM Mono',monospace;font-size:clamp(15px,1.35vw,20px);font-weight:650;color:#fff;line-height:1.2;white-space:nowrap;letter-spacing:0}
.breakdown-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.full-chart-btn{background:#0B131D;border:1px solid #1B2A3A;color:#9EB9E9;border-radius:5px;padding:7px 10px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;letter-spacing:.4px;cursor:pointer;transition:all .18s}
.full-chart-btn:hover{border-color:#63E6BE66;color:#D6E2F0;background:#101A27}
.investment-breakdown{display:grid;grid-template-columns:250px 1fr;gap:12px}
.breakdown-card{background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:14px;min-width:0}
.donut-wrap{display:flex;align-items:center;justify-content:center;gap:14px;min-height:170px}
.donut-legend{display:grid;gap:8px;font-size:11px;color:#8aaac8}
.legend-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px}
.legend-value{display:block;color:#D6E2F0;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:14px;font-weight:650;margin-top:2px}
.calc-chart{height:210px;background:#071019;border:1px solid #1B2A3A;border-radius:8px;padding:12px}
.chart-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.chart-toggle{display:inline-flex;align-items:center;background:#0B131D;border:1px solid #1B2A3A;border-radius:6px;padding:2px}
.chart-toggle button{border:0;background:transparent;color:#7D91AA;border-radius:4px;padding:4px 8px;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:10px;cursor:pointer}
.chart-toggle button.active{background:#132033;color:#D6E2F0}
.chart-legend{display:flex;justify-content:flex-end;gap:14px;font-size:10px;color:#8aaac8}
.chart-caption{text-align:center;font-size:10px;color:#7D91AA;letter-spacing:1.2px;margin-top:4px;font-family:'IBM Plex Mono','DM Mono',monospace}
.monthly-return-table{margin-top:14px;background:#071019;border:1px solid #1B2A3A;border-radius:8px;overflow:hidden}
.monthly-return-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #1B2A3A}
.monthly-return-note{font-size:10px;color:#7D91AA}
.monthly-return-scroll{max-height:300px;overflow:auto}
.monthly-return-table th,.monthly-return-table td{text-align:right;white-space:nowrap}
.monthly-return-table th:first-child,.monthly-return-table td:first-child{text-align:left}
.monthly-return-table td:nth-child(2){color:#63E6BE}
.monthly-return-table td:nth-child(4){color:#FFD84D}
.chart-modal{width:min(90vw,1220px);max-height:88vh;background:#071019;border:1px solid #22364A;border-radius:10px;box-shadow:0 28px 90px rgba(0,0,0,.64);padding:22px;display:flex;flex-direction:column;gap:16px;overflow:hidden}
.chart-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;border-bottom:1px solid #1B2A3A;padding-bottom:14px}
.chart-modal-title{font-family:'Syne',sans-serif;font-size:26px;font-weight:760;color:#fff;line-height:1.18}
.chart-modal-subtitle{font-size:12px;color:#8aaac8;margin-top:8px}
.modal-close{background:#0B131D;border:1px solid #1B2A3A;color:#D6E2F0;border-radius:6px;width:34px;height:34px;cursor:pointer;font-size:18px;line-height:1}
.chart-modal-body{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:16px;min-height:0;flex:1;overflow-y:auto}
.expanded-chart-card,.milestones-card{background:#050A0F;border:1px solid #1B2A3A;border-radius:8px;padding:16px;min-width:0;position:relative}
.expanded-chart-card{display:flex;flex-direction:column;gap:10px}
.expanded-chart-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#8aaac8;justify-content:flex-end}
.expanded-chart{height:270px}
.chart-tooltip{position:absolute;min-width:238px;background:#0B131D;border:1px solid #2C425C;border-radius:8px;padding:12px;box-shadow:0 18px 48px rgba(0,0,0,.5);pointer-events:none;color:#D6E2F0;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:1.55;z-index:2}
.chart-tooltip-title{font-family:'Syne',sans-serif;font-weight:760;color:#fff;font-size:15px;line-height:1.18;margin-bottom:6px}
.chart-tooltip-row{display:flex;justify-content:space-between;gap:12px}
.chart-tooltip-row span:last-child{font-family:'IBM Plex Mono','DM Mono',monospace;font-weight:650;color:#fff}
.milestones-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:760;color:#fff;line-height:1.18;margin-bottom:12px}
.milestone-list{display:grid;gap:10px}
.milestone{border:1px solid #1B2A3A;background:#071019;border-radius:7px;padding:12px}
.milestone-target{font-family:'IBM Plex Mono','DM Mono',monospace;font-size:20px;font-weight:650;color:#fff;line-height:1.18}
.milestone-status{font-size:11px;color:#8aaac8;margin-top:8px}
.milestone-status.reached{color:#63E6BE}
.calc-cta{margin-top:18px;background:#0B131D;border:1px solid #1B2A3A;border-radius:8px;padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:18px}
.calc-cta-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:760;color:#fff;line-height:1.18;margin-bottom:6px}
.calc-cta-copy{font-size:12px;color:#8aaac8;line-height:1.55;max-width:720px}
/* ── Simulator ── */
.sim-wrap{display:flex;border:1px solid #22364A;border-radius:8px;overflow:hidden;margin-top:0;background:#050A0F;min-height:690px;box-shadow:0 26px 80px rgba(0,0,0,.52),inset 0 1px 0 rgba(255,255,255,.035);font-family:'DM Mono','IBM Plex Mono',monospace}
.sim-left{width:326px;flex-shrink:0;border-right:1px solid #22364A;background:radial-gradient(circle at 18% 0%,rgba(91,140,255,.08),transparent 33%),linear-gradient(180deg,#071019,#050A0F);overflow-y:auto;padding:16px 16px;display:flex;flex-direction:column;gap:14px}
.sim-right{flex:1;overflow:hidden;display:flex;flex-direction:column;min-width:0;background:linear-gradient(180deg,#050A0F,#071019)}
.sim-slbl{font-size:11px;letter-spacing:2.15px;text-transform:uppercase;color:#B7C9EA;margin-bottom:10px;font-weight:700;font-family:'DM Mono','IBM Plex Mono',monospace}
.sim-strike-box{background:#071019;border:1px solid #1B2A3A;border-radius:9px;padding:10px 11px}
.sim-strike-big{font-family:'IBM Plex Mono','DM Mono',monospace;font-size:23px;font-weight:650;color:#FFD84D;flex:1;letter-spacing:0;line-height:1.18}
.sim-strike-input{background:#0B131D;border:1px solid #FFD84D44;color:#FFD84D;font-family:'IBM Plex Mono','DM Mono',monospace;font-size:12px;padding:4px 8px;border-radius:5px;width:76px;text-align:center}
.sim-strike-input:focus{outline:none;border-color:#FFD84Daa}
.sim-chip{background:#071019;border:1px solid #102033;color:#AFC4E9;padding:7px 9px;border-radius:8px;cursor:pointer;font-family:'DM Mono','IBM Plex Mono',monospace;font-size:12px;white-space:nowrap;flex-shrink:0;transition:all .15s;min-width:50px}
.sim-chip:hover{border-color:#22364A;color:#D6E2F0;background:#0B131D}
.sim-chip.sel{background:#0F2A66;border-color:#5B8CFF;color:#D6E2F0;font-weight:700;box-shadow:0 0 0 1px rgba(91,140,255,.24),0 0 20px rgba(91,140,255,.32)}
.sim-chip.atm{border-color:#63E6BE55;color:#63E6BE}
.sim-metric{background:linear-gradient(180deg,#0B131D,#071019);border:1px solid #22364A;border-radius:6px;padding:15px 14px;position:relative;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}
.sim-metric::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:var(--mt);opacity:.7}
.sim-metric-lbl{font-size:10px;letter-spacing:.8px;text-transform:uppercase;color:#9EB9E9;margin-bottom:7px;font-family:'DM Mono','IBM Plex Mono',monospace}
.sim-metric-val{font-family:'DM Mono','IBM Plex Mono',monospace;font-size:20px;font-weight:800;color:var(--mc);letter-spacing:-.3px}
.sim-timeline{border-bottom:1px solid #22364A;background:#071019;padding:13px 17px;flex-shrink:0;overflow-x:auto}
.sim-timeline::-webkit-scrollbar,.sim-matrix::-webkit-scrollbar{height:5px;width:5px}
.sim-timeline::-webkit-scrollbar-thumb,.sim-matrix::-webkit-scrollbar-thumb{background:#22364A;border-radius:4px}
.sim-exp-btn{background:#050A0F;border:1px solid #1B2A3A;color:#AFC4E9;padding:10px 14px;border-radius:18px;cursor:pointer;font-family:'DM Mono','IBM Plex Mono',monospace;font-size:15px;font-weight:700;white-space:nowrap;flex-shrink:0;transition:all .15s;min-width:52px;text-align:center;line-height:1.1}
.sim-exp-btn:hover{border-color:#2a4a6a;color:#D6E2F0;background:#0B131D}
.sim-exp-btn.sel{background:#9CFAC8;border-color:#9CFAC8;color:#050A0F;font-weight:800;box-shadow:0 0 0 2px rgba(99,230,190,.14),0 0 24px rgba(99,230,190,.62),0 0 44px rgba(99,230,190,.2)}
.sim-dir-row{display:flex;gap:6px}
.sim-toolbar{display:flex;align-items:center;gap:18px;padding:13px 19px;border-top:1px solid #0B131D;border-bottom:1px solid #22364A;background:#050A0F;flex-shrink:0;flex-wrap:wrap}
.sim-view-group{display:flex;background:#050A0F;border:1px solid #22364A;border-radius:8px;padding:2px;gap:6px}
.sim-view-btn{background:#050A0F;border:1px solid transparent;padding:8px 18px;border-radius:7px;cursor:pointer;font-family:'DM Mono','IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:#9EB9E9;letter-spacing:.4px;transition:all .15s}
.sim-view-btn.sel{background:#0F2A66;color:#D6E2F0;border-color:#3558C9;box-shadow:0 0 18px rgba(91,140,255,.2)}
.sim-range-track{height:12px;appearance:none;background:linear-gradient(90deg,#273DFF,#5B8CFF);border-radius:8px;outline:none}
.sim-range-track::-webkit-slider-thumb{appearance:none;width:22px;height:22px;border-radius:50%;background:#5B8CFF;border:2px solid #5B8CFF;box-shadow:0 0 16px rgba(91,140,255,.55);cursor:pointer}
.sim-matrix{flex:1;overflow:auto;background:#050A0F}
.sim-th{position:sticky;top:0;z-index:10;background:#071019;font-size:11px;letter-spacing:1px;color:#7D91AA;padding:11px 12px;text-align:center;border-bottom:1px solid #22364A;border-right:1px solid #050A0F;white-space:nowrap;font-weight:500;font-family:'DM Mono','IBM Plex Mono',monospace;text-transform:uppercase}
.sim-th.sp1{position:sticky;left:0;z-index:15;text-align:left;padding-left:20px;min-width:118px;background:#071019;border-right:1px solid #22364A}
.sim-th.sp2{position:sticky;left:118px;z-index:15;min-width:70px;background:#071019;border-right:1px solid #22364A}
.sim-th.sel-exp{color:#63E6BE;font-weight:800;background:#092017;box-shadow:inset 0 -2px 0 #63E6BE,inset 0 0 18px rgba(99,230,190,.08)}
.sim-td{padding:9px 14px;text-align:center;font-size:14px;font-weight:650;border-bottom:1px solid #071019;border-right:1px solid #050A0F;white-space:nowrap;font-family:'DM Mono','IBM Plex Mono',monospace;transition:filter .1s;text-shadow:0 1px 6px rgba(0,0,0,.35)}
.sim-td-price{text-align:left;padding-left:20px;font-size:14px;background:#071019!important;position:sticky;left:0;z-index:5;border-right:1px solid #22364A;border-bottom:1px solid #0B131D;white-space:nowrap;font-family:'DM Mono','IBM Plex Mono',monospace}
.sim-td-pct{font-size:13px;background:#071019!important;position:sticky;left:118px;z-index:5;border-right:1px solid #22364A;border-bottom:1px solid #0B131D;text-align:center;padding:8px 12px;font-family:'DM Mono','IBM Plex Mono',monospace;font-weight:700}
.sim-row-atm .sim-td-price{color:#fff!important;font-weight:800;background:linear-gradient(90deg,#63E6BE14,transparent)!important;box-shadow:inset 3px 0 0 #63E6BE}
.sim-row-atm .sim-td-pct{background:linear-gradient(90deg,#63E6BE0d,transparent)!important}
.sim-row-atm{border-top:1px solid #63E6BE55!important;border-bottom:1px solid #63E6BE33!important}
.sim-row-be{border-top:1px dashed #FFD84D88!important}
tr:hover .sim-td,.sim-row-atm:hover .sim-td-price,.sim-row-atm:hover .sim-td-pct{filter:brightness(1.18)}
@media(max-width:768px){
  html,body{overflow-x:hidden;max-width:100%}
  .hdr{padding:10px 12px;flex-wrap:wrap;gap:6px}
  .hdr>div:last-child{display:none}
  .logo-mark{width:36px;height:36px}
  .logo{font-size:18px}
  .logo-lockup{gap:6px}
  .beta-badge{font-size:8px;padding:3px 5px;letter-spacing:.6px}
  .tabs{padding:0 8px}
  .main{padding:14px 12px;box-sizing:border-box;max-width:100%;overflow-x:hidden}
  .start-desk{grid-template-columns:1fr;padding:15px}
  .start-grid{grid-template-columns:1fr}
  .start-title{font-size:22px}
  .priority-strip{grid-template-columns:1fr;align-items:flex-start}
  .priority-strip-main{width:100%;justify-content:space-between}
  .risk-legend{justify-content:flex-start;gap:8px}
  .pbar{margin:10px 8px 0;padding:8px 12px;box-sizing:border-box}
  .cards{grid-template-columns:1fr 1fr}
  .learn-main,.calc-page{padding-top:18px}
  .learn-head{align-items:flex-start;flex-direction:column}
  .learn-grid{grid-template-columns:1fr}
  .glossary-tools{grid-template-columns:1fr}
  .glossary-filters{justify-content:flex-start}
  .glossary-grid{grid-template-columns:1fr}
  .playbook-tools,.playbook-filters{justify-content:flex-start}
  .playbook-grid{grid-template-columns:1fr}
  .playbook-modal-grid{grid-template-columns:1fr}
  .calc-wrap{grid-template-columns:1fr}
  .calc-results{grid-template-columns:1fr}
  .investment-breakdown{grid-template-columns:1fr}
  .calc-cta{align-items:flex-start;flex-direction:column}
  .return-field-head{align-items:flex-start;flex-direction:column}
  .monthly-return-scroll{overflow-x:auto}
  .chart-modal{width:94vw;max-height:88vh;padding:16px}
  .chart-modal-body{grid-template-columns:1fr;overflow-y:auto}
  .expanded-chart{height:220px}
  .expanded-chart-legend,.chart-top{align-items:flex-start;flex-direction:column}
  .lgrid{grid-template-columns:1fr 1fr}
  .sec table{display:block;overflow-x:auto;width:100%;-webkit-overflow-scrolling:touch}
  .sim-wrap{flex-direction:column;overflow-x:hidden;max-width:100%}
  .sim-left{width:100%!important;flex-shrink:unset;border-right:none!important;border-bottom:1px solid #1B2A3A;box-sizing:border-box;max-width:100%}
  .sim-right{width:100%;max-width:100%;overflow-x:hidden;box-sizing:border-box}
  .sim-timeline{overflow-x:auto;max-width:100%}
  .sim-toolbar{flex-wrap:wrap;max-width:100%;overflow-x:hidden}
  .sim-matrix{overflow-x:auto;max-width:100%}
  .sim-dir-row{flex-wrap:wrap}
  .sim-dir-row .toggle-group{flex:1 1 calc(50% - 3px);min-width:0}
  .tgl{padding:7px 10px;font-size:10px}
  .toggle-group{min-width:0}
}
@media(min-width:769px) and (max-width:1024px){
  .logo-mark{width:44px;height:44px}
  .start-desk{grid-template-columns:1fr}
  .risk-legend{justify-content:center}
}
.ts-tooltip{display:none;position:absolute;bottom:22px;left:-90px;z-index:99;background:#0B131D;border:1px solid #3a6a9a;border-radius:8px;padding:13px 15px;width:250px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#c0d8f0;line-height:1.65;white-space:pre-line;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,.6)}
.ts-tooltip b{color:#D6E2F0;display:block;margin-bottom:4px;font-size:10px}
div:hover>.ts-tooltip{display:block}
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
          background:"#1B2A3A",
          border:"1px solid #2a3a4a",
          borderRadius:6,
          padding:"8px 12px",
          fontFamily:"Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize:12,
          color:"#D6E2F0",
          zIndex:999,
          boxShadow:"0 4px 20px rgba(0,0,0,0.4)",
          width:320,
          maxWidth:"calc(100vw - 40px)",
          lineHeight:1.55,
          whiteSpace:"pre-line",
          pointerEvents:"none",
        }}>{text}</div>
      )}
    </span>
  );
}

// ── Strategy Badge ────────────────────────────────────────────────────────────
function EmptyState({ title, copy, children, style }) {
  return (
    <div className="empty" style={style}>
      <div className="empty-title">{title}</div>
      {copy&&<div className="empty-copy" style={{margin:"0 auto"}}>{copy}</div>}
      {children&&<div className="empty-actions">{children}</div>}
    </div>
  );
}

function StratBadge({ strategy }) {
  const colors = { PMCC:"#5B8CFF", "Covered Call":"#FFD84D", "Cash Secured Put":"#fb923c", "Long Call":"#63E6BE", "Long Put":"#ff6b9d", "Bull Call Spread":"#B37CFF", "Bear Put Spread":"#FF4D6D", "Bull Put Spread":"#63E6BE", "Bear Call Spread":"#FF4D6D", "Iron Condor":"#63E6BE", Straddle:"#FFD84D", Strangle:"#7D91AA" };
  const c = colors[strategy] || "#7D91AA";
  return <span style={{fontSize:11,padding:"2px 8px",borderRadius:4,background:c+"20",color:c,border:`1px solid ${c}44`}}>{strategy||"PMCC"}</span>;
}

function TradeStrategyBadge({ trade, strategies=[] }) {
  const strategy = getAssignedStrategy(trade, strategies);
  if(!strategy) {
    return <span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:"#1B2A3A",border:"1px solid #2a3a4a",color:"#7D91AA",whiteSpace:"nowrap"}}>Unassigned</span>;
  }
  return <StratBadge strategy={strategy.strategy_type}/>;
}

function CreateStrategyModal({ asset, onCreate, onClose }) {
  const [strategyType, setStrategyType] = useState(asset?.strategy && STRATEGY_TYPES.includes(asset.strategy) ? asset.strategy : "Long Call");
  const [name, setName] = useState(`${asset?.ticker||"Strategy"} ${strategyType}`);
  const [notes, setNotes] = useState("");
  useEffect(()=>{ setName(`${asset?.ticker||"Strategy"} ${strategyType}`); },[asset?.ticker,strategyType]);
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="fbox" style={{width:520,maxWidth:"95vw"}}>
        <div className="ftitle">Create Strategy</div>
        <div className="fgrp" style={{marginBottom:10}}>
          <label className="flbl">Strategy type</label>
          <select className="fsel" value={strategyType} onChange={e=>setStrategyType(e.target.value)}>
            {STRATEGY_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="fgrp" style={{marginBottom:10}}>
          <label className="flbl">Strategy name</label>
          <input className="finput" value={name} onChange={e=>setName(e.target.value)} />
        </div>
        <div className="fgrp" style={{marginBottom:12}}>
          <label className="flbl">Notes</label>
          <textarea className="finput" value={notes} onChange={e=>setNotes(e.target.value)} rows={3} style={{resize:"vertical"}}/>
        </div>
        <div className="factions">
          <button className="btn bneutral bfull" onClick={onClose}>Cancel</button>
          <button className="btn bfull" disabled={!name.trim()} onClick={()=>onCreate({name:name.trim(),strategy_type:strategyType,notes})}>Create</button>
        </div>
      </div>
    </div>
  );
}

function StrategyAssignmentModal({ asset, trade, strategies=[], suggestions=[], mode="assign", onConfirm, onClose }) {
  const ticker = asset?.ticker || trade?.ticker || asset?.id || "";
  const matchingStrategies = strategies.filter(s=>s.status!=="archived" && normalizeTicker(s.ticker)===normalizeTicker(ticker));
  const current = getAssignedStrategy(trade, strategies);
  const [choice, setChoice] = useState(matchingStrategies.length ? "existing" : "new");
  const [existingId, setExistingId] = useState(current?.id || matchingStrategies[0]?.id || "");
  const [newType, setNewType] = useState(strategyLabelForTrade(trade));
  const [newName, setNewName] = useState(`${ticker} ${strategyLabelForTrade(trade)}`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const canConfirm = choice==="existing" ? !!existingId
    : choice==="new" ? !!newType && !!newName.trim()
    : choice==="isolated" || choice==="detach";

  const chooseSuggestion = (s) => {
    setError("");
    if(s.kind==="existing") {
      setChoice("existing");
      setExistingId(s.strategy.id);
    } else {
      setChoice("new");
      setNewType(s.strategyType);
      setNewName(`${ticker} ${s.strategyType}`);
    }
  };

  const submit = async () => {
    if(!canConfirm || submitting) return;
    const payload = choice==="existing" && existingId ? {type:"existing", strategyId:existingId}
      : choice==="new" && newType && newName.trim() ? {type:"new", strategyType:newType, name:newName.trim()}
      : choice==="isolated" ? {type:"isolated"}
      : choice==="detach" ? {type:"detach"}
      : null;
    if(!payload) return;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(payload);
    } catch(e) {
      console.error("strategy assignment confirm failed:", e);
      setError(e?.message || e?.code || "Strategy assignment failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="fbox" style={{width:620,maxWidth:"96vw"}}>
        <div className="ftitle">{mode==="change"?"Change Strategy Assignment":"Assign Trade to Strategy"}</div>
        <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:8,padding:12,marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",gap:14,alignItems:"center",flexWrap:"wrap"}}>
            <div>
              <div style={{fontFamily:"Syne,sans-serif",fontSize:16,fontWeight:800,color:"#fff"}}>{ticker}</div>
              <div style={{fontSize:11,color:"#8aaac8",marginTop:3}}>
                {(trade?.action||"").toUpperCase()} {(trade?.option_type||"call").toUpperCase()} ${trade?.strike} exp {trade?.expiration}
              </div>
            </div>
            <div style={{fontSize:12,color:"#FFD84D",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>
              {trade?.contracts||1} contract{(trade?.contracts||1)>1?"s":""} @ ${fmt(trade?.premium)}
            </div>
          </div>
          {current&&<div style={{marginTop:9,fontSize:11,color:"#7D91AA"}}>Current: <TradeStrategyBadge trade={trade} strategies={strategies}/></div>}
        </div>

        {suggestions.length>0&&(
          <div style={{marginBottom:14}}>
            <div className="flbl" style={{marginBottom:7}}>Suggested matches</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {suggestions.map((s,i)=>(
                <button key={`${s.kind}-${s.strategy?.id||s.strategyType}-${i}`} type="button" onClick={()=>chooseSuggestion(s)}
                  style={{textAlign:"left",background:choice==="existing"&&s.strategy?.id===existingId||choice==="new"&&s.strategyType===newType?"#0F2A66":"#071019",border:"1px solid #1B2A3A",borderRadius:8,padding:"10px 12px",cursor:"pointer"}}>
                  <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:5}}>
                    <span style={{fontSize:12,fontWeight:800,color:"#D6E2F0"}}>{s.title}</span>
                    <span style={{fontSize:9,color:s.confidence==="Strong match"?"#63E6BE":s.confidence==="Weak match"?"#7D91AA":"#FFD84D"}}>{s.confidence}</span>
                  </div>
                  <div style={{fontSize:10,color:"#7D91AA",lineHeight:1.45}}>{s.reason}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div>
            <label className="flbl">Choose existing strategy</label>
            <div style={{display:"flex",gap:8,marginTop:5}}>
              <select className="fsel" value={existingId} onFocus={()=>{setError("");setChoice("existing");}} onClick={()=>{setError("");setChoice("existing");}} onChange={e=>{setError("");setChoice("existing");setExistingId(e.target.value);}}>
                {matchingStrategies.length===0?<option value="">No existing strategies</option>:matchingStrategies.map(s=><option key={s.id} value={s.id}>{s.name} - {s.strategy_type}</option>)}
              </select>
              <button className="btn bsm bneutral" disabled={!existingId} onClick={()=>{setError("");setChoice("existing");}}>Use</button>
            </div>
          </div>
          <div>
            <label className="flbl">Create new strategy</label>
            <select className="fsel" value={newType} onFocus={()=>{setError("");setChoice("new");}} onClick={()=>{setError("");setChoice("new");}} onChange={e=>{setError("");setChoice("new");setNewType(e.target.value);setNewName(`${ticker} ${e.target.value}`);}} style={{marginTop:5}}>
              {STRATEGY_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="fgrp" style={{marginBottom:14}}>
          <label className="flbl">New strategy name</label>
          <input className="finput" value={newName} onFocus={()=>{setError("");setChoice("new");}} onClick={()=>{setError("");setChoice("new");}} onChange={e=>{setError("");setChoice("new");setNewName(e.target.value);}} />
        </div>

        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
          <button className="btn bneutral" onClick={()=>{setError("");setChoice("isolated");}}>Save as isolated</button>
          {mode==="change"&&<button className="btn bwarn" onClick={()=>{setError("");setChoice("detach");}}>Detach from strategy</button>}
          <span style={{fontSize:11,color:"#4A6A8A",alignSelf:"center"}}>No automatic assignment is made.</span>
        </div>
        {error&&<div style={{fontSize:11,color:"#FF4D6D",marginBottom:10}}>{error}</div>}

        <div className="factions">
          <button className="btn bneutral bfull" onClick={onClose}>Cancel</button>
          <button className="btn bfull" disabled={!canConfirm || submitting} onClick={submit}>
            {submitting?"Assigning...":choice==="isolated"?"Confirm isolated":choice==="detach"?"Confirm detach":"Confirm assignment"}
          </button>
        </div>
      </div>
    </div>
  );
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
      if (!e||!e.length) { setError(`No listed option expirations found for "${s}".`); setLoading(false); return; }
      setExps(e); setSelExp(e[0]);
      const [q, ch] = await Promise.all([fetchQuote(s), fetchOptionChain(s, e[0])]);
      if (q?.last) setPrice(q.last);
      setChain(ch);
    } catch { setError("Market data is unavailable right now. Try refreshing in a moment."); }
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
        {error&&<span style={{fontSize:11,color:"#FF4D6D"}}>{error}</span>}
      </div>
      <div className="sec">
        <div className="sechdr">
          <div className="sectitle">Option chain — {optType==="call"?"Calls":"Puts"} {sym}</div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            <div className="toggle-group">
              {["call","put"].map(t=>(
                <button key={t} className="tgl" onClick={()=>setOptType(t)} style={{background:optType===t?color:"transparent",color:optType===t?"#071019":"#7D91AA"}}>{t==="call"?"Call":"Put"}</button>
              ))}
            </div>
            <select className="fsel sm" value={selExp} onChange={e=>loadChain(e.target.value)}>
              {exps.map(e=><option key={e} value={e}>{e}</option>)}
            </select>
            <button className="btn bsm" onClick={()=>loadSym(sym)} disabled={loading} style={{color,borderColor:color+"44",background:color+"15"}}>↻</button>
          </div>
        </div>
        {loading?<EmptyState title="Loading option chain" copy="Fetching the latest contracts and market data."/>:filtered.length===0?<EmptyState title="No contracts available" copy="Try another expiration, switch calls/puts, or search a different ticker."/>:(
          <table>
            <thead><tr><th>Strike</th><th>Last</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th><th>Delta</th><th>Theta</th><th>Gamma</th></tr></thead>
            <tbody>
              {filtered.map(o=>{
                const isATM=price>0&&Math.abs(o.strike-price)<0.5;
                return (<tr key={o.symbol} style={{background:isATM?color+"10":undefined}}>
                  <td><span style={{color:isATM?color:"#FFD84D",fontWeight:isATM?700:400}}>${o.strike}{isATM&&" ◀"}</span></td>
                  <td>${fmt(o.last||0)}</td><td style={{color:"#63E6BE"}}>${fmt(o.bid||0)}</td><td style={{color:"#FF4D6D"}}>${fmt(o.ask||0)}</td>
                  <td style={{color:"#7D91AA"}}>{(o.volume||0).toLocaleString()}</td><td style={{color:"#7D91AA"}}>{(o.open_interest||0).toLocaleString()}</td>
                  <td style={{color:"#FFD84D"}}>{o.greeks?.smv_vol?((o.greeks.smv_vol)*100).toFixed(2)+"%":"—"}</td>
                  <td style={{color:"#5B8CFF"}}>{o.greeks?.delta?fmt(o.greeks.delta,3):"—"}</td>
                  <td style={{color:"#FF4D6D"}}>{o.greeks?.theta?fmt(o.greeks.theta,3):"—"}</td>
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
          {[["Strike ($)",sellStrike,setSellStrike,0.5],["Premium received ($)",sellPrem,setSellPrem,0.01],["Premium paid to close ($)",buyPrem,setBuyPrem,0.01],["Weeks projected",weeks,setWeeks,1]].map(([l,v,s,st])=>(
            <div className="fgrp" key={l}><label className="flbl">{l}</label><input className="finput" type="number" step={st} value={v} onChange={e=>s(e.target.value)}/></div>
          ))}
        </div>
        <div style={{padding:"0 16px 16px",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[["Net credit",`$${fmt(net)}`,net>=0?color:"#FF4D6D"],["Per contract",`$${fmt(net*100)}`,net>=0?color:"#FF4D6D"],["Return on LEAP",`${(wpct*100).toFixed(2)}%`,"#5B8CFF"],["Spread",`$${fmt(spread)}`,"#FFD84D"],["Weeks to free LEAP",`~${Math.ceil(projW)}`,"#D6E2F0"],["Projected total",`$${fmt(proj*100)}`,color]].map(([l,v,c])=>(
            <div key={l} style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"12px 14px"}}>
              <div style={{fontSize:10,letterSpacing:"1.5px",textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>{l}</div>
              <div style={{fontSize:17,fontFamily:"IBM Plex Mono,DM Mono,monospace",fontWeight:650,color:c,lineHeight:1.18}}>{v}</div>
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
              <tr key={l}><td style={{color:"#D6E2F0"}}>{l}</td><td style={{color:"#FFD84D"}}>${fmt(p)}</td><td style={{color:"#8aaac8",fontSize:11}}>{o}</td><td style={{color:pnl>=0?color:"#FF4D6D"}}>{pnl>=0?"+":""}${fmt(pnl)}</td></tr>
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
  const color = asset?.color||"#63E6BE";
  const TYPES = ["Long Call","Long Put","Short Call","Short Put","LEAP"];
  const typeToForm = t=>t==="Long Call"?{action:"BUY",option_type:"call"}:t==="Long Put"?{action:"BUY",option_type:"put"}:t==="Short Call"?{action:"SELL",option_type:"call"}:t==="Short Put"?{action:"SELL",option_type:"put"}:{action:"BUY",option_type:"call"};
  const initTypeLabel = initial.isLeap?"LEAP":form.action==="BUY"&&form.option_type==="call"?"Long Call":form.action==="BUY"&&form.option_type==="put"?"Long Put":form.action==="SELL"&&form.option_type==="call"?"Short Call":"Short Put";
  const [typeLabel, setTypeLabel] = useState(initTypeLabel);
  const showLeapSelector = typeLabel==="Short Call" || typeLabel==="Short Put";
  const isLeapEntry = !isEdit && (typeLabel==="LEAP" || (form.action==="BUY" && form.expiration && form.date && (new Date(form.expiration)-new Date(form.date))>180*24*60*60*1000));

  const totalVal = ((parseFloat(form.premium)||0)*(parseInt(form.contracts)||1)*100);

  async function handleSave(){
    if(!form.strike||!form.expiration||!form.premium) return;
    const d={
      date:form.date, action:form.action, option_type:form.option_type,
      strike:parseFloat(form.strike), expiration:form.expiration,
      premium:parseFloat(form.premium), contracts:Math.max(1,parseInt(form.contracts)||1),
      fees:parseFloat(form.fees)||0, notes:form.notes||null,
      status:form.status||"open",
      trade_group:form.action==="SELL"?(form.trade_group||null):null,
      typeLabel,
    };
    if(!isEdit&&isLeapEntry&&onSaveLeap){
      await onSaveLeap({id:`${asset?.id||"t"}_${Date.now()}`,date:d.date,strike:d.strike,expiration:d.expiration,cost:d.premium,contracts:d.contracts});
      onClose(); return;
    }
    await onSave(d);
    onClose();
  }

  const inp={background:"#071019",border:"1px solid #1B2A3A",color:"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:12,padding:"7px 10px",borderRadius:5,outline:"none",width:"100%",boxSizing:"border-box"};
  const lbl={fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4,display:"block"};
  const g2={display:"grid",gridTemplateColumns:"1fr 1fr",gap:10};
  const col={display:"flex",flexDirection:"column"};

  return(
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:12,padding:"22px 24px",width:380,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontFamily:"Syne,sans-serif",fontSize:15,fontWeight:800,color:"#fff"}}>{title}</div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {isLeapEntry&&<span style={{fontSize:9,background:"#63E6BE15",border:"1px solid #63E6BE44",color:"#63E6BE",padding:"2px 7px",borderRadius:4}}>→ LEAP</span>}
            <button onClick={onClose} style={{background:"none",border:"none",color:"#4A6A8A",fontSize:16,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>

          <div style={g2}>
            <div style={col}><label style={lbl}>Date</label><input style={inp} type="date" value={form.date} onChange={e=>upd("date",e.target.value)}/></div>
            <div style={col}><label style={lbl}>Trade Type</label>
              <select style={inp} value={typeLabel} onChange={e=>{
                const t=e.target.value;
                setTypeLabel(t);
                const {action,option_type}=typeToForm(t);
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
              <div style={{display:"flex",alignItems:"center",gap:5,background:"#071019",border:"1px solid #1B2A3A",borderRadius:5,padding:"4px 8px"}}>
                <button onClick={()=>upd("contracts",Math.max(1,(parseInt(form.contracts)||1)-1))} style={{background:"#1B2A3A",border:"none",color:"#D6E2F0",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>−</button>
                <input value={form.contracts} onChange={e=>upd("contracts",Math.max(1,parseInt(e.target.value)||1))} style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#fff",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:14,fontWeight:600,textAlign:"center"}}/>
                <button onClick={()=>upd("contracts",(parseInt(form.contracts)||1)+1)} style={{background:"#1B2A3A",border:"none",color:"#D6E2F0",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>+</button>
              </div>
            </div>
          </div>

          {showLeapSelector&&(
            <div style={col}>
              <label style={{...lbl,color:"#FFD84D"}}>Associated LEAP <span style={{opacity:.4,fontWeight:400,textTransform:"none",letterSpacing:0}}>— optional</span></label>
              {leaps.length===0?(
                <div style={{fontSize:11,color:"#4A6A8A",padding:"8px 10px",background:"#071019",border:"1px solid #1B2A3A",borderRadius:5}}>No LEAP positions available for this asset</div>
              ):(
                <select style={{...inp,borderColor:"#FFD84D44",color:"#FFD84D"}} value={form.trade_group||"none"} onChange={e=>upd("trade_group",e.target.value==="none"?null:e.target.value)}>
                  <option value="none">— None —</option>
                  {leaps.map(l=><option key={l.id} value={l.id}>${l.strike} · {l.expiration} · {l.contracts} contract{l.contracts!==1?"s":""}</option>)}
                </select>
              )}
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
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:10,color:"#4A6A8A"}}>Total value</span>
              <span style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:15,fontWeight:700,color:form.action==="SELL"?"#63E6BE":"#FF4D6D"}}>
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
function DeleteOrderConfirmModal({ order, onCancel, onConfirm }) {
  if(!order) return null;
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onCancel()}>
      <div className="fbox" style={{width:430,maxWidth:"94vw"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <div style={{width:36,height:36,borderRadius:"50%",background:"#FF4D6D15",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <span style={{color:"#FF4D6D",fontSize:18}}>!</span>
          </div>
          <div className="ftitle" style={{margin:0}}>Delete order?</div>
        </div>
        <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"10px 13px",marginBottom:14,fontSize:12,color:"#D6E2F0"}}>
          {order.label}
        </div>
        <p style={{fontSize:13,color:"#8aaac8",lineHeight:1.6,marginBottom:18}}>
          All information for this order will be permanently lost. It will not be closed, expired, or rolled, and it will not appear in history.
        </p>
        <div className="factions">
          <button className="btn bneutral bfull" onClick={onCancel}>Cancel</button>
          <button className="btn bfull bdanger" onClick={onConfirm}>Yes, delete</button>
        </div>
      </div>
    </div>
  );
}

function AssetDashboard({ asset, strategies=[], onCreateStrategy, onChangeTradeStrategy, onDetachTradeStrategy, onClose, onSaveTrade, onUpdateTrade, onDeleteTrade, onDeleteLeap, onUpdateLeap, onDeleteAsset, onSaveLeap }) {
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
  const [showCreateStrategy, setShowCreateStrategy] = useState(false);
  const [strategyEditorTrade, setStrategyEditorTrade] = useState(null);
  const [closeLeap, setCloseLeap] = useState(null);
  const [closeLeapPrem, setCloseLeapPrem] = useState("");
  const [editLeapData, setEditLeapData] = useState(null);
  const [deleteOrder, setDeleteOrder] = useState(null);
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
    try{const q=await fetchQuote(asset.ticker);if(q?.last)setEtfPrice(q.last);setLiveData(q);}catch{setLiveErr("Market data is unavailable right now.");}
    setLoadingLive(false);
  },[asset.ticker]);
  useEffect(()=>{fetchLive();},[fetchLive]);

  const leaps = asset.leaps||[];
  const totalLeapCost = leaps.reduce((s,l)=>s+l.cost*l.contracts*100,0);
  const leapContracts = leaps.reduce((s,l)=>s+l.contracts,0);
  const hasLeap = leapContracts>0;
  const primaryLeap = leaps[0] || null;
  const isPmccDashboard = hasLeap;
  const leapAvg = leapContracts>0 ? totalLeapCost/leapContracts : 0; // dollars per contract
  const leapAvgPerShare = leapContracts>0 ? leaps.reduce((s,l)=>s+l.cost*l.contracts,0)/leapContracts : 0;

  const thetaCashDollar = thetaEngineCashDollars(trades, leaps);
  const realizedPnLDollar = realizedOptionPnLDollars(trades);
  const assetIncomeDollar = assetIncomeGeneratedDollars(trades);
  const realizedDisplayDollar = realizedPnLDollar;
  const totalCollected = thetaCashDollar/100;
  const premiumPerLeap = leapContracts>0 ? thetaCashDollar/leapContracts : 0;
  const costBasis = leapAvg - premiumPerLeap;
  const recovPct = Math.min(totalLeapCost>0?thetaCashDollar/totalLeapCost:0,1);
  const openTrades = trades.filter(t=>t.status==="open").sort((a,b)=>new Date(a.expiration)-new Date(b.expiration));
  const closedTrades = trades.filter(t=>t.status==="closed").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const expiredTrades = trades.filter(t=>t.status==="expired").sort((a,b)=>new Date(b.date)-new Date(a.date));
  const allOrderRows = [
    ...leaps.map(l=>({
      ...l,
      id:l.id,
      rowKey:`leap-${l.id}`,
      isLeap:true,
      typeLabel:"LEAP",
      action:"BUY",
      option_type:"call",
      premium:l.cost,
      status:"open",
      value:l.cost*l.contracts*100,
    })),
    ...trades.map(t=>({
      ...t,
      rowKey:`trade-${t.id}`,
      isLeap:false,
      typeLabel:optionType(t)==="put"?"Put":"Call",
      premium:tradePremium(t),
      contracts:tradeContracts(t),
      value:tradeDollarValue(t),
    })),
  ];
  const filteredOrders = allOrderRows
    .filter(o=>statusFilter==="all" || o.status===statusFilter)
    .sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const assetStrategies = strategies.filter(s=>normalizeTicker(s.ticker)===normalizeTicker(asset.ticker));
  const pmccShortCalls = trades
    .filter(t=>isThetaShortCallTrade(t, leaps))
    .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  const pmccClosingBuys = trades
    .filter(t=>isThetaEngineTrade(t,trades,leaps)&&isThetaClosingBuyTrade(t,trades,leaps))
    .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  const remainingClosingBuys = pmccClosingBuys.map(trade=>({
    trade,
    remaining: tradeContracts(trade),
  }));
  const pmccCycles = pmccShortCalls.map((sell,idx)=>{
    const contracts = tradeContracts(sell);
    const sellDate = new Date(sell.date||0);
    const consumeCloseMatches = (exactOnly) => {
      let remaining = contracts;
      const matches = [];
      remainingClosingBuys.forEach(entry=>{
        if(remaining<=0 || entry.remaining<=0) return;
        const closeDate = new Date(entry.trade.date||sell.date||0);
        if(closeDate<sellDate) return;
        if(exactOnly && !sameOptionContract(entry.trade, sell)) return;
        if(!exactOnly && sameOptionContract(entry.trade, sell)) return;
        const consumed = Math.min(remaining, entry.remaining);
        entry.remaining -= consumed;
        remaining -= consumed;
        matches.push({trade:entry.trade, consumed});
      });
      return matches;
    };
    let closeMatches = consumeCloseMatches(true);
    if(closeMatches.length===0 && sell.status==="closed") {
      closeMatches = consumeCloseMatches(false);
    }
    const close = closeMatches[0]?.trade || null;
    const isExpired = sell.status==="expired";
    const isOpen = sell.status==="open";
    const isClosed = sell.status==="closed" && !!close;
    const missingClose = sell.status==="closed" && !close;
    const credit = tradeDollarValue(sell);
    const debit = closeMatches.reduce((sum,match)=>sum+tradePremium(match.trade)*match.consumed*100,0);
    const net = isExpired ? credit : isClosed ? credit-debit : null;
    const dte = sell.expiration?Math.max(Math.ceil((new Date(sell.expiration)-new Date())/(1000*60*60*24)),0):0;
    return {
      id:sell.id||idx,
      number:idx+1,
      short:sell,
      close,
      status:isOpen?"open":isExpired?"expired":isClosed?"closed":missingClose?"missing close":sell.status,
      realized:isExpired||isClosed,
      missingClose,
      credit,
      debit: roundMoney(debit),
      net,
      contracts,
      dte,
    };
  });
  const activeCycle = pmccCycles.find(c=>c.status==="open");
  const realizedPremium = roundMoney(pmccCycles.filter(c=>c.realized).reduce((s,c)=>s+c.net,0));
  const openCycleCredit = pmccCycles.filter(c=>c.status==="open").reduce((s,c)=>s+c.credit,0);
  const premiumCaptured = realizedPremium + openCycleCredit;
  const weeklyPremium = pmccCycles.length
    ? premiumCaptured/Math.max(1,(new Date()-new Date(pmccCycles[0].short.date||new Date()))/(1000*60*60*24))*7
    : 0;
  const projectedFreeDays = weeklyPremium>0
    ? Math.ceil(Math.max(totalLeapCost-premiumCaptured,0)/(weeklyPremium/7))
    : null;
  const currentShort = activeCycle?.short;
  const healthDte = currentShort?.expiration?Math.max(Math.ceil((new Date(currentShort.expiration)-new Date())/(1000*60*60*24)),0):0;
  const distancePct = currentShort&&etfPrice>0?(parseFloat(currentShort.strike)-etfPrice)/etfPrice*100:null;
  const healthScore = currentShort ? Math.max(0,Math.min(100,
    Math.round(100
      - (distancePct==null?25:distancePct<0?45:distancePct<3?30:distancePct<7?15:0)
      - (healthDte<=2?25:healthDte<=7?15:healthDte<=14?7:0)
      - (currentShort.status==="open"?0:10)
    )
  )) : null;
  const healthState = healthScore==null?"No short call":healthScore>=80?"Healthy":healthScore>=60?"Watch":healthScore>=30?"Danger":"Breached";
  const healthColor = healthScore==null?"#7D91AA":healthScore>=80?"#63E6BE":healthScore>=60?"#FFD84D":"#FF4D6D";
  const inferredRolls = pmccClosingBuys.flatMap(close=>{
    const nextSell = pmccShortCalls.find(s=>
      s.date===close.date &&
      (Math.abs(parseFloat(s.strike)-parseFloat(close.strike))>=0.01 || s.expiration!==close.expiration)
    );
    if(!nextSell) return [];
    const contracts = Math.min(parseInt(close.contracts||1),parseInt(nextSell.contracts||1));
    const debit = parseFloat(close.premium||0)*contracts*100;
    const credit = parseFloat(nextSell.premium||0)*contracts*100;
    const oldStrike = parseFloat(close.strike);
    const newStrike = parseFloat(nextSell.strike);
    const oldExp = new Date(close.expiration);
    const newExp = new Date(nextSell.expiration);
    const type = newStrike>oldStrike&&newExp>oldExp?"Up/Out":newExp>oldExp?"Out":newStrike>oldStrike?"Up":"Defensive";
    return [{date:close.date,from:close,to:nextSell,contracts,debit,credit,net:credit-debit,type}];
  });

  function openAdd(){setEditId(null);setForm({...ef,strategy});setShowForm(true);}
  function openEdit(t){setEditId(t.id);setForm({...ef,...t,contracts:t.contracts||1,fees:t.fees||"",notes:t.notes||""});setShowForm(true);}
  async function saveTrade(tradeData){
    if(editId){
      if(tradeData.typeLabel==="LEAP"){
        await onDeleteTrade(editId);
        await onSaveLeap({id:`${asset.id}_${Date.now()}`,date:tradeData.date,strike:tradeData.strike,expiration:tradeData.expiration,cost:tradeData.premium,contracts:tradeData.contracts});
      } else {
        await onUpdateTrade(editId,tradeData);
      }
    } else {
      await onSaveTrade(tradeData);
    }
    setShowForm(false);
  }
  function removeTrade(id, label="this order"){
    setDeleteOrder({kind:"trade",id,label});
  }
  function removeLeap(id, label="this LEAP"){
    setDeleteOrder({kind:"leap",id,label});
  }
  async function confirmDeleteOrder(){
    if(!deleteOrder) return;
    if(deleteOrder.kind==="leap") await onDeleteLeap(deleteOrder.id);
    else await onDeleteTrade(deleteOrder.id);
    setDeleteOrder(null);
  }
  async function createStrategyFromDashboard(payload){
    await onCreateStrategy({...payload,asset_id:asset.id,ticker:asset.ticker});
    setShowCreateStrategy(false);
  }
  async function confirmStrategyEditor(choice){
    if(!strategyEditorTrade) return;
    if(choice.type==="detach"||choice.type==="isolated") await onDetachTradeStrategy(strategyEditorTrade.id);
    if(choice.type==="existing") await onChangeTradeStrategy(strategyEditorTrade.id, choice.strategyId);
    if(choice.type==="new"){
      const created = await onCreateStrategy({asset_id:asset.id,ticker:asset.ticker,name:choice.name,strategy_type:choice.strategyType});
      await onChangeTradeStrategy(strategyEditorTrade.id, created.id);
    }
    setStrategyEditorTrade(null);
  }
  function openCR(t){
    const group=openTrades.filter(o=>parseFloat(o.strike)===parseFloat(t.strike)&&o.expiration===t.expiration);
    const total=group.reduce((s,o)=>s+parseInt(o.contracts||1),0);
    setCrGroup(group);
    setShowCR(t);
    setCrForm({mode:"close",closePrem:"",newStrike:t.strike,newExp:"",newPrem:"",contracts:total});
  }
  function openMissingClose(t){
    setCrGroup([t]);
    setShowCR(t);
    setCrForm({mode:"close",closePrem:"",newStrike:t.strike,newExp:"",newPrem:"",contracts:tradeContracts(t)});
  }
  async function confirmCR(){
    if(crForm.mode!=="expired"&&!crForm.closePrem)return;
    const today=new Date().toISOString().slice(0,10);
    const groupTotal=crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0);
    let rem=Math.max(1,Math.min(parseInt(crForm.contracts)||1,groupTotal));
    const closingTotal=rem;

    if(crForm.mode==="expired"){
      for(const trade of crGroup){
        if(rem<=0)break;
        const tc=parseInt(trade.contracts||1);
        const closing=Math.min(rem,tc);
        const keeping=tc-closing;
        rem-=closing;
        if(keeping>0){
          await onUpdateTrade(trade.id,{contracts:keeping});
          await onSaveTrade({date:trade.date||today,action:"SELL",strike:trade.strike,expiration:trade.expiration,premium:trade.premium,contracts:closing,status:"expired"});
        }else{
          await onUpdateTrade(trade.id,{status:"expired"});
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
    const openingTrade = await onSaveTrade({
      date:closeLeap.date, action:"BUY", strike:closeLeap.strike,
      expiration:closeLeap.expiration, premium:closeLeap.cost,
      contracts:closeLeap.contracts||1, status:"closed",
      positionEffect:"technical",
      option_type:"call", strategy:"LEAP_OPEN",
      notes:`LEAP opening cost for ${asset.ticker}`
    }, {skipStrategyAssignment:true, skipDuplicateCheck:true});
    if(!openingTrade) return;
    const closingTrade = await onSaveTrade({
      date:today, action:"SELL", strike:closeLeap.strike,
      expiration:closeLeap.expiration, premium:parseFloat(closeLeapPrem),
      contracts:closeLeap.contracts||1, status:"closed",
      positionEffect:"technical",
      option_type:"call", strategy:"LEAP_CLOSE",
      notes:`LEAP close for ${asset.ticker}`
    }, {skipStrategyAssignment:true, skipDuplicateCheck:true});
    if(!closingTrade){
      await onDeleteTrade(openingTrade.id);
      return;
    }
    try {
      await onDeleteLeap(closeLeap.id);
    } catch(e) {
      await onDeleteTrade(openingTrade.id);
      await onDeleteTrade(closingTrade.id);
      throw e;
    }
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
          <span style={{fontSize:11,color:"#7D91AA"}}>Price $</span>
          <input className="pinput" type="number" step="0.01" value={etfPrice} onChange={e=>setEtfPrice(parseFloat(e.target.value)||0)} style={{color}}/>
        </div>
        {liveData&&<><div className="dvdr"/><div className="sml">open <span>${liveData.open||"—"}</span></div><div className="dvdr"/><div className="sml">high <span style={{color:"#63E6BE"}}>${liveData.high||"—"}</span></div><div className="dvdr"/><div className="sml">low <span style={{color:"#FF4D6D"}}>${liveData.low||"—"}</span></div><div className="dvdr"/><div className="sml">vol <span>{liveData.volume?.toLocaleString()||"—"}</span></div></>}
        {isPmccDashboard&&<><div className="dvdr"/><div className="sml">LEAP <span>${primaryLeap?.strike}</span></div><div className="dvdr"/><div className="sml">distance <span className={etfPrice>=primaryLeap?.strike?"green":"red"}>{etfPrice>=primaryLeap?.strike?"+":""}{fmt(etfPrice-primaryLeap?.strike)}</span></div><div className="dvdr"/><div className="sml">avg cost <span style={{color}}>${fmt(leapAvg)}</span></div></>}
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button className="btn bsm" onClick={fetchLive} disabled={loadingLive} style={{color,borderColor:color+"44",background:color+"15"}}>{loadingLive?"...":"↻"}</button>
          <button className="btn bsm bneutral" onClick={()=>setShowDelete(true)}>✕ Delete</button>
          <button className="btn bsm bdanger" onClick={()=>setShowClose(true)}>Close strategy</button>
        </div>
        {liveErr&&<div style={{fontSize:11,color:"#FF4D6D"}}>{liveErr}</div>}
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
              {(isPmccDashboard?[
                [color,"Income generated",`${assetIncomeDollar>=0?"+":""}$${fmt(assetIncomeDollar)}`,`${fmt(thetaCashDollar)} from Theta Engine`],
                ["#5B8CFF","Current cost basis",`$${fmt(costBasis)}`,`avg was $${fmt(leapAvg)}`],
                ["#FFD84D","Open positions",openTrades.filter(t=>t.action==="SELL").length,`${closedTrades.length} closed`],
                ["#FF4D6D","Accumulated P&L",`${realizedPremium>=0?"+":""}$${fmt(realizedPremium)}`,`${fmt(totalLeapCost>0?(realizedPremium/totalLeapCost)*100:0)}% realized`],
              ]:[
                [color,"Income generated",`${assetIncomeDollar>=0?"+":""}$${fmt(assetIncomeDollar)}`,"net premium and realized results"],
                ["#5B8CFF","Cost basis",`$${fmt(asset.leapCost*100)}`,`${strategy}`],
                ["#FFD84D","Open positions",openTrades.length,`${closedTrades.length} closed`],
                ["#FF4D6D","Realized P&L",`${realizedPnLDollar>=0?"+":""}$${fmt(realizedPnLDollar)}`,`from closed trades`],
              ]).map(([c,l,v,s])=>(
                <div className="card" key={l} style={{"--top":c}}>
                  <div className="clbl">{l}</div><div className="cval">{v}</div><div className="csub">{s}</div>
                </div>
              ))}
            </div>

            {isPmccDashboard&&(
              <>
                <div className="sec">
                  <div className="sechdr">
                    <div className="sectitle">Cost basis recovery</div>
                    <div style={{fontSize:11,color:"#7D91AA"}}>target: <span style={{color:"#D6E2F0"}}>${fmt(totalLeapCost)}</span></div>
                  </div>
                  <div style={{padding:"14px 16px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#7D91AA",marginBottom:8}}>
                      <span>$0</span>
                      <span style={{color}}>${fmt(thetaCashDollar)} net recovered</span>
                      <span>${fmt(totalLeapCost)} target</span>
                    </div>
                    <div className="ptrack"><div className="pfill" style={{width:`${recovPct*100}%`,background:`linear-gradient(90deg,${color},#5B8CFF)`}}/></div>
                    <div style={{fontSize:11,color:"#7D91AA",marginTop:6}}>$<span style={{color:"#FFD84D"}}>{fmt(Math.max(totalLeapCost-thetaCashDollar,0))}</span> remaining to free LEAP</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1.2fr 1fr",gap:14,marginBottom:16}}>
                  <div className="sec" style={{marginBottom:0}}>
                    <div className="sechdr">
                      <div className="sectitle">Theta Engine - {asset.ticker}</div>
                      <div style={{fontSize:11,color:"#7D91AA"}}>{pmccCycles.length} short-call cycle{pmccCycles.length!==1?"s":""}</div>
                    </div>
                    {pmccCycles.length===0?<EmptyState title="No short-call cycles yet" copy="Sell a call against this LEAP to start tracking premium capture, cycle status, and net theta income."/>:(
                      <table>
                        <thead><tr><th>#</th><th>Short Call</th><th>Status</th><th>Credit</th><th>Debit</th><th>Net</th></tr></thead>
                        <tbody>
                          {pmccCycles.map(c=>(
                            <tr key={c.id}>
                              <td style={{color:"#7D91AA"}}>{c.number}</td>
                              <td><span style={{color:"#FFD84D"}}>${c.short.strike}C</span> <span style={{color:"#7D91AA"}}>{c.short.expiration}</span></td>
                              <td><span className={c.status==="open"?"stopen":c.status==="expired"?"stexpired":c.missingClose?"stclosed":"stclosed"} style={c.status==="open"?{color,borderColor:color+"44",background:color+"15"}:c.missingClose?{color:"#FFD84D",borderColor:"#FFD84D44",background:"#FFD84D15"}:undefined}>{c.status}</span></td>
                              <td style={{color:"#63E6BE"}}>${fmt(c.credit)}</td>
                              <td style={{color:c.debit>0?"#FF4D6D":c.missingClose?"#FFD84D":"#4A6A8A"}}>
                                {c.debit>0?`-$${fmt(c.debit)}`:c.missingClose?(
                                  <button className="btn bsm bwarn" onClick={()=>openMissingClose(c.short)}>Add close price</button>
                                ):"-"}
                              </td>
                              <td style={{color:c.net==null?"#7D91AA":c.net>=0?"#63E6BE":"#FF4D6D"}}>{c.net==null?"—":`${c.net>=0?"+":""}$${fmt(c.net)}`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div className="sec" style={{marginBottom:0}}>
                    <div className="sechdr"><div className="sectitle">Premium Capture</div></div>
                    <div style={{padding:"14px 16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                      {[
                        ["Captured",`$${fmt(premiumCaptured)}`,"#63E6BE"],
                        ["Realized",`$${fmt(realizedPremium)}`,"#5B8CFF"],
                        ["Weekly pace",`$${fmt(weeklyPremium)}`,"#FFD84D"],
                        ["Free LEAP ETA",projectedFreeDays?`~${projectedFreeDays}d`:"-","#B37CFF"],
                      ].map(([label,value,c])=>(
                        <div key={label} style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"11px 12px"}}>
                          <div style={{fontSize:9,letterSpacing:1.4,textTransform:"uppercase",color:"#4A6A8A",marginBottom:5}}>{label}</div>
                          <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:18,fontWeight:650,color:c,lineHeight:1.18}}>{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:16}}>
                  <div className="sec" style={{marginBottom:0}}>
                    <div className="sechdr">
                      <div className="sectitle">Position Health</div>
                      <div style={{fontSize:12,fontWeight:700,color:healthColor}}>{healthState}</div>
                    </div>
                    <div style={{padding:"14px 16px"}}>
                      {currentShort?(
                        <>
                          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
                            <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:36,fontWeight:650,color:healthColor,lineHeight:1.18}}>{healthScore}</div>
                            <div style={{flex:1}}>
                              <div className="ptrack"><div className="pfill" style={{width:`${healthScore}%`,background:`linear-gradient(90deg,${healthColor},#5B8CFF)`}}/></div>
                              <div style={{fontSize:11,color:"#7D91AA",marginTop:6}}>Short ${currentShort.strike}C exp {currentShort.expiration}</div>
                            </div>
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,fontSize:11}}>
                            <div><span style={{color:"#4A6A8A"}}>DTE</span><div style={{color:"#D6E2F0",fontWeight:700}}>{healthDte}</div></div>
                            <div><span style={{color:"#4A6A8A"}}>Distance</span><div style={{color:(distancePct||0)>=0?"#63E6BE":"#FF4D6D",fontWeight:700}}>{distancePct==null?"-":`${distancePct>=0?"+":""}${fmt(distancePct,1)}%`}</div></div>
                            <div><span style={{color:"#4A6A8A"}}>Open credit</span><div style={{color:"#63E6BE",fontWeight:700}}>${fmt(openCycleCredit)}</div></div>
                          </div>
                        </>
                      ):<EmptyState title="No active short call" copy="This position has no open short call cycle right now." style={{padding:22}}/>}
                    </div>
                  </div>
                  <div className="sec" style={{marginBottom:0}}>
                    <div className="sechdr">
                      <div className="sectitle">Roll History</div>
                      <div style={{fontSize:11,color:"#7D91AA"}}>{inferredRolls.length} inferred</div>
                    </div>
                    {inferredRolls.length===0?<EmptyState title="No rolls detected" copy="Roll history appears after a close and replacement sell are entered on the same date."/>:(
                      <table>
                        <thead><tr><th>Date</th><th>From</th><th>To</th><th>Net</th><th>Type</th></tr></thead>
                        <tbody>
                          {inferredRolls.slice(-4).map((r,i)=>(
                            <tr key={`${r.date}-${i}`}>
                              <td style={{color:"#7D91AA"}}>{r.date}</td>
                              <td>${r.from.strike}C</td>
                              <td><span style={{color:"#FFD84D"}}>${r.to.strike}C</span></td>
                              <td style={{color:r.net>=0?"#63E6BE":"#FF4D6D"}}>{r.net>=0?"+":""}${fmt(r.net)}</td>
                              <td style={{color:"#8aaac8"}}>{r.type}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
                <div className="sec">
                  <div className="sechdr">
                    <div className="sectitle">LEAP positions</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      {leapContracts>1&&<span style={{fontSize:11,color:"#FFD84D"}}>{leapContracts} contracts · avg ${fmt(leapAvg)}</span>}
                      <div className="badge" style={{color,borderColor:color+"44",background:color+"15"}}>LONG</div>
                    </div>
                  </div>
                  <table>
                    <thead><tr><th>Date</th><th>Strike</th><th>Expiration</th><th>Cost</th><th>Contracts</th><th>Total</th><th></th></tr></thead>
                    <tbody>
                      {leaps.map((l,i)=>(
                        <tr key={l.id||i}>
                          <td style={{color:"#7D91AA"}}>{l.date}</td>
                          <td style={{color:"#FFD84D"}}>${l.strike}</td>
                          <td>{l.expiration}</td>
                          <td style={{color}}>${fmt(l.cost)}</td>
                          <td style={{color:"#8aaac8"}}>{l.contracts}</td>
                          <td style={{color}}>${fmt(l.cost*l.contracts*100)}</td>
                          <td><div style={{display:"flex",gap:5}}>
                            <button className="btn bsm bneutral" onClick={()=>setEditLeapData(l)}>Edit</button>
                            <button className="btn bsm bdanger" onClick={()=>{setCloseLeap(l);setCloseLeapPrem("");}}>Close</button>
                            <button className="btn bsm bdanger" title="Delete order without history" onClick={()=>removeLeap(l.id, `${asset.ticker} LEAP $${l.strike}`)}>✕</button>
                          </div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{padding:"10px 16px",borderTop:"1px solid #1B2A3A",display:"flex",justifyContent:"space-between",fontSize:11,color:"#7D91AA"}}>
                    <span>Total cost: <span style={{color:"#D6E2F0"}}>${fmt(totalLeapCost)}</span></span>
                    <span>Avg cost/contract: <span style={{color}}>${fmt(leapAvg)}</span></span>
                  </div>
                </div>
              </>
            )}

            {!isPmccDashboard&&leaps.length>0&&(
              <div className="sec">
                <div className="sechdr">
                  <div className="sectitle">Long positions</div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {leapContracts>1&&<span style={{fontSize:11,color:"#FFD84D"}}>{leapContracts} contracts</span>}
                    <div className="badge" style={{color,borderColor:color+"44",background:color+"15"}}>LONG</div>
                  </div>
                </div>
                <table>
                  <thead><tr><th>Date</th><th>Strike</th><th>Expiration</th><th>Cost</th><th>Contracts</th><th>Total</th><th></th></tr></thead>
                  <tbody>
                    {leaps.map((l,i)=>(
                      <tr key={l.id||i}>
                        <td style={{color:"#7D91AA"}}>{l.date}</td>
                        <td style={{color:"#FFD84D"}}>${l.strike}</td>
                        <td>{l.expiration}</td>
                        <td style={{color}}>${fmt(l.cost)}</td>
                        <td style={{color:"#8aaac8"}}>{l.contracts}</td>
                        <td style={{color}}>${fmt(l.cost*l.contracts*100)}</td>
                        <td><div style={{display:"flex",gap:5}}>
                          <button className="btn bsm bneutral" onClick={()=>setEditLeapData(l)}>Edit</button>
                          <button className="btn bsm bdanger" title="Delete order without history" onClick={()=>removeLeap(l.id, `${asset.ticker} long $${l.strike}`)}>✕</button>
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
                <div style={{display:"flex",gap:8}}>
                  <button className="btn bneutral" onClick={()=>setShowCreateStrategy(true)}>+ Strategy</button>
                  <button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>+ Add trade</button>
                </div>
              </div>
              {openTrades.length===0?<EmptyState title="No open positions" copy="Add a trade to begin tracking expiration, premium, and position actions."><button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>Add trade</button></EmptyState>:(
                <table>
                  <thead><tr><th>Date</th><th>Strategy</th><th>Strike</th><th>Premium</th><th>Contracts</th><th>Value $</th><th>Expiration</th><th></th></tr></thead>
                  <tbody>
                    {openTrades.map(t=>{
                      const dl=Math.ceil((new Date(t.expiration)-new Date())/(1000*60*60*24));
                      const bc=dl<=7?"#E24B4A":dl<=14?"#BA7517":"#1D9E75";
                      const bw=Math.min(Math.max((dl/21)*100,4),100);
                      return (<tr key={t.id}>
                        <td style={{color:"#7D91AA"}}>{t.date}</td>
                        <td><TradeStrategyBadge trade={t} strategies={strategies}/></td>
                        <td><span style={{color:"#FFD84D"}}>${t.strike}</span></td>
                        <td style={{color}}>${fmt(t.premium)}</td>
                        <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                        <td style={{color}}>${fmt(t.premium*(t.contracts||1)*100)}</td>
                        <td style={{minWidth:130}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <div style={{flex:1,height:5,background:"#1B2A3A",borderRadius:3}}><div style={{height:"100%",width:`${bw}%`,background:bc,borderRadius:3}}/></div>
                            <span style={{fontSize:11,color:bc,whiteSpace:"nowrap"}}>{dl<=0?"Expired!":dl+"d"}</span>
                          </div>
                        </td>
                        <td><div style={{display:"flex",gap:5}}>
                          <button className="btn bsm bneutral" onClick={()=>openEdit(t)}>Edit</button>
                          <button className="btn bsm bneutral" onClick={()=>setStrategyEditorTrade(t)}>Strategy</button>
                          {(isPremium||isThetaShortCallTrade(t,leaps))&&<button className="btn bsm bwarn" onClick={()=>openCR(t)}>Close/Roll</button>}
                          <button className="btn bsm bdanger" title="Delete order without history" onClick={()=>removeTrade(t.id, `${asset.ticker} ${t.action} $${t.strike}`)}>✕</button>
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
                <div style={{display:"flex",background:"#1B2A3A",borderRadius:6,padding:3,gap:2}}>
                  {[["all","All"],["open","Open"],["closed","Closed"],["expired","Expired"]].map(([v,l])=>(
                    <button key={v} onClick={()=>setStatusFilter(v)} style={{padding:"4px 10px",borderRadius:4,border:"none",cursor:"pointer",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:10,background:statusFilter===v?color:"transparent",color:statusFilter===v?"#071019":"#7D91AA"}}>{l}</button>
                  ))}
                </div>
                <button className="btn bsm" onClick={()=>exportCSV(allOrderRows,asset.ticker)} style={{color,borderColor:color+"44",background:color+"15"}}>↓ CSV</button>
                <button className="btn bsm bneutral" onClick={()=>setShowCreateStrategy(true)}>+ Strategy</button>
                <button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>+ Add trade</button>
              </div>
            </div>
            {filteredOrders.length===0?<EmptyState title="No orders match this view" copy="Change the status filter or add a new trade to build this asset's order ledger."><button className="btn" onClick={openAdd} style={{color,borderColor:color+"44",background:color+"15"}}>Add trade</button></EmptyState>:(
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Action</th><th>Strategy</th><th>Strike</th><th>Expiration</th><th>Price</th><th>Contracts</th><th>Value $</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {filteredOrders.map(t=>(
                    <tr key={t.rowKey}>
                      <td style={{color:"#7D91AA"}}>{t.date}</td>
                      <td><span style={{fontSize:10,padding:"2px 8px",borderRadius:4,background:t.isLeap?"#5B8CFF20":"#1B2A3A",border:`1px solid ${t.isLeap?"#5B8CFF44":"#2a3a4a"}`,color:t.isLeap?"#5B8CFF":"#8aaac8",whiteSpace:"nowrap"}}>{t.typeLabel}</span></td>
                      <td><span style={{color:t.action==="SELL"?color:"#FF4D6D"}}>{t.action==="SELL"?"SELL":"BUY"}</span></td>
                      <td>{t.isLeap?"-":<TradeStrategyBadge trade={t} strategies={strategies}/>}</td>
                      <td><span style={{color:"#FFD84D"}}>${t.strike}</span></td>
                      <td>{t.expiration}</td>
                      <td style={{color:t.action==="SELL"?color:"#FF4D6D"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium)}</td>
                      <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                      <td style={{color:t.action==="SELL"?color:"#FF4D6D"}}>{t.action==="SELL"?"+":"-"}${fmt(t.value)}</td>
                      <td>{t.status==="open"?<span className="stopen" style={{color,borderColor:color+"44",background:color+"15"}}>Open</span>:t.status==="expired"?<span className="stexpired">Expired</span>:<span className="stclosed">Closed</span>}</td>
                      <td><div style={{display:"flex",gap:5}}>
                        <button className="btn bsm bneutral" onClick={()=>t.isLeap?setEditLeapData(t):openEdit(t)}>Edit</button>
                        {!t.isLeap&&<button className="btn bsm bneutral" onClick={()=>setStrategyEditorTrade(t)}>Strategy</button>}
                        <button className="btn bsm bdanger" title="Delete order without history" onClick={()=>t.isLeap?removeLeap(t.id, `${asset.ticker} LEAP $${t.strike}`):removeTrade(t.id, `${asset.ticker} ${t.action} $${t.strike}`)}>✕</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{padding:"10px 16px",borderTop:"1px solid #1B2A3A",display:"flex",justifyContent:"flex-end",gap:20,fontSize:13}}>
              <span style={{color:"#7D91AA"}}>Net total:</span>
              <span style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:15,fontWeight:650,color:realizedDisplayDollar>=0?color:"#FF4D6D"}}>{realizedDisplayDollar>=0?"+":""}${fmt(realizedDisplayDollar)}</span>
            </div>
          </div>
        )}

        {tab==="calculator"&&isPmccDashboard&&<Calculator asset={asset} totalCollected={totalCollected} etfPrice={etfPrice}/>}
        {tab==="calculator"&&!isPmccDashboard&&<EmptyState title="Calculator not available for this strategy" copy="The recovery calculator is designed for LEAP-backed PMCC positions." style={{padding:48}}/>}
        {tab==="market"&&<MarketTab defaultSymbol={asset.ticker} color={color}/>}
      </div>

      {/* Close/Roll Modal */}
      {showCR&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowCR(null)}>
          <div className="fbox">
            <div className="ftitle">Close or Roll position</div>
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              {(()=>{const tot=crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0);return(<><span style={{color:"#FFD84D"}}>${showCR.strike}</span> · exp. {showCR.expiration} · <span style={{color:"#D6E2F0"}}>{tot} contract{tot>1?"s":""}</span>{crGroup.length>1&&<span style={{color:"#7D91AA",marginLeft:4}}>({crGroup.length} orders)</span>}</>);})()}
            </div>
            <div className="toggle-group" style={{marginBottom:14}}>
              {[["close","Close only"],["roll","Roll"],["expired","Expired worthless"]].map(([m,l])=>(
                <button key={m} className="tgl" onClick={()=>setCrForm({...crForm,mode:m})} style={{flex:1,background:crForm.mode===m?color:"transparent",color:crForm.mode===m?"#071019":"#7D91AA"}}>{l}</button>
              ))}
            </div>
            {crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0)>1&&(
            <div className="fgrp" style={{marginBottom:12}}>
              {(()=>{const tot=crGroup.reduce((s,o)=>s+parseInt(o.contracts||1),0);return(<>
              <label className="flbl">
                Contracts to {crForm.mode==="roll"?"roll":crForm.mode==="expired"?"expire":"close"}
                <span style={{color:"#4A6A8A",marginLeft:6,fontSize:11}}>(max {tot}{crGroup.length>1?`, ${crGroup.length} orders`:""})</span>
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
              <div style={{background:"#B37CFF10",border:"1px solid #B37CFF33",borderRadius:6,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#B37CFF"}}>
                Option expired worthless — full premium kept, no cost to close. ✅
              </div>
            )}
            {crForm.mode==="roll"&&(
              <>
                <div style={{borderTop:"1px solid #1B2A3A",paddingTop:12,marginBottom:10,fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#4A6A8A"}}>New position</div>
                <div className="frow">
                  <div className="fgrp"><label className="flbl">New strike ($)</label><input className="finput" type="number" step="0.5" value={crForm.newStrike} onChange={e=>setCrForm({...crForm,newStrike:e.target.value})}/></div>
                  <div className="fgrp"><label className="flbl">Premium received ($)</label><input className="finput" type="number" min="0" step="0.01" placeholder="0.55" value={crForm.newPrem} onChange={e=>setCrForm({...crForm,newPrem:e.target.value})}/></div>
                </div>
                <div className="fgrp" style={{marginBottom:12}}>
                  <label className="flbl">New expiration</label>
                  <input className="finput" type="date" value={crForm.newExp} onChange={e=>setCrForm({...crForm,newExp:e.target.value})}/>
                </div>
                {crForm.closePrem&&crForm.newPrem&&(
                  <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 13px",marginBottom:12,fontSize:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#7D91AA"}}>Paid:</span><span style={{color:"#FF4D6D"}}>-${fmt(parseFloat(crForm.closePrem)*100)}</span></div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:"#7D91AA"}}>Received:</span><span style={{color}}>${fmt(parseFloat(crForm.newPrem)*100)}</span></div>
                    <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #1B2A3A",paddingTop:6,marginTop:4}}>
                      <span style={{color:"#7D91AA"}}>Net credit:</span>
                      <span style={{fontWeight:700,color:(parseFloat(crForm.newPrem)-parseFloat(crForm.closePrem))>=0?color:"#FF4D6D"}}>
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
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
              <span style={{color:"#FFD84D"}}>${closeLeap.strike}</span> · exp {closeLeap.expiration} · cost <span style={{color}}>${fmt(closeLeap.cost)}</span> · {closeLeap.contracts} contract{closeLeap.contracts>1?"s":""}
            </div>
            <div className="fgrp" style={{marginBottom:12}}>
              <label className="flbl">Price received to sell LEAP ($)</label>
              <input className="finput" type="number" step="0.01" placeholder="e.g. 5.50" value={closeLeapPrem}
                onChange={e=>setCloseLeapPrem(e.target.value)} autoFocus/>
            </div>
            {closeLeapPrem&&(
              <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 13px",marginBottom:12,fontSize:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{color:"#7D91AA"}}>Original cost:</span>
                  <span style={{color:"#FF4D6D"}}>-${fmt(closeLeap.cost*closeLeap.contracts*100)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{color:"#7D91AA"}}>Sale price:</span>
                  <span style={{color:"#63E6BE"}}>+${fmt(parseFloat(closeLeapPrem)*closeLeap.contracts*100)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #1B2A3A",paddingTop:6,marginTop:4}}>
                  <span style={{color:"#7D91AA"}}>Net P&L on LEAP:</span>
                  <span style={{fontWeight:700,color:(parseFloat(closeLeapPrem)-closeLeap.cost)>=0?"#63E6BE":"#FF4D6D"}}>
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
              <div style={{width:36,height:36,borderRadius:"50%",background:"#FF4D6D15",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <span style={{color:"#FF4D6D",fontSize:18}}>⚠</span>
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
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 13px",marginBottom:14,fontSize:12,color:"#8aaac8"}}>
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
      {showCreateStrategy&&(
        <CreateStrategyModal
          asset={asset}
          onCreate={createStrategyFromDashboard}
          onClose={()=>setShowCreateStrategy(false)}
        />
      )}
      {strategyEditorTrade&&(
        <StrategyAssignmentModal
          mode="change"
          asset={asset}
          trade={strategyEditorTrade}
          strategies={assetStrategies}
          suggestions={buildStrategySuggestions({trade:strategyEditorTrade,asset,strategies:assetStrategies})}
          onConfirm={confirmStrategyEditor}
          onClose={()=>setStrategyEditorTrade(null)}
        />
      )}
      <DeleteOrderConfirmModal
        order={deleteOrder}
        onCancel={()=>setDeleteOrder(null)}
        onConfirm={confirmDeleteOrder}
      />
    </div>
  );
}

// ── Payoff Chart ─────────────────────────────────────────────────────────────
function PayoffChart({ spot, pnlAt, breakeven, singleLeg, height=185 }) {
  if (!spot || !pnlAt) return null;
  const isUnlimited = singleLeg?.side==="buy" && singleLeg?.optType==="call";
  const isUnlimitedLoss = singleLeg?.side==="sell" && singleLeg?.optType==="call";
  const W = 600, H = height;
  const PAD = { l: 68, r: 22, t: 32, b: 30 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const pMin = spot * 0.76, pMax = spot * 1.24;

  const absMax = Math.max(Math.abs(pnlAt(pMax)), Math.abs(pnlAt(pMin)), 10) * 1.3;
  const yMin = -absMax, yMax = absMax;
  const xOf = p => PAD.l + ((p - pMin) / (pMax - pMin)) * cW;
  const yOf = v => PAD.t + ((yMax - v) / (yMax - yMin)) * cH;
  const yZero = yOf(0);

  const N = 80;
  const pts = Array.from({ length: N + 1 }, (_, i) => pMin + (i / N) * (pMax - pMin));
  const curvePts = pts.map(p => `${xOf(p).toFixed(1)},${yOf(pnlAt(p)).toFixed(1)}`).join(" ");
  const polyPts = `${PAD.l},${yZero} ${curvePts} ${W - PAD.r},${yZero}`;

  const axisTick = Math.max(100, Math.floor((absMax * 0.82) / 100) * 100);
  const gridVals = [-axisTick, 0, axisTick].filter(v => v >= yMin - 1 && v <= yMax + 1);

  const xLabels = Array.from({ length: 7 }, (_, i) => pMin + (i / 6) * (pMax - pMin));
  const uid = spot.toFixed(0) + "-" + (breakeven||0).toFixed(0);
  const beVisible = breakeven > pMin && breakeven < pMax;

  const clampLabel = (x, w) => Math.min(Math.max(x, PAD.l + w / 2), W - PAD.r - w / 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} preserveAspectRatio="none">
      <defs>
        <clipPath id={`above-${uid}`}><rect x={PAD.l} y={PAD.t} width={cW} height={Math.max(yZero - PAD.t, 0)} /></clipPath>
        <clipPath id={`below-${uid}`}><rect x={PAD.l} y={yZero} width={cW} height={Math.max(H - PAD.b - yZero, 0)} /></clipPath>
        <linearGradient id={`profitGrad-${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#63E6BE" stopOpacity=".34" />
          <stop offset="100%" stopColor="#63E6BE" stopOpacity=".08" />
        </linearGradient>
        <linearGradient id={`lossGrad-${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#FF4D6D" stopOpacity=".10" />
          <stop offset="100%" stopColor="#FF4D6D" stopOpacity=".34" />
        </linearGradient>
      </defs>

      {/* Chart frame + zone backgrounds */}
      <rect x={PAD.l} y={PAD.t} width={cW} height={cH} fill="rgba(5,10,15,.55)" stroke="#1B2A3A" strokeWidth="1" />
      <rect x={PAD.l} y={PAD.t} width={cW} height={Math.max(yZero - PAD.t, 0)} fill={`url(#profitGrad-${uid})`} />
      <rect x={PAD.l} y={yZero} width={cW} height={Math.max(H - PAD.b - yZero, 0)} fill={`url(#lossGrad-${uid})`} />

      {/* Grid */}
      {gridVals.map(v => (
        <g key={v}>
          <line x1={PAD.l} y1={yOf(v)} x2={W - PAD.r} y2={yOf(v)} stroke={v === 0 ? "#2A4A6A" : "#102033"} strokeWidth={v === 0 ? 1.2 : 0.7} />
          <text x={PAD.l - 10} y={yOf(v) + 4} textAnchor="end" fontSize={11} fill="#B7C9EA" fontFamily="IBM Plex Mono,DM Mono,monospace">{v > 0 ? "+$" : v < 0 ? "-$" : "$"}{Math.abs(v)}</text>
        </g>
      ))}

      {/* Filled areas */}
      <polygon points={polyPts} fill="rgba(99,230,190,.23)" clipPath={`url(#above-${uid})`} />
      <polygon points={polyPts} fill="rgba(255,77,109,.25)" clipPath={`url(#below-${uid})`} />

      {/* ATM vertical */}
      <line x1={xOf(spot)} y1={PAD.t} x2={xOf(spot)} y2={H - PAD.b} stroke="#5B8CFF" strokeWidth={1.2} strokeDasharray="5,4" />

      {/* Breakeven vertical */}
      {beVisible && <>
        <line x1={xOf(breakeven)} y1={PAD.t} x2={xOf(breakeven)} y2={H - PAD.b} stroke="#63E6BE" strokeWidth={1.2} strokeDasharray="5,4" />
        <circle cx={xOf(breakeven)} cy={yZero} r={5.2} fill="#63E6BE" stroke="#050A0F" strokeWidth={2.2} />
        <circle cx={xOf(breakeven)} cy={yZero} r={8.5} fill="none" stroke="#63E6BE55" strokeWidth={1} />
        <rect x={clampLabel(xOf(breakeven), 122) - 61} y={H - PAD.b - 20} width={122} height={18} rx={4} fill="#063D30" stroke="#63E6BE88" />
        <text x={clampLabel(xOf(breakeven), 122)} y={H - PAD.b - 8} textAnchor="middle" fontSize={9} fill="#63E6BE" fontFamily="IBM Plex Mono,DM Mono,monospace">Breakeven ${breakeven.toFixed(2)}</text>
      </>}

      {/* Strike dot */}
      {singleLeg?.strike&&singleLeg.strike>pMin&&singleLeg.strike<pMax&&(
        <circle cx={xOf(singleLeg.strike)} cy={yOf(pnlAt(singleLeg.strike))} r={5} fill="#5B8CFF" stroke="#050A0F" strokeWidth={2} />
      )}

      {/* ATM label */}
      <rect x={clampLabel(xOf(spot), 84) - 42} y={PAD.t + 2} width={84} height={18} rx={4} fill="#0F2A66" stroke="#5B8CFF" />
      <text x={clampLabel(xOf(spot), 84)} y={PAD.t + 14} textAnchor="middle" fontSize={9} fill="#9EB9FF" fontFamily="IBM Plex Mono,DM Mono,monospace">ATM ${spot.toFixed(2)}</text>

      {/* Payoff line */}
      <polyline points={curvePts} fill="none" stroke="#63E6BE" strokeWidth={3.1} strokeLinejoin="round" clipPath={`url(#above-${uid})`} />
      <polyline points={curvePts} fill="none" stroke="#FF4D6D" strokeWidth={3.1} strokeLinejoin="round" clipPath={`url(#below-${uid})`} />

      {/* Annotations */}
      {isUnlimited && <text x={W - PAD.r - 6} y={PAD.t + 18} textAnchor="end" fontSize={9} fill="#63E6BE66" fontFamily="IBM Plex Mono,DM Mono,monospace">Unlimited profit ↗</text>}
      {isUnlimitedLoss && <text x={W - PAD.r - 6} y={PAD.t + 18} textAnchor="end" fontSize={9} fill="#ff6b6b66" fontFamily="IBM Plex Mono,DM Mono,monospace">Unlimited risk ↗</text>}

      {/* X axis */}
      {xLabels.map((p, i) => (
        <text key={i} x={xOf(p)} y={H - PAD.b + 18} textAnchor="middle" fontSize={9} fill="#9EB9E9" fontFamily="IBM Plex Mono,DM Mono,monospace">${p.toFixed(0)}</text>
      ))}
      <text x={18} y={H / 2} textAnchor="middle" fontSize={10} fill="#B7C9EA" transform={`rotate(-90,18,${H / 2})`} fontFamily="IBM Plex Mono,DM Mono,monospace">P&L ($)</text>
    </svg>
  );
}

// ── Simulator Panel ───────────────────────────────────────────────────────────
function SimulatorPanel({ onSaveManualTrade, simulatorPreset }) {
  const [searchInput, setSearchInput] = useState("IBIT");
  const [sym, setSym]         = useState("");
  const [legs, setLegs] = useState([{id:1,side:"buy",optType:"call",strike:null,strikeInput:"",customPremium:null,premInput:""}]);
  const [activePresetName, setActivePresetName] = useState("");
  const appliedPresetRef = useRef(null);
  const updateLeg = (id,patch) => setLegs(p=>p.map(l=>l.id===id?{...l,...patch}:l));
  const primaryLeg = legs[0];
  // Aliases + wrapper setters — all downstream code stays unchanged
  const side    = primaryLeg.side;
  const optType = primaryLeg.optType;
  const selStrike = primaryLeg.strike;
  const customPremium = primaryLeg.customPremium;
  const premiumInput  = primaryLeg.premInput;
  const strikeInputVal = primaryLeg.strikeInput;
  const setSide           = (v) => updateLeg(primaryLeg.id, {side:v});
  const setOptType        = (v) => updateLeg(primaryLeg.id, {optType:v});
  const setSelStrike      = (v) => updateLeg(primaryLeg.id, {strike:v});
  const setStrikeInputVal = (v) => updateLeg(primaryLeg.id, {strikeInput:v});
  const setCustomPremium  = (v) => updateLeg(primaryLeg.id, {customPremium:v});
  const setPremiumInput   = (v) => updateLeg(primaryLeg.id, {premInput:v});
  const [exps, setExps]   = useState([]);
  const [selExp, setSelExp]   = useState("");
  const [chain, setChain]     = useState([]);
  const [quote, setQuote]     = useState(null);
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
  const [priceRangeLevel, setPriceRangeLevel] = useState(20);
  const [showGreeks, setShowGreeks] = useState(true);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [symbolSuggestions, setSymbolSuggestions] = useState([]);
  const [searchingSymbols, setSearchingSymbols] = useState(false);

  const spot = quote?.last || 0;
  const activeSpot = spot;

  useEffect(()=>{
    if(!showSymbolSearch) return;
    const q = searchInput.trim();
    if(q.length<1) { setSymbolSuggestions([]); return; }
    let canceled = false;
    const timer = setTimeout(async()=>{
      setSearchingSymbols(true);
      try {
        const results = await fetchSymbolSearch(q);
        if(!canceled) setSymbolSuggestions(results.slice(0,7));
      } catch {
        if(!canceled) setSymbolSuggestions([]);
      }
      if(!canceled) setSearchingSymbols(false);
    },220);
    return ()=>{ canceled = true; clearTimeout(timer); };
  },[searchInput, showSymbolSearch]);

  const selectSimulatorSymbol = (symbol) => {
    const s = (symbol||"").trim().toUpperCase();
    if(!s) return;
    setShowSymbolSearch(false);
    setSymbolSuggestions([]);
    setSearchInput(s);
    loadSym(s);
  };

  const typedSymbol = searchInput.trim().toUpperCase();
  const canUseTypedSymbol = /^[A-Z][A-Z0-9.]{0,9}$/.test(typedSymbol);
  const visibleSymbolSuggestions = useMemo(() => {
    const normalized = symbolSuggestions
      .map((item) => ({
        ...item,
        symbol: String(item?.symbol || "").toUpperCase(),
        description: item?.description || "",
      }))
      .filter((item) => item.symbol);
    if(canUseTypedSymbol && !normalized.some((item) => item.symbol===typedSymbol)) {
      return [{ symbol: typedSymbol, description: "Use typed ticker" }, ...normalized].slice(0, 8);
    }
    return normalized.slice(0, 8);
  }, [symbolSuggestions, canUseTypedSymbol, typedSymbol]);

  const filteredChain = useMemo(()=>
    chain.filter(o=>o.option_type===optType).sort((a,b)=>a.strike-b.strike),
    [chain, optType]
  );
  const availableStrikes = useMemo(()=>filteredChain.map(o=>o.strike),[filteredChain]);

  // Multi-leg helpers
  const getLegStrikes = useCallback((leg)=>
    [...new Set(chain.filter(o=>o.option_type===leg.optType).map(o=>o.strike))].sort((a,b)=>a-b),
    [chain]
  );
  const getLegOption  = useCallback((leg)=>chain.find(o=>o.option_type===leg.optType&&o.strike===leg.strike),[chain]);
  const getLegPremium = useCallback((leg)=>{
    if(leg.customPremium!==null) return leg.customPremium;
    const o=getLegOption(leg); return o?.ask||o?.last||0;
  },[getLegOption]);
  const getLegIV = useCallback((leg)=>{
    const o=getLegOption(leg); return Math.max(o?.greeks?.smv_vol||0.3,0.05);
  },[getLegOption]);

  useEffect(()=>{
    if(!simulatorPreset?.title || appliedPresetRef.current===simulatorPreset.id) return;
    const preset = SIMULATOR_PRESETS[simulatorPreset.title];
    if(!preset) {
      appliedPresetRef.current = simulatorPreset.id;
      setActivePresetName(simulatorPreset.title);
      return;
    }
    setActivePresetName(simulatorPreset.title);
    if(!chain.length || !spot) {
      setLegs(preset.map((leg,idx)=>({
        id: Date.now()+idx,
        side: leg.side,
        optType: leg.optType,
        strike: null,
        strikeInput: "",
        customPremium: null,
        premInput: "",
      })));
      return;
    }
    const selectStrike = (optType, offset) => {
      const strikes = [...new Set(chain.filter(o=>o.option_type===optType).map(o=>o.strike))].sort((a,b)=>a-b);
      if(!strikes.length) return null;
      let atmIdx = 0;
      strikes.forEach((strike,idx)=>{
        if(Math.abs(strike-spot)<Math.abs(strikes[atmIdx]-spot)) atmIdx = idx;
      });
      const idx = Math.max(0, Math.min(strikes.length-1, atmIdx + offset));
      return strikes[idx];
    };
    const nextLegs = preset.map((leg,idx)=>{
      const strike = selectStrike(leg.optType, leg.offset);
      return {
        id: Date.now()+idx,
        side: leg.side,
        optType: leg.optType,
        strike,
        strikeInput: strike ? strike.toFixed(2) : "",
        customPremium: null,
        premInput: "",
      };
    });
    if(nextLegs.some(leg=>leg.strike)) {
      setLegs(nextLegs);
      appliedPresetRef.current = simulatorPreset.id;
    }
  },[simulatorPreset, chain, spot]);

  const addLeg = ()=>{
    const last=legs[legs.length-1];
    const newSide=last.side==="buy"?"sell":"buy";
    const stk=getLegStrikes({optType:last.optType});
    const atm=stk.length&&spot?stk.reduce((a,b)=>Math.abs(b-spot)<Math.abs(a-spot)?b:a):null;
    setLegs(p=>[...p,{id:Date.now(),side:newSide,optType:last.optType,strike:atm,strikeInput:atm?.toFixed(2)||"",customPremium:null,premInput:""}]);
  };

  const snapStrikeLeg=(id,val)=>{
    const n=parseFloat(val); if(isNaN(n)) return;
    const leg=legs.find(l=>l.id===id); if(!leg) return;
    const stk=getLegStrikes(leg); if(!stk.length) return;
    const c=stk.reduce((a,b)=>Math.abs(b-n)<Math.abs(a-n)?b:a);
    updateLeg(id,{strike:c,strikeInput:c.toFixed(2)});
  };

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

  // Reset displayed heatmap width on new symbol
  useEffect(()=>{ setPriceRangeLevel(20); },[sym]);

  // Populate Add Trade modal fields when opened
  useEffect(()=>{
    if(showQuickAdd){ setQaContracts(1); setQaPremium(activePremium.toFixed(2)); setQaStrike(selStrike); setQaExp(selExp); }
  },[showQuickAdd]);
  const iv       = Math.max(selOption?.greeks?.smv_vol||0.3, 0.05);
  const delta    = selOption?.greeks?.delta||0;
  const theta    = selOption?.greeks?.theta||0;
  const gamma    = selOption?.greeks?.gamma||0;
  const vega     = selOption?.greeks?.vega||0;


  // Combined payoff across all legs (at expiration) — declared early so breakeven/maxProfit can use it
  const combinedPnlAt = useCallback((price)=>legs.reduce((sum,leg)=>{
    if(!leg.strike) return sum;
    const prem=getLegPremium(leg); if(prem<=0) return sum;
    const intr=leg.optType==="call"?Math.max(price-leg.strike,0):Math.max(leg.strike-price,0);
    const raw=(intr-prem)*100;
    return sum+(leg.side==="buy"?raw:-raw);
  },0),[legs,getLegPremium]);

  const priceSamples = useMemo(()=>Array.from({length:400},(_,i)=>activeSpot*0.4+(i/399)*activeSpot*1.2),[activeSpot]);
  const payoffSamples = useMemo(()=>priceSamples.map(p=>combinedPnlAt(p)),[priceSamples,combinedPnlAt]);

  const breakeven = useMemo(()=>{
    if(legs.length===1&&selStrike&&activePremium){
      if(optType==="call") return side==="buy"?selStrike+activePremium:selStrike-activePremium;
      return side==="buy"?selStrike-activePremium:selStrike+activePremium;
    }
    // Multi-leg: find first zero crossing
    for(let i=1;i<priceSamples.length;i++){
      const prev=payoffSamples[i-1],curr=payoffSamples[i];
      if((prev<0&&curr>=0)||(prev>0&&curr<=0)) return (priceSamples[i-1]+priceSamples[i])/2;
    }
    return 0;
  },[legs,selStrike,activePremium,optType,side,priceSamples,payoffSamples]);

  const maxProfit = useMemo(()=>{ if(!payoffSamples.length) return 0; const m=Math.max(...payoffSamples); const rising=payoffSamples.slice(-5); return rising[4]>rising[0]?Infinity:m; },[payoffSamples]);
  const maxLoss   = useMemo(()=>{ if(!payoffSamples.length) return 0; const m=Math.min(...payoffSamples); const fall=payoffSamples.slice(0,5); return fall[0]<fall[4]?-Infinity:m; },[payoffSamples]);
  const probITM   = Math.abs(delta);
  const probTouch = Math.min(probITM*2,0.99);
  const chanceOfProfit = side==="buy"?probITM:(1-probITM);
  const assignmentRisk = useMemo(()=>{
    if(side!=="sell"||!selStrike||!activeSpot) return "—";
    const dist=Math.abs(selStrike-activeSpot)/activeSpot;
    if(dist<0.03) return "High";
    if(dist<0.07) return "Med";
    return "Low";
  },[side,selStrike,activeSpot]);
  const deltaDir = delta > 0.1 ? "Bullish" : delta < -0.1 ? "Bearish" : "Neutral";
  const deltaDirColor = delta > 0.1 ? "#5B8CFF" : delta < -0.1 ? "#FF4D6D" : "#8aaac8";
  const expectedValue = useMemo(()=>{
    if(!payoffSamples.length||!selStrike) return null;
    return payoffSamples.reduce((s,v)=>s+v,0)/payoffSamples.length;
  },[payoffSamples,selStrike]);

  const strategy = useMemo(()=>{
    if(legs.length===1){
      const l=legs[0];
      if(l.side==="buy"&&l.optType==="call") return "Long Call";
      if(l.side==="sell"&&l.optType==="call") return "Short Call";
      if(l.side==="buy"&&l.optType==="put")  return "Long Put";
      if(l.side==="sell"&&l.optType==="put")  return "Short Put";
    }
    return legs.map(l=>`${l.side==="buy"?"Buy":"Sell"} ${l.optType}`).join(" / ");
  },[legs]);

  const loadSym = useCallback(async(s)=>{
    setLoading(true); setError(null); setChain([]); setQuote(null);
    setLegs([{id:1,side:"buy",optType:"call",strike:null,strikeInput:"",customPremium:null,premInput:""}]);
    try{
      const e=await fetchExpirations(s);
      if(!e?.length){setError(`No listed option expirations found for "${s}".`);setLoading(false);return;}
      const defaultExp=e[Math.min(11,e.length-1)];
      setExps(e); setSelExp(defaultExp); setSym(s);
      const[q,ch]=await Promise.all([fetchQuote(s),fetchOptionChain(s,defaultExp)]);
      setQuote(q); setChain(ch);
    }catch{setError("Market data is unavailable right now. Try refreshing in a moment.");}
    setLoading(false);
  },[]);

  const loadChain = useCallback(async(exp)=>{
    setSelExp(exp); setLoading(true);
    setLegs(p=>p.map(l=>({...l,customPremium:null,premInput:""})));
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


  // P&L matrix using Black-Scholes — sums all legs
  const downsideRangePct = 10 + priceRangeLevel * 0.6;
  const upsideRangePct = 50 + priceRangeLevel;
  const heatmapPrices = useMemo(()=>{
    if(!activeSpot) return [];
    const levels=7;
    const above=Array.from({length:levels},(_,i)=>{
      const pct=upsideRangePct*((levels-i)/levels);
      return +(activeSpot*(1+pct/100)).toFixed(2);
    });
    const below=Array.from({length:levels},(_,i)=>{
      const pct=downsideRangePct*((i+1)/levels);
      return +(activeSpot*(1-pct/100)).toFixed(2);
    });
    return [...above,+activeSpot.toFixed(2),...below];
  },[activeSpot,downsideRangePct,upsideRangePct]);
  const matrixRows = useMemo(()=>{
    if(!chain.length||!selExp||!legs.some(l=>l.strike&&getLegPremium(l)>0)) return [];
    const r=0.05;
    const expDate=new Date(selExp+"T16:00:00");
    return heatmapPrices.map(rowPrice=>{
      const pct=activeSpot>0?((rowPrice-activeSpot)/activeSpot*100).toFixed(1):"0.0";
      const cols=colExps.map(exp=>{
        const colDate=new Date(exp+"T16:00:00");
        const combined=legs.reduce((sum,leg)=>{
          if(!leg.strike) return sum;
          const prem=getLegPremium(leg); if(prem<=0) return sum;
          const T=Math.max((expDate-colDate)/(365*24*3600*1000),0);
          const optVal=bsPrice(rowPrice,leg.strike,T,r,getLegIV(leg),leg.optType);
          const raw=leg.side==="buy"?(optVal-prem)*100:(prem-optVal)*100;
          return sum+raw;
        },0);
        return Math.round(combined);
      });
      return{price:rowPrice,pct:parseFloat(pct),cols};
    });
  },[chain,heatmapPrices,colExps,selExp,legs,getLegPremium,getLegIV,activeSpot]);

  const atmRowIdx = useMemo(()=>{
    if(!matrixRows.length||!activeSpot) return -1;
    let best=0,bestD=Infinity;
    matrixRows.forEach((r,i)=>{const d=Math.abs(r.price-activeSpot);if(d<bestD){bestD=d;best=i;}});
    return best;
  },[matrixRows,activeSpot]);

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
    if(v>150)  return"linear-gradient(180deg,rgba(13,84,61,.82),rgba(11,64,49,.72))";
    if(v>80)   return"linear-gradient(180deg,rgba(10,72,55,.66),rgba(9,53,42,.58))";
    if(v>20)   return"linear-gradient(180deg,rgba(8,58,48,.48),rgba(7,42,36,.42))";
    if(v>0)    return"linear-gradient(180deg,rgba(8,46,40,.34),rgba(7,33,31,.28))";
    if(v>-20)  return"linear-gradient(180deg,rgba(60,22,31,.30),rgba(43,18,25,.25))";
    if(v>-80)  return"linear-gradient(180deg,rgba(89,31,42,.48),rgba(62,23,32,.42))";
    if(v>-200) return"linear-gradient(180deg,rgba(111,36,49,.62),rgba(78,27,38,.54))";
    return"linear-gradient(180deg,rgba(130,41,55,.76),rgba(90,31,42,.66))";
  };
  const pnlColor=(v)=>v>0?"#63E6BE":v<-5?"#FF4D6D":"#2a4a5a";

  const fmtCell=(v,cost)=>{
    const c=cost||activePremium*100||1;
    if(viewMode==="dollar") return(v>0?"+":"")+v;
    if(viewMode==="pct")    return(v>0?"+":"")+(v/c*100).toFixed(0)+"%";
    return(1+v/c).toFixed(2)+"x";
  };

  const distFromATM = selStrike&&spot?(selStrike-spot).toFixed(2):"0.00";
  const dte = selExp?Math.max(Math.ceil((new Date(selExp)-new Date())/(1000*60*60*24)),0):0;

  const thetaScore = useMemo(()=>{
    if(!selStrike||!activePremium||!dte||!theta||!delta) return null;
    const thetaEff = Math.min(Math.abs(theta)/Math.max(activePremium,0.01)/0.03,1);
    const dteS     = Math.exp(-Math.pow((dte-33)/18,2));
    const deltaS   = Math.exp(-Math.pow((Math.abs(delta)-0.27)/0.15,2));
    const ivS      = Math.min(iv/0.35,1);
    const dist     = activeSpot>0?Math.abs(selStrike-activeSpot)/activeSpot:0;
    const distS    = Math.exp(-Math.pow((dist-0.05)/0.04,2));
    return Math.round((thetaEff*0.35+dteS*0.25+deltaS*0.20+ivS*0.15+distS*0.10)*100);
  },[selStrike,activePremium,dte,theta,delta,iv,activeSpot]);

  return(
    <div className="sim-wrap">
      {/* ── LEFT PANEL ── */}
      <div className="sim-left">
        {activePresetName&&(
          <div style={{background:"#5B8CFF12",border:"1px solid #5B8CFF55",borderRadius:7,padding:"10px 12px",fontSize:11,color:"#9EB9E9",fontFamily:"IBM Plex Mono,DM Mono,monospace",letterSpacing:.3}}>
            Loaded playbook: <span style={{color:"#D6E2F0",fontWeight:800}}>{activePresetName}</span>
          </div>
        )}

        {/* Symbol search / header */}
        {sym?(
          <div style={{background:"radial-gradient(circle at 18% 0%,rgba(99,230,190,.09),transparent 34%),linear-gradient(180deg,#071019,#050A0F)",border:"1px solid #22364A",borderRadius:7,padding:"17px 18px",boxShadow:"inset 0 1px 0 rgba(255,255,255,.035)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:7,position:"relative"}}>
                <div
                  style={{fontFamily:"Syne,sans-serif",fontSize:31,fontWeight:800,color:"#63E6BE",letterSpacing:1,lineHeight:1,textShadow:"0 0 24px rgba(99,230,190,.20)"}}>
                  {sym}
                </div>
                <button title="Search symbol" onClick={()=>{setShowSymbolSearch(v=>!v);setSearchInput(sym);}}
                  style={{background:"#050A0F",border:"1px solid #22364A",borderRadius:6,color:"#8EF0D0",fontSize:13,cursor:"pointer",padding:"4px 7px",lineHeight:1,flexShrink:0}}>
                  &#8981;
                </button>
                <button title="Favorite" style={{background:"none",border:"none",color:"#4A6A8A",fontSize:15,cursor:"pointer",padding:0,lineHeight:1,flexShrink:0}}>☆</button>
                {showSymbolSearch&&(
                  <div style={{position:"absolute",top:"calc(100% + 8px)",left:0,width:310,maxWidth:"78vw",background:"#071019",border:"1px solid #22364A",borderRadius:8,padding:8,zIndex:30,boxShadow:"0 18px 42px rgba(0,0,0,.45)"}}>
                    <div style={{display:"flex",gap:6,marginBottom:7}}>
                      <input className="finput" autoFocus value={searchInput}
                        onChange={e=>setSearchInput(e.target.value.toUpperCase())}
                        onKeyDown={e=>{if(e.key==="Enter") selectSimulatorSymbol(searchInput); if(e.key==="Escape") setShowSymbolSearch(false);}}
                        placeholder="Search ticker..."
                        style={{fontSize:12,textTransform:"uppercase",letterSpacing:.8,color:"#63E6BE",padding:"6px 9px"}}/>
                      <button className="btn bsm" onClick={()=>selectSimulatorSymbol(searchInput)} disabled={loading||!searchInput.trim()}>Go</button>
                    </div>
                    <div style={{maxHeight:220,overflowY:"auto"}}>
                      {searchingSymbols&&<div style={{fontSize:11,color:"#7D91AA",padding:"8px 9px"}}>Searching...</div>}
                      {!searchingSymbols&&visibleSymbolSuggestions.length===0&&searchInput.trim()&&<div style={{fontSize:11,color:"#7D91AA",padding:"8px 9px"}}>No matches found.</div>}
                      {visibleSymbolSuggestions.map(s=>(
                        <button key={s.symbol} onMouseDown={e=>e.preventDefault()} onClick={()=>selectSimulatorSymbol(s.symbol)}
                          style={{width:"100%",display:"flex",alignItems:"center",gap:10,background:"transparent",border:"none",borderRadius:6,padding:"8px 9px",cursor:"pointer",textAlign:"left",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>
                          <span style={{fontWeight:800,color:"#D6E2F0",minWidth:58}}>{s.symbol}</span>
                          <span style={{fontSize:10,color:"#7D91AA",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.description||"US equity"}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <button title="Refresh" onClick={()=>loadSym(sym)} disabled={loading}
                style={{background:"#050A0F",border:"1px solid #22364A",borderRadius:7,color:loading?"#22364A":"#63E6BE",
                  fontSize:15,cursor:"pointer",padding:"7px 9px",lineHeight:1,display:"flex",alignItems:"center",
                  justifyContent:"center",transition:"all .15s",flexShrink:0}}>
                ⟳
              </button>
            </div>
            {quote?.description&&<div style={{fontSize:11,color:"#9EB9E9",marginBottom:2,lineHeight:1.3}}>{quote.description}</div>}
            {spot>0&&(
              <div style={{fontSize:11,color:"#7D91AA",marginTop:6,fontFamily:"IBM Plex Mono,DM Mono,monospace",letterSpacing:.3}}>
                Price: <span style={{color:"#D6E2F0",fontWeight:800}}>${spot.toFixed(2)}</span>
              </div>
            )}
            {error&&<div style={{fontSize:10,color:"#FF4D6D",marginTop:4}}>{error}</div>}
          </div>
        ):(
          <div>
            <div className="sim-slbl">Symbol</div>
            <div style={{display:"flex",gap:6}}>
              <input className="finput" style={{textTransform:"uppercase",letterSpacing:1,fontSize:14,fontWeight:500,color:"#63E6BE"}}
                value={searchInput} onChange={e=>setSearchInput(e.target.value.toUpperCase())}
                onKeyDown={e=>e.key==="Enter"&&loadSym(searchInput)}
                placeholder="AAPL, TSLA..."/>
              <button className="btn bsm" onClick={()=>loadSym(searchInput)} disabled={loading} style={{flexShrink:0}}>{loading?"…":"↻"}</button>
            </div>
            {error&&<div style={{fontSize:10,color:"#FF4D6D",marginTop:4}}>{error}</div>}
          </div>
        )}


        {/* Legs */}
        <div>
          <div className="sim-slbl">Legs</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {legs.map((leg)=>{
              const legStrikes=getLegStrikes(leg);
              const legOpt=getLegOption(leg);
              const legMktPrem=legOpt?.ask||legOpt?.last||0;
              const legAtm=legStrikes.length&&spot?legStrikes.reduce((a,b)=>Math.abs(b-spot)<Math.abs(a-spot)?b:a):null;
              return(
                <div key={leg.id} style={{background:"linear-gradient(180deg,#0B131D,#071019)",border:"1px solid #22364A",borderRadius:8,padding:"10px 11px",boxShadow:"inset 0 1px 0 rgba(255,255,255,.03)"}}>
                  <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:12}}>
                    {[
                      {label:"Buy",  active:leg.side==="buy",   bg:"#63E6BE", col:"#050A0F", fn:()=>updateLeg(leg.id,{side:"buy"})},
                      {label:"Sell", active:leg.side==="sell",  bg:"#FF4D6D", col:"#fff",    fn:()=>updateLeg(leg.id,{side:"sell"})},
                      {label:"Call", active:leg.optType==="call", bg:"#5B8CFF", col:"#fff",  fn:()=>updateLeg(leg.id,{optType:"call",strike:null,strikeInput:""})},
                      {label:"Put",  active:leg.optType==="put",  bg:"#B37CFF", col:"#fff",  fn:()=>updateLeg(leg.id,{optType:"put",strike:null,strikeInput:""})},
                    ].map(({label,active,bg,col,fn})=>(
                      <button key={label} onClick={fn}
                        style={{flex:1,padding:"10px 0",borderRadius:7,
                          border:`1px solid ${active?bg+"66":"#1B2A3A"}`,
                          cursor:"pointer",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:12,fontWeight:700,
                          letterSpacing:.3,transition:"all .15s",
                          background:active?bg:"#0B131D",
                          color:active?col:"#7D91AA",
                          boxShadow:active?`0 0 0 1px ${bg}55,0 0 18px ${bg}66,0 0 36px ${bg}22`:"none"}}>
                        {label}
                      </button>
                    ))}
                    {legs.length>1&&(
                      <button onClick={()=>setLegs(p=>p.filter(l=>l.id!==leg.id))}
                        style={{background:"none",border:"1px solid #FF4D6D44",borderRadius:4,color:"#FF4D6D",cursor:"pointer",fontSize:11,padding:"2px 6px",lineHeight:1,flexShrink:0}}>✕</button>
                    )}
                  </div>
                  {legStrikes.length>0&&(
                    <div
                      ref={el=>{if(!el)return;const atm=el.querySelector('[data-atm]');if(atm)requestAnimationFrame(()=>{el.scrollLeft=atm.offsetLeft-el.offsetWidth/2+atm.offsetWidth/2;});}}
                      style={{overflowX:"auto",paddingBottom:4,marginBottom:5}}>
                      <div style={{display:"flex",gap:3,minWidth:"max-content"}}>
                        {legStrikes.map(s=>{
                          const isAtm=s===legAtm;
                          const isSel=s===leg.strike;
                          return(
                            <button key={s} data-atm={isAtm?true:undefined}
                              className={`sim-chip${isSel?" sel":""}${isAtm&&!isSel?" atm":""}`}
                              onClick={()=>updateLeg(leg.id,{strike:s,strikeInput:s.toFixed(2)})}>
                              {s.toFixed(2)}{isAtm&&!isSel?" ◀":""}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <div style={{display:"flex",alignItems:"center",gap:7,flex:1,background:"#050A0F",border:"1px solid #1B2A3A",borderRadius:6,padding:"9px 10px"}}>
                      <span style={{fontSize:10,color:"#7D91AA",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>K</span>
                      <input value={leg.strikeInput}
                        onChange={e=>updateLeg(leg.id,{strikeInput:e.target.value})}
                        onBlur={e=>snapStrikeLeg(leg.id,e.target.value)}
                        onKeyDown={e=>e.key==="Enter"&&snapStrikeLeg(leg.id,leg.strikeInput)}
                        placeholder="strike"
                        style={{background:"transparent",border:"none",outline:"none",color:"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:17,width:72}}/>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:7,flex:1,background:"#050A0F",border:`1px solid ${leg.customPremium!==null?"#FFD84D66":"#1B2A3A"}`,borderRadius:6,padding:"9px 10px"}}>
                      <span style={{fontSize:10,color:"#7D91AA",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>$</span>
                      <input value={leg.premInput||legMktPrem.toFixed(2)}
                        onChange={e=>updateLeg(leg.id,{premInput:e.target.value})}
                        onBlur={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>0){updateLeg(leg.id,{customPremium:v,premInput:v.toFixed(2)});}else{updateLeg(leg.id,{customPremium:null,premInput:legMktPrem>0?legMktPrem.toFixed(2):"0.00"});}}}
                        onKeyDown={e=>{if(e.key==="Enter"){const v=parseFloat(leg.premInput);if(!isNaN(v)&&v>0)updateLeg(leg.id,{customPremium:v,premInput:v.toFixed(2)});}}}
                        style={{background:"transparent",border:"none",outline:"none",color:leg.customPremium!==null?"#FFD84D":"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:17,width:72}}/>
                      {leg.customPremium!==null&&(
                        <button onClick={()=>updateLeg(leg.id,{customPremium:null,premInput:legMktPrem>0?legMktPrem.toFixed(2):"0.00"})}
                          title="Reset to market" style={{background:"none",border:"none",cursor:"pointer",color:"#5B8CFF",fontSize:9,padding:0,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>↺</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={addLeg}
            style={{width:"100%",padding:"13px 0",marginTop:10,background:"#63E6BE10",border:"1px dashed #63E6BE66",
              borderRadius:7,color:"#63E6BE",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:13,fontWeight:700,
              cursor:"pointer",letterSpacing:.5,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            ＋ Add Leg
          </button>
        </div>

        {/* Summary metrics */}
        {legs.some(l=>l.strike&&getLegPremium(l)>0)&&(
          <div>
            <div className="sim-slbl">Summary</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {(()=>{
                const netDebit=legs.reduce((s,l)=>{const p=getLegPremium(l);if(!l.strike||p<=0)return s;return s+(l.side==="buy"?p:-p);},0);
                const isDebit=netDebit>=0;
                return[
                  ["Net "+(isDebit?"Debit":"Credit"),(isDebit?"-":"+")+`$${(Math.abs(netDebit)*100).toFixed(0)}`,isDebit?"#FF4D6D":"#63E6BE"],
                  ["Max Loss",maxLoss===-Infinity?"Unlimited":`-$${Math.abs(maxLoss).toFixed(0)}`,"#FF4D6D"],
                  ["Max Profit",maxProfit===Infinity?"Unlimited":`+$${maxProfit.toFixed(0)}`,"#63E6BE"],
                  ["Breakeven",breakeven>0?`$${breakeven.toFixed(2)}`:"—","#FFD84D"],
                ];
              })().map(([l,v,c])=>(
                <div key={l} className="sim-metric" style={{"--mt":c,"--mc":c}}>
                  <div className="sim-metric-lbl">{l}</div>
                  <div className="sim-metric-val">{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Greeks + Theta Score */}
        {selOption&&showGreeks&&(
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <div className="sim-slbl">Greeks</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:5}}>
              {[["Delta",fmt(delta,3),"#5B8CFF"],["Gamma",fmt(gamma,4),"#63E6BE"],["Theta",fmt(theta,3),"#FF4D6D"],["Vega",fmt(vega,3),"#B37CFF"]].map(([name,val,c])=>(
                <div key={name} style={{background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:9,padding:"10px 8px",textAlign:"center"}}>
                  <div style={{fontSize:12,color:"#4A6A8A",marginBottom:4,letterSpacing:.5}}>{name}</div>
                  <div style={{fontSize:15,fontWeight:600,color:c}}>{val}</div>
                </div>
              ))}
            </div>
            {thetaScore!==null&&(()=>{
              const sc=thetaScore;
              const col=sc>=70?"#63E6BE":sc>=40?"#FFD84D":"#FF4D6D";
              const lbl=sc>=70?"Strong":sc>=40?"Moderate":"Weak";
              return(
                <div style={{background:"linear-gradient(180deg,#0B131D,#071019)",border:`1px solid ${col}66`,borderRadius:7,padding:"11px 12px",boxShadow:`0 0 18px ${col}18,inset 0 1px 0 rgba(255,255,255,.03)`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{fontSize:14,fontWeight:700,color:"#B7C9EA",letterSpacing:.7}}>Theta Score</div>
                      <div style={{position:"relative",display:"inline-block"}}>
                        <button style={{width:15,height:15,borderRadius:"50%",background:"#1B2A3A",border:"1px solid #2a3a4a",
                          color:"#6a8aaa",fontSize:9,cursor:"default",display:"flex",alignItems:"center",justifyContent:"center",
                          fontFamily:"IBM Plex Mono,DM Mono,monospace",padding:0}}>?</button>
                        <div className="ts-tooltip">
                          Theta Efficiency (35%) — decay per dollar of premium{"\n"}
                          DTE sweet spot (25%) — ideal 21–45 days{"\n"}
                          Delta positioning (20%) — ideal 0.20–0.35{"\n"}
                          IV level (15%) — premium available{"\n"}
                          Strike Distance (10%) — ideal 3–7% OTM
                        </div>
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:26,fontWeight:650,color:col,lineHeight:1.18,textShadow:`0 0 18px ${col}44`}}>{sc}</div>
                      <div style={{fontSize:10,color:col,letterSpacing:.5,marginTop:2}}>{lbl}</div>
                    </div>
                  </div>
                  <div style={{height:7,background:"#102033",borderRadius:4,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${sc}%`,background:`linear-gradient(90deg,${col}aa,${col})`,borderRadius:4,transition:"width .3s",boxShadow:`0 0 14px ${col}66`}}/>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Selected expiration info */}
        {selExp&&activePremium>0&&(
          <div style={{background:"#071019",border:"1px solid #63E6BE33",borderRadius:6,padding:"9px 11px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:13,fontWeight:650,color:"#63E6BE"}}>{selExp}</div>
              <div style={{fontSize:11,fontWeight:700,color:"#FF4D6D",background:"#FF4D6D15",border:"1px solid #FF4D6D55",borderRadius:4,padding:"3px 9px",letterSpacing:.5}}>{dte} DTE</div>
            </div>
            <div style={{fontSize:10,color:"#4A6A8A",marginTop:3}}>
              Premium: <span style={{color:"#D6E2F0"}}>${fmt(premium)} ask</span>
              {iv>0&&<> &nbsp;·&nbsp; IV: <span style={{color:"#FFD84D"}}>{(iv*100).toFixed(1)}%</span></>}
            </div>
          </div>
        )}

        {activePremium>0&&(
          <button onClick={()=>setShowQuickAdd(p=>!p)}
            style={{width:"100%",padding:"11px 0",marginTop:"auto",
              background:showQuickAdd?"#FF4D6D15":"#63E6BE14",
              border:`1px solid ${showQuickAdd?"#FF4D6D55":"#63E6BE55"}`,borderRadius:8,
              color:showQuickAdd?"#FF4D6D":"#63E6BE",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:12,fontWeight:700,
              cursor:"pointer",letterSpacing:.5,display:"flex",alignItems:"center",justifyContent:"center",gap:7,
              boxShadow:showQuickAdd?"none":"0 0 18px rgba(99,230,190,.1)",transition:"all .2s"}}>
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
                  <div style={{fontSize:11,letterSpacing:1.7,textTransform:"uppercase",color:"#5f7c9d",textAlign:"center",borderRight:"1px solid #1B2A3A",padding:"0 10px 5px",marginBottom:5,fontWeight:700}}>{month}</div>
                  <div style={{display:"flex",gap:3,padding:"0 6px 8px"}}>
                    {dates.map(exp=>{
                      const d=new Date(exp+"T12:00:00");
                      const expDte=Math.max(Math.ceil((new Date(exp)-new Date())/(1000*60*60*24)),0);
                      return(
                        <button key={exp} className={`sim-exp-btn${selExp===exp?" sel":""}`} onClick={()=>loadChain(exp)}>
                          {d.getDate()}
                          <span style={{display:"block",fontSize:10,opacity:.78,marginTop:2,textAlign:"center",fontWeight:700}}>{expDte}d</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Probabilities + Payoff Chart side by side */}
        {selOption&&selStrike&&activePremium>0&&(()=>{
          const arColor=assignmentRisk==="High"?"#FF4D6D":assignmentRisk==="Med"?"#FFD84D":"#63E6BE";
          const ivLbl=iv>0.4?"High":iv>0.2?"Med":"Low";
          const ivColor=iv>0.4?"#FF4D6D":iv>0.2?"#FFD84D":"#63E6BE";
          const evColor=expectedValue!=null&&expectedValue>=0?"#63E6BE":"#FF4D6D";
          const evPct=expectedValue!=null&&activePremium>0?((expectedValue/Math.abs(activePremium*100))*100):null;
          const lowerCardStyle={background:"linear-gradient(180deg,#0B131D,#071019)",border:"1px solid #22364A",borderRadius:7,padding:"9px 11px",minHeight:58,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"flex-start",gap:7,boxSizing:"border-box"};
          const lowerLabelStyle={fontSize:11,color:"#B7C9EA",letterSpacing:.5,fontWeight:800,fontFamily:"IBM Plex Mono,DM Mono,monospace",textTransform:"uppercase",lineHeight:1.2};
          const lowerValueStyle={fontSize:14,fontWeight:800,fontFamily:"IBM Plex Mono,DM Mono,monospace",lineHeight:1.05};
          const lowerSubStyle={fontSize:10,fontFamily:"IBM Plex Mono,DM Mono,monospace",lineHeight:1.05,marginTop:2};
          return(
          <div style={{display:"grid",gridTemplateColumns:"minmax(470px,47%) minmax(430px,1fr)",gap:0,alignItems:"start",borderBottom:"1px solid #22364A",background:"#071019"}}>
            {/* LEFT: Probabilities */}
            <div style={{padding:"15px 20px 18px",borderRight:"1px solid #22364A",borderBottom:"1px solid #22364A",display:"flex",flexDirection:"column",gap:10,alignSelf:"start",background:"linear-gradient(180deg,#071019,#050A0F)"}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div className="sim-slbl" style={{margin:0,letterSpacing:2}}>Probabilities</div>
              </div>

              {/* Top row — primary metrics */}
              <div style={{display:"grid",gridTemplateColumns:"1.15fr 1fr 1fr",gap:10,alignItems:"start"}}>
                <div>
                  <div style={{fontSize:12,color:"#D6E2F0",marginBottom:7,letterSpacing:.4,fontWeight:800,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>Chance of Profit</div>
                  <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:29,fontWeight:650,color:"#5B8CFF",lineHeight:1.18,letterSpacing:0,textShadow:"0 0 18px rgba(91,140,255,.18)"}}>{(chanceOfProfit*100).toFixed(1)}%</div>
                </div>
                <div>
                  <div style={{fontSize:12,color:"#D6E2F0",marginBottom:7,letterSpacing:.4,fontWeight:800,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>Delta</div>
                  <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:23,fontWeight:650,color:deltaDirColor,lineHeight:1.18,textShadow:"0 0 16px rgba(91,140,255,.14)"}}>{Math.abs(delta).toFixed(2)}</div>
                  <div style={{fontSize:10,color:deltaDirColor,marginTop:5,fontWeight:700,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>{deltaDir}</div>
                </div>
                <div>
                  <div style={{fontSize:12,color:"#D6E2F0",marginBottom:7,letterSpacing:.4,fontWeight:800,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>IV (option)</div>
                  <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:23,fontWeight:650,color:"#FFD84D",lineHeight:1.18,textShadow:"0 0 16px rgba(255,216,77,.14)"}}>{(iv*100).toFixed(1)}%</div>
                  <div style={{fontSize:10,color:ivColor,marginTop:5,fontWeight:700,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>{ivLbl}</div>
                </div>
              </div>

              {/* Progress bar */}
              <div style={{height:6,background:"#102033",borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${chanceOfProfit*100}%`,background:"linear-gradient(90deg,#5B8CFF,#63E6BE)",borderRadius:2,transition:"width .4s"}}/>
              </div>

              {/* Bottom row — 4 smaller metric cards */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,alignItems:"stretch"}}>
                <div style={lowerCardStyle}>
                  <div style={lowerLabelStyle}>Prob ITM</div>
                  <div style={{...lowerValueStyle,color:"#5B8CFF"}}>{(probITM*100).toFixed(1)}%</div>
                </div>
                <div style={lowerCardStyle}>
                  <div style={lowerLabelStyle}>Prob Touch</div>
                  <div style={{...lowerValueStyle,color:"#B37CFF"}}>{(probTouch*100).toFixed(1)}%</div>
                </div>
                <div style={lowerCardStyle}>
                  <div style={lowerLabelStyle}>Assignment Risk</div>
                  {side==="sell"?(
                    <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                      <div style={{...lowerValueStyle,color:arColor}}>{assignmentRisk}</div>
                      <div style={{...lowerSubStyle,color:arColor}}>{(probITM*100).toFixed(0)}%</div>
                    </div>
                  ):<div style={{...lowerValueStyle,color:"#2a4a6a"}}>N/A</div>}
                </div>
                <div style={lowerCardStyle}>
                  <div style={lowerLabelStyle}>Expected Value</div>
                  {expectedValue!=null?(
                    <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                      <div style={{...lowerValueStyle,color:evColor}}>{expectedValue>=0?"+$":"$"}{Math.abs(expectedValue).toFixed(0)}</div>
                      {evPct!=null&&<div style={{...lowerSubStyle,color:evColor}}>{evPct>=0?"+":""}{evPct.toFixed(1)}%</div>}
                    </div>
                  ):<div style={{...lowerValueStyle,color:"#2a4a6a"}}>—</div>}
                </div>
              </div>
            </div>

            {/* RIGHT: Payoff Chart */}
            <div style={{minWidth:0,padding:"15px 20px 0",background:"radial-gradient(circle at 50% 0%,rgba(91,140,255,.08),transparent 42%),#050A0F"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:11,letterSpacing:2,textTransform:"uppercase",color:"#B7C9EA",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontWeight:700}}>
                  Payoff at Expiration — <span style={{color:"#D6E2F0"}}>{strategy}</span>
                </div>

              </div>
              <PayoffChart spot={activeSpot||spot} pnlAt={combinedPnlAt} breakeven={breakeven} singleLeg={legs.length===1?primaryLeg:null} height={188}/>
            </div>
          </div>
          );
        })()}

        {/* Toolbar */}
        {matrixRows.length>0&&(
          <div className="sim-toolbar">
            <div style={{fontSize:9,color:"#4A6A8A",letterSpacing:1.5,textTransform:"uppercase"}}>View</div>
            <div className="sim-view-group">
              {[["dollar","P&L $"],["pct","P&L %"],["roi","ROI"]].map(([m,l])=>(
                <button key={m} className={`sim-view-btn${viewMode===m?" sel":""}`} onClick={()=>setViewMode(m)}>{l}</button>
              ))}
            </div>
            {breakeven>0&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#FFD84D"}}>
              <div style={{width:20,height:0,borderTop:"1px dashed #FFD84D"}}/> Breakeven ${breakeven.toFixed(2)}
            </div>}
            <div style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#63E6BE"}}>
              <div style={{width:20,height:2,background:"#63E6BE33",boxShadow:"0 0 4px #63E6BE44"}}/>
              <span style={{opacity:.7}}>ATM</span>
              <span style={{color:"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>${spot.toFixed(2)}</span>
            </div>
            <div style={{marginLeft:"auto",fontSize:9,color:"#4A6A8A"}}>Hover any cell for details</div>
          </div>
        )}

        {/* Range slider */}
        {matrixRows.length>0&&(
          <div style={{display:"flex",alignItems:"center",gap:16,padding:"14px 18px",borderBottom:"1px solid #22364A",background:"#071019"}}>
            <span style={{fontSize:11,letterSpacing:1.4,textTransform:"uppercase",color:"#9EB9E9",flexShrink:0,fontWeight:700}}>Price Range</span>
            <button onClick={()=>setPriceRangeLevel(v=>Math.max(0,v-5))}
              style={{background:"none",border:"none",color:"#7D91AA",cursor:"pointer",fontSize:13,padding:"0 2px",lineHeight:1}}>&lt;</button>
            <input className="sim-range-track" type="range" min={0} max={100} step={5} value={priceRangeLevel}
              onChange={e=>setPriceRangeLevel(parseFloat(e.target.value))}
              style={{flex:1,cursor:"pointer"}}/>
            <button onClick={()=>setPriceRangeLevel(v=>Math.min(100,v+5))}
              style={{background:"none",border:"none",color:"#7D91AA",cursor:"pointer",fontSize:13,padding:"0 2px",lineHeight:1}}>&gt;</button>
            <span style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:10,color:"#63E6BE",minWidth:92,textAlign:"right"}}>
              -{downsideRangePct.toFixed(0)}% / +{upsideRangePct.toFixed(0)}%
            </span>
            {priceRangeLevel!==20&&(
              <button onClick={()=>setPriceRangeLevel(20)}
                title="Reset price range"
                style={{fontSize:9,color:"#5B8CFF",background:"none",border:"1px solid #5B8CFF44",borderRadius:3,cursor:"pointer",padding:"1px 5px",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>R</button>
            )}
          </div>
        )}

        {/* P&L Matrix */}
        {matrixRows.length>0?(
          <div className="sim-matrix">
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th className="sim-th sp1">Price</th>
                  <th className="sim-th sp2">Move %</th>
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
                  const isBe=ri===beRowIdx;
                  const cost=activePremium*100;
                  return(
                    <tr key={row.price}
                      className={isAtm?"sim-row-atm":isBe?"sim-row-be":""}
                      style={{borderTop:isAtm?"1px solid #63E6BE22":isBe?"1px dashed #FFD84D44":undefined,
                              borderBottom:isAtm?"1px solid #63E6BE22":undefined}}>
                      <td className="sim-td-price" style={{color:isAtm?"#fff":"#D6E2F0",fontWeight:isAtm?700:400,
                          background:isAtm?"linear-gradient(90deg,#63E6BE08,transparent)":"",
                          boxShadow:isAtm?"inset 3px 0 0 #63E6BE":"none"}}>
                        <span style={{display:"flex",alignItems:"center",gap:4}}>
                          ${row.price.toFixed(2)}
                          {isAtm&&<span style={{fontSize:9,background:"#63E6BE",color:"#050A0F",borderRadius:4,padding:"2px 6px",fontWeight:800,letterSpacing:.45,boxShadow:"0 0 12px rgba(99,230,190,.5)"}}>ATM</span>}
                          {isBe&&<span style={{fontSize:9,background:"#FFD84D",color:"#050A0F",border:"1px solid #FFD84D",borderRadius:4,padding:"2px 6px",fontWeight:800,letterSpacing:.45,boxShadow:"0 0 12px rgba(255,216,77,.35)"}}>BE</span>}
                        </span>
                      </td>
                      <td className="sim-td-pct" style={{color:row.pct>=0?"#63E6BE":"#FF4D6D"}}>
                        {row.pct>=0?"+":""}{row.pct===0?"0":row.pct.toFixed(1)}%
                      </td>
                      {row.cols.map((v,ci)=>{
                        const isSel=colExps[ci]===selExp;
                        const exp=colExps[ci];
                        const colLabel=new Date(exp+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"});
                        return(
                          <td key={ci} className="sim-td"
                            style={{background:pnlBg(v),color:pnlColor(v),
                              outline:isSel?"1px solid #63E6BE88":"none",outlineOffset:"-1px",
                              boxShadow:isSel?"inset 0 1px 0 rgba(99,230,190,.24),inset 0 -1px 0 rgba(99,230,190,.18),inset 0 0 20px rgba(99,230,190,.08)":"none",
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
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#4A6A8A",fontSize:12,flexDirection:"column",gap:8}}>
            {loading?"Loading data...":sym?"Select a strike to view the heatmap":"Enter a symbol and press ↻ to begin"}
          </div>
        )}
      </div>

      {/* Hover Tooltip */}
      {tooltip&&(
        <div style={{position:"fixed",
          left:tipPos.x+(tipPos.x>window.innerWidth-175?-170:14),
          top:tipPos.y+(tipPos.y>window.innerHeight-175?-165:14),
          zIndex:999,background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:8,
          padding:"10px 13px",boxShadow:"0 8px 32px rgba(0,0,0,.6)",
          pointerEvents:"none",minWidth:150,
        }}>
          <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:5}}>{tooltip.date} · ${tooltip.price.toFixed(2)}</div>
          <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:15,fontWeight:650,color:tooltip.dollar>=0?"#63E6BE":"#FF4D6D",marginBottom:6}}>
            {tooltip.dollar>=0?"+":""}{viewMode==="dollar"?`$${tooltip.dollar}`:viewMode==="pct"?`${tooltip.pctStr}%`:`${tooltip.roi}x`}
          </div>
          <div style={{height:1,background:"#1B2A3A",margin:"5px 0"}}/>
          {[["P&L $",(tooltip.dollar>=0?"+":"")+"$"+tooltip.dollar,tooltip.dollar>=0?"#63E6BE":"#FF4D6D"],
            ["Return",(parseFloat(tooltip.pctStr)>=0?"+":"")+tooltip.pctStr+"%","#D6E2F0"],
            ["ROI",tooltip.roi+"x","#D6E2F0"]].map(([l,v,c])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3,fontSize:11}}>
              <span style={{color:"#7D91AA"}}>{l}</span><span style={{fontWeight:600,color:c}}>{v}</span>
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
              zIndex:301,background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:12,
              padding:"20px 22px",width:320,boxShadow:"0 16px 48px rgba(0,0,0,.7)"}}>

              {/* Header */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
                <div>
                  <div style={{fontFamily:"Syne,sans-serif",fontSize:15,fontWeight:800,color:"#fff"}}>{sym}</div>
                  <div style={{fontSize:10,color:"#63E6BE",letterSpacing:.5,marginTop:2}}>
                    {side==="buy"?"BUY":"SELL"} {optType.toUpperCase()} · {strategy}
                  </div>
                </div>
                <button onClick={()=>setShowQuickAdd(false)}
                  style={{background:"none",border:"none",color:"#4A6A8A",fontSize:16,cursor:"pointer",lineHeight:1}}>✕</button>
              </div>

              {/* Editable fields */}
              <div style={{display:"flex",flexDirection:"column",gap:10}}>

                {/* Contracts */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Contracts</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"7px 10px"}}>
                    <button onClick={()=>setQaContracts(c=>Math.max(1,c-1))}
                      style={{background:"#1B2A3A",border:"none",color:"#D6E2F0",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>−</button>
                    <input value={qaContracts} onChange={e=>setQaContracts(Math.max(1,parseInt(e.target.value)||1))}
                      style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#fff",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:15,fontWeight:600,textAlign:"center"}}/>
                    <button onClick={()=>setQaContracts(c=>c+1)}
                      style={{background:"#1B2A3A",border:"none",color:"#D6E2F0",width:22,height:22,borderRadius:4,cursor:"pointer",fontSize:14,lineHeight:"22px",textAlign:"center"}}>+</button>
                  </div>
                </div>

                {/* Price per contract */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Price per Contract</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"7px 10px"}}>
                    <span style={{color:"#7D91AA",fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>$</span>
                    <input value={qaPremium} onChange={e=>setQaPremium(e.target.value)}
                      onBlur={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>0)setQaPremium(v.toFixed(2));}}
                      style={{flex:1,background:"transparent",border:"none",outline:"none",color:"#FFD84D",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:15,fontWeight:600}}/>
                    <span style={{fontSize:9,color:"#4A6A8A"}}>×100 = ${(qaPrem*100).toFixed(0)}</span>
                  </div>
                </div>

                {/* Strike */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Strike</div>
                  <select value={qaStrike||""} onChange={e=>setQaStrike(parseFloat(e.target.value))}
                    className="fsel" style={{width:"100%",fontSize:13}}>
                    {availableStrikes.map(s=><option key={s} value={s}>${s.toFixed(2)}</option>)}
                  </select>
                </div>

                {/* Expiration */}
                <div>
                  <div style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Expiration</div>
                  <select value={qaExp} onChange={e=>setQaExp(e.target.value)}
                    className="fsel" style={{width:"100%",fontSize:13}}>
                    {exps.map(e=><option key={e} value={e}>{e}</option>)}
                  </select>
                </div>

              </div>

              {/* Summary strip */}
              <div style={{marginTop:14,padding:"10px 12px",background:"#071019",borderRadius:7,border:"1px solid #1B2A3A"}}>
                {[
                  ["Total Cost",(side==="buy"?"-":"+")+`$${totalCost.toFixed(0)}`],
                  ["Breakeven",`$${qaBreakeven.toFixed(2)}`],
                  ["Contracts",`${qaCont} × $${(qaPrem*100).toFixed(0)}`],
                ].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:11}}>
                    <span style={{color:"#7D91AA"}}>{l}</span>
                    <span style={{color:"#D6E2F0",fontWeight:600,fontFamily:"IBM Plex Mono,DM Mono,monospace"}}>{v}</span>
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
                      positionEffect:"auto",
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
function Home({ assets, strategies=[], onSelectAsset, onShowPositions, onSaveManualTrade, onEditTrade, onDeleteTrade, onDeleteLeap, onOpenLearn, onStartAdd, simulatorPreset }) {
  const [stratFilter, setStratFilter] = useState("all");
  const [sortBy, setSortBy] = useState("expiration");
  const [deleteOrder, setDeleteOrder] = useState(null);
  const activeAssets = useMemo(()=>assets.filter(a=>a.active),[assets]);

  const totals = useMemo(()=>assets.filter(a=>a.active).map(a=>{
    const leaps = a.leaps||[];
    const leapCost = leaps.reduce((s,l)=>s+l.cost*l.contracts*100,0); // total cost in dollars
    const leapContracts = leaps.reduce((s,l)=>s+l.contracts,0);
    const hasLeap = leapContracts>0;
    const leapAvg = leapContracts>0 ? leapCost/leapContracts : 0; // dollars per contract
    const netColDollar = thetaEngineCashDollars(a.trades, leaps);
    const realizedPnLDollar = realizedOptionPnLDollars(a.trades);
    const incomeGeneratedDollar = assetIncomeGeneratedDollars(a.trades);
    const openTrades=a.trades.filter(t=>t.status==="open");
    const openSells=openTrades.filter(t=>isThetaShortCallTrade(t, leaps));
    const openPremium=openSells.reduce((acc,t)=>acc+tradePremium(t)*tradeContracts(t),0);
    const nearestExp=[...openSells].sort((a,b)=>new Date(a.expiration)-new Date(b.expiration))[0];
    const daysLeft=nearestExp?Math.ceil((new Date(nearestExp.expiration)-new Date())/(1000*60*60*24)):null;
    const premiumPerLeap = leapContracts>0 ? netColDollar/leapContracts : 0;
    const hasTrackedActivity = leapContracts>0 || a.trades.length>0;
    return {...a,leaps,leapCost,leapContracts,leapAvg,netColDollar,realizedPnLDollar,incomeGeneratedDollar,basis:leapAvg-premiumPerLeap,openTrades,openSells,openPremium,nearestExp,daysLeft,hasTrackedActivity};
  }).filter(a=>a.hasTrackedActivity),[assets]);
  const grandCost=useMemo(()=>totals.reduce((a,t)=>a+t.leapCost,0),[totals]);
  const openPositions=useMemo(()=>totals.reduce((a,t)=>a+t.openTrades.length,0)+totals.reduce((a,t)=>a+t.leapContracts,0),[totals]);
  const grandNetCol=useMemo(()=>totals.reduce((a,t)=>a+t.netColDollar,0),[totals]);
  const grandIncomeGenerated=useMemo(()=>totals.reduce((a,t)=>a+t.incomeGeneratedDollar,0),[totals]);
  const avgRecovery=useMemo(()=>grandCost>0?(grandNetCol/grandCost)*100:0,[grandNetCol,grandCost]);

  const filteredTotals=useMemo(()=>totals
    .filter(t=>stratFilter==="all"||(t.strategy||"PMCC")===stratFilter)
    .sort((a,b)=>{
      if(sortBy==="expiration")return(a.daysLeft||999)-(b.daysLeft||999);
      if(sortBy==="ticker")return a.ticker.localeCompare(b.ticker);
      if(sortBy==="recovery")return((b.leapCost>0?b.netColDollar/b.leapCost:0)-(a.leapCost>0?a.netColDollar/a.leapCost:0));
      return 0;
    }),[totals,stratFilter,sortBy]);

  const riskLegend = [
    ["Expiration risk","#FF4D6D","Short call expiring within 3 days."],
    ["Manage this week","#FF7A1A","Short call expiring within 7 days."],
    ["Near milestone","#63E6BE","LEAP recovery between 75% and 99%."],
    ["Engine idle","#5B8CFF","Open LEAP with no active short call generating premium."],
  ];
  const allOpenRows = useMemo(()=>totals.flatMap(t=>{
    const recovery = t.leapCost>0 ? t.netColDollar/t.leapCost*100 : 0;
    const leapRisk = t.leapContracts>0 && t.openSells.length===0
      ? {label:"Engine idle", color:"#5B8CFF"}
      : t.leapCost>0 && recovery>=75 && recovery<100
        ? {label:"Near milestone", color:"#63E6BE"}
        : null;
    const riskForTrade = (tr) => {
      if(!(tr.action==="SELL" && (tr.option_type||"call")==="call")) return null;
      const days = Math.ceil((new Date(tr.expiration)-new Date())/(1000*60*60*24));
      if(days<=3) return {label:"Expiration risk", color:"#FF4D6D"};
      if(days<=7) return {label:"Manage this week", color:"#FF7A1A"};
      return null;
    };
    return [
      ...(t.leaps||[]).map(l=>({
        ...l,
        ticker:t.ticker, color:t.color, assetId:t.id,
        isLeap:true, label:"LEAP", action:"BUY", premium:l.cost,
        priorityRisk:leapRisk,
      })),
      ...t.openTrades.map(tr=>({
        ...tr,
        ticker:t.ticker, color:t.color, assetId:t.id,
        isLeap:false,
        label:tr.action==="BUY"?(tr.option_type==="put"?"Long Put":"Long Call"):(tr.option_type==="put"?"Short Put":"Short Call"),
        contracts:tr.contracts||1,
        priorityRisk:riskForTrade(tr),
      })),
    ];
  }).sort((a,b)=>new Date(a.expiration)-new Date(b.expiration)),[totals]);
  const scrollToSimulator = () => document.getElementById("strategy-builder")?.scrollIntoView({behavior:"smooth",block:"start"});
  const deleteOpenOrder = (row) => {
    const label = row.isLeap ? `${row.ticker} LEAP $${row.strike}` : `${row.ticker} ${row.action} $${row.strike}`;
    setDeleteOrder({kind:row.isLeap?"leap":"trade",assetId:row.assetId,id:row.id,label});
  };
  const confirmDeleteOrder = async () => {
    if(!deleteOrder) return;
    if(deleteOrder.kind==="leap") await onDeleteLeap?.(deleteOrder.assetId,deleteOrder.id);
    else await onDeleteTrade?.(deleteOrder.assetId,deleteOrder.id);
    setDeleteOrder(null);
  };

  return (
    <div className="main fade-in">
      {activeAssets.length===0&&(
        <div className="start-desk">
          <div>
            <div className="start-kicker">Start desk</div>
            <div className="start-title">Build your first options workspace.</div>
            <div className="start-copy">Start with a ticker, test a setup, then track the trade lifecycle from opening premium to exit.</div>
          </div>
          <div className="start-grid">
            <div className="start-card" style={{"--accent":"#63E6BE"}}>
              <div>
                <div className="start-step">Step 01</div>
                <div className="start-card-title">Add a ticker</div>
                <div className="start-card-copy">Create the first position shell for the symbol you want to follow.</div>
              </div>
              <button className="start-action" onClick={onStartAdd}>Add position</button>
            </div>
            <div className="start-card" style={{"--accent":"#5B8CFF"}}>
              <div>
                <div className="start-step">Step 02</div>
                <div className="start-card-title">Model the trade</div>
                <div className="start-card-copy">Use the simulator to compare premium, risk, and expiration before entry.</div>
              </div>
              <button className="start-action" onClick={scrollToSimulator}>Open simulator</button>
            </div>
            <div className="start-card" style={{"--accent":"#FFD84D"}}>
              <div>
                <div className="start-step">Step 03</div>
                <div className="start-card-title">Sharpen context</div>
                <div className="start-card-copy">Review calculators and playbooks when a setup needs a second pass.</div>
              </div>
              <button className="start-action" onClick={onOpenLearn}>Learn desk</button>
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="cards" style={{gridTemplateColumns:"repeat(4,1fr)"}}>
        <div className="card" style={{"--top":"#63E6BE",borderColor:"#63E6BE22"}}>
          <div className="clbl">Income Generated <Tooltip text="Net option income across each asset, including open short-option credits and realized option results."/></div>
          <div className="cval" style={{color:"#63E6BE",textShadow:"0 0 20px rgba(0,212,170,0.3)"}}>{grandIncomeGenerated>=0?"+":""}${fmt(grandIncomeGenerated)}</div>
          <div className="csub">${fmt(grandNetCol)} belongs to the Theta Engine</div>
        </div>
        <div className="card" style={{"--top":"#B37CFF",borderColor:"#B37CFF22"}}>
          <div className="clbl">Engine Progress <Tooltip text="Average percentage of LEAP costs recovered through premium. At 100% your LEAPs are free."/></div>
          <div className="cval" style={{color:"#B37CFF",textShadow:"0 0 20px rgba(167,139,250,0.3)"}}>{fmt(avgRecovery,1)}%</div>
          <div className="csub">of LEAP cost recovered</div>
        </div>
        <div className="card" style={{"--top":"#5B8CFF"}}>
          <div className="clbl">Capital at Risk <Tooltip text="Total cost of your active LEAPs — the maximum you could lose if all expire worthless."/></div>
          <div className="cval">${fmt(grandCost)}</div>
          <div className="csub">{totals.length} active asset{totals.length!==1?"s":""}</div>
        </div>
        <div className="card" style={{"--top":"#FFD84D"}}>
          <div className="clbl">Open Positions <Tooltip text="Total number of open orders across all active strategies — LEAPs, short calls, puts, etc."/></div>
          <div className="cval" style={{color:"#FFD84D"}}>{openPositions}</div>
          <div className="csub" style={{cursor:"pointer",color:"#FFD84D88",textDecoration:"underline",textDecorationStyle:"dotted"}} onClick={onShowPositions}>see all positions →</div>
        </div>
      </div>

      {/* Theta Engine */}
      {grandCost>0&&(
        <div className="sec" style={{marginBottom:18}}>
          <div className="sechdr">
            <div className="sectitle">Theta Engine <Tooltip text="Progress toward making open LEAP positions free using net theta cash, including open short-call credits."/></div>
            <div style={{fontSize:11,color:"#7D91AA"}}><span style={{color:"#63E6BE"}}>{grandNetCol>=0?"+":""}${fmt(grandNetCol)}</span> net of <span style={{color:"#D6E2F0"}}>${fmt(grandCost)}</span> target</div>
          </div>
          <div style={{padding:"18px 20px"}}>
            {/* Bar */}
            <div style={{position:"relative",height:14,background:"#071019",borderRadius:7,overflow:"hidden",marginBottom:10,border:"1px solid #1B2A3A"}}>
              <div style={{
                height:"100%",
                width:`${Math.min(avgRecovery,100)}%`,
                background:"linear-gradient(90deg,#63E6BE,#5B8CFF)",
                borderRadius:7,
                transition:"width 0.8s ease",
                boxShadow:"0 0 12px rgba(0,212,170,0.4)",
                position:"relative",
              }}>
                <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"linear-gradient(180deg,rgba(255,255,255,0.15) 0%,transparent 100%)",borderRadius:7}}/>
              </div>
              {/* Milestone markers */}
              {[25,50,75].map(m=>(
                <div key={m} style={{position:"absolute",top:0,bottom:0,left:`${m}%`,width:1,background:"#1B2A3A",zIndex:2}}/>
              ))}
            </div>
            {/* Milestone labels */}
            <div style={{position:"relative",height:16,marginBottom:8}}>
              {[25,50,75].map(m=>(
                <div key={m} style={{position:"absolute",left:`${m}%`,transform:"translateX(-50%)",fontSize:9,color:avgRecovery>=m?"#63E6BE44":"#1B2A3A",letterSpacing:0.5,textAlign:"center"}}>
                  {m}%
                </div>
              ))}
              <div style={{position:"absolute",right:0,fontSize:9,color:avgRecovery>=100?"#63E6BE":"#1B2A3A",letterSpacing:0.5,fontWeight:700}}>
                {avgRecovery>=100?"🎉 LEAP FREE!":"LEAP FREE"}
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#7D91AA"}}>
              <span>$0</span>
              <span style={{color:"#63E6BE"}}>{grandNetCol>=0?"+":""}${fmt(grandNetCol)} net recovered</span>
              <span>Target: LEAP fully paid</span>
            </div>

            {/* Velocity metrics */}
            {(()=>{
              const thetaDates = totals.flatMap(t=>
                t.trades
                  .filter(tr=>isThetaEngineTrade(tr,t.trades,t.leaps))
                  .map(tr=>new Date(tr.date||0))
              ).filter(d=>!isNaN(d));
              const firstThetaDate = thetaDates.length ? new Date(Math.min(...thetaDates.map(d=>d.getTime()))) : null;
              const elapsedWeeks = firstThetaDate ? Math.max(1,(new Date()-firstThetaDate)/(1000*60*60*24*7)) : 1;
              const weeklyVelocity = grandNetCol / elapsedWeeks;
              const remaining = Math.max(grandCost - grandNetCol, 0);
              const daysToFree = weeklyVelocity > 0 ? Math.ceil((remaining / weeklyVelocity) * 7) : null;
              const annualized = weeklyVelocity > 0 && grandCost > 0 ? (weeklyVelocity * 52 / grandCost * 100) : 0;
              return (
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginTop:16,paddingTop:16,borderTop:"1px solid #1B2A3A"}}>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Theta Velocity <Tooltip text="Average weekly net theta cash since the first LEAP-backed short-call cycle, including open short-call credits."/></div>
                    <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:18,fontWeight:650,color:"#63E6BE"}}>${fmt(weeklyVelocity)}<span style={{fontSize:11,color:"#7D91AA"}}>/wk</span></div>
                  </div>
                  <div style={{textAlign:"center",borderLeft:"1px solid #1B2A3A",borderRight:"1px solid #1B2A3A"}}>
                    <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Days to Free LEAP <Tooltip text="Estimated days to recover the full LEAP cost at current collection velocity."/></div>
                    <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:18,fontWeight:650,color:"#FFD84D"}}>{daysToFree?`~${daysToFree}d`:"—"}</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:4}}>Annualized Recovery <Tooltip text="Projected annual LEAP recovery rate based on current weekly velocity."/></div>
                    <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:18,fontWeight:650,color:"#B37CFF"}}>{fmt(annualized,1)}%<span style={{fontSize:11,color:"#7D91AA"}}>/yr</span></div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Open Positions — flat per-trade table */}
      <div className="sec" style={{marginBottom:12,opacity:.78}}>
        <div className="sechdr">
          <div className="priority-strip">
            <div className="priority-strip-main">
              <div>
                <div className="priority-kicker" style={{marginBottom:3}}>Priority desk</div>
                <div className="priority-strip-title" style={{display:"flex",alignItems:"center",gap:4}}>
                  What needs attention now
                  <Tooltip text={"Expiration risk: Short call expiring within 3 days.\nManage this week: Short call expiring within 7 days.\nNear milestone: LEAP recovery between 75% and 99%.\nEngine idle: Open LEAP with no active short call generating premium."}/>
                </div>
              </div>
            </div>
            <div className="risk-legend">
              {riskLegend.map(([label,c,tip])=>(
                <span key={label} className="risk-legend-item" title={tip}>
                  <span className="risk-dot" style={{"--risk":c}}/>
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
        {allOpenRows.length===0?(
          <div className="empty">
            <div className="empty-title">No open positions yet</div>
            <div className="empty-copy" style={{margin:"0 auto"}}>Add a ticker or model a trade setup to start tracking expirations, premium, and recovery.</div>
            <div className="empty-actions">
              <button className="btn" onClick={onStartAdd}>Add position</button>
              <button className="btn bneutral" onClick={scrollToSimulator}>Open simulator</button>
            </div>
          </div>
        ):(
          <table>
            <thead><tr><th></th><th>Ticker</th><th>Type</th><th>Strategy</th><th>Action</th><th>Strike</th><th>Premium</th><th>Contracts</th><th>Expiration</th><th>Days</th><th></th></tr></thead>
            <tbody>
              {allOpenRows.map((r,i)=>{
                const dl=Math.ceil((new Date(r.expiration)-new Date())/(1000*60*60*24));
                const bc=dl<=3?"#E24B4A":dl<=7?"#BA7517":"#1D9E75";
                const isSell=r.action==="SELL";
                return(
                  <tr key={i} onClick={()=>onSelectAsset&&onSelectAsset(r.assetId)} style={{cursor:"pointer"}}>
                    <td style={{width:34,paddingRight:0}}>{r.priorityRisk&&<span className="risk-dot" title={r.priorityRisk.label} style={{"--risk":r.priorityRisk.color}}/>}</td>
                    <td><span style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:14,color:r.color}}>{r.ticker}</span></td>
                    <td><span style={{fontSize:10,padding:"2px 8px",borderRadius:3,background:isSell?"#63E6BE15":"#ff6b9d15",border:`1px solid ${isSell?"#63E6BE44":"#ff6b9d44"}`,color:isSell?"#63E6BE":"#ff6b9d"}}>{r.label}</span></td>
                    <td>{r.isLeap?<span style={{fontSize:10,color:"#4A6A8A"}}>-</span>:<TradeStrategyBadge trade={r} strategies={strategies}/>}</td>
                    <td><span style={{color:isSell?"#63E6BE":"#ff6b9d",fontWeight:600}}>{r.action}</span></td>
                    <td style={{color:"#FFD84D",fontWeight:600}}>${r.strike}</td>
                    <td style={{color:isSell?"#63E6BE":"#ff6b9d"}}>{isSell?"+":"-"}${fmt(r.premium*100)}</td>
                    <td style={{color:"#8aaac8"}}>{r.contracts}</td>
                    <td style={{color:"#D6E2F0"}}>{r.expiration}</td>
                    <td><span style={{fontSize:11,color:bc,fontWeight:600}}>{dl<=0?"Exp!":dl+"d"}</span></td>
                    <td onClick={e=>e.stopPropagation()}>
                      <div style={{display:"flex",gap:5}}>
                        <button className="btn bsm bneutral" onClick={()=>onEditTrade&&onEditTrade(r)}>Edit</button>
                        <button className="btn bsm bdanger" title="Delete order without history" onClick={()=>deleteOpenOrder(r)}>✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Simulator */}
      <div id="strategy-builder" style={{marginBottom:8,marginTop:4,display:"flex",alignItems:"center",gap:10}}>
        <div style={{fontSize:13,letterSpacing:2.6,textTransform:"uppercase",color:"#B7C9EA",fontWeight:700}}>Simulator</div>
        <div style={{flex:1,height:1,background:"linear-gradient(90deg,#22364A,transparent)"}}/>
      </div>
      <SimulatorPanel onSaveManualTrade={onSaveManualTrade} simulatorPreset={simulatorPreset}/>
      <DeleteOrderConfirmModal
        order={deleteOrder}
        onCancel={()=>setDeleteOrder(null)}
        onConfirm={confirmDeleteOrder}
      />
    </div>
  );
}

// ── Learn ───────────────────────────────────────────────────────────────────
const LEARN_SECTIONS = [
  { id:"learn-courses", title:"Courses", icon:"01", accent:"#63E6BE", copy:"Video lessons and strategy education." },
  { id:"learn-playbooks", title:"Playbooks", icon:"02", accent:"#5B8CFF", copy:"Step-by-step strategy guides." },
  { id:"learn-glossary", title:"Glossary", icon:"03", accent:"#FFD84D", copy:"Options terminology explained." },
  { id:"learn-calculators", title:"Calculators", icon:"04", accent:"#B37CFF", copy:"Financial planning and strategy tools." },
];
const PLAYBOOK_CATEGORIES = ["Income","Directional","Neutral","Risk Management"];
const playbookEntry = (category, title, summary, details) => ({category,title,summary,...details});
const PLAYBOOKS = [
  playbookEntry("Income","Covered Call","Sell calls against shares to collect income.",{
    overview:"Own shares and sell a call against them.",
    goal:"Collect premium while accepting capped upside.",
    when:"Use when you own 100 shares and are neutral to mildly bullish.",
    outlook:"Sideways to slightly bullish.",
    capital:"100 shares per short call.",
    maxProfit:"Premium plus share gains up to the strike.",
    maxLoss:"Share downside minus premium collected.",
    setup:["Own 100 shares","Sell one OTM call","Choose a strike you would sell at"],
    management:["Close or roll before expiration if risk changes","Let expire worthless when price stays below strike","Accept assignment if the plan allows it"],
    mistakes:["Selling below your desired exit price","Ignoring earnings or dividend dates","Sizing as if premium removes stock risk"],
    related:["Cash Secured Put","Wheel","Assignment Risk"],
  }),
  playbookEntry("Income","Cash Secured Put","Sell puts backed by cash to generate income or enter shares.",{
    overview:"Sell a put while reserving cash for assignment.",
    goal:"Collect premium or buy shares at an effective discount.",
    when:"Use when you are willing to own the stock.",
    outlook:"Neutral to bullish.",
    capital:"Cash equal to strike x 100, less premium.",
    maxProfit:"Premium received.",
    maxLoss:"Strike x 100 minus premium if the stock falls to zero.",
    setup:["Pick a stock you want to own","Sell an OTM put","Reserve assignment cash"],
    management:["Buy back when most premium is captured","Roll if still bullish and challenged","Accept shares if assigned"],
    mistakes:["Selling puts on stocks you do not want","Overusing buying power","Ignoring assignment risk"],
    related:["Covered Call","Wheel","Position Sizing"],
  }),
  playbookEntry("Income","PMCC","Use a long dated call and sell shorter calls against it.",{
    overview:"A Poor Man's Covered Call pairs a LEAP-style call with short calls.",
    goal:"Generate premium against a long call with less capital than shares.",
    when:"Use when bullish long term but willing to sell short-term upside.",
    outlook:"Bullish with controlled short-term expectations.",
    capital:"Cost of the long call plus margin for the short call.",
    maxProfit:"Limited by short call behavior and long call value.",
    maxLoss:"Long call cost minus net credits.",
    setup:["Buy a deep ITM long dated call","Sell shorter dated OTM calls","Track net credits against cost basis"],
    management:["Avoid short strikes below long-call breakeven","Roll challenged shorts with discipline","Track days to free LEAP"],
    mistakes:["Selling calls too close to the money","Ignoring liquidity","Letting the short call overpower the long call"],
    related:["Covered Call","Rolling Options","Position Sizing"],
  }),
  playbookEntry("Income","Wheel","Cycle between cash secured puts and covered calls.",{
    overview:"Sell puts, take shares if assigned, then sell calls.",
    goal:"Create a repeatable income process around stocks you accept owning.",
    when:"Use when you want income and can hold shares.",
    outlook:"Neutral to bullish over time.",
    capital:"Cash for puts or 100 shares for calls.",
    maxProfit:"Premium plus possible stock gains.",
    maxLoss:"Stock downside after assignment, reduced by premium.",
    setup:["Sell a cash secured put","If assigned, hold shares","Sell covered calls against shares"],
    management:["Keep position size small","Roll only when the thesis remains valid","Use assignment as part of the plan"],
    mistakes:["Wheeling weak tickers","Chasing high premiums","Forgetting that assignment creates stock risk"],
    related:["Cash Secured Put","Covered Call","Assignment Risk"],
  }),
  playbookEntry("Directional","Long Call","Buy calls to express bullish upside.",{
    overview:"A long call benefits from upside movement.",
    goal:"Capture upside with defined premium risk.",
    when:"Use when you expect a strong move higher.",
    outlook:"Bullish.",
    capital:"Premium paid.",
    maxProfit:"Theoretical unlimited upside.",
    maxLoss:"Premium paid.",
    setup:["Choose enough time for the move","Pick liquid strikes","Define target and invalidation"],
    management:["Take gains before theta accelerates","Cut if thesis breaks","Avoid overpaying in high IV"],
    mistakes:["Buying too short dated","Ignoring implied volatility","Holding through decay without a plan"],
    related:["Bull Call Spread","Long Put","Position Sizing"],
  }),
  playbookEntry("Directional","Long Put","Buy puts to express bearish downside.",{
    overview:"A long put benefits from downside movement.",
    goal:"Profit from a drop or hedge existing exposure.",
    when:"Use when you expect a strong move lower.",
    outlook:"Bearish.",
    capital:"Premium paid.",
    maxProfit:"Large but limited by the stock reaching zero.",
    maxLoss:"Premium paid.",
    setup:["Choose expiration beyond the expected move","Pick liquid strikes","Set a downside target"],
    management:["Take profits into sharp drops","Watch IV crush after events","Exit if price invalidates the thesis"],
    mistakes:["Using puts as permanent insurance","Buying after fear is already expensive","Ignoring theta"],
    related:["Bear Put Spread","Long Call","Position Sizing"],
  }),
  playbookEntry("Directional","Bull Call Spread","Buy a call and sell a higher strike call.",{
    overview:"A defined-risk bullish debit spread.",
    goal:"Target upside with lower cost than a naked long call.",
    when:"Use when you expect moderate upside.",
    outlook:"Bullish.",
    capital:"Net debit paid.",
    maxProfit:"Spread width minus debit.",
    maxLoss:"Net debit paid.",
    setup:["Buy lower strike call","Sell higher strike call","Use same expiration"],
    management:["Close near target profit","Avoid holding to expiration if assignment risk appears","Keep width realistic"],
    mistakes:["Choosing too narrow a spread","Overpaying for low probability moves","Ignoring liquidity"],
    related:["Long Call","Bear Put Spread","Position Sizing"],
  }),
  playbookEntry("Directional","Bear Put Spread","Buy a put and sell a lower strike put.",{
    overview:"A defined-risk bearish debit spread.",
    goal:"Target downside with reduced cost.",
    when:"Use when you expect moderate downside.",
    outlook:"Bearish.",
    capital:"Net debit paid.",
    maxProfit:"Spread width minus debit.",
    maxLoss:"Net debit paid.",
    setup:["Buy higher strike put","Sell lower strike put","Use same expiration"],
    management:["Take profit before expiration risk rises","Close if bearish thesis fails","Watch bid-ask spreads"],
    mistakes:["Buying too far OTM","Holding after the move is complete","Letting cheap cost justify poor odds"],
    related:["Long Put","Bull Call Spread","Position Sizing"],
  }),
  playbookEntry("Neutral","Iron Condor","Sell a call spread and put spread around a range.",{
    overview:"A neutral credit strategy with defined risk.",
    goal:"Collect premium when price stays inside a range.",
    when:"Use when IV is elevated and price is range-bound.",
    outlook:"Neutral.",
    capital:"Max loss collateral.",
    maxProfit:"Net credit received.",
    maxLoss:"Spread width minus credit.",
    setup:["Sell OTM call spread","Sell OTM put spread","Keep defined wings"],
    management:["Take profits early","Adjust or close threatened side","Avoid oversized positions"],
    mistakes:["Selling too narrow","Ignoring event risk","Letting max loss happen by default"],
    related:["Strangle","Rolling Options","Position Sizing"],
  }),
  playbookEntry("Neutral","Straddle","Use a call and put at the same strike.",{
    overview:"A volatility strategy centered at one strike.",
    goal:"Trade a large move or sell rich volatility.",
    when:"Use around events or high uncertainty.",
    outlook:"Big move for long straddles; quiet market for short straddles.",
    capital:"Premium paid for long; high margin for short.",
    maxProfit:"Long can gain from large moves; short is capped at premium.",
    maxLoss:"Long loses premium; short can have very large losses.",
    setup:["Use same strike and expiration","Define long or short direction","Check IV and event timing"],
    management:["Long: take gains on volatility expansion","Short: manage risk early","Avoid undefined risk if not experienced"],
    mistakes:["Ignoring IV crush","Shorting without risk controls","Holding too long after the catalyst"],
    related:["Strangle","Iron Condor","Position Sizing"],
  }),
  playbookEntry("Neutral","Strangle","Use an OTM call and OTM put.",{
    overview:"A wider volatility strategy using different strikes.",
    goal:"Trade large movement or sell range-bound premium.",
    when:"Use when expecting movement beyond a wider range, or selling rich IV.",
    outlook:"Large move for long strangles; range-bound for short strangles.",
    capital:"Premium paid for long; high margin for short.",
    maxProfit:"Long has large upside; short is capped at premium.",
    maxLoss:"Long loses premium; short can have very large losses.",
    setup:["Pick OTM call and put","Use same expiration","Define expected move"],
    management:["Take long profits on sharp moves","Control short-side losses quickly","Watch liquidity on both legs"],
    mistakes:["Buying too cheap and too far OTM","Shorting without exits","Ignoring skew"],
    related:["Straddle","Iron Condor","Rolling Options"],
  }),
  playbookEntry("Risk Management","Position Sizing","Keep each trade small enough to survive losses.",{
    overview:"Position sizing limits damage before the trade begins.",
    goal:"Avoid one trade controlling the portfolio.",
    when:"Use before every trade.",
    outlook:"Applies to all markets.",
    capital:"Based on defined risk or worst-case exposure.",
    maxProfit:"Not strategy-specific.",
    maxLoss:"Predefined by size limits.",
    setup:["Set max risk per trade","Size by max loss, not premium","Leave buying power unused"],
    management:["Reduce size after losses","Avoid adding risk to fix a bad trade","Track total correlated exposure"],
    mistakes:["Sizing by confidence","Ignoring undefined risk","Letting multiple trades become one big bet"],
    related:["Assignment Risk","Rolling Options","Cash Secured Put"],
  }),
  playbookEntry("Risk Management","Rolling Options","Close one option and open another to change risk.",{
    overview:"Rolling moves a position to a new strike, expiration, or both.",
    goal:"Extend time, adjust risk, or collect/limit debit.",
    when:"Use when the original plan is challenged but still valid.",
    outlook:"Depends on the strategy being rolled.",
    capital:"May require extra debit or collateral.",
    maxProfit:"Changes after the new position is opened.",
    maxLoss:"Can increase if rolls add risk.",
    setup:["Close the current option","Open the new option","Compare net credit or debit"],
    management:["Roll for a reason, not hope","Track total credits and debits","Avoid rolling into oversized risk"],
    mistakes:["Rolling forever","Ignoring total P&L","Moving strikes without a plan"],
    related:["PMCC","Iron Condor","Assignment Risk"],
  }),
  playbookEntry("Risk Management","Assignment Risk","Plan for short options being exercised.",{
    overview:"Assignment can turn an option position into stock exposure.",
    goal:"Know what happens if assigned before it occurs.",
    when:"Use with any short option.",
    outlook:"Most important near expiration and when ITM.",
    capital:"Shares or cash may be required.",
    maxProfit:"Depends on the original strategy.",
    maxLoss:"Can become stock downside or short stock risk.",
    setup:["Identify short options","Check ITM status and expiration","Know broker requirements"],
    management:["Close or roll if assignment is unwanted","Keep cash or shares ready","Watch ex-dividend risk on calls"],
    mistakes:["Assuming assignment cannot happen early","Selling contracts without capital","Ignoring ITM shorts near expiration"],
    related:["Covered Call","Cash Secured Put","Position Sizing"],
  }),
];
const SIMULATOR_PRESETS = {
  "Covered Call": [{side:"sell",optType:"call",offset:2}],
  "Cash Secured Put": [{side:"sell",optType:"put",offset:-2}],
  PMCC: [{side:"buy",optType:"call",offset:-4},{side:"sell",optType:"call",offset:2}],
  Wheel: [{side:"sell",optType:"put",offset:-2}],
  "Long Call": [{side:"buy",optType:"call",offset:1}],
  "Long Put": [{side:"buy",optType:"put",offset:-1}],
  "Bull Call Spread": [{side:"buy",optType:"call",offset:0},{side:"sell",optType:"call",offset:3}],
  "Bear Put Spread": [{side:"buy",optType:"put",offset:0},{side:"sell",optType:"put",offset:-3}],
  "Iron Condor": [
    {side:"buy",optType:"put",offset:-4},
    {side:"sell",optType:"put",offset:-2},
    {side:"sell",optType:"call",offset:2},
    {side:"buy",optType:"call",offset:4},
  ],
  Straddle: [{side:"buy",optType:"call",offset:0},{side:"buy",optType:"put",offset:0}],
  Strangle: [{side:"buy",optType:"call",offset:3},{side:"buy",optType:"put",offset:-3}],
};
const GLOSSARY_CATEGORIES = ["Basics","Greeks","Volatility","Strategies","Risk","Portfolio","OptionDesk"];
const glossaryEntry = (category, term, short, definition, example, why, related) => ({
  category, term, short, definition, example, why, related,
});
const GLOSSARY_ENTRIES = [
  glossaryEntry("Basics","Call Option","A contract that gives the buyer the right to buy shares at a set strike.","A call option gives its buyer the right, not the obligation, to buy the underlying asset at the strike price before expiration.","Buying a $50 call lets you control upside above $50 before expiration.","Calls are the basic building block for bullish option trades.",["Put Option","Strike Price","Expiration Date"]),
  glossaryEntry("Basics","Put Option","A contract that gives the buyer the right to sell shares at a set strike.","A put option gives its buyer the right, not the obligation, to sell the underlying asset at the strike price before expiration.","Buying a $40 put can gain value if the stock falls below $40.","Puts are used for bearish trades, hedging, and cash secured puts.",["Call Option","Strike Price","Cash Secured Put"]),
  glossaryEntry("Basics","Strike Price","The price where an option can be exercised.","The strike price is the agreed price used if the option is exercised.","A $45 call can buy shares at $45 if exercised.","Strike selection controls moneyness, risk, and reward.",["ITM","ATM","OTM"]),
  glossaryEntry("Basics","Expiration Date","The date when an option contract stops trading and expires.","Expiration is the final date an option has value or can be exercised.","A call expiring June 19 must be closed, rolled, or left to expire by then.","Time left affects premium, theta, and assignment risk.",["Theta","Premium","Assignment Risk"]),
  glossaryEntry("Basics","Premium","The price paid or received for an option contract.","Premium is the option price per share, usually multiplied by 100 shares per contract.","Selling one call for $0.50 collects about $50 before fees.","Premium is the income or cost that drives most option P&L.",["Contract","Theta","Realized P&L"]),
  glossaryEntry("Basics","Contract","One option unit, usually representing 100 shares.","A standard option contract controls 100 shares of the underlying asset.","Two contracts at $1.20 premium equal about $240 of option value.","Contracts scale position size and risk quickly.",["Premium","Underlying Asset","Capital At Risk"]),
  glossaryEntry("Basics","Underlying Asset","The stock or ETF tied to an option.","The underlying asset is the security that determines the option's value.","IBIT is the underlying for an IBIT call option.","Every option trade depends on the movement of its underlying.",["Call Option","Put Option","Delta"]),
  glossaryEntry("Basics","ITM","In the money; the option has intrinsic value.","A call is ITM when the underlying is above the strike. A put is ITM when it is below the strike.","A $40 call is ITM if the stock trades at $43.","ITM options have exercise value and higher assignment risk.",["ATM","OTM","Assignment Risk"]),
  glossaryEntry("Basics","ATM","At the money; the strike is near the current asset price.","An ATM option has a strike close to where the underlying trades now.","If a stock is $50, the $50 strike is ATM.","ATM options often carry high time value and active trading.",["ITM","OTM","Premium"]),
  glossaryEntry("Basics","OTM","Out of the money; the option has no intrinsic value.","A call is OTM when the underlying is below the strike. A put is OTM when it is above the strike.","A $60 call is OTM if the stock trades at $52.","OTM options are cheaper but need movement to finish profitable.",["ITM","ATM","Probability of Profit"]),
  glossaryEntry("Greeks","Delta","How much an option may move for a $1 move in the underlying.","Delta estimates the option price change when the underlying moves by $1.","A 0.30 delta call may gain about $0.30 if the stock rises $1.","Delta helps size direction, hedge exposure, and compare strikes.",["Gamma","Underlying Asset","Probability of Profit"]),
  glossaryEntry("Greeks","Gamma","How fast delta changes as the underlying moves.","Gamma measures the rate of change in delta.","High gamma near expiration can make delta jump quickly.","Gamma shows how unstable or responsive an option can become.",["Delta","Expiration Date","Risk"]),
  glossaryEntry("Greeks","Theta","Estimated daily option value lost from time decay.","Theta shows how much premium may decay each day, all else equal.","A theta of -0.04 means about $4 per contract may decay daily.","Theta is central to premium selling and the Theta Engine.",["Premium","Theta Engine","Expiration Date"]),
  glossaryEntry("Greeks","Vega","How much an option may move when implied volatility changes.","Vega estimates option price sensitivity to a 1 point change in implied volatility.","A vega of 0.08 may add $8 per contract if IV rises 1 point.","Vega helps explain gains or losses that come from volatility, not price.",["Implied Volatility","IV Rank","Premium"]),
  glossaryEntry("Greeks","Rho","How much an option may move when interest rates change.","Rho estimates sensitivity to interest rate changes.","Long dated calls can gain some value when rates rise.","Rho is usually smaller than other Greeks for short dated trades.",["Call Option","Put Option","Expiration Date"]),
  glossaryEntry("Volatility","Implied Volatility","The market's expected future movement priced into options.","Implied volatility is the volatility level embedded in option prices.","High IV can make a covered call pay more premium.","IV affects option prices even when the stock does not move.",["Vega","IV Rank","Premium"]),
  glossaryEntry("Volatility","Historical Volatility","How much the underlying has moved in the past.","Historical volatility measures realized price movement over a prior period.","A stock with large past swings may show high historical volatility.","It gives context for whether current option pricing looks rich or cheap.",["Implied Volatility","IV Percentile","Underlying Asset"]),
  glossaryEntry("Volatility","IV Rank","Where current IV sits versus its one year range.","IV Rank compares current implied volatility to its high and low range.","An IV Rank of 80 means IV is near the high end of its range.","Premium sellers often prefer higher IV Rank for richer credits.",["Implied Volatility","IV Percentile","Vega"]),
  glossaryEntry("Volatility","IV Percentile","How often past IV readings were below today's IV.","IV Percentile shows the percent of past days with lower implied volatility.","An IV Percentile of 70 means IV was lower on 70% of measured days.","It helps judge whether current premium is unusually high.",["Implied Volatility","IV Rank","Premium"]),
  glossaryEntry("Strategies","Covered Call","Selling a call against shares you own.","A covered call combines long shares with a short call on the same underlying.","Own 100 shares and sell one OTM call for income.","It generates income but caps upside above the strike.",["Call Option","Assignment Risk","Max Profit"]),
  glossaryEntry("Strategies","Cash Secured Put","Selling a put while holding enough cash to buy shares.","A cash secured put obligates you to buy shares if assigned, backed by cash.","Sell a $40 put while reserving $4,000 buying power.","It can generate income or enter a stock at a lower effective price.",["Put Option","Assignment Risk","Buying Power"]),
  glossaryEntry("Strategies","PMCC","A Poor Man's Covered Call using a long call and short calls.","A PMCC pairs a long dated call with shorter dated calls sold against it.","Buy a LEAP call and sell weekly or monthly calls for premium.","It seeks income with less capital than owning 100 shares.",["Theta Engine","Days to Free LEAP","Covered Call"]),
  glossaryEntry("Strategies","Wheel Strategy","Selling puts, taking shares if assigned, then selling covered calls.","The wheel cycles between cash secured puts and covered calls.","Sell a put, accept shares, then sell calls until shares are called away.","It creates a repeatable income process with assignment built in.",["Cash Secured Put","Covered Call","Assignment Risk"]),
  glossaryEntry("Strategies","Bull Call Spread","A bullish debit spread using two calls.","A bull call spread buys a lower strike call and sells a higher strike call.","Buy the $40 call and sell the $45 call for a net debit.","It limits both risk and upside for a bullish view.",["Max Profit","Max Loss","Breakeven"]),
  glossaryEntry("Strategies","Bear Call Spread","A bearish credit spread using two calls.","A bear call spread sells a lower strike call and buys a higher strike call.","Sell the $50 call and buy the $55 call for a credit.","It profits if the underlying stays below the short call area.",["Max Loss","Probability of Profit","Call Option"]),
  glossaryEntry("Strategies","Bull Put Spread","A bullish credit spread using two puts.","A bull put spread sells a higher strike put and buys a lower strike put.","Sell the $45 put and buy the $40 put for a credit.","It profits if the underlying stays above the short put area.",["Cash Secured Put","Max Loss","Probability of Profit"]),
  glossaryEntry("Strategies","Bear Put Spread","A bearish debit spread using two puts.","A bear put spread buys a higher strike put and sells a lower strike put.","Buy the $55 put and sell the $50 put for a net debit.","It defines risk while targeting downside movement.",["Put Option","Max Profit","Breakeven"]),
  glossaryEntry("Strategies","Iron Condor","A neutral credit strategy using a call spread and put spread.","An iron condor sells an OTM call spread and an OTM put spread.","Sell a call spread above price and a put spread below price.","It profits when price stays inside a range.",["Strangle","Max Loss","Probability of Profit"]),
  glossaryEntry("Strategies","Straddle","Buying or selling a call and put at the same strike.","A straddle uses a call and put with the same strike and expiration.","Buy the $50 call and $50 put before a big event.","It targets large movement or sells volatility, depending on direction.",["Strangle","Implied Volatility","Breakeven"]),
  glossaryEntry("Strategies","Strangle","Buying or selling a call and put at different strikes.","A strangle uses an OTM call and OTM put with the same expiration.","Buy the $55 call and $45 put when price is $50.","It is often cheaper than a straddle but needs a bigger move.",["Straddle","Implied Volatility","OTM"]),
  glossaryEntry("Risk","Breakeven","The price where a trade stops losing and starts winning.","Breakeven is the underlying price needed at expiration to cover the trade cost or credit.","A $50 call bought for $2 breaks even near $52.","Breakeven gives a clean target for judging the trade plan.",["Premium","Max Profit","Max Loss"]),
  glossaryEntry("Risk","Max Profit","The best possible profit for a defined trade.","Max profit is the highest amount a position can make if the ideal outcome happens.","A $5 wide credit spread sold for $1 has about $100 max profit.","It sets realistic upside before entering a trade.",["Max Loss","Breakeven","Return on Capital"]),
  glossaryEntry("Risk","Max Loss","The worst possible loss for a defined trade.","Max loss is the most a position can lose under its defined risk structure.","A $5 wide credit spread sold for $1 has about $400 max loss.","Knowing max loss prevents oversized trades.",["Max Profit","Capital At Risk","Margin Requirement"]),
  glossaryEntry("Risk","Probability of Profit","An estimate of how likely a trade is to finish profitable.","Probability of profit estimates the chance that the trade ends above breakeven or keeps some profit.","An OTM credit spread may show a 65% probability of profit.","It helps compare win rate against reward and risk.",["Delta","Breakeven","Max Loss"]),
  glossaryEntry("Risk","Assignment Risk","The risk that a short option is exercised against you.","Assignment risk means you may be required to buy or sell shares because of a short option.","A short ITM call can assign and sell your shares at the strike.","It matters most near expiration, ex-dividend dates, and ITM shorts.",["Early Assignment","ITM","Covered Call"]),
  glossaryEntry("Risk","Early Assignment","Assignment before expiration.","Early assignment happens when a short option is exercised before its expiration date.","A short call may be assigned early before a dividend.","It can change a planned options trade into a stock position.",["Assignment Risk","Expiration Date","Margin Requirement"]),
  glossaryEntry("Risk","Margin Requirement","Capital your broker requires to hold a position.","Margin requirement is the buying power or collateral needed for a trade.","A spread may require its max loss as collateral.","It controls position size and whether a trade can be opened.",["Buying Power","Capital At Risk","Max Loss"]),
  glossaryEntry("Portfolio","Realized P&L","Profit or loss from closed trades.","Realized P&L is the gain or loss locked in after closing a position.","Sell a call for $80 and buy it back for $30: realized P&L is $50.","It shows actual booked performance.",["Unrealized P&L","Premium","Cost Basis"]),
  glossaryEntry("Portfolio","Unrealized P&L","Profit or loss on positions still open.","Unrealized P&L is the current gain or loss before a position is closed.","An open call bought for $200 now worth $260 has $60 unrealized P&L.","It can change quickly and is not final.",["Realized P&L","Underlying Asset","Vega"]),
  glossaryEntry("Portfolio","Cost Basis","Your effective net cost after credits and debits.","Cost basis is what you effectively paid after adjusting for premiums and trade costs.","A LEAP bought for $1,000 with $200 collected has an $800 adjusted basis.","It shows how much capital still needs recovery.",["Recovery Rate","Engine Progress","Premium"]),
  glossaryEntry("Portfolio","Return on Capital","Profit compared with the capital required.","Return on capital measures gains as a percent of capital used or at risk.","A $50 profit on $1,000 at risk is a 5% return on capital.","It helps compare trades of different sizes.",["Capital At Risk","Max Profit","Buying Power"]),
  glossaryEntry("Portfolio","Buying Power","Capital available to open or support positions.","Buying power is what your account can use for new trades or collateral.","A broker may reduce buying power when you sell a put.","It limits what positions you can enter or hold.",["Margin Requirement","Capital At Risk","Cash Secured Put"]),
  glossaryEntry("Portfolio","Capital At Risk","Money that could be lost or tied to a position.","Capital at risk is the amount exposed to loss or reserved for a trade.","A cash secured put at $40 uses about $4,000 of capital at risk.","It keeps portfolio sizing honest.",["Max Loss","Buying Power","Return on Capital"]),
  glossaryEntry("OptionDesk","Theta Engine","OptionDesk's short premium tracking area for income cycles.","Theta Engine tracks short call cycles, credits, debits, and net premium.","A PMCC short call appears as a cycle with credit, debit, and net.","It keeps income strategy progress visible.",["Theta","PMCC","Engine Progress"]),
  glossaryEntry("OptionDesk","Engine Progress","How much premium has recovered against the target cost.","Engine Progress shows the percent of LEAP cost recovered by net premium.","If $300 is captured against a $1,000 LEAP, progress is 30%.","It shows whether the income engine is paying down the position.",["Recovery Rate","Days to Free LEAP","Cost Basis"]),
  glossaryEntry("OptionDesk","Theta Velocity","The pace of premium capture over time.","Theta Velocity is the rate at which the strategy collects net theta income.","Collecting $40 per week gives a faster velocity than $10 per week.","It helps estimate how quickly the strategy may recover cost.",["Theta","Days to Free LEAP","Recovery Rate"]),
  glossaryEntry("OptionDesk","Days to Free LEAP","Estimated time until premiums recover the LEAP cost.","Days to Free LEAP estimates how long current premium pace needs to cover remaining LEAP cost.","At $20 per week with $200 remaining, the estimate is about 70 days.","It turns premium collection into a time target.",["Engine Progress","Theta Velocity","PMCC"]),
  glossaryEntry("OptionDesk","Engine Health","A quick condition read on the current short option cycle.","Engine Health summarizes risk signals such as distance, DTE, and open short status.","A near ITM short call close to expiration may show weak health.","It highlights cycles that may need attention.",["Assignment Risk","Delta","Theta Engine"]),
  glossaryEntry("OptionDesk","Recovery Rate","The percent of original cost recovered by net premium.","Recovery Rate measures net collected premium against the initial cost target.","Recovering $250 on a $1,000 LEAP equals a 25% recovery rate.","It shows how much basis has been paid down.",["Cost Basis","Engine Progress","Realized P&L"]),
  glossaryEntry("OptionDesk","Strategy Score","A simple quality score for comparing strategy setups.","Strategy Score ranks a setup using factors like premium, risk, DTE, and positioning.","A higher score may flag a cleaner covered call candidate.","It helps compare candidates without reading every metric manually.",["Probability of Profit","Return on Capital","Engine Health"]),
];

function LearnHeader({ title, copy, action }) {
  return (
    <div className="learn-head">
      <div>
        <div className="learn-kicker">Learn</div>
        <div className="learn-title">{title}</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",justifyContent:"flex-end"}}>
        <div className="learn-copy">{copy}</div>
        {action}
      </div>
    </div>
  );
}

function LearnPage({ onNavigate }) {
  return (
    <div className="main learn-main fade-in">
      <LearnHeader
        title="Learn"
        copy="Focused tools and references for building an options process."
      />
      <div className="learn-grid">
        {LEARN_SECTIONS.map(section=>(
          <button
            key={section.id}
            className="learn-card"
            onClick={()=>onNavigate(section.id)}
            style={{"--accent":section.accent,textAlign:"left"}}
          >
            <div>
              <div className="learn-icon">{section.icon}</div>
              <div className="learn-card-title">{section.title}</div>
              <div className="learn-card-copy">{section.copy}</div>
            </div>
            <div className="learn-card-action">Open</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function LearnPlaceholderPage({ title, onNavigate }) {
  return (
    <div className="main fade-in">
      <LearnHeader
        title={title}
        copy={`${title} content will live here. The section is wired into navigation and ready for the next learning modules.`}
        action={<button className="btn bneutral" onClick={()=>onNavigate("learn")}>Back to Learn</button>}
      />
      <div className="sec">
        <div className="sechdr"><div className="sectitle">{title}</div></div>
        <div style={{padding:28,color:"#8aaac8",fontSize:13,lineHeight:1.7}}>
          This page is set up in the Learn section. Add the first {title.toLowerCase()} items here when the curriculum is ready.
        </div>
      </div>
      <div className="learn-grid">
        {LEARN_SECTIONS.filter(s=>s.title!==title).map(s=>(
          <button key={s.id} className="learn-card" onClick={()=>onNavigate(s.id)} style={{"--accent":s.accent,textAlign:"left"}}>
            <div>
              <div className="learn-icon">{s.icon}</div>
              <div className="learn-card-title">{s.title}</div>
              <div className="learn-card-copy">{s.copy}</div>
            </div>
            <div className="learn-card-action">Open {s.title} &rarr;</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlaybooksPage({ onNavigate, onOpenSimulator }) {
  const [category, setCategory] = useState("All");
  const [selectedPlaybook, setSelectedPlaybook] = useState(null);
  const filteredPlaybooks = PLAYBOOKS.filter(playbook => category==="All" || playbook.category===category);
  const openSimulator = () => {
    setSelectedPlaybook(null);
    onOpenSimulator(selectedPlaybook?.title);
  };
  const openRelatedPlaybook = (title) => {
    const related = PLAYBOOKS.find(playbook => playbook.title===title);
    if(!related) return;
    setCategory(related.category);
    setSelectedPlaybook(related);
  };

  return (
    <div className="main learn-main fade-in">
      <LearnHeader
        title="Strategy Playbooks"
        copy="Practical guides for building and managing options strategies."
        action={<button className="btn bneutral" onClick={()=>onNavigate("learn")}>Back to Learn</button>}
      />
      <div className="playbook-tools">
        <div className="playbook-filters" aria-label="Playbook categories">
          {["All",...PLAYBOOK_CATEGORIES].map(cat=>(
            <button
              key={cat}
              type="button"
              className={`playbook-filter ${category===cat?"active":""}`}
              onClick={()=>setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>
      <div className="playbook-grid">
        {filteredPlaybooks.map(playbook=>(
          <button key={playbook.title} className="playbook-card" type="button" onClick={()=>setSelectedPlaybook(playbook)}>
            <div>
              <div className="playbook-card-top">
                <div className="playbook-title">{playbook.title}</div>
                <div className="playbook-category">{playbook.category}</div>
              </div>
              <div className="playbook-summary" style={{marginTop:10}}>{playbook.summary}</div>
            </div>
            <div className="playbook-action">Open guide</div>
          </button>
        ))}
      </div>
      {selectedPlaybook&&(
        <div className="overlay" onMouseDown={()=>setSelectedPlaybook(null)}>
          <div className="fbox" style={{width:760,maxWidth:"96vw"}} onMouseDown={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:16}}>
              <div>
                <div className="playbook-category" style={{display:"inline-block",marginBottom:9}}>{selectedPlaybook.category}</div>
                <div className="ftitle" style={{fontSize:24,marginBottom:4}}>{selectedPlaybook.title}</div>
                <div style={{fontSize:12,color:"#8aaac8",lineHeight:1.5}}>{selectedPlaybook.summary}</div>
              </div>
              <button className="btn bneutral" type="button" onClick={()=>setSelectedPlaybook(null)}>Close</button>
            </div>
            <div className="playbook-modal-grid">
              {[
                ["Overview",selectedPlaybook.overview],
                ["Goal",selectedPlaybook.goal],
                ["When to Use",selectedPlaybook.when],
                ["Market Outlook",selectedPlaybook.outlook],
                ["Capital Required",selectedPlaybook.capital],
                ["Max Profit",selectedPlaybook.maxProfit],
                ["Max Loss",selectedPlaybook.maxLoss],
              ].map(([label,copy])=>(
                <div className="playbook-section" key={label}>
                  <div className="playbook-label">{label}</div>
                  <div className="playbook-copy">{copy}</div>
                </div>
              ))}
            </div>
            <div className="playbook-modal-grid">
              {[
                ["Setup",selectedPlaybook.setup],
                ["Management Rules",selectedPlaybook.management],
                ["Common Mistakes",selectedPlaybook.mistakes],
              ].map(([label,items])=>(
                <div className="playbook-section" key={label}>
                  <div className="playbook-label">{label}</div>
                  <ul className="playbook-list">
                    {items.map(item=><li key={item}>{item}</li>)}
                  </ul>
                </div>
              ))}
              <div className="playbook-section">
                <div className="playbook-label">Related Strategies</div>
                <div className="playbook-related">
                  {selectedPlaybook.related.map(title=>{
                    const related = PLAYBOOKS.find(playbook => playbook.title===title);
                    return related ? (
                      <button key={title} className="playbook-related-btn" type="button" onClick={()=>openRelatedPlaybook(title)}>
                        {title}
                      </button>
                    ) : (
                      <span key={title} className="playbook-related-btn" style={{cursor:"default",opacity:.65}}>{title}</span>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
              <button className="btn" type="button" onClick={openSimulator}>Open Simulator</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GlossaryPage({ onNavigate }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [selectedTerm, setSelectedTerm] = useState(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTerms = GLOSSARY_ENTRIES.filter(entry => {
    const categoryMatch = category==="All" || entry.category===category;
    const queryMatch = !normalizedQuery
      || entry.term.toLowerCase().includes(normalizedQuery)
      || entry.category.toLowerCase().includes(normalizedQuery)
      || entry.short.toLowerCase().includes(normalizedQuery)
      || entry.definition.toLowerCase().includes(normalizedQuery);
    return categoryMatch && queryMatch;
  });
  const openRelatedTerm = (term) => {
    const relatedEntry = GLOSSARY_ENTRIES.find(entry => entry.term===term);
    if(!relatedEntry) return;
    setQuery("");
    setCategory(relatedEntry.category);
    setSelectedTerm(relatedEntry);
  };

  return (
    <div className="main learn-main fade-in">
      <LearnHeader
        title="Glossary"
        copy="Concise options terms for reading trades, risk, and OptionDesk signals faster."
        action={<button className="btn bneutral" onClick={()=>onNavigate("learn")}>Back to Learn</button>}
      />
      <div className="glossary-tools">
        <input
          className="glossary-search"
          value={query}
          onChange={e=>setQuery(e.target.value)}
          placeholder="Search options terms..."
        />
        <div className="glossary-filters" aria-label="Glossary categories">
          {["All",...GLOSSARY_CATEGORIES].map(cat=>(
            <button
              key={cat}
              type="button"
              className={`glossary-filter ${category===cat?"active":""}`}
              onClick={()=>setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>
      {filteredTerms.length===0 ? (
        <div className="glossary-empty">No terms match your search.</div>
      ) : (
        <div className="glossary-grid">
          {filteredTerms.map(entry=>(
            <button key={`${entry.category}-${entry.term}`} className="term-card" type="button" onClick={()=>setSelectedTerm(entry)}>
              <div className="term-card-top">
                <div className="term-name">{entry.term}</div>
                <div className="term-category">{entry.category}</div>
              </div>
              <div className="term-definition">{entry.short}</div>
            </button>
          ))}
        </div>
      )}
      {selectedTerm&&(
        <div className="overlay" onMouseDown={()=>setSelectedTerm(null)}>
          <div className="fbox" style={{width:620,maxWidth:"96vw"}} onMouseDown={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:16}}>
              <div>
                <div className="term-category" style={{display:"inline-block",marginBottom:9}}>{selectedTerm.category}</div>
                <div className="ftitle" style={{fontSize:24,marginBottom:0}}>{selectedTerm.term}</div>
              </div>
              <button className="btn bneutral" type="button" onClick={()=>setSelectedTerm(null)}>Close</button>
            </div>
            {[
              ["Definition", selectedTerm.definition],
              ["Example", selectedTerm.example],
              ["Why it matters", selectedTerm.why],
            ].map(([label,copy])=>(
              <div className="term-modal-section" key={label}>
                <div className="term-modal-label">{label}</div>
                <div className="term-modal-copy">{copy}</div>
              </div>
            ))}
            <div className="term-modal-section" style={{marginBottom:0}}>
              <div className="term-modal-label">Related terms</div>
              <div className="related-terms">
                {selectedTerm.related.map(term=>{
                  const relatedEntry = GLOSSARY_ENTRIES.find(entry => entry.term===term);
                  return relatedEntry ? (
                    <button className="related-term" type="button" key={term} onClick={()=>openRelatedTerm(term)}>
                      {term}
                    </button>
                  ) : (
                    <span className="related-term" key={term} style={{cursor:"default",opacity:.65}}>{term}</span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const integerInputValue = (value) => {
  const raw = String(value || "");
  const beforeDecimal = raw.includes(".") ? raw.slice(0, raw.indexOf(".")) : raw;
  return beforeDecimal.replace(/\D/g, "");
};
const decimalInputValue = (value) => {
  const raw = String(value || "").replace(",", ".");
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...decimals] = cleaned.split(".");
  return decimals.length ? `${whole}.${decimals.join("")}` : whole;
};
const formatWholeNumber = (value) => Math.round(Number(value || 0)).toLocaleString("en-US", { maximumFractionDigits:0 });
const formatCurrencyWhole = (value) => `$${formatWholeNumber(value)}`;
const formatIntegerInput = (value) => value === "" ? "" : formatWholeNumber(value);
const formatDecimalInput = (value) => value === "" ? "" : String(value);
const milestoneTargets = [100000,250000,500000,1000000];

function ExpandedGrowthChartModal({ points, milestones, onClose }) {
  const [hoverPoint, setHoverPoint] = useState(null);
  useEffect(()=>{
    const onKey = (e) => { if(e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  },[onClose]);

  const area = {left:7,right:98,top:10,bottom:90};
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const maxValue = Math.max(...points.map(p=>Math.max(p.value,p.contributions,p.growth)), 1);
  const xFor = (idx) => area.left + (points.length <= 1 ? 0 : (idx / (points.length - 1)) * width);
  const yFor = (value) => area.bottom - (Math.max(0,value) / maxValue) * height;
  const pathFor = (key) => points.map((point,idx)=>`${idx===0?"M":"L"} ${xFor(idx).toFixed(2)} ${yFor(point[key]).toFixed(2)}`).join(" ");
  const portfolioPath = pathFor("value");
  const contributionPath = pathFor("contributions");
  const growthPath = pathFor("growth");
  const hoverIdx = hoverPoint ? points.indexOf(hoverPoint.point) : -1;
  const hoverX = hoverIdx >= 0 ? xFor(hoverIdx) : 0;
  const hoverPortfolioY = hoverPoint ? yFor(hoverPoint.point.value) : 0;

  const handleMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pctX = ((e.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(area.left, Math.min(area.right, pctX));
    const idx = Math.round(((clamped - area.left) / width) * Math.max(points.length - 1, 0));
    const point = points[Math.max(0, Math.min(points.length - 1, idx))];
    setHoverPoint({
      point,
      left: Math.min(Math.max(e.clientX - rect.left + 18, 14), rect.width - 260),
      top: Math.min(Math.max(e.clientY - rect.top + 18, 12), rect.height - 178),
    });
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="chart-modal" onMouseDown={(e)=>e.stopPropagation()}>
        <div className="chart-modal-head">
          <div>
            <div className="chart-modal-title">Portfolio Growth</div>
            <div className="chart-modal-subtitle">Expanded projection with contributions and investment growth.</div>
          </div>
          <button className="modal-close" type="button" aria-label="Close chart" onClick={onClose}>×</button>
        </div>
        <div className="chart-modal-body">
          <div className="expanded-chart-card">
            <div className="expanded-chart-legend">
              <span><span className="legend-dot" style={{background:"#63E6BE"}}/>Portfolio Value</span>
              <span><span className="legend-dot" style={{background:"#5B8CFF"}}/>Total Contributions</span>
              <span><span className="legend-dot" style={{background:"#FFD84D"}}/>Investment Growth</span>
            </div>
            <div className="expanded-chart">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{width:"100%",height:"100%",display:"block"}} onMouseMove={handleMove} onMouseLeave={()=>setHoverPoint(null)}>
                <defs>
                  <linearGradient id="portfolioGlow" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#63E6BE" stopOpacity=".18"/>
                    <stop offset="100%" stopColor="#63E6BE" stopOpacity="0"/>
                  </linearGradient>
                </defs>
                {[25,45,65,85].map(y=><line key={y} x1={area.left} x2={area.right} y1={y} y2={y} stroke="#1B2A3A" strokeWidth=".35"/>)}
                <line x1={area.left} x2={area.right} y1={area.bottom} y2={area.bottom} stroke="#314457" strokeWidth=".45"/>
                <path d={`${portfolioPath} L ${area.right} ${area.bottom} L ${area.left} ${area.bottom} Z`} fill="url(#portfolioGlow)"/>
                <path d={contributionPath} fill="none" stroke="#5B8CFF" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
                <path d={growthPath} fill="none" stroke="#FFD84D" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
                <path d={portfolioPath} fill="none" stroke="#63E6BE" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
                {hoverPoint&&(
                  <>
                    <line x1={hoverX} x2={hoverX} y1={area.top} y2={area.bottom} stroke="#D6E2F0" strokeOpacity=".32" strokeWidth=".5"/>
                    <circle cx={hoverX} cy={hoverPortfolioY} r="1.2" fill="#63E6BE" stroke="#071019" strokeWidth=".4" vectorEffect="non-scaling-stroke"/>
                  </>
                )}
              </svg>
              {hoverPoint&&(
                <div className="chart-tooltip" style={{left:hoverPoint.left,top:hoverPoint.top}}>
                  <div className="chart-tooltip-title">Year {formatWholeNumber(Math.max(0, hoverPoint.point.month / 12))}</div>
                  <div className="chart-tooltip-row"><span>Portfolio Value</span><span>{formatCurrencyWhole(hoverPoint.point.value)}</span></div>
                  <div className="chart-tooltip-row"><span>Total Contributions</span><span>{formatCurrencyWhole(hoverPoint.point.contributions)}</span></div>
                  <div className="chart-tooltip-row"><span>Investment Growth</span><span>{formatCurrencyWhole(hoverPoint.point.growth)}</span></div>
                  <div className="chart-tooltip-row"><span>Growth Share</span><span>{formatWholeNumber(hoverPoint.point.growthShare * 100)}%</span></div>
                </div>
              )}
            </div>
          </div>
          <div className="milestones-card">
            <div className="milestones-title">Milestones</div>
            <div className="milestone-list">
              {milestones.map(milestone=>(
                <div className="milestone" key={milestone.target}>
                  <div className="milestone-target">{formatCurrencyWhole(milestone.target)}</div>
                  <div className={`milestone-status ${milestone.reached?"reached":""}`}>
                    {milestone.reached ? "✓ Reached" : milestone.years == null ? "Not reached" : `${milestone.years.toFixed(1)} years`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CalculatorsPage({ onNavigate }) {
  const [initial, setInitial] = useState("10000");
  const [monthly, setMonthly] = useState("500");
  const [annualReturn, setAnnualReturn] = useState("8");
  const [returnPeriod, setReturnPeriod] = useState("annual");
  const [years, setYears] = useState("20");
  const [chartPeriod, setChartPeriod] = useState("month");
  const [fullChartOpen, setFullChartOpen] = useState(()=>new URLSearchParams(window.location.search).get("fullChart")==="1");
  const months = Math.max(0, Math.round((parseFloat(years)||0) * 12));
  const returnRate = (parseFloat(annualReturn)||0) / 100;
  const monthlyRate = returnPeriod === "annual"
    ? Math.pow(1 + returnRate, 1 / 12) - 1
    : returnRate;
  const initialValue = parseFloat(initial)||0;
  const monthlyContribution = parseFloat(monthly)||0;
  const finalValue = useMemo(()=>{
    let value = initialValue;
    for(let i=0;i<months;i++){
      value = value * (1 + monthlyRate);
      value += monthlyContribution;
    }
    return value;
  },[initialValue, monthlyContribution, monthlyRate, months]);
  const totalContributions = initialValue + monthlyContribution * months;
  const totalGrowth = finalValue - totalContributions;
  const fullChartPoints = useMemo(()=>{
    let value = initialValue;
    const points = [{month:0,value,contributions:initialValue,growth:0,growthShare:0}];
    for(let month=1;month<=months;month++){
      value = value * (1 + monthlyRate);
      value += monthlyContribution;
      const contributions = initialValue + monthlyContribution * month;
      const growth = Math.max(value - contributions, 0);
      points.push({month,value,contributions,growth,growthShare:value > 0 ? growth / value : 0});
    }
    return points;
  },[initialValue, monthlyContribution, monthlyRate, months]);
  const monthlyRows = useMemo(()=>{
    let value = initialValue;
    const rows = [{month:0,interest:0,contributions:initialValue,totalInterest:0,value}];
    for(let month=1;month<=months;month++){
      const interest = value * monthlyRate;
      value = value + interest + monthlyContribution;
      const contributions = initialValue + monthlyContribution * month;
      rows.push({
        month,
        interest,
        contributions,
        totalInterest:value - contributions,
        value,
      });
    }
    return rows;
  },[initialValue, monthlyContribution, monthlyRate, months]);
  const milestones = useMemo(()=>{
    return milestoneTargets.map(target=>{
      if(initialValue >= target) return {target,reached:true,years:0};
      let value = initialValue;
      for(let month=1;month<=1200;month++){
        value = value * (1 + monthlyRate);
        value += monthlyContribution;
        if(value >= target) return {target,reached:false,years:month/12};
      }
      return {target,reached:false,years:null};
    });
  },[initialValue, monthlyContribution, monthlyRate, months]);
  const chartPoints = useMemo(()=>{
    const steps = chartPeriod === "year" ? Math.max(1, Math.ceil(months / 12)) : Math.min(Math.max(months, 1), 120);
    const interval = chartPeriod === "year" ? 12 : Math.max(1, Math.ceil(Math.max(months, 1) / steps));
    let value = initialValue;
    const points = [{month:0,value,contributions:initialValue}];
    for(let month=1;month<=months;month++){
      value = value * (1 + monthlyRate);
      value += monthlyContribution;
      if(month % interval === 0 || month === months) {
        points.push({month,value,contributions:initialValue + monthlyContribution * month});
      }
    }
    return points;
  },[initialValue, monthlyContribution, monthlyRate, months, chartPeriod]);
  const chartMax = Math.max(...chartPoints.map(p=>Math.max(p.value,p.contributions)), 1);
  const barArea = {left:3,right:98,top:9,bottom:91};
  const chartHeight = barArea.bottom - barArea.top;
  const barStep = (barArea.right - barArea.left) / Math.max(chartPoints.length, 1);
  const barWidth = Math.max(0.28, Math.min(1.6, barStep * 0.64));
  const chartBars = chartPoints.map((point,idx)=>{
    const contributions = Math.min(point.contributions, point.value);
    const growth = Math.max(point.value - point.contributions, 0);
    const contributionHeight = (contributions / chartMax) * chartHeight;
    const growthHeight = (growth / chartMax) * chartHeight;
    const x = barArea.left + idx * barStep + (barStep - barWidth) / 2;
    return {
      x,
      contributionY: barArea.bottom - contributionHeight,
      contributionHeight,
      growthY: barArea.bottom - contributionHeight - growthHeight,
      growthHeight,
    };
  });
  const growthShare = finalValue > 0 ? Math.max(0, Math.min(1, totalGrowth / finalValue)) : 0;
  const contributionShare = finalValue > 0 ? Math.max(0, Math.min(1, totalContributions / finalValue)) : 0;
  const donutRadius = 36;
  const donutCircumference = 2 * Math.PI * donutRadius;
  const growthDash = `${(growthShare * donutCircumference).toFixed(2)} ${donutCircumference.toFixed(2)}`;
  const contributionDash = `${(contributionShare * donutCircumference).toFixed(2)} ${donutCircumference.toFixed(2)}`;
  const updateWhole = (setter) => (e) => setter(integerInputValue(e.target.value));
  const updateDecimal = (setter) => (e) => setter(decimalInputValue(e.target.value));

  return (
    <div className="main calc-page fade-in">
      <div className="learn-head">
        <div>
          <div className="calc-head-kicker-row">
            <div className="learn-kicker">Calculators</div>
            <button className="btn" onClick={()=>onNavigate("learn-courses")}>Learn About Options</button>
          </div>
          <div className="learn-title">Compound Interest Calculator</div>
          <div className="calc-subtitle">Plan long-term portfolio growth.</div>
        </div>
        <button className="btn bneutral" onClick={()=>onNavigate("learn")}>Back to Learn</button>
      </div>

      <div className="calc-wrap">
        <div className="calc-panel">
          <div className="sectitle" style={{marginBottom:14}}>Compound Interest Calculator</div>
          <div className="calc-form">
            {[
              ["Initial Investment",initial,setInitial,"1000","compound-initial"],
              ["Monthly Contribution",monthly,setMonthly,"250","compound-monthly"],
            ].map(([label,value,setter,placeholder,id])=>(
              <div className="fgrp" key={label}>
                <label className="flbl" htmlFor={id}>{label}</label>
                <input
                  id={id}
                  className="finput"
                  type="text"
                  inputMode="numeric"
                  value={formatIntegerInput(value)}
                  placeholder={formatIntegerInput(placeholder)}
                  onChange={updateWhole(setter)}
                />
              </div>
            ))}
            <div className="fgrp">
              <div className="return-field-head">
                <label className="flbl" htmlFor="compound-return">
                  {returnPeriod==="annual" ? "Annual Return %" : "Monthly Return %"}
                </label>
                <div className="return-toggle" aria-label="Return period">
                  <button type="button" className={returnPeriod==="annual"?"active":""} aria-pressed={returnPeriod==="annual"} onClick={()=>setReturnPeriod("annual")}>Annual</button>
                  <button type="button" className={returnPeriod==="monthly"?"active":""} aria-pressed={returnPeriod==="monthly"} onClick={()=>setReturnPeriod("monthly")}>Monthly</button>
                </div>
              </div>
              <input
                id="compound-return"
                className="finput"
                type="text"
                inputMode="decimal"
                value={formatDecimalInput(annualReturn)}
                placeholder="8"
                onChange={updateDecimal(setAnnualReturn)}
              />
            </div>
            <div className="fgrp">
              <label className="flbl" htmlFor="compound-years">Years</label>
              <input
                id="compound-years"
                className="finput"
                type="text"
                inputMode="numeric"
                value={formatIntegerInput(years)}
                placeholder={formatIntegerInput("10")}
                onChange={updateWhole(setYears)}
              />
            </div>
            <div className="calc-panel-cta">
              <div className="calc-cta-title">Looking for higher income strategies?</div>
              <div className="calc-cta-copy">
                Learn how option traders generate premium income using Covered Calls, Cash-Secured Puts, PMCCs and other income strategies.
              </div>
              <button className="btn" onClick={()=>onNavigate("learn-courses")}>Learn About Options</button>
            </div>
          </div>
        </div>

        <div className="calc-panel">
          <div className="sectitle" style={{marginBottom:14}}>Results</div>
          <div className="calc-results">
            <div className="calc-result" style={{borderColor:"#63E6BE44"}}>
              <div className="calc-result-label">Final Portfolio Value</div>
              <div className="calc-result-value" style={{color:"#63E6BE"}}>{formatCurrencyWhole(finalValue)}</div>
            </div>
            <div className="calc-result" style={{borderColor:"#5B8CFF44"}}>
              <div className="calc-result-label">Total Contributions</div>
              <div className="calc-result-value" style={{color:"#5B8CFF"}}>{formatCurrencyWhole(totalContributions)}</div>
            </div>
            <div className="calc-result" style={{borderColor:(totalGrowth>=0?"#FFD84D44":"#FF4D6D44")}}>
              <div className="calc-result-label">Investment Growth</div>
              <div className="calc-result-value" style={{color:totalGrowth>=0?"#FFD84D":"#FF4D6D"}}>{formatCurrencyWhole(totalGrowth)}</div>
            </div>
          </div>
          <div className="breakdown-head">
            <div className="sectitle">Investment Breakdown</div>
            <button className="full-chart-btn" type="button" onClick={()=>setFullChartOpen(true)}>View Full Chart ↗</button>
          </div>
          <div className="investment-breakdown">
            <div className="breakdown-card">
              <div className="donut-wrap">
                <svg width="116" height="116" viewBox="0 0 100 100" aria-label="Investment breakdown donut chart">
                  <circle cx="50" cy="50" r={donutRadius} fill="none" stroke="#1B2A3A" strokeWidth="12"/>
                  <circle cx="50" cy="50" r={donutRadius} fill="none" stroke="#5B8CFF" strokeWidth="12" strokeDasharray={contributionDash} strokeLinecap="round" transform="rotate(-90 50 50)"/>
                  <circle cx="50" cy="50" r={donutRadius} fill="none" stroke="#FFD84D" strokeWidth="12" strokeDasharray={growthDash} strokeDashoffset={-(contributionShare * donutCircumference)} strokeLinecap="round" transform="rotate(-90 50 50)"/>
                  <text x="50" y="47" textAnchor="middle" fill="#D6E2F0" fontSize="10" fontFamily="DM Mono, monospace">Growth</text>
                  <text x="50" y="60" textAnchor="middle" fill="#FFD84D" fontSize="11" fontWeight="700" fontFamily="DM Mono, monospace">{formatWholeNumber(growthShare*100)}%</text>
                </svg>
                <div className="donut-legend">
                  <div><span className="legend-dot" style={{background:"#5B8CFF"}}/>Total Contributions<span className="legend-value">{formatCurrencyWhole(totalContributions)}</span></div>
                  <div><span className="legend-dot" style={{background:"#FFD84D"}}/>Investment Growth<span className="legend-value">{formatCurrencyWhole(totalGrowth)}</span></div>
                </div>
              </div>
            </div>
            <div className="calc-chart" aria-label="Projected portfolio growth chart">
              <div className="chart-top">
                <div className="chart-toggle" aria-label="Chart period">
                  <button type="button" className={chartPeriod==="month"?"active":""} aria-pressed={chartPeriod==="month"} onClick={()=>setChartPeriod("month")}>Month</button>
                  <button type="button" className={chartPeriod==="year"?"active":""} aria-pressed={chartPeriod==="year"} onClick={()=>setChartPeriod("year")}>Year</button>
                </div>
                <div className="chart-legend">
                  <span><span className="legend-dot" style={{background:"#5B8CFF"}}/>Total Contributions</span>
                  <span><span className="legend-dot" style={{background:"#FFD84D"}}/>Investment Growth</span>
                </div>
              </div>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{width:"100%",height:"calc(100% - 34px)",display:"block"}}>
                <defs>
                  <linearGradient id="contributionBars" x1="0" x2="0" y1="1" y2="0">
                    <stop offset="0%" stopColor="#3658B8" stopOpacity=".88"/>
                    <stop offset="100%" stopColor="#5B8CFF" stopOpacity=".98"/>
                  </linearGradient>
                  <linearGradient id="growthBars" x1="0" x2="0" y1="1" y2="0">
                    <stop offset="0%" stopColor="#FFD84D" stopOpacity=".6"/>
                    <stop offset="100%" stopColor="#FFE88A" stopOpacity=".96"/>
                  </linearGradient>
                </defs>
                {[25,50,75].map(y=><line key={y} x1="3" x2="98" y1={y} y2={y} stroke="#1B2A3A" strokeWidth=".35"/>)}
                <line x1="3" x2="98" y1="91" y2="91" stroke="#314457" strokeWidth=".5"/>
                {chartBars.map((bar,idx)=>(
                  <g key={idx}>
                    <rect x={bar.x} y={bar.contributionY} width={barWidth} height={bar.contributionHeight} fill="url(#contributionBars)" rx=".16"/>
                    {bar.growthHeight>0&&(
                      <rect x={bar.x} y={bar.growthY} width={barWidth} height={bar.growthHeight} fill="url(#growthBars)" rx=".16"/>
                    )}
                  </g>
                ))}
              </svg>
              <div className="chart-caption">{chartPeriod==="year"?"Years":"Months"}</div>
            </div>
          </div>
          <div className="monthly-return-table">
            <div className="monthly-return-head">
              <div className="sectitle">Monthly Returns</div>
              <div className="monthly-return-note">
                Rate basis: {returnPeriod==="annual" ? "annual converted to monthly" : "monthly"}
              </div>
            </div>
            <div className="monthly-return-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Interest</th>
                    <th>Total Invested</th>
                    <th>Total Interest</th>
                    <th>Accumulated</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyRows.map(row=>(
                    <tr key={row.month}>
                      <td>{row.month}</td>
                      <td>{formatCurrencyWhole(row.interest)}</td>
                      <td>{formatCurrencyWhole(row.contributions)}</td>
                      <td>{formatCurrencyWhole(row.totalInterest)}</td>
                      <td>{formatCurrencyWhole(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {fullChartOpen&&(
        <ExpandedGrowthChartModal
          points={fullChartPoints}
          milestones={milestones}
          onClose={()=>setFullChartOpen(false)}
        />
      )}
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
          The positions below have passed their expiration date. Mark only worthless expirations here. If you closed or rolled, keep it open and enter the closing price through Close/Roll.
        </p>
        {trades.map(t=>(
          <div key={t.id} style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"10px 14px",marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:13}}>
                <span style={{color:t.color||"#63E6BE",fontWeight:700,fontFamily:"Syne,sans-serif"}}>{t.ticker}</span>
                {" "}<span style={{color:"#FFD84D"}}>${t.strike}</span>
                {" "}<span style={{color:"#7D91AA"}}>{t.action}</span>
                {" · exp "}<span style={{color:"#7D91AA"}}>{t.expiration}</span>
                {" · "}<span style={{color:"#63E6BE"}}>${fmt(parseFloat(t.premium||0)*(parseInt(t.contracts||1))*100)}</span>
              </div>
              <span style={{fontSize:10,color:"#FF4D6D",background:"#FF4D6D10",border:"1px solid #FF4D6D33",padding:"2px 8px",borderRadius:3,letterSpacing:1,textTransform:"uppercase"}}>expired</span>
            </div>
            <div className="toggle-group">
              <button className="tgl" style={{flex:1,background:decisions[t.id]==="expired"?"#B37CFF":"transparent",color:decisions[t.id]==="expired"?"#fff":"#7D91AA"}}
                onClick={()=>setDecisions(p=>({...p,[t.id]:"expired"}))}>Expired worthless</button>
              <button className="tgl" style={{flex:1,background:decisions[t.id]==="open"?"#FFD84D":"transparent",color:decisions[t.id]==="open"?"#071019":"#7D91AA"}}
                onClick={()=>setDecisions(p=>({...p,[t.id]:"open"}))}>Needs close price</button>
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
        <EmptyState title="No closed strategies yet" copy="Closed, expired, and archived strategy records will appear here after a full lifecycle is completed." style={{padding:"60px 0"}}/>
      ):(
        closedAssets.map(a=>{
          const total=hasLeapContracts(a)
            ? thetaEngineRealizedDollars(a.trades, a.leaps||[])
            : realizedOptionPnLDollars(a.trades);
          return (
            <div key={a.id} className="sec" style={{marginBottom:16}}>
              <div className="sechdr">
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontFamily:"Syne",fontWeight:700,fontSize:16,color:"#D6E2F0"}}>{a.ticker}</span>
                  <StratBadge strategy={a.strategy||"PMCC"}/>
                  <span className="stclosed">Closed</span>
                  <span style={{fontSize:11,color:"#7D91AA"}}>{a.closedAt}</span>
                </div>
                <div style={{display:"flex",gap:16,fontSize:12}}>
                  {hasLeapContracts(a)&&<span style={{color:"#7D91AA"}}>LEAP: <span style={{color:"#D6E2F0"}}>${a.leapStrike} {a.leapExpiration}</span></span>}
                  <span style={{color:"#7D91AA"}}>{hasLeapContracts(a)?"Theta collected":"Realized P&L"}: <span style={{color:total>=0?"#63E6BE":"#FF4D6D"}}>{total>=0?"+":""}${fmt(total)}</span></span>
                </div>
              </div>
              <table>
                <thead><tr><th>Date</th><th>Action</th><th>Strike</th><th>Expiration</th><th>Premium</th><th>Contracts</th><th>Value $</th></tr></thead>
                <tbody>
                  {a.trades.sort((x,y)=>new Date(y.date)-new Date(x.date)).map(t=>(
                    <tr key={t.id}>
                      <td style={{color:"#7D91AA"}}>{t.date}</td>
                      <td><span style={{color:t.action==="SELL"?"#63E6BE":"#FF4D6D"}}>{t.action}</span></td>
                      <td><span style={{color:"#FFD84D"}}>${t.strike}</span></td>
                      <td>{t.expiration}</td>
                      <td style={{color:t.action==="SELL"?"#63E6BE":"#FF4D6D"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium)}</td>
                      <td style={{color:"#8aaac8"}}>{t.contracts||1}</td>
                      <td style={{color:t.action==="SELL"?"#63E6BE":"#FF4D6D"}}>{t.action==="SELL"?"+":"-"}${fmt(t.premium*(t.contracts||1)*100)}</td>
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
  const avColor=COLORS.find(c=>!usedColors.includes(c))||"#B37CFF";
  const needsLeap = selectedStrategy==="PMCC" || selectedStrategy==="";
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
              <div style={{fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"#4A6A8A",marginBottom:6,marginTop:4}}>{category}</div>
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
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:"10px 14px",marginTop:8,fontSize:12}}>
              <div style={{color:"#D6E2F0",marginBottom:6,fontWeight:500}}>{stratInfo.label}</div>
              <div style={{color:"#7D91AA",lineHeight:1.5,marginBottom:8}}>{stratInfo.desc}</div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                <div>
                  {stratInfo.tracks.map(t=><div key={t} style={{fontSize:11,color:"#63E6BE",marginBottom:2}}>✓ {t}</div>)}
                </div>
                <div>
                  {stratInfo.no.map(t=><div key={t} style={{fontSize:11,color:"#4A6A8A",marginBottom:2}}>✕ {t}</div>)}
                </div>
              </div>
            </div>
          )}
          {!selectedStrategy&&<div style={{fontSize:11,color:"#4A6A8A",marginTop:6}}>No strategy selected — will be tracked as free entry</div>}
        </div>

        {(needsLeap||isPremiumStrategy(selectedStrategy))&&(
          <>
            <div style={{borderTop:"1px solid #1B2A3A",paddingTop:12,marginBottom:10,fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#4A6A8A"}}>LEAP details</div>
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

        <div style={{fontSize:11,color:"#7D91AA",marginBottom:4,marginTop:4}}>Color: <span style={{color:avColor}}>●</span> {avColor}</div>
        <div className="factions">
          <button className="btn bneutral bfull" onClick={onClose}>Cancel</button>
          <button className="btn bfull" onClick={submit} style={{color:avColor,borderColor:avColor+"44",background:avColor+"15"}}>Add position</button>
        </div>
      </div>
    </div>
  );
}

// ── All Positions Modal ───────────────────────────────────────────────────────
function AllPositionsModal({ assets, strategies=[], onClose }) {
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
              <th>Ticker</th><th>Type</th><th>Strategy</th><th>Action</th><th>Strike</th>
              <th>Expiration</th><th>Cost / Premium</th><th>Contracts</th>
            </tr>
          </thead>
          <tbody>
            {allOpen.map((p,i)=>(
              <tr key={i}>
                <td><span style={{fontFamily:"Syne,sans-serif",fontWeight:700,color:p.color}}>{p.ticker}</span></td>
                <td><span style={{fontSize:11,padding:"2px 8px",borderRadius:4,background:p.type==="LEAP"?"#5B8CFF20":p.action==="BUY"?"#5B8CFF20":"#63E6BE15",color:p.type==="LEAP"?"#5B8CFF":p.action==="BUY"?"#5B8CFF":"#63E6BE",border:`1px solid ${p.type==="LEAP"?"#5B8CFF44":p.action==="BUY"?"#5B8CFF44":"#63E6BE44"}`}}>{p.type}</span></td>
                <td>{p.type==="LEAP"?<span style={{fontSize:10,color:"#4A6A8A"}}>-</span>:<TradeStrategyBadge trade={p} strategies={strategies}/>}</td>
                <td><span style={{color:p.action==="SELL"?"#63E6BE":"#FF4D6D"}}>{p.action}</span></td>
                <td style={{color:"#FFD84D"}}>{p.strike}</td>
                <td>
                  {p.daysLeft!=null?(
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:36,height:3,background:"#1B2A3A",borderRadius:2}}>
                        <div style={{height:"100%",width:`${Math.min(Math.max((p.daysLeft/21)*100,4),100)}%`,background:p.daysColor,borderRadius:2}}/>
                      </div>
                      <span style={{fontSize:11,color:p.daysColor}}>{p.daysLeft<=0?"exp!":p.daysLeft+"d"}</span>
                    </div>
                  ):<span style={{color:"#7D91AA",fontSize:12}}>{p.expiration}</span>}
                </td>
                <td style={{color:p.action==="SELL"?"#63E6BE":"#D6E2F0"}}>{p.cost}</td>
                <td style={{color:"#8aaac8"}}>{p.contracts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{marginTop:12,padding:"10px 0",borderTop:"1px solid #1B2A3A",display:"flex",justifyContent:"space-between",fontSize:11,color:"#7D91AA"}}>
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
        positionEffect: "auto",
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

  const orderColor = form.orderType==="BUY" ? "#63E6BE" : "#FF4D6D";

  const summaryRows = [
    ["Asset",      form.symbol||"—",                                                                                                    "#D6E2F0"],
    ["Order",      `${form.orderType==="BUY"?"Buy":"Sell"} ${form.optionType==="call"?"Call":"Put"}`,                                   orderColor],
    ["Strike",     form.strike  ? `$${fmt(parseFloat(form.strike))}` : "—",                                                            "#FFD84D"],
    ["Expiration", form.expiration || "—",                                                                                              "#D6E2F0"],
    ["Qty",        `${qty} contract${qty>1?"s":""}`,                                                                                    "#8aaac8"],
    ["Price",      price ? `$${fmt(price)}` : "—",                                                                                     "#D6E2F0"],
    ["Value",      totalValue>0 ? `${netAmount<0?"-":"+"}$${fmt(Math.abs(netAmount))}` : "—", netAmount<0 ? "#FF4D6D" : "#63E6BE"],
  ];

  const inputStyle = (field) => ({
    ...(touched[field] && !form[field] ? {borderColor:"#FF4D6D88"} : {}),
  });

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:12,width:880,maxWidth:"97vw",maxHeight:"92vh",boxShadow:"0 40px 80px rgba(0,0,0,0.7)",display:"flex",flexDirection:"column",overflowY:"auto"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"16px 24px",borderBottom:"1px solid #1B2A3A",flexShrink:0}}>
          <span style={{color:"#63E6BE",fontSize:16,fontWeight:700}}>+</span>
          <span style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:16,color:"#fff"}}>Register trade manually</span>
          <button onClick={onClose} style={{marginLeft:"auto",background:"none",border:"none",color:"#7D91AA",cursor:"pointer",fontSize:20,lineHeight:1,padding:"0 4px"}}>✕</button>
        </div>

        {/* Body */}
        <div style={{display:"flex",flex:1,minHeight:0}}>

          {/* Left — Form */}
          <div style={{flex:1,padding:"20px 24px",overflowY:"auto"}}>

            {/* Asset */}
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#4A6A8A",marginBottom:10}}>Asset</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
              {/* Symbol — autocomplete from Tradier search */}
              <div className="fgrp">
                <label className="flbl">Symbol *</label>
                <div style={{position:"relative"}}>
                  <input className="finput"
                    style={{textTransform:"uppercase",letterSpacing:1,paddingRight:30,
                      ...(symbolValid?{borderColor:"#63E6BE66"}
                        :touched.symbol&&form.symbol?{borderColor:"#FF4D6D88"}
                        :touched.symbol&&!form.symbol?{borderColor:"#FF4D6D88"}:{})
                    }}
                    placeholder="AAPL, TSLA..."
                    value={form.symbol}
                    onBlur={()=>{touch("symbol"); setTimeout(()=>setShowDrop(false),160);}}
                    onFocus={()=>{if(suggestions.length>0) setShowDrop(true);}}
                    onChange={e=>handleSymbolChange(e.target.value)}/>
                  {symbolValid&&!searching&&
                    <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",color:"#63E6BE",fontSize:13,fontWeight:700,pointerEvents:"none"}}>✓</span>}
                  {searching&&
                    <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",color:"#4A6A8A",fontSize:11,pointerEvents:"none",animation:"pulse 1s infinite"}}>…</span>}
                  {showDrop&&(
                    <div style={{position:"absolute",top:"calc(100% + 2px)",left:0,right:0,background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:6,zIndex:400,boxShadow:"0 8px 24px rgba(0,0,0,0.6)",maxHeight:220,overflowY:"auto"}}>
                      {suggestions.length===0?(
                        <div style={{padding:"10px 14px",fontSize:12,color:"#4A6A8A"}}>No matching assets</div>
                      ):(
                        suggestions.map(s=>(
                          <div key={s.symbol}
                            onMouseDown={()=>selectSuggestion(s)}
                            style={{padding:"9px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #0f1e2e",transition:"background 0.15s"}}
                            onMouseEnter={e=>e.currentTarget.style.background="#1B2A3A"}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <span style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontWeight:700,fontSize:13,color:"#fff",minWidth:56}}>{s.symbol}</span>
                            <span style={{fontSize:11,color:"#8aaac8",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.description}</span>
                            <span style={{fontSize:10,color:"#4A6A8A",background:"#1B2A3A",padding:"2px 6px",borderRadius:3,flexShrink:0}}>{s.exchange}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {touched.symbol&&!form.symbol&&
                  <span style={{fontSize:10,color:"#FF4D6D",marginTop:2,display:"block"}}>Symbol is required</span>}
                {touched.symbol&&form.symbol&&!symbolValid&&
                  <span style={{fontSize:10,color:"#FF4D6D",marginTop:2,display:"block"}}>Select a valid asset from the list</span>}
              </div>
              <div className="fgrp">
                <label className="flbl">Asset name (optional)</label>
                <input className="finput" placeholder="Auto-filled from search"
                  value={form.assetName} onChange={e=>setForm(p=>({...p,assetName:e.target.value}))}/>
              </div>
            </div>

            {/* Trade Details */}
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#4A6A8A",marginBottom:10}}>Trade details</div>

            {/* Order type + Option type */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
              <div className="fgrp">
                <label className="flbl">Order type</label>
                <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1px solid #1B2A3A"}}>
                  {[["BUY","Buy","#63E6BE","#071019"],["SELL","Sell","#FF4D6D","#fff"]].map(([val,label,col,tc])=>(
                    <button key={val} onClick={()=>setForm(p=>({...p,orderType:val}))}
                      style={{flex:1,padding:"10px 0",border:"none",cursor:"pointer",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:13,fontWeight:700,transition:"all 0.2s",
                        background:form.orderType===val?col:"#071019",
                        color:form.orderType===val?tc:"#7D91AA",
                        letterSpacing:0.5}}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="fgrp">
                <label className="flbl">Option type</label>
                <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1px solid #1B2A3A"}}>
                  {[["call","Call","#5B8CFF"],["put","Put","#B37CFF"]].map(([val,label,col])=>(
                    <button key={val} onClick={()=>setForm(p=>({...p,optionType:val}))}
                      style={{flex:1,padding:"10px 0",border:"none",cursor:"pointer",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:13,fontWeight:700,transition:"all 0.2s",
                        background:form.optionType===val?col:"#071019",
                        color:form.optionType===val?"#fff":"#7D91AA",
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
                {fieldErr("strike")&&<span style={{fontSize:10,color:"#FF4D6D",marginTop:2,display:"block"}}>{fieldErr("strike")}</span>}
              </div>
              <div className="fgrp">
                <label className="flbl">Expiration *</label>
                <input className="finput" type="date"
                  value={form.expiration} style={inputStyle("expiration")}
                  onBlur={()=>touch("expiration")}
                  onChange={e=>setForm(p=>({...p,expiration:e.target.value}))}/>
                {fieldErr("expiration")&&<span style={{fontSize:10,color:"#FF4D6D",marginTop:2,display:"block"}}>{fieldErr("expiration")}</span>}
              </div>
              <div className="fgrp">
                <label className="flbl">Price *</label>
                <div style={{position:"relative"}}>
                  <input className="finput" type="number" step="0.01" placeholder="0.23"
                    value={form.price} style={{paddingRight:38,...inputStyle("price")}}
                    onBlur={()=>touch("price")}
                    onChange={e=>setForm(p=>({...p,price:e.target.value}))}/>
                  <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#4A6A8A",pointerEvents:"none"}}>USD</span>
                </div>
                {fieldErr("price")&&<span style={{fontSize:10,color:"#FF4D6D",marginTop:2,display:"block"}}>{fieldErr("price")}</span>}
              </div>
            </div>
            <div style={{fontSize:10,color:"#4A6A8A",marginBottom:14,letterSpacing:0.5}}>contracts</div>

            {/* Debit / Credit — only active box is fully visible */}
            <div style={{marginBottom:16}}>
              {form.orderType==="BUY" ? (
                <div style={{background:"#FF4D6D12",border:"1px solid #FF4D6D55",borderRadius:8,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:"#FF4D6D",marginBottom:6,fontWeight:600,letterSpacing:0.5}}>You will pay (debit)</div>
                  <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:22,fontWeight:650,color:"#FF4D6D"}}>
                    -{totalValue>0?`$${fmt(totalValue)}`:"$—"}
                  </div>
                  <div style={{fontSize:11,color:"#7D91AA",marginTop:4}}>
                    {qty} contract{qty>1?"s":""} × 100 shares × ${fmt(price)}
                    {fees>0 && <span style={{color:"#FF4D6D88"}}> + ${fmt(fees)} fees</span>}
                  </div>
                </div>
              ) : (
                <div style={{background:"#63E6BE12",border:"1px solid #63E6BE55",borderRadius:8,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:"#63E6BE",marginBottom:6,fontWeight:600,letterSpacing:0.5}}>You will receive (credit)</div>
                  <div style={{fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:22,fontWeight:650,color:"#63E6BE"}}>
                    +{totalValue>0?`$${fmt(totalValue)}`:"$—"}
                  </div>
                  <div style={{fontSize:11,color:"#7D91AA",marginTop:4}}>
                    {qty} contract{qty>1?"s":""} × 100 shares × ${fmt(price)}
                    {fees>0 && <span style={{color:"#7D91AA88"}}> − ${fmt(fees)} fees</span>}
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
                  <span style={{position:"absolute",right:9,top:"50%",transform:"translateY(-50%)",fontSize:10,color:"#4A6A8A",pointerEvents:"none"}}>USD</span>
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
            <button onClick={()=>setShowMore(!showMore)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",background:"none",border:"none",borderTop:"1px solid #1B2A3A",color:"#7D91AA",cursor:"pointer",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:12,padding:"12px 0",marginTop:14}}>
              <span>Show more options</span>
              <span style={{fontSize:11}}>{showMore?"▲":"▼"}</span>
            </button>

            {showMore&&(
              <div style={{paddingTop:12,display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div className="fgrp">
                  <label className="flbl">Trade Group (free label)</label>
                  <input className="finput" placeholder="e.g. PMCC PBR 2026, IBIT CC..."
                    value={form.tradeGroup} onChange={e=>setForm(p=>({...p,tradeGroup:e.target.value}))}/>
                  <span style={{fontSize:10,color:"#4A6A8A",marginTop:3,display:"block"}}>Groups legs of the same strategy</span>
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
          <div style={{width:196,background:"#071019",borderLeft:"1px solid #1B2A3A",padding:"20px 16px",flexShrink:0,overflowY:"auto"}}>
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#4A6A8A",marginBottom:14}}>Trade summary</div>
            {summaryRows.map(([label,value,color])=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,paddingBottom:10,borderBottom:"1px solid #0f1e2e"}}>
                <span style={{fontSize:11,color:"#4A6A8A",flexShrink:0}}>{label}</span>
                <span style={{fontSize:12,fontWeight:600,color,textAlign:"right",marginLeft:6,wordBreak:"break-all"}}>{value}</span>
              </div>
            ))}
            <div style={{background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:8,padding:"12px",marginTop:4}}>
              <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:6}}>
                <span style={{fontSize:13}}>💡</span>
                <span style={{fontSize:11,fontWeight:600,color:"#FFD84D"}}>Tip</span>
              </div>
              <div style={{fontSize:11,color:"#7D91AA",lineHeight:1.6}}>
                All registered trades will be added to your portfolio and used to calculate P&L and strategy performance.
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{padding:"14px 24px",borderTop:"1px solid #1B2A3A",flexShrink:0}}>
          {saveError&&(
            <div style={{background:"#FF4D6D10",border:"1px solid #FF4D6D44",borderRadius:6,padding:"8px 12px",marginBottom:10,fontSize:12,color:"#FF4D6D"}}>
              ⚠ {saveError}
            </div>
          )}
          <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
            <button className="btn bneutral" style={{padding:"9px 28px",fontSize:13}} onClick={onClose}>Cancel</button>
            <button className="btn" style={{padding:"9px 28px",fontSize:13,color:"#63E6BE",borderColor:"#63E6BE44",background:"#63E6BE15",opacity:canSave?1:0.5,cursor:canSave?"pointer":"not-allowed"}}
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
  const [strategies, setStrategies] = useState([]);
  const [closedAssets, setClosedAssets] = useState([]);
  const [active, setActive] = useState(()=>{
    return window.location.hash.replace("#","") || "home";
  });
  const [showAdd, setShowAdd] = useState(false);
  const [showPositions, setShowPositions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expiredPending, setExpiredPending] = useState([]);
  const [toast, setToast] = useState(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const [simulatorPreset, setSimulatorPreset] = useState(null);
  const showToast = (msg, ok=true) => { setToast({msg,ok}); setTimeout(()=>setToast(null),6000); };
  const [editTrade, setEditTrade] = useState(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);
  const duplicateResolver = useRef(null);
  const [closePrompt, setClosePrompt] = useState(null);
  const closeResolver = useRef(null);
  const [strategyPrompt, setStrategyPrompt] = useState(null);
  const strategyResolver = useRef(null);

  const strategyByTradeId = useMemo(()=>{
    const map = {};
    strategies.forEach(strategy=>{
      (strategy.links||[])
        .filter(l=>l.assignment_status==="confirmed"&&!l.detached_at)
        .forEach(link=>{ map[link.trade_id] = {...link,strategy}; });
    });
    return map;
  },[strategies]);

  const assetsWithStrategyLinks = useMemo(()=>assets.map(asset=>({
    ...asset,
    trades:(asset.trades||[]).map(t=>({...t,strategyLink:strategyByTradeId[t.id]||null})),
  })),[assets,strategyByTradeId]);

  const loadPortfolio = useCallback(async()=>{
    const [freshAssets, freshStrategies] = await Promise.all([fetchAssets(), fetchStrategies()]);
    setAssets(freshAssets);
    setStrategies(freshStrategies);
    return {freshAssets, freshStrategies};
  },[]);

  useEffect(()=>{
    const today=new Date().toISOString().slice(0,10);
    loadPortfolio()
      .then(({freshAssets})=>{
        const fresh=freshAssets;
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
  },[loadPortfolio]);

  useEffect(()=>{
    if(active==="home"||active==="closed"||active.startsWith("learn")) return;
    loadPortfolio().catch(e=>console.error("nav reload:",e));
  },[active,loadPortfolio]);

  useEffect(()=>{
    const onHashChange = () => setActive(window.location.hash.replace("#","") || "home");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  },[]);

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
      await loadPortfolio();
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
      showToast(`Error creating asset: ${e?.message||e?.code||"unknown"}`,false);
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

  const normalizeTradeForLifecycle = (trade) => ({
    ...trade,
    action: (trade.action||"SELL").toUpperCase(),
    option_type: trade.option_type || "call",
    strike: parseFloat(trade.strike),
    premium: parseFloat(trade.premium)||0,
    contracts: Math.max(1, parseInt(trade.contracts)||1),
    positionEffect: trade.positionEffect || (trade.status==="closed" ? "close" : "auto"),
    status: trade.positionEffect==="close" ? "closed" : (trade.status || "open"),
  });

  const sameTradeCore = (a,b) =>
    (a.action||"").toUpperCase()===(b.action||"").toUpperCase() &&
    (a.option_type||"call")===(b.option_type||"call") &&
    Math.abs(parseFloat(a.strike)-parseFloat(b.strike))<0.01 &&
    a.expiration===b.expiration;

  const findDuplicateTrade = (asset, trade) => {
    const normalized = normalizeTradeForLifecycle(trade);
    return (asset?.trades||[]).find(t =>
      sameTradeCore(t, normalized) &&
      (t.date||"")===(normalized.date||"") &&
      (t.status||"open")===(normalized.status||"open") &&
      Math.abs(parseFloat(t.premium||0)-normalized.premium)<0.005 &&
      parseInt(t.contracts||1)===normalized.contracts
    );
  };

  const requestDuplicateApproval = (payload) => new Promise(resolve => {
    duplicateResolver.current = resolve;
    setDuplicatePrompt(payload);
  });

  const resolveDuplicatePrompt = (approved) => {
    const resolve = duplicateResolver.current;
    duplicateResolver.current = null;
    setDuplicatePrompt(null);
    if(resolve) resolve(approved);
  };

  const requestCloseApproval = (payload) => new Promise(resolve => {
    closeResolver.current = resolve;
    setClosePrompt(payload);
  });

  const resolveClosePrompt = (choice) => {
    const resolve = closeResolver.current;
    closeResolver.current = null;
    setClosePrompt(null);
    if(resolve) resolve(choice);
  };

  const requestStrategyAssignment = (payload) => new Promise(resolve => {
    strategyResolver.current = resolve;
    setStrategyPrompt(payload);
  });

  const closeStrategyPrompt = (choice) => {
    const resolve = strategyResolver.current;
    strategyResolver.current = null;
    setStrategyPrompt(null);
    if(resolve) resolve(choice);
  };

  const handleCreateStrategy = async (payload) => {
    const created = await dbCreateStrategy(payload);
    const fresh = await fetchStrategies();
    setStrategies(fresh);
    return created;
  };

  const handleDetachTradeStrategy = async (tradeId) => {
    await detachTradeFromStrategy(tradeId);
    const fresh = await fetchStrategies();
    setStrategies(fresh);
    showToast("Trade detached from strategy.");
  };

  const handleChangeTradeStrategy = async (tradeId, strategyId) => {
    const link = await moveTradeToStrategy(tradeId, strategyId);
    const fresh = await fetchStrategies();
    setStrategies(withConfirmedStrategyLink(fresh, strategyId, link));
    showToast("Strategy assignment updated.");
  };

  const applyStrategyAssignmentChoice = async ({asset, trade, choice}) => {
    if(!trade || !choice || choice.type==="cancel") {
      showToast("Trade saved as unassigned.", true);
      return;
    }
    if(choice.type==="isolated") {
      showToast("Trade saved as isolated.");
      return;
    }
    try {
      if(choice.type==="existing") {
        const link = await moveTradeToStrategy(trade.id, choice.strategyId);
        const fresh = await fetchStrategies();
        setStrategies(withConfirmedStrategyLink(fresh, choice.strategyId, link));
        showToast("Trade assigned to strategy.");
        return;
      }
      if(choice.type==="new") {
        const created = await dbCreateStrategy({
          asset_id: asset?.id || trade.asset_id || null,
          ticker: asset?.ticker || trade.ticker || asset?.id || "",
          name: choice.name,
          strategy_type: choice.strategyType,
        });
        const link = await linkTradeToStrategy(trade.id, created.id);
        const fresh = await fetchStrategies();
        setStrategies(withConfirmedStrategyLink(fresh, created.id, link, created));
        showToast("Trade assigned to strategy.");
        return;
      }
    } catch(e) {
      console.error("strategy assignment failed:", e);
      showToast("Trade saved, but strategy assignment failed. It remains isolated.", false);
    }
  };

  const getOppositeOpenMatches = (asset, trade) => {
    const normalized = normalizeTradeForLifecycle(trade);
    const oppositeAction = normalized.action==="BUY"?"SELL":"BUY";
    return (asset?.trades||[])
      .filter(t =>
        t.status==="open" &&
        t.action===oppositeAction &&
        (t.option_type||"call")===normalized.option_type &&
        Math.abs(parseFloat(t.strike)-normalized.strike)<0.01 &&
        t.expiration===normalized.expiration
      )
      .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  };

  const getClosingPlan = (asset, trade) => {
    const normalized = normalizeTradeForLifecycle(trade);
    if(normalized.positionEffect!=="close") return [];
    let remaining = normalized.contracts;
    return getOppositeOpenMatches(asset, normalized)
      .map(t=>{
        if(remaining<=0) return null;
        const currentContracts = Math.max(1, parseInt(t.contracts)||1);
        const consumed = Math.min(remaining, currentContracts);
        remaining -= consumed;
        return {
          trade:t,
          consumed,
          remainingContracts: currentContracts-consumed,
          changes: currentContracts-consumed>0
            ? {contracts:currentContracts-consumed}
            : {status:"closed"},
        };
      })
      .filter(Boolean);
  };

  const saveTradeLifecycle = async (assetId, trade) => {
    const normalized = normalizeTradeForLifecycle(trade);
    const asset = assets.find(a=>a.id===assetId);
    const closingPlan = getClosingPlan(asset, normalized);
    const saved = await addTrade(assetId, normalized);
    if(closingPlan.length) {
      try {
        await Promise.all(closingPlan.map(p=>updateTrade(p.trade.id,p.changes)));
      } catch(closeError) {
        console.error("close update failed after trade save:", closeError);
        showToast("Trade saved, but closing update failed. Refreshing positions.", false);
        await reloadAssets();
        return {saved, closingPlan:[], closeError};
      }
    }
    setAssets(p=>p.map(a=>{
      if(a.id!==assetId) return a;
      const updatedTrades = a.trades.map(t=>{
        const planned = closingPlan.find(p=>p.trade.id===t.id);
        return planned ? {...t,...planned.changes} : t;
      });
      return {...a,trades:[...updatedTrades,saved]};
    }));
    return {saved, closingPlan};
  };

  const handleSaveTrade = async (assetId, trade, options={}) => {
    try {
      const asset = assets.find(a=>a.id===assetId);
      let normalized = normalizeTradeForLifecycle(trade);
      const preserveTechnicalStrategy = THETA_EXCLUDED_STRATEGIES.has(normalized.strategy || "");
      normalized = {...normalized, strategy:preserveTechnicalStrategy ? normalized.strategy : null};
      const technicalLeapClose = isLeapCloseTrade(normalized, asset?.leaps||[]);
      if(normalized.positionEffect==="auto" && normalized.action==="BUY") {
        const closeMatches = getOppositeOpenMatches(asset, normalized);
        if(closeMatches.length) {
          const choice = await requestCloseApproval({asset, trade:normalized, matches:closeMatches});
          if(choice==="cancel") {
            showToast("Trade canceled.", false);
            return null;
          }
          normalized = normalizeTradeForLifecycle({
            ...normalized,
            positionEffect: choice==="close" ? "close" : "open",
            status: choice==="close" ? "closed" : "open",
          });
        }
      }
      if(!options.skipDuplicateCheck && !technicalLeapClose) {
        const duplicate = findDuplicateTrade(asset, normalized);
        if(duplicate) {
          const approved = await requestDuplicateApproval({asset, trade:normalized, duplicate});
          if(!approved) {
            showToast("Duplicate trade canceled.", false);
            return null;
          }
        }
      }
      const result = await saveTradeLifecycle(assetId, normalized);
      const closedContracts = result?.closingPlan.reduce((sum,p)=>sum+p.consumed,0) || 0;
      if(result?.saved && !options.skipStrategyAssignment && !technicalLeapClose) {
        const assignmentAsset = options.assignmentAsset || asset || {id:assetId,ticker:assetId,trades:[],leaps:[]};
        const assetStrategies = strategies.filter(s=>normalizeTicker(s.ticker)===normalizeTicker(assignmentAsset.ticker||assetId));
        const savedWithContext = {...result.saved,ticker:assignmentAsset.ticker||assetId};
        const suggestions = buildStrategySuggestions({trade:savedWithContext,asset:assignmentAsset,strategies:assetStrategies});
        const choice = await requestStrategyAssignment({asset:assignmentAsset,trade:savedWithContext,strategies:assetStrategies,suggestions});
        await applyStrategyAssignmentChoice({asset:assignmentAsset,trade:savedWithContext,choice});
      }
      return result?.saved ? {...result.saved, closedCount:closedContracts} : null;
    } catch(e){ console.error("handleSaveTrade error:",e); showToast(`Trade save failed: ${e?.message||e?.code||"unknown"}`,false); }
  };

  const handleUpdateTrade = async (assetId, tradeId, changes) => {
    const safe={date:changes.date,action:changes.action,option_type:changes.option_type,
      strike:changes.strike,expiration:changes.expiration,premium:changes.premium,
      contracts:changes.contracts,status:changes.status||"open",
      fees:changes.fees??0,notes:changes.notes??null,
      trade_group:changes.trade_group??null,strategy:changes.strategy??null};
    await updateTrade(tradeId, safe);
    setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:a.trades.map(t=>t.id===tradeId?{...t,...safe}:t)}:a));
  };

  const handleDeleteLeap = async (assetId, leapId) => {
    await deleteLeap(leapId);
    setAssets(p=>p.map(a=>a.id===assetId?{...a,leaps:a.leaps.filter(l=>l.id!==leapId)}:a));
  };

  const handleUpdateLeap = async (assetId, leapId, changes) => {
    await updateLeap(leapId, changes);
    setAssets(p=>p.map(a=>a.id===assetId?{...a,leaps:a.leaps.map(l=>l.id===leapId?{...l,...changes}:l)}:a));
  };

  const handleDeleteTrade = async (assetId, tradeId) => {
    try {
      await deleteTrade(tradeId);
      setAssets(p=>p.map(a=>a.id===assetId?{...a,trades:a.trades.filter(t=>t.id!==tradeId)}:a));
    } catch(e){ console.error(e); }
  };

  const reloadAssets = async () => {
    try { await loadPortfolio(); } catch(e){ console.error("reloadAssets error:",e); }
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
        const color = COLORS.find(c=>!usedColors.includes(c)) || "#B37CFF";
        const newAsset = {
          id:ticker, ticker, strategy:detectedStrategy, color,
          leapStrike:null, leapExpiration:null, leapCost:null, leapDelta:null,
          initialPrice:0, active:true, trades:[],
        };
        const ok = await addAssetSilent(newAsset);
        if(ok===false) { showToast(`Failed to create ${ticker} in the database.`,false); return; }
        assetId = ticker;
        await loadPortfolio();
      } else {
        assetId = existing.id;
      }
      const assignmentAsset = existing || {id:ticker,ticker,color:"#63E6BE",leaps:[],trades:[],strategy:detectedStrategy};
      const saved = await handleSaveTrade(assetId, {...trade, strategy: detectedStrategy}, {assignmentAsset});
      if(saved) {
        showToast(`Trade saved: ${ticker} ${trade.action} $${trade.strike}`);
        await reloadAssets();
      }
    } catch(e) {
      console.error("handleSaveManualTrade error:", e);
      showToast(`Error saving: ${e?.message||e?.code||String(e)}`,false);
    }
  };

  if(loading) return (
    <div style={{minHeight:"100vh",background:"#071019",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{CSS}</style>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"Syne,sans-serif",fontSize:28,fontWeight:800,color:"#fff",marginBottom:12}}>Option<span style={{color:"#63E6BE"}}>Desk</span></div>
        <div style={{fontSize:12,color:"#4A6A8A",letterSpacing:1}}>Loading your portfolio...</div>
      </div>
    </div>
  );

  const navigate = (id) => {
    window.location.hash = id;
    setActive(id);
  };
  const openSimulatorFromPlaybook = (playbookTitle) => {
    setSimulatorPreset(playbookTitle ? {title:playbookTitle,id:Date.now()} : null);
    navigate("home");
    window.setTimeout(()=>{
      document.getElementById("strategy-builder")?.scrollIntoView({behavior:"smooth",block:"start"});
    },120);
  };

  return (
    <div style={{minHeight:"100vh",background:"#071019",color:"#D6E2F0"}}>
      <style>{CSS}</style>
      <div className="hdr">
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div className="logo" onClick={()=>navigate("home")}>
            <img className="logo-mark" src="/optiondesk-logo.png" alt="" aria-hidden="true" />
            <span className="logo-lockup">
              <span className="logo-name">OptionDesk</span>
              <span className="beta-badge">Beta</span>
            </span>
          </div>
          {active!=="home"&&<button className="home-btn" onClick={()=>navigate("home")}>← HOME</button>}
        </div>
        <div style={{fontSize:11,color:"#4A6A8A"}}>{new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</div>
      </div>

      <div className="tabs">
        <button className={`tab ${active==="home"?"active":""}`} onClick={()=>navigate("home")} style={{"--tc":"#63E6BE"}}>⌂ HOME</button>
        {assets.filter(a=>a.active).map(a=>(
          <button key={a.id} className={`tab ${active===a.id?"active":""}`} onClick={()=>navigate(a.id)} style={{"--tc":a.color}}>{a.ticker}</button>
        ))}
        <button className="add-tab" onClick={()=>setShowAdd(true)} title="Add position">+</button>
        <div
          className={`learn-nav ${learnOpen?"open":""}`}
          onMouseEnter={()=>setLearnOpen(true)}
          onMouseLeave={()=>setLearnOpen(false)}
        >
          <button
            className={`tab learn-tab ${active.startsWith("learn")?"active":""}`}
            onClick={()=>{ setLearnOpen(false); navigate("learn"); }}
            style={{"--tc":"#63E6BE"}}
          >
            Learn <span className="learn-chevron">▼</span>
          </button>
          <div className="learn-menu">
            {LEARN_SECTIONS.map(section=>(
              <button
                key={section.id}
                className={active===section.id?"active":""}
                onClick={()=>{ setLearnOpen(false); navigate(section.id); }}
              >
                {section.title}
              </button>
            ))}
          </div>
        </div>
        {closedAssets.length>0&&(
          <button className={`tab ${active==="closed"?"active":""}`} onClick={()=>navigate("closed")} style={{"--tc":"#7D91AA"}}>Closed ({closedAssets.length})</button>
        )}
      </div>

      {active==="home"&&<Home assets={assetsWithStrategyLinks} strategies={strategies} onSelectAsset={id=>navigate(id)} onShowPositions={()=>setShowPositions(true)} onSaveManualTrade={handleSaveManualTrade} onEditTrade={r=>{const a=assetsWithStrategyLinks.find(x=>x.id===r.assetId);setEditTrade({r,asset:a});}} onDeleteTrade={handleDeleteTrade} onDeleteLeap={handleDeleteLeap} onOpenLearn={()=>navigate("learn-calculators")} onStartAdd={()=>setShowAdd(true)} simulatorPreset={simulatorPreset}/>}
      {active==="learn"&&<LearnPage onNavigate={navigate}/>}
      {active==="learn-courses"&&<LearnPlaceholderPage title="Courses" onNavigate={navigate}/>}
      {(active==="learn-playbooks"||active==="learn-playbook")&&<PlaybooksPage onNavigate={navigate} onOpenSimulator={openSimulatorFromPlaybook}/>}
      {active==="learn-glossary"&&<GlossaryPage onNavigate={navigate}/>}
      {active==="learn-calculators"&&<CalculatorsPage onNavigate={navigate}/>}
      {assetsWithStrategyLinks.filter(a=>a.active).map(a=>active===a.id&&(
        <AssetDashboard key={a.id} asset={a} onClose={closeAsset}
          strategies={strategies}
          onCreateStrategy={handleCreateStrategy}
          onChangeTradeStrategy={handleChangeTradeStrategy}
          onDetachTradeStrategy={handleDetachTradeStrategy}
          onSaveTrade={(t,o)=>handleSaveTrade(a.id,t,o)}
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
      {showPositions&&<AllPositionsModal assets={assetsWithStrategyLinks} strategies={strategies} onClose={()=>setShowPositions(false)}/>}
      {expiredPending.length>0&&<ExpirationAlertModal trades={expiredPending} onResolve={handleExpiredResolution}/>}
      {strategyPrompt&&(
        <StrategyAssignmentModal
          asset={strategyPrompt.asset}
          trade={strategyPrompt.trade}
          strategies={strategyPrompt.strategies||strategies}
          suggestions={strategyPrompt.suggestions||[]}
          onConfirm={closeStrategyPrompt}
          onClose={()=>closeStrategyPrompt({type:"cancel"})}
        />
      )}
      {duplicatePrompt&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&resolveDuplicatePrompt(false)}>
          <div className="fbox" style={{width:420,maxWidth:"94vw"}}>
            <div className="ftitle">Possible duplicate trade</div>
            <div style={{fontSize:12,color:"#8aaac8",lineHeight:1.6,marginBottom:14}}>
              A very similar trade already exists for {duplicatePrompt.asset?.ticker||"this asset"}. Review it before saving another copy.
            </div>
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:8,padding:12,marginBottom:14}}>
              {[
                ["Action", duplicatePrompt.trade.action],
                ["Type", duplicatePrompt.trade.option_type],
                ["Strike", `$${fmt(duplicatePrompt.trade.strike)}`],
                ["Expiration", duplicatePrompt.trade.expiration],
                ["Premium", `$${fmt(duplicatePrompt.trade.premium)}`],
                ["Contracts", duplicatePrompt.trade.contracts],
                ["Status", duplicatePrompt.trade.status],
              ].map(([label,value])=>(
                <div key={label} style={{display:"flex",justifyContent:"space-between",gap:12,fontSize:12,marginBottom:6}}>
                  <span style={{color:"#4A6A8A"}}>{label}</span>
                  <span style={{color:"#D6E2F0",textAlign:"right"}}>{value}</span>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button className="btn bneutral" onClick={()=>resolveDuplicatePrompt(false)}>Cancel</button>
              <button className="btn bwarn" onClick={()=>resolveDuplicatePrompt(true)}>Save anyway</button>
            </div>
          </div>
        </div>
      )}
      {closePrompt&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&resolveClosePrompt("cancel")}>
          <div className="fbox" style={{width:460,maxWidth:"94vw"}}>
            <div className="ftitle">Potential closing trade</div>
            <div style={{fontSize:12,color:"#8aaac8",lineHeight:1.6,marginBottom:14}}>
              This BUY matches an open SELL. Should this close the existing position?
            </div>
            <div style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:8,padding:12,marginBottom:14}}>
              {[
                ["Ticker", closePrompt.asset?.ticker||""],
                ["Option", `${closePrompt.trade.option_type} $${fmt(closePrompt.trade.strike)}`],
                ["Expiration", closePrompt.trade.expiration],
                ["BUY contracts", closePrompt.trade.contracts],
                ["Open SELL contracts", closePrompt.matches.reduce((s,t)=>s+parseInt(t.contracts||1),0)],
              ].map(([label,value])=>(
                <div key={label} style={{display:"flex",justifyContent:"space-between",gap:12,fontSize:12,marginBottom:6}}>
                  <span style={{color:"#4A6A8A"}}>{label}</span>
                  <span style={{color:"#D6E2F0",textAlign:"right"}}>{value}</span>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8}}>
              <button className="btn" onClick={()=>resolveClosePrompt("close")} style={{color:"#63E6BE",borderColor:"#63E6BE44",background:"#63E6BE15"}}>Close existing position</button>
              <button className="btn bneutral" onClick={()=>resolveClosePrompt("open")}>Save as new open BUY</button>
              <button className="btn bdanger" onClick={()=>resolveClosePrompt("cancel")}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <ClaudeChat assets={assets} onSaveTrade={handleSaveTrade} onUpdateTrade={handleUpdateTrade} onSaveLeap={handleSaveLeap} onAddAsset={addAssetSilent} onRefresh={reloadAssets}/>
      {editTrade&&(
        <UnifiedTradeModal
          title={`Edit · ${editTrade.r.ticker} ${editTrade.r.label}`}
          initial={editTrade.r}
          asset={editTrade.asset}
          isEdit={true}
          onSave={async(changes)=>{
            try{
              const wasLeap=editTrade.r.isLeap, nowLeap=changes.typeLabel==="LEAP";
              if(wasLeap&&nowLeap){
                await updateLeap(editTrade.r.id,{date:changes.date,strike:changes.strike,expiration:changes.expiration,cost:changes.premium,contracts:changes.contracts});
              } else if(wasLeap&&!nowLeap){
                if(!window.confirm("Convert this LEAP into a trade? This removes the LEAP record and creates a trade record.")) return;
                await deleteLeap(editTrade.r.id);
                await handleSaveTrade(editTrade.r.assetId,{date:changes.date,action:changes.action,option_type:changes.option_type,strike:changes.strike,expiration:changes.expiration,premium:changes.premium,contracts:changes.contracts,status:"open",positionEffect:"open",fees:changes.fees||0,notes:changes.notes||null,trade_group:changes.trade_group||null,strategy:changes.typeLabel});
              } else if(!wasLeap&&nowLeap){
                if(!window.confirm("Convert this trade into a LEAP? This removes the trade record and creates a LEAP record.")) return;
                await deleteTrade(editTrade.r.id);
                await addLeap(editTrade.r.assetId,{id:`${editTrade.r.assetId}_${Date.now()}`,date:changes.date,strike:changes.strike,expiration:changes.expiration,cost:changes.premium,contracts:changes.contracts});
              } else {
                await updateTrade(editTrade.r.id,{date:changes.date,action:changes.action,option_type:changes.option_type,strike:changes.strike,expiration:changes.expiration,premium:changes.premium,contracts:changes.contracts,status:changes.status||"open",fees:changes.fees??0,notes:changes.notes??null,trade_group:changes.trade_group??null});
              }
              await reloadAssets();
              showToast(`Position updated: ${editTrade.r.ticker}`);
              setEditTrade(null);
            }catch(e){
              console.error("edit save error:",e);
              showToast(`Save failed: ${e?.message||e?.code||String(e)}`,false);
            }
          }}
          onClose={()=>setEditTrade(null)}
        />
      )}
      {toast&&(
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          background:toast.ok?"#1D9E75":"#E24B4A",color:"#fff",borderRadius:8,padding:"12px 24px",
          fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:13,maxWidth:"90vw",boxShadow:"0 4px 20px rgba(0,0,0,0.5)",
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
          color: "#63E6BE",
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
      // Matching and quantity-aware closing are handled by onSaveTrade.

      // Save the new trade — auto-detect strategy from action+option_type if not set
      const detectedStrat = t.strategy || (
        t.action==="BUY"  && t.option_type==="put"  ? "Long Put"   :
        t.action==="SELL" && t.option_type==="call"  ? "Short Call" :
        t.action==="SELL" && t.option_type==="put"   ? "Short Put"  : "Long Call"
      );
      const savedTrade = await onSaveTrade(assetId, {
        date:fixedDate, action:t.action, strike:t.strike,
        expiration:fixedExp, premium:normalizedPremium,
        contracts:t.contracts||1, status: t.status||"open",
        option_type: t.option_type||"call", strategy: detectedStrat,
      });
      if(savedTrade){
        closed += savedTrade.closedCount || 0;
        saved++;
      }
    }

    setLoading(false);
    let msg = `✅ ${saved} trade${saved>1?"s":""} saved!`;
    if(closed>0) msg += ` ${closed} contract${closed>1?"s":""} adjusted.`;
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
        borderRadius:"50%",background:"linear-gradient(135deg,#63E6BE,#5B8CFF)",
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
          background:"#0B131D",border:"1px solid #1B2A3A",borderRadius:12,
          boxShadow:"0 20px 60px rgba(0,0,0,0.6)",zIndex:300,
          display:"flex",flexDirection:"column",overflow:"hidden",
        }}>
          {/* Header */}
          <div style={{padding:"12px 16px",borderBottom:"1px solid #1B2A3A",display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:"#63E6BE",animation:"pulse 1.8s infinite"}}/>
            <div style={{fontFamily:"Syne,sans-serif",fontWeight:700,fontSize:14,color:"#fff"}}>Claude</div>
            <div style={{fontSize:11,color:"#4A6A8A"}}>trade assistant</div>
          </div>

          {/* Messages */}
          <div style={{flex:1,overflowY:"auto",padding:12,display:"flex",flexDirection:"column",gap:8}}>
            {messages.map((m,i)=>(
              <div key={i} style={{
                display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",
              }}>
                <div style={{
                  maxWidth:"85%",padding:"8px 12px",borderRadius:10,fontSize:12,lineHeight:1.5,
                  background:m.role==="user"?"#63E6BE20":"#1B2A3A",
                  color:m.role==="user"?"#63E6BE":"#D6E2F0",
                  border:`1px solid ${m.role==="user"?"#63E6BE44":"#2a3a4a"}`,
                  whiteSpace:"pre-wrap",
                }}>{typeof m.content==="string"?m.content:"📸 Image sent"}</div>
              </div>
            ))}
            {loading&&(
              <div style={{display:"flex",justifyContent:"flex-start"}}>
                <div style={{padding:"8px 12px",borderRadius:10,background:"#1B2A3A",border:"1px solid #2a3a4a",fontSize:12,color:"#7D91AA"}}>
                  thinking...
                </div>
              </div>
            )}
            {pendingTrades.length>0&&!missingField&&(
              <div style={{background:"#071019",border:"1px solid #63E6BE33",borderRadius:8,padding:10}}>
                <div style={{fontSize:10,letterSpacing:2,color:"#7D91AA",textTransform:"uppercase",marginBottom:8}}>Review & edit before saving</div>
                {pendingTrades.map((t,i)=>(
                  <div key={i} style={{background:"#071019",border:"1px solid #1B2A3A",borderRadius:6,padding:8,marginBottom:8}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
                      <div>
                        <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>ASSET</div>
                        <input style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#fff",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.asset_id||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],asset_id:e.target.value.toUpperCase()};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>ACTION</div>
                        <select style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:t.action==="SELL"?"#63E6BE":"#FF4D6D",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none"}}
                          value={t.action||"SELL"} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],action:e.target.value};setPendingTrades(v);}}>
                          <option value="SELL">SELL</option>
                          <option value="BUY">BUY</option>
                        </select>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>STRIKE</div>
                        <input type="number" style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#FFD84D",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.strike||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],strike:e.target.value};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>EXPIRATION</div>
                        <input style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          placeholder="YYYY-MM-DD" value={t.expiration||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],expiration:e.target.value};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>PRICE/SHARE ($)</div>
                        <input type="number" style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#63E6BE",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.premium||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],premium:e.target.value};setPendingTrades(v);}}/>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>CONTRACTS</div>
                        <input type="number" style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#8aaac8",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none",boxSizing:"border-box"}}
                          value={t.contracts||1} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],contracts:e.target.value};setPendingTrades(v);}}/>
                      </div>
                    </div>
                    <div style={{marginTop:6}}>
                      <div style={{fontSize:9,color:"#7D91AA",marginBottom:2}}>STRATEGY</div>
                      <select style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#B37CFF",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:11,padding:"4px 8px",borderRadius:4,outline:"none"}}
                        value={t.strategy||""} onChange={e=>{const v=[...pendingTrades];v[i]={...v[i],strategy:e.target.value};setPendingTrades(v);}}>
                        <option value="">— Auto-detect —</option>
                        {SIM_STRATEGIES.map(s=><option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div style={{fontSize:10,color:"#7D91AA",textAlign:"right",marginTop:6}}>
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
              <div style={{background:"#FFD84D10",border:"1px solid #FFD84D33",borderRadius:8,padding:10}}>
                <div style={{fontSize:11,color:"#FFD84D",marginBottom:8}}>⚠️ Missing: {missingField}</div>
                <input
                  style={{width:"100%",background:"#071019",border:"1px solid #1B2A3A",color:"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:12,padding:"6px 10px",borderRadius:6,outline:"none",marginBottom:8}}
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
          <div style={{padding:"10px 12px",borderTop:"1px solid #1B2A3A",display:"flex",gap:8,alignItems:"center"}}>
            <button className="btn bsm bneutral" onClick={handleFileClick} title="Upload photo">📸</button>
            <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleFile}/>
            <input
              style={{flex:1,background:"#071019",border:"1px solid #1B2A3A",color:"#D6E2F0",fontFamily:"IBM Plex Mono,DM Mono,monospace",fontSize:12,padding:"6px 10px",borderRadius:6,outline:"none"}}
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

export {
  assetIncomeGeneratedDollars,
  isThetaShortCallTrade,
  thetaEngineCashDollars,
};
export default App;

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

// ── Assets ────────────────────────────────────────────────────────────────────
export async function fetchAssets() {
  const { data, error } = await supabase
    .from('assets')
    .select('*, leaps(*), trades(*)')
    .eq('active', true)
    .order('created_at');
  if (error) throw error;
  return data.map(a => ({
    ...a,
    id: a.id,
    ticker: a.ticker,
    strategy: a.strategy,
    color: a.color,
    leapStrike: a.leap_strike,
    leapExpiration: a.leap_expiration,
    leapDelta: a.leap_delta,
    initialPrice: a.initial_price,
    active: a.active,
    leaps: (a.leaps||[]).map(l => ({
      id: l.id,
      date: l.date,
      strike: l.strike,
      expiration: l.expiration,
      cost: l.cost,
      contracts: l.contracts,
    })),
    trades: (a.trades||[]).map(t => ({
      id:          t.id,
      date:        t.date,
      action:      t.action,
      strike:      t.strike,
      expiration:  t.expiration,
      premium:     t.premium,
      contracts:   t.contracts,
      status:      t.status,
      option_type: t.option_type  ?? null,
      fees:        t.fees         ?? 0,
      notes:       t.notes        ?? null,
      tags:        t.tags         ?? null,
      trade_group: t.trade_group  ?? null,
      strategy:    t.strategy     ?? null,
    })),
  }));
}

export async function addAsset(asset) {
  const { data, error } = await supabase.from('assets').upsert({
    id: asset.id,
    ticker: asset.ticker,
    strategy: asset.strategy,
    color: asset.color,
    leap_strike: asset.leapStrike,
    leap_expiration: asset.leapExpiration,
    leap_delta: asset.leapDelta,
    initial_price: asset.initialPrice || 0,
    active: true,
  }, {onConflict: 'id'}).select().single();
  if (error) throw error;
  return data;
}

export async function addLeap(assetId, leap) {
  const { data, error } = await supabase.from('leaps').insert({
    id: leap.id || `${assetId}_${Date.now()}`,
    asset_id: assetId,
    date: leap.date,
    strike: leap.strike,
    expiration: leap.expiration,
    cost: leap.cost,
    contracts: leap.contracts,
  }).select().single();
  if (error) throw error;
  return data;
}

// Builds the core payload (always works with the existing schema).
function coreTradePayload(assetId, trade) {
  return {
    asset_id:   assetId,
    date:       trade.date,
    action:     trade.action,
    strike:     trade.strike,
    expiration: trade.expiration,
    premium:    trade.premium,
    contracts:  trade.contracts,
    status:     trade.status,
  };
}

// Builds the extended payload (requires the migration below to have been run).
function extendedTradePayload(assetId, trade) {
  return {
    ...coreTradePayload(assetId, trade),
    option_type: trade.option_type ?? null,
    fees:        trade.fees        ?? 0,
    notes:       trade.notes       ?? null,
    tags:        trade.tags        ?? null,
    trade_group: trade.tradeGroup  ?? null,
    strategy:    trade.strategy    ?? null,
  };
}

const HAS_EXTENDED_COLUMNS_KEY = '__trades_extended_ok';
let _extendedColumnsKnown = sessionStorage.getItem(HAS_EXTENDED_COLUMNS_KEY) === '1' ? true
  : sessionStorage.getItem(HAS_EXTENDED_COLUMNS_KEY) === '0' ? false : null;

export async function addTrade(assetId, trade) {
  // Only attempt extended payload when the trade carries extra fields.
  const hasExtended = trade.option_type !== undefined || trade.fees !== undefined
    || trade.notes !== undefined || trade.tags !== undefined
    || trade.tradeGroup !== undefined || trade.strategy !== undefined;

  if (hasExtended && _extendedColumnsKnown !== false) {
    const { data, error } = await supabase
      .from('trades').insert(extendedTradePayload(assetId, trade)).select().single();

    if (!error) {
      _extendedColumnsKnown = true;
      sessionStorage.setItem(HAS_EXTENDED_COLUMNS_KEY, '1');
      return { ...trade, id: data.id };
    }
    // 42703 = undefined_column in PostgreSQL; migration not yet applied.
    if (error.code === '42703' || error.message?.toLowerCase().includes('column')) {
      _extendedColumnsKnown = false;
      sessionStorage.setItem(HAS_EXTENDED_COLUMNS_KEY, '0');
      // Fall through to core insert below.
    } else {
      throw error;
    }
  }

  const { data, error } = await supabase
    .from('trades').insert(coreTradePayload(assetId, trade)).select().single();
  if (error) throw error;
  return { ...trade, id: data.id };
}

export async function updateTrade(id, changes) {
  const { error } = await supabase.from('trades').update(changes).eq('id', id);
  if (error) throw error;
}

export async function deleteTrade(id) {
  const { error } = await supabase.from('trades').delete().eq('id', id);
  if (error) throw error;
}

export async function deleteLeap(id) {
  const { error } = await supabase.from('leaps').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchOpenTrades(assetId) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .eq('asset_id', assetId)
    .eq('status', 'open');
  if (error) throw error;
  return data;
}

export async function closeAsset(id) {
  const { error } = await supabase.from('assets').update({ active: false }).eq('id', id);
  if (error) throw error;
}

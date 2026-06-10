import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

const missingSupabaseEnv = !supabaseUrl || !supabaseKey;

export const supabase = missingSupabaseEnv
  ? null
  : createClient(supabaseUrl, supabaseKey);

function requireSupabase() {
  if (!supabase) {
    throw new Error("Missing Supabase environment variables. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.");
  }
  return supabase;
}

// ── Assets ────────────────────────────────────────────────────────────────────
export async function fetchAssets() {
  const { data, error } = await requireSupabase()
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
  const { data, error } = await requireSupabase().from('assets').upsert({
    id: asset.id,
    ticker: asset.ticker,
    strategy: asset.strategy || null,
    color: asset.color,
    leap_strike: asset.leapStrike || null,
    leap_expiration: asset.leapExpiration || null,   // empty string → null (DATE column)
    leap_delta: asset.leapDelta || null,
    initial_price: asset.initialPrice || 0,
    active: true,
  }, {onConflict: 'id'}).select().single();
  if (error) throw error;
  return data;
}

export async function addLeap(assetId, leap) {
  const { data, error } = await requireSupabase().from('leaps').insert({
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
    trade_group: trade.trade_group ?? trade.tradeGroup ?? null,
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
    const { data, error } = await requireSupabase()
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

  const { data, error } = await requireSupabase()
    .from('trades').insert(coreTradePayload(assetId, trade)).select().single();
  if (error) throw error;
  return { ...trade, id: data.id };
}

export async function updateTrade(id, changes) {
  const { error } = await requireSupabase().from('trades').update(changes).eq('id', id);
  if (!error) return;
  if (error.code === '42703' || error.message?.toLowerCase().includes('column')) {
    // Extended columns missing — retry with only core columns
    const {option_type, fees, notes, tags, trade_group, strategy, ...core} = changes;
    const { error: e2 } = await requireSupabase().from('trades').update(core).eq('id', id);
    if (e2) throw e2;
  } else {
    throw error;
  }
}

export async function deleteTrade(id) {
  const { error } = await requireSupabase().from('trades').delete().eq('id', id);
  if (error) throw error;
}

export async function updateLeap(id, changes) {
  const { error } = await requireSupabase().from('leaps').update(changes).eq('id', id);
  if (error) throw error;
}

export async function deleteLeap(id) {
  const { error } = await requireSupabase().from('leaps').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchOpenTrades(assetId) {
  const { data, error } = await requireSupabase()
    .from('trades')
    .select('*')
    .eq('asset_id', assetId)
    .eq('status', 'open');
  if (error) throw error;
  return data;
}

export async function closeAsset(id) {
  const { error } = await requireSupabase().from('assets').update({ active: false }).eq('id', id);
  if (error) throw error;
}

export async function fetchStrategies() {
  const { data, error } = await requireSupabase()
    .from('strategies')
    .select('*, trade_strategy_links(*)')
    .order('created_at', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST200' || error.message?.toLowerCase().includes('strategies')) {
      return [];
    }
    throw error;
  }
  return (data||[]).map(s => ({
    id: s.id,
    user_id: s.user_id,
    asset_id: s.asset_id,
    ticker: s.ticker,
    name: s.name,
    strategy_type: s.strategy_type,
    status: s.status,
    notes: s.notes,
    created_at: s.created_at,
    updated_at: s.updated_at,
    links: (s.trade_strategy_links||[]).map(l => ({
      id: l.id,
      trade_id: l.trade_id,
      strategy_id: l.strategy_id,
      assignment_status: l.assignment_status,
      assigned_at: l.assigned_at,
      detached_at: l.detached_at,
    })),
  }));
}

export async function createStrategy(strategy) {
  const { data, error } = await requireSupabase()
    .from('strategies')
    .insert({
      asset_id: strategy.asset_id || null,
      ticker: (strategy.ticker || '').toUpperCase(),
      name: strategy.name,
      strategy_type: strategy.strategy_type,
      status: strategy.status || 'open',
      notes: strategy.notes || null,
    })
    .select()
    .single();
  if (error) throw error;
  return { ...data, links: [] };
}

export async function linkTradeToStrategy(tradeId, strategyId) {
  const { data, error } = await requireSupabase()
    .from('trade_strategy_links')
    .insert({
      trade_id: tradeId,
      strategy_id: strategyId,
      assignment_status: 'confirmed',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function detachTradeFromStrategy(tradeId) {
  const { data, error } = await requireSupabase()
    .from('trade_strategy_links')
    .update({
      assignment_status: 'detached',
      detached_at: new Date().toISOString(),
    })
    .eq('trade_id', tradeId)
    .eq('assignment_status', 'confirmed')
    .is('detached_at', null)
    .select();
  if (error) throw error;
  return data || [];
}

export async function moveTradeToStrategy(tradeId, strategyId) {
  await detachTradeFromStrategy(tradeId);
  return linkTradeToStrategy(tradeId, strategyId);
}

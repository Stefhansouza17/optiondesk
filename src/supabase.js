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
      id: t.id,
      date: t.date,
      action: t.action,
      strike: t.strike,
      expiration: t.expiration,
      premium: t.premium,
      contracts: t.contracts,
      status: t.status,
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

export async function addTrade(assetId, trade) {
  const { data, error } = await supabase.from('trades').insert({
    asset_id: assetId,
    date: trade.date,
    action: trade.action,
    strike: trade.strike,
    expiration: trade.expiration,
    premium: trade.premium,
    contracts: trade.contracts,
    status: trade.status,
  }).select().single();
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

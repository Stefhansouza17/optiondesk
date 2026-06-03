export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        system: `You are a trading assistant for OptionDesk, a PMCC options dashboard. Your job is to extract trade information from user messages or images and return structured JSON. When the user describes a trade or sends a confirmation image, extract: asset_id, date (YYYY-MM-DD), action (BUY or SELL), strike, expiration (YYYY-MM-DD), premium (per share), contracts, status (open or closed). Always respond with JSON only: {"trades":[{"asset_id":"IBIT","date":"2026-06-03","action":"SELL","strike":42.0,"expiration":"2026-06-06","premium":0.45,"contracts":1,"status":"open"}],"message":"Found 1 trade"}. If no trade found: {"trades":[],"message":"Could not identify trades."}`,
        messages,
      }),
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;

  try {
    // Fix image content format for Anthropic API
    const formattedMessages = messages.map(m => {
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map(c => {
            if (c.type === 'image') {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: c.source?.media_type || 'image/jpeg',
                  data: c.source?.data || c.data,
                }
              };
            }
            return c;
          })
        };
      }
      return m;
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: `You are a trading assistant for OptionDesk, a PMCC options dashboard. Your job is to extract trade information from user messages or images and return structured JSON. When the user describes a trade or sends a confirmation image, extract: asset_id (ticker symbol), date (YYYY-MM-DD), action (BUY or SELL — BTC means BUY, STO means SELL), strike (number), expiration (YYYY-MM-DD), premium (per share as decimal — if given as dollar amount divide by 100), contracts (number), status (open if STO, closed if BTC). Always respond with JSON only, no markdown: {"trades":[{"asset_id":"IBIT","date":"2026-06-03","action":"SELL","strike":42.0,"expiration":"2026-06-06","premium":0.45,"contracts":1,"status":"open"}],"message":"Found 1 trade: SELL IBIT $42 Call exp 06/06 @ $0.45"}. If no trade found: {"trades":[],"message":"Could not identify any trades. Please send a clearer image or describe the trade."}`,
        messages: formattedMessages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(200).json({ error: data.error?.message || JSON.stringify(data.error) });
    }
    res.status(200).json(data);
  } catch (error) {
    res.status(200).json({ error: error.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;
  const currentYear = new Date().getFullYear();

  try {
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
        system: `You are a trading assistant for OptionDesk. Current year is ${currentYear}.

Extract trade information from messages or images and return JSON only.

ACTION AND STATUS RULES — read carefully from the confirmation:
- STO (Sell to Open) → action: "SELL", status: "open"
- BTC (Buy to Close) → action: "BUY", status: "closed"  
- BTO (Buy to Open) → action: "BUY", status: "open"
- STC (Sell to Close) → action: "SELL", status: "closed"
- If "Position effect: Open" → status: "open"
- If "Position effect: Close" → status: "closed"

PREMIUM RULES:
- Premium must be PER SHARE (per unit), not per contract
- If confirmation shows total cost like "$45.00" for 1 contract → premium = 0.45
- If confirmation shows "$0.45" already → premium = 0.45
- Never return premium > 5 for standard options

DATE RULES:
- Always use year ${currentYear} unless clearly a future expiration
- Never use past years for trade date
- If expiration not visible → set to "unknown"

Return JSON only, no markdown:
{
  "trades": [
    {
      "asset_id": "IBIT",
      "date": "${currentYear}-06-03",
      "action": "SELL",
      "strike": 42.0,
      "expiration": "${currentYear}-06-06",
      "premium": 0.45,
      "contracts": 1,
      "status": "open"
    }
  ],
  "message": "Found 1 trade: SELL to Open IBIT $42 Call exp 06/06 @ $0.45"
}

If no trade found: {"trades":[],"message":"Could not identify any trades. Please send a clearer image."}`,
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

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
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: `You are a trading assistant for OptionDesk, a PMCC options dashboard.
Your job is to extract trade information from user messages or images and return structured JSON.

When the user describes a trade or sends a confirmation image, extract:
- asset_id: ticker symbol (e.g. "IBIT", "EWZ")
- date: trade date in YYYY-MM-DD format
- action: "BUY" or "SELL" (BTC = BUY, STO = SELL)
- strike: strike price as number
- expiration: expiration date in YYYY-MM-DD format
- premium: premium per share as number (divide by 100 if given as dollar amount per contract)
- contracts: number of contracts
- status: "open" if STO/new position, "closed" if BTC/closing position

Always respond with JSON only, no extra text:
{
  "trades": [
    {
      "asset_id": "IBIT",
      "date": "2026-06-03",
      "action": "SELL",
      "strike": 42.0,
      "expiration": "2026-06-06",
      "premium": 0.45,
      "contracts": 1,
      "status": "open"
    }
  ],
  "message": "Found 1 trade: SELL IBIT $42 Call exp 06/06 @ $0.45"
}

If you cannot identify a trade, return:
{ "trades": [], "message": "I couldn't identify any trades. Please describe the trade or send a clearer image." }`,
        messages,
      }),
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

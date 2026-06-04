export default async function handler(req, res) { 
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { endpoint, ...params } = req.query;
  const queryString = new URLSearchParams(params).toString();
  const url = `https://api.tradier.com/v1/${endpoint}?${queryString}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.TRADIER_TOKEN}`, Accept: 'application/json' },
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

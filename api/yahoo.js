const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
let yahooSession;

const cleanSymbol = (value) => {
  const symbol = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9.^=-]{1,20}$/.test(symbol) ? symbol : null;
};

const toDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

async function getYahooSession(forceRefresh = false) {
  if (yahooSession && !forceRefresh && yahooSession.expiresAt > Date.now()) return yahooSession;

  const cookieResponse = await fetch("https://fc.yahoo.com", {
    redirect: "manual",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OptionDesk/1.0)" },
  });
  const rawCookie = cookieResponse.headers.get("set-cookie") || "";
  const cookie = rawCookie.split(";")[0];
  if (!cookie) throw new Error("Yahoo session cookie was not issued");

  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0 (compatible; OptionDesk/1.0)" },
  });
  if (!crumbResponse.ok) throw new Error(`Yahoo authentication returned ${crumbResponse.status}`);
  const crumb = (await crumbResponse.text()).trim();
  if (!crumb) throw new Error("Yahoo authentication token was empty");

  yahooSession = { cookie, crumb, expiresAt: Date.now() + 30 * 60 * 1000 };
  return yahooSession;
}

async function yahooJson(path, retryAuth = true) {
  const session = await getYahooSession();
  const separator = path.includes("?") ? "&" : "?";
  const authenticatedPath = `${path}${separator}crumb=${encodeURIComponent(session.crumb)}`;
  let lastError;
  for (const host of YAHOO_HOSTS) {
    try {
      const response = await fetch(`${host}${authenticatedPath}`, {
        headers: {
          Accept: "application/json",
          Cookie: session.cookie,
          "User-Agent": "Mozilla/5.0 (compatible; OptionDesk/1.0)",
        },
      });
      if (response.status === 401 && retryAuth) {
        await getYahooSession(true);
        return yahooJson(path, false);
      }
      if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Yahoo Finance is unavailable");
}

function normCdf(x) {
  const p = 0.2316419;
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const pdf = Math.exp(-0.5 * absX * absX) / Math.sqrt(2 * Math.PI);
  const approx = 1 - pdf * (b1 * t + b2 * t ** 2 + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);
  return x >= 0 ? approx : 1 - approx;
}

function greeks({ spot, strike, expiration, iv, type }) {
  const sigma = Number(iv);
  const s = Number(spot);
  const k = Number(strike);
  const years = Math.max((Number(expiration) * 1000 - Date.now()) / (365.25 * 86400000), 1 / 365.25);
  if (!(s > 0 && k > 0 && sigma > 0)) return null;

  // A modest risk-free-rate assumption; Yahoo does not include a curve in option-chain responses.
  const rate = 0.045;
  const rootT = Math.sqrt(years);
  const d1 = (Math.log(s / k) + (rate + sigma * sigma / 2) * years) / (sigma * rootT);
  const d2 = d1 - sigma * rootT;
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const delta = type === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (s * sigma * rootT);
  const commonTheta = -(s * pdf * sigma) / (2 * rootT);
  const thetaAnnual = type === "call"
    ? commonTheta - rate * k * Math.exp(-rate * years) * normCdf(d2)
    : commonTheta + rate * k * Math.exp(-rate * years) * normCdf(-d2);

  return {
    smv_vol: sigma,
    delta,
    gamma,
    theta: thetaAnnual / 365.25,
    vega: (s * pdf * rootT) / 100,
  };
}

function normalizeContract(contract, type, spot) {
  const iv = Number(contract.impliedVolatility) || 0;
  return {
    symbol: contract.contractSymbol,
    description: contract.contractSymbol,
    option_type: type,
    strike: Number(contract.strike) || 0,
    expiration_date: toDate(contract.expiration),
    last: Number(contract.lastPrice) || 0,
    bid: Number(contract.bid) || 0,
    ask: Number(contract.ask) || 0,
    volume: Number(contract.volume) || 0,
    open_interest: Number(contract.openInterest) || 0,
    greeks: greeks({ spot, strike: contract.strike, expiration: contract.expiration, iv, type }),
  };
}

async function optionResult(symbol, expiration) {
  const dateQuery = expiration ? `?date=${Math.floor(Date.parse(`${expiration}T00:00:00Z`) / 1000)}` : "";
  const data = await yahooJson(`/v7/finance/options/${encodeURIComponent(symbol)}${dateQuery}`);
  const result = data?.optionChain?.result?.[0];
  if (!result) throw new Error(`No Yahoo Finance data found for ${symbol}`);
  return result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const action = String(req.query.action || "");
    if (action === "search") {
      const query = String(req.query.q || "").trim().slice(0, 50);
      if (!query) return res.status(200).json({ results: [] });
      const data = await yahooJson(`/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`);
      const results = (data?.quotes || [])
        .filter((item) => ["EQUITY", "ETF", "INDEX"].includes(item.quoteType))
        .map((item) => ({
          symbol: item.symbol,
          description: item.longname || item.shortname || "",
          type: item.quoteType,
        }));
      return res.status(200).json({ results });
    }

    const symbol = cleanSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ error: "Invalid symbol" });
    const result = await optionResult(symbol, action === "chain" ? req.query.expiration : null);

    if (action === "quote") {
      const quote = result.quote || {};
      return res.status(200).json({
        quote: {
          symbol,
          description: quote.longName || quote.shortName || symbol,
          last: Number(quote.regularMarketPrice) || 0,
          bid: Number(quote.bid) || 0,
          ask: Number(quote.ask) || 0,
          change: Number(quote.regularMarketChange) || 0,
          change_percentage: Number(quote.regularMarketChangePercent) || 0,
        },
      });
    }

    if (action === "expirations") {
      return res.status(200).json({ expirations: (result.expirationDates || []).map(toDate) });
    }

    if (action === "chain") {
      const spot = Number(result.quote?.regularMarketPrice) || 0;
      const options = result.options?.[0] || {};
      const contracts = [
        ...(options.calls || []).map((item) => normalizeContract(item, "call", spot)),
        ...(options.puts || []).map((item) => normalizeContract(item, "put", spot)),
      ];
      return res.status(200).json({ options: contracts });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Yahoo Finance request failed" });
  }
}

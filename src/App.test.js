import {
  assetIncomeGeneratedDollars,
  isThetaShortCallTrade,
  realizedOptionPnLDollars,
  thetaEngineCashDollars,
} from "./App";

const ibitLeaps = [
  {
    id: "IBIT_LEAP_1",
    date: "2026-01-15",
    strike: 40,
    expiration: "2027-12-17",
    contracts: 2,
  },
];

const shortCall = {
  id: 1,
  date: "2026-02-02",
  action: "SELL",
  option_type: "call",
  strike: 60,
  expiration: "2026-03-20",
  premium: 1,
  contracts: 1,
  status: "open",
  strategy: "Covered Call",
};

describe("Theta Engine eligibility", () => {
  test("includes an IBIT short call opened after an IBIT LEAP", () => {
    expect(isThetaShortCallTrade(shortCall, ibitLeaps)).toBe(true);
    expect(thetaEngineCashDollars([shortCall], ibitLeaps)).toBe(100);
  });

  test("excludes a short call when that asset has no LEAP", () => {
    expect(isThetaShortCallTrade(shortCall, [])).toBe(false);
    expect(thetaEngineCashDollars([shortCall], [])).toBe(0);
  });

  test("excludes calls opened before the LEAP purchase", () => {
    const beforeLeap = {...shortCall, date:"2026-01-10"};
    expect(isThetaShortCallTrade(beforeLeap, ibitLeaps)).toBe(false);
  });

  test("excludes calls expiring after the backing LEAP", () => {
    const laterExpiration = {...shortCall, expiration:"2028-01-21"};
    expect(isThetaShortCallTrade(laterExpiration, ibitLeaps)).toBe(false);
  });

  test("excludes the sale that closes the LEAP itself", () => {
    const leapClose = {
      ...shortCall,
      strike:40,
      expiration:"2027-12-17",
      status:"closed",
      strategy:"LEAP_CLOSE",
    };
    expect(isThetaShortCallTrade(leapClose, ibitLeaps)).toBe(false);
  });
});

describe("asset income", () => {
  test("keeps an EWZ short-call credit in EWZ income without adding it to Theta", () => {
    expect(assetIncomeGeneratedDollars([shortCall])).toBe(100);
    expect(thetaEngineCashDollars([shortCall], [])).toBe(0);
  });

  test("uses only registered short-premium cycles and removes deleted trades", () => {
    const closedShortCall = {...shortCall,status:"closed"};
    const buy = {
      ...shortCall,
      id:2,
      action:"BUY",
      premium:0.4,
      status:"closed",
    };
    expect(assetIncomeGeneratedDollars([closedShortCall, buy])).toBe(60);
    expect(assetIncomeGeneratedDollars([shortCall])).toBe(100);
    expect(assetIncomeGeneratedDollars([{...buy,status:"open"}])).toBe(0);
    expect(assetIncomeGeneratedDollars([buy])).toBe(0);
    expect(assetIncomeGeneratedDollars([closedShortCall])).toBe(0);
    expect(assetIncomeGeneratedDollars([])).toBe(0);
  });

  test("keeps IBIT income positive when valid cycles total $539", () => {
    const cycleCash = [
      [32,2],[23,44],[66,2],[30,3],[68,10],[34,4],[66,124],
      [190,22],[52,57],[124,278],[294,534],[566,364],[386,170],[194,44],
    ];
    const cycles = cycleCash.flatMap(([credit,debit],index)=>{
      const strike = 30+index;
      const expiration = `2026-03-${String(index+1).padStart(2,"0")}`;
      return [
        {...shortCall,id:`sell-${index}`,date:"2026-01-01",strike,expiration,premium:credit/100,status:"closed"},
        {...shortCall,id:`buy-${index}`,date:"2026-01-02",action:"BUY",strike,expiration,premium:debit/100,status:"closed"},
      ];
    });
    const openCredit = {...shortCall,id:"open",premium:0.72,status:"open"};
    const orphanBuy = {...shortCall,id:"orphan-buy",action:"BUY",premium:9,status:"closed",strike:99};
    const orphanSellToClose = {...shortCall,id:"orphan-sell",premium:9,status:"closed",strike:98};
    expect(assetIncomeGeneratedDollars([...cycles,openCredit,orphanBuy,orphanSellToClose])).toBe(539);
  });

  test("counts only realized LEAP profit or loss after both legs are registered", () => {
    const leapOpen = {
      date:"2026-01-15",
      action:"BUY",
      option_type:"call",
      strike:40,
      expiration:"2027-12-17",
      premium:10,
      contracts:1,
      status:"closed",
      strategy:"LEAP_OPEN",
    };
    const leapClose = {
      ...leapOpen,
      date:"2026-07-02",
      action:"SELL",
      premium:12,
      strategy:"LEAP_CLOSE",
    };
    expect(assetIncomeGeneratedDollars([leapOpen])).toBe(0);
    expect(assetIncomeGeneratedDollars([leapClose])).toBe(0);
    expect(assetIncomeGeneratedDollars([leapOpen, leapClose])).toBe(200);
    expect(assetIncomeGeneratedDollars([leapOpen, {...leapClose,premium:8}])).toBe(-200);
  });
});

describe("one-for-one lifecycle accounting", () => {
  const contract = {
    option_type:"call",
    strike:60,
    expiration:"2026-08-21",
    contracts:1,
  };

  test("BUY closes an open SELL and realizes the short-call P/L", () => {
    const trades = [
      {...contract,date:"2026-07-01",action:"SELL",premium:2,status:"closed"},
      {...contract,date:"2026-07-02",action:"BUY",premium:0.75,status:"closed"},
    ];
    expect(realizedOptionPnLDollars(trades)).toBe(125);
  });

  test("SELL closes an open BUY and realizes the long-call P/L", () => {
    const trades = [
      {...contract,date:"2026-07-01",action:"BUY",premium:1.25,status:"closed"},
      {...contract,date:"2026-07-02",action:"SELL",premium:2,status:"closed"},
    ];
    expect(realizedOptionPnLDollars(trades)).toBe(75);
  });

  test("an oversized close realizes only the matched contract and keeps excess open", () => {
    const trades = [
      {...contract,date:"2026-07-01",action:"SELL",premium:2,status:"closed"},
      {...contract,date:"2026-07-02",action:"BUY",premium:0.75,status:"closed"},
      {...contract,date:"2026-07-02",action:"BUY",premium:0.75,status:"open"},
    ];
    expect(realizedOptionPnLDollars(trades)).toBe(125);
  });
});

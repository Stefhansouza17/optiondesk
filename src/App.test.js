import {
  assetIncomeGeneratedDollars,
  isThetaShortCallTrade,
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

  test("equals the signed cash value of the trades that remain registered", () => {
    const buy = {
      ...shortCall,
      id:2,
      action:"BUY",
      premium:0.4,
      status:"closed",
    };
    expect(assetIncomeGeneratedDollars([shortCall, buy])).toBe(60);
    expect(assetIncomeGeneratedDollars([shortCall])).toBe(100);
    expect(assetIncomeGeneratedDollars([{...buy,status:"open"}])).toBe(0);
    expect(assetIncomeGeneratedDollars([])).toBe(0);
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

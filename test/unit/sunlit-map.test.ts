import { expect } from "chai";

import {
  batteries,
  batteryEta,
  deviceArray,
  buckets,
  dayCurve,
  liveValues,
  num,
  periodTotals,
  solarFromBattery,
} from "../../src/lib/sunlit-map";

describe("sunlit-map", () => {
  it("reads numbers tolerant", () => {
    expect(num(5)).to.equal(5);
    expect(num("7.5")).to.equal(7.5);
    expect(num("")).to.equal(null);
    expect(num(null)).to.equal(null);
    expect(num("x")).to.equal(null);
  });

  it("sums the MPPT inputs of head unit and modules", () => {
    expect(
      solarFromBattery({
        batteryMppt1InPower: 120,
        batteryMppt2InPower: 80,
        battery2Mppt1InPower: 50,
        batterySoc: 40,
      }),
    ).to.equal(250);
    expect(solarFromBattery({ batterySoc: 40 })).to.equal(null);
  });

  it("maps the space index and battery statistics", () => {
    const v = liveValues(
      {
        today: { yield: 3.2, homePower: 410, currency: "EUR" },
        eleMeter: { totalAcPower: -35 },
        inverter: { currentPower: 380 },
        battery: {
          batteryLevel: 64,
          inputPower: 0,
          outputPower: 380,
          dischargingRemaining: 4,
          batteryCount: 2,
          deviceStatus: "Online",
        },
      },
      { batteryMppt1InPower: 0, batteryMppt2InPower: 0 },
    );
    expect(v).to.include({
      soc: 64,
      batteryChargeW: 0,
      batteryDischargeW: 380,
      batteryW: -380,
      solarW: 0,
      inverterW: 380,
      meterW: -35,
      homeW: 410,
      dischargeRemainingMin: 240,
      todaySolarKwh: 3.2,
      batteryModules: 2,
      batteryStatus: "Online",
      batteryFault: false,
    });
  });

  it("falls back to the device fields and returns null for missing values", () => {
    const v = liveValues({}, { batterySoc: 55, inputPowerTotal: 300 });
    expect(v.soc).to.equal(55);
    expect(v.batteryW).to.equal(300);
    expect(v.inverterW).to.equal(null);
    expect(v.meterW).to.equal(null);
  });

  it("filters the batteries of the device list", () => {
    expect(
      batteries([
        { deviceType: "ENERGY_STORAGE_BATTERY", deviceId: 1 },
        { deviceType: "SHELLY_PRO3EM_METER" },
      ]),
    ).to.have.length(1);
  });

  it("joins energy and earning buckets per key", () => {
    const list = buckets(
      {
        energyDistributions: [
          { key: 2, yield: 4.1, consumption: 6 },
          { key: 1, yield: 3, consumption: 5 },
        ],
      },
      {
        powerEarningsList: [
          { key: 1, totalPowerGeneration: 3, totalEarnings: 0.9 },
        ],
        chargingEnergyList: [{ key: 1, chargingEnergy: 1.5 }],
      },
    );
    expect(list).to.deep.equal([
      {
        key: 1,
        yield: 3,
        consumption: 5,
        generation: 3,
        earnings: 0.9,
        chargingEnergy: 1.5,
      },
      { key: 2, yield: 4.1, consumption: 6 },
    ]);
    expect(buckets({}, {})).to.deep.equal([]);
  });

  it("reads period totals", () => {
    expect(
      periodTotals(
        {
          totalYield: 120,
          totalConsumption: 300,
          totalSelfUseRate: 0.9,
          selfSufficiencyRate: 0.35,
        },
        { totalEarnings: { earnings: 36 } },
      ),
    ).to.include({
      yieldKwh: 120,
      consumptionKwh: 300,
      selfUseRate: 0.9,
      selfSufficiencyRate: 0.35,
      earnings: 36,
    });
  });

  it("joins the intraday curve with battery in/out", () => {
    const c = dayCurve(
      {
        powerList: [
          { key: "08:02", power: 100, homePower: 300 },
          { key: "08:00", power: 50, homePower: null },
        ],
      },
      [{ key: "08:00", batteryInputPower: 0, batteryOutputPower: 250 }],
    );
    expect(c).to.deep.equal([
      { t: "08:00", solarW: 50, homeW: null, batteryInW: 0, batteryOutW: 250 },
      { t: "08:02", solarW: 100, homeW: 300 },
    ]);
  });

  it("estimates when the battery is full or empty", () => {
    const now = 0;
    // cloud minutes win
    expect(
      batteryEta(
        {
          soc: 50,
          batteryW: -400,
          chargeRemainingMin: null,
          dischargeRemainingMin: 90,
        },
        4.3,
        10,
        now,
      ).emptyAt,
    ).to.equal(90 * 60_000);
    // estimate: 4.3 kWh, 50 % -> 10 %: 1.72 kWh at 430 W = 4 h
    expect(
      batteryEta(
        {
          soc: 50,
          batteryW: -430,
          chargeRemainingMin: null,
          dischargeRemainingMin: null,
        },
        4.3,
        10,
        now,
      ).emptyAt,
    ).to.equal(240 * 60_000);
    // charging 50 % -> 100 %: 2.15 kWh at 1075 W = 2 h
    expect(
      batteryEta(
        {
          soc: 50,
          batteryW: 1075,
          chargeRemainingMin: 0,
          dischargeRemainingMin: null,
        },
        4.3,
        10,
        now,
      ).fullAt,
    ).to.equal(120 * 60_000);
    // idle
    expect(
      batteryEta(
        {
          soc: 50,
          batteryW: 5,
          chargeRemainingMin: null,
          dischargeRemainingMin: null,
        },
        4.3,
        10,
        now,
      ),
    ).to.deep.equal({ fullAt: null, emptyAt: null });
  });

  it("unpacks the paged device list and reads the meter counters", () => {
    const list = deviceArray({
      content: [
        {
          deviceType: "SHELLY_PRO3EM_METER",
          dailyBuyEnergy: 9.17,
          dailyRetEnergy: 0,
          totalBuyEnergy: 6706.92,
          totalRetEnergy: 19.8,
        },
        {
          deviceType: "ENERGY_STORAGE_BATTERY",
          deviceId: 63021,
          batteryLevel: 21,
        },
      ],
      totalPages: 1,
    });
    expect(list).to.have.length(2);
    expect(deviceArray([{ a: 1 }])).to.have.length(1);
    expect(deviceArray(null)).to.deep.equal([]);
    const v = liveValues({}, list[1], list[0]);
    expect(v).to.include({
      gridBuyTodayKwh: 9.17,
      gridRetTodayKwh: 0,
      gridBuyTotalKwh: 6706.92,
      gridRetTotalKwh: 19.8,
      soc: 21,
    });
  });

  it("converts the remaining time from hours to minutes", () => {
    const v = liveValues(
      { battery: { dischargingRemaining: 35.82, chargingRemaining: null } },
      {},
    );
    expect(v.dischargeRemainingMin).to.equal(2149);
    expect(v.chargeRemainingMin).to.equal(null);
  });
});

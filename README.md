![Logo](admin/bk215.png)

# ioBroker.bk215

**Tests:** ![Test and Release](https://github.com/Sven-83/sunlit/workflows/Test%20and%20Release/badge.svg)

## BK215 battery storage adapter for ioBroker (cloud reader)

Reads the **Sunlit / SunEnergyXT BK215** balcony power-plant battery from the **SunEnergyXT cloud**
(formerly Sunlit Solar), with the login of the official app: battery level and power, solar power,
inverter output, home consumption and energy statistics per day, month and year.

- **Read-only.** The adapter never changes anything on the battery; the app keeps control.
- **No local mode needed.**
- The cloud API is undocumented. Endpoints and fields follow the community integration
  [cedricziel/ha-sunlit](https://github.com/cedricziel/ha-sunlit). If SunEnergyXT changes the API,
  the adapter has to follow.

## Setup

1. Install from GitHub: `iobroker url https://github.com/Sven-83/sunlit`
2. Create an instance, enter **e-mail and password of the app** (the password is stored encrypted).
3. Optional: system id (0 = first system of the account), polling intervals, battery capacity
   (0 = modules × 2.15 kWh) and the discharge floor for the full/empty estimate.

## States

| State | Meaning |
|---|---|
| `info.connection`, `info.lastSync`, `info.lastError` | cloud reachable, last read, last error |
| `live.soc` | battery level (%) |
| `live.batteryW` | battery power, + charging / − discharging (W); also `live.batteryChargeW`, `live.batteryDischargeW` |
| `live.solarW` | solar power at the MPPT inputs (W) |
| `live.inverterW` | inverter output (W) |
| `live.meterW` | grid power from the meter linked in the app (W) |
| `live.homeW` | home consumption (W) |
| `live.fullAt`, `live.emptyAt` | expected time full / empty (cloud minutes, else estimated) |
| `today.solarKwh`, `today.earning` | yield and earnings today |
| `today.gridBuyKwh`, `today.gridRetKwh`, `total.gridBuyKwh`, `total.gridRetKwh` | grid import / export of the meter linked in the app (kWh) |
| `today.curve` | JSON `[{t, solarW, homeW, batteryInW, batteryOutW}]`, about every 2 min |
| `stats.days`, `stats.daysPrev`, `stats.months`, `stats.years` | JSON per day of this/previous month, per month of this year, per year |
| `stats.dayTotals`, `stats.monthTotals`, `stats.yearTotals`, `stats.total` | totals incl. self-use and self-sufficiency rate |
| `raw.*` | raw cloud answers (personal fields redacted) for diagnosis |

Live values are read every 60 s, statistics every 15 min (both configurable). After errors the
adapter waits longer (up to 10 min) and logs one warning per kind of problem.

## Development

```bash
npm install
npm run check       # type check
npm run lint
npm run test:unit
npm run test:package
npm run build       # build/ is committed (installation from GitHub)
```

## Disclaimer

Independent project, not affiliated with SunEnergyXT, Sunlit Solar or Sonnenladen GmbH.

## License

MIT, see [LICENSE](LICENSE).

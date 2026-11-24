# pump-fun-replay-sprint-jack

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hungndp/pump-fun-replay-sprint-jack/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hungndp/pump-fun-replay-sprint-jack/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the pump.fun replay sprint: the house replays 24 hours of recorded pump.fun activity and the bot trades 10 SOL of paper money against it, ranked on net PnL. The strategy is selective momentum with a coverage floor. It only enters coins whose price is rising over a trailing window with clearly dominant buy-side flow, a healthy real SOL reserve, and enough trades to be a real market — never fresh snipes and never curves near completion. Stakes are small and capped (0.06 SOL target, at most 5 open positions, a hard cap on total buys so fees cannot bleed the account), and every position carries a −12% stop-loss, a +30% take-profit, a trailing stop, a time stop, and a dead-liquidity exit. A drawdown gate halts new entries past 22% off the equity peak and tightens past 35%, keeping the 50% drawdown guardrail at a wide margin, while a coverage mode relaxes entry thresholds in tiers until the 20-coin round-trip bar (≥0.01 SOL per round trip) is banked. Fully deterministic: no clock, no environment, no randomness — decisions read only the hello, each batch, and the state folded from them.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout via the vendored shim (`vendor/makefun-bot.ts`) and needs Node 22.18 or later; the harness drives it batch by batch and it answers each batch with its orders.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ebjdb2tv&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>

Bounty: [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

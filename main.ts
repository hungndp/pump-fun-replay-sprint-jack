// Pump.fun Replay Sprint — paper bot: selective momentum with a coverage floor.
//
// The house replays 24 hours of recorded pump.fun activity; this bot trades 10 SOL of
// paper money against it. The ranking is net PnL, but a placement first has to clear
// the guardrail bar: a round trip of at least 0.01 SOL on at least 20 distinct coins
// and a maximum drawdown of 50% or less. The strategy is built around both:
//
//   - Entries only on coins with real momentum: price up over a trailing window,
//     buy-side quote flow clearly dominant, a healthy real SOL reserve (not dust,
//     not a curve about to complete), enough trades to be a market and not a snipe.
//   - Small, capped stakes (0.06 SOL target), at most 5 open positions, a hard cap on
//     the total number of buys so transaction fees cannot bleed the account.
//   - Every position carries a stop-loss (-12%), a take-profit (+30%), a trailing
//     stop once it is up 15%, and a time stop, so slots keep rotating.
//   - A drawdown gate: past 22% down from the equity peak the bot stops opening new
//     positions; past 35% it halves sizes and tightens stops. The 50% bar keeps a
//     wide margin.
//   - A coverage mode: until 20 round trips are banked, entry thresholds relax in
//     tiers as the window progresses, at reduced size, so the bar is met without
//     betting the account on weak coins late.
//
// Deterministic: decisions read only the hello, the batch and state folded from them.
// No clock, no environment, no Math.random; the only seed is state.hello.seed, unused
// here because nothing is randomised. Every batch is answered within the caps:
// exits first, then entries, at most hello.caps.max_orders_per_batch orders.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

const SOL = LAMPORTS_PER_SOL;
/** Normal stake target: 0.06 SOL. */
const TARGET_BUY = SOL / 100n * 6n;
/** Reduced stake while banking round trips for the guardrail bar: 0.03 SOL. */
const COVERAGE_BUY = SOL / 100n * 3n;
/** A buy counts toward the 20-coin round-trip bar only at 0.01 SOL or more. */
const MIN_COUNTED_BUY = SOL / 100n;
/** Smallest per-mint size cap (1% of real reserve) worth entering in normal mode. */
const MIN_CAP_NORMAL = SOL / 50n;
/** In late coverage mode a cap of exactly the counted minimum is enough. */
const MIN_CAP_LATE = MIN_COUNTED_BUY;
/** Real SOL reserve band for entries: below is dust, above is a curve near its end. */
const RESERVE_MIN = SOL * 3n / 2n;
const RESERVE_MAX = SOL * 55n;
/** A coin must be at least this many slots old and have this many trades. */
const MIN_AGE_SLOTS = 150;
const MIN_TRADES = 25;
/** Momentum is price now versus price this many slots back. */
const MOMENTUM_SLOTS = 150;
/** Buy-pressure is measured over this trailing window of slots. */
const FLOW_SLOTS = 400;
/** Exit rules, as multiples of a position's remaining cost. */
const STOP_LOSS_X = 0.88;
const TAKE_PROFIT_X = 1.3;
const TRAIL_ARM_X = 1.15;
const TRAIL_DROP_X = 0.9;
/** Positions are closed after this many slots whatever they are doing. */
const MAX_HOLD_SLOTS = 3000;
/** A held coin with no trade for this many slots counts as dead and is exited. */
const DEAD_SLOTS = 900;
/** Drawdown gates, as fractions of the equity peak. */
const DD_HALT = 0.22;
const DD_TIGHT = 0.35;
const DD_TIGHT_STOP_X = 0.92;
/** Fee discipline: never more than this many buys in the whole run. */
const MAX_TOTAL_BUYS = 500;
const BUY_SLIPPAGE_BPS = 400;
const SELL_SLIPPAGE_BPS = 800;
/** Round trips the guardrail bar asks for. */
const ROUND_TRIP_TARGET = 20;

// ---------------------------------------------------------------- own bookkeeping

interface PricePoint {
  slot: number;
  price: number;
}

interface FlowPoint {
  slot: number;
  buy: bigint;
  sell: bigint;
}

interface MintStats {
  firstSeenSlot: number;
  /** Slot of the most recent trade seen on this mint; -1 until one is seen. */
  lastTradeSlot: number;
  prices: PricePoint[];
  flow: FlowPoint[];
}

interface PositionMeta {
  entrySlot: number;
  peakValue: bigint;
}

/** Per-mint price/flow history, folded from the batches' own events. */
const stats = new Map<string, MintStats>();
/** Entry slot and peak marked value per held mint. */
const positionMeta = new Map<string, PositionMeta>();
/** Total quote lamports this bot has spent buying each mint (fills only). */
const boughtLamports = new Map<string, bigint>();
/** Mints whose round trip is complete: bought >= 0.01 SOL and fully sold since. */
const roundTripped = new Set<string>();
/** Buys sent per mint, so one coin cannot churn the account. */
const buysPerMint = new Map<string, number>();

let firstSlot = -1;
let totalBuys = 0;
let peakEquity = 0n;

/** Spot price of a curve as a double: quote lamports per raw token unit. */
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

/** Current marked value of a token amount on a curve, in lamports (bigint-exact). */
function valueOf(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (tokens * vQuote) / vToken;
}

/** Fold this batch's fills into the round-trip ledger before deciding anything. */
function foldFills(state: import('./vendor/makefun-bot.ts').BotState, batch: import('./vendor/makefun-bot.ts').Batch): void {
  for (const f of batch.fills) {
    if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
    if (f.side === 'buy') {
      boughtLamports.set(f.mint, (boughtLamports.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
      if (!positionMeta.has(f.mint)) positionMeta.set(f.mint, { entrySlot: f.slot, peakValue: 0n });
    }
  }
  // A mint counts as round-tripped once a counted buy is fully sold back out.
  for (const mint of boughtLamports.keys()) {
    if (roundTripped.has(mint)) continue;
    if ((boughtLamports.get(mint) ?? 0n) < MIN_COUNTED_BUY) continue;
    if (!state.positions.has(mint)) roundTripped.add(mint);
  }
  for (const mint of [...positionMeta.keys()]) {
    if (!state.positions.has(mint)) positionMeta.delete(mint);
  }
}

/** Fold this batch's trade events into the per-mint price/flow history. */
function foldEvents(batch: import('./vendor/makefun-bot.ts').Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!stats.has(e.mint)) stats.set(e.mint, { firstSeenSlot: e.slot, lastTradeSlot: -1, prices: [], flow: [] });
      continue;
    }
    if (e.event !== 'TradeEvent') continue;
    let s = stats.get(e.mint);
    if (s === undefined) {
      s = { firstSeenSlot: e.slot, lastTradeSlot: -1, prices: [], flow: [] };
      stats.set(e.mint, s);
    }
    s.lastTradeSlot = e.slot;
    const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
    const last = s.prices[s.prices.length - 1];
    if (last !== undefined && last.slot === e.slot) last.price = price;
    else s.prices.push({ slot: e.slot, price });
    const quote = BigInt(e.quote_amount);
    const flast = s.flow[s.flow.length - 1];
    if (flast !== undefined && flast.slot === e.slot) {
      if (e.is_buy) flast.buy += quote;
      else flast.sell += quote;
    } else {
      s.flow.push({ slot: e.slot, buy: e.is_buy ? quote : 0n, sell: e.is_buy ? 0n : quote });
    }
    // Keep the trailing windows only; held mints are marked from state, not history.
    while (s.prices.length > 1 && s.prices[0].slot < e.slot - FLOW_SLOTS - MOMENTUM_SLOTS) s.prices.shift();
    while (s.flow.length > 1 && s.flow[0].slot < e.slot - FLOW_SLOTS) s.flow.shift();
  }
}

/** Price change over the momentum window, or null when history is too short. */
function momentum(s: MintStats, nowSlot: number): number | null {
  if (s.prices.length < 2) return null;
  const now = s.prices[s.prices.length - 1];
  let then: PricePoint | null = null;
  for (const p of s.prices) {
    if (p.slot <= nowSlot - MOMENTUM_SLOTS) then = p;
    else break;
  }
  if (then === null || then.price <= 0) return null;
  if (now.slot - then.slot < MOMENTUM_SLOTS / 2) return null;
  return now.price / then.price - 1;
}

/** Buy share of quote flow over the trailing window, 0..1 (0.5 when no flow). */
function buyPressure(s: MintStats, nowSlot: number): number {
  let buy = 0n;
  let sell = 0n;
  for (const f of s.flow) {
    if (f.slot < nowSlot - FLOW_SLOTS) continue;
    buy += f.buy;
    sell += f.sell;
  }
  const total = buy + sell;
  if (total <= 0n) return 0.5;
  return Number(buy) / Number(total);
}

/** Marked equity: cash plus every position at its curve's latest reserves. */
function equityOf(state: import('./vendor/makefun-bot.ts').BotState): bigint {
  let equity = state.cash;
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) {
      equity += holding.cost_lamports;
      continue;
    }
    equity += valueOf(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
  }
  return equity;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    const progress = slot - firstSlot; // slots since the window opened; ~216_000 is a full day

    foldFills(state, batch);
    foldEvents(batch);

    const equity = equityOf(state);
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0n ? Number(peakEquity - equity) / Number(peakEquity) : 0;
    const halted = drawdown > DD_HALT;
    const tight = drawdown > DD_TIGHT;

    const orders: OrderInput[] = [];
    const pendingMints = new Set<string>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);

    // ------------------------------------------------------------ exits first
    const stopX = tight ? DD_TIGHT_STOP_X : STOP_LOSS_X;
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const meta = positionMeta.get(mint) ?? { entrySlot: slot, peakValue: 0n };
      const value = valueOf(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value > meta.peakValue) meta.peakValue = value;
      positionMeta.set(mint, meta);
      const cost = Number(holding.cost_lamports);
      if (cost <= 0) continue;
      const ratio = Number(value) / cost;
      const heldFor = slot - meta.entrySlot;
      // A held coin nobody has traded for DEAD_SLOTS is done moving: leave at the
      // marked price instead of riding it to the end-of-window flatten.
      const s = stats.get(mint);
      const goneQuiet = s !== undefined && s.lastTradeSlot >= 0 && slot - s.lastTradeSlot >= DEAD_SLOTS;
      const exit =
        ratio <= stopX ||
        ratio >= TAKE_PROFIT_X ||
        (meta.peakValue > 0n && Number(meta.peakValue) / cost >= TRAIL_ARM_X && value <= (meta.peakValue * 9n) / 10n) ||
        heldFor >= MAX_HOLD_SLOTS ||
        goneQuiet;
      if (!exit) continue;
      const sell: SellInput = { side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS };
      orders.push(sell);
      pendingMints.add(mint);
    }

    // ------------------------------------------------------------ entries
    if (!halted && totalBuys < MAX_TOTAL_BUYS) {
      const needCoverage = roundTripped.size < ROUND_TRIP_TARGET;
      // Coverage tiers relax as the window runs: past ~40% with the bar unmet the
      // bot takes weaker signals at coverage size; past ~75% it banks round trips
      // on almost any live coin at the counted minimum.
      const lateCoverage = needCoverage && progress > 86_000;
      const lastCoverage = needCoverage && progress > 162_000;
      const momMin = lastCoverage ? -0.01 : lateCoverage ? 0.0 : needCoverage ? 0.02 : 0.05;
      const pressureMin = lastCoverage ? 0.5 : lateCoverage ? 0.52 : needCoverage ? 0.55 : 0.62;
      const minCap = lastCoverage ? MIN_CAP_LATE : MIN_CAP_NORMAL;
      const stake = needCoverage ? COVERAGE_BUY : TARGET_BUY;

      let free = state.freeCashLamports();
      const tx = state.txFeeLamports();
      let openSlots = caps.max_open_positions - state.committedPositionCount();

      // Candidates are the mints trading in this batch, scored, best first.
      const seen = new Set<string>();
      const candidates: { mint: string; score: number }[] = [];
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent' || seen.has(e.mint)) continue;
        seen.add(e.mint);
        const mint = e.mint;
        if (state.positions.has(mint) || pendingMints.has(mint)) continue;
        if ((buysPerMint.get(mint) ?? 0) >= 2) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.trades < MIN_TRADES) continue;
        const born = curve.created_slot ?? stats.get(mint)?.firstSeenSlot ?? slot;
        if (slot - born < MIN_AGE_SLOTS) continue;
        const reserve = curve.real_quote_reserves;
        if (reserve < RESERVE_MIN || reserve > RESERVE_MAX) continue;
        if (state.maxBuyLamports(mint) < minCap) continue;
        const s = stats.get(mint);
        if (s === undefined) continue;
        const mom = momentum(s, slot);
        if (mom === null || mom < momMin) continue;
        const pressure = buyPressure(s, slot);
        if (pressure < pressureMin) continue;
        candidates.push({ mint, score: mom * 2 + pressure });
      }
      candidates.sort((a, b) => (b.score - a.score) || (a.mint < b.mint ? -1 : 1));

      for (const c of candidates) {
        if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
        const cap = state.maxBuyLamports(c.mint);
        let amount = stake < cap ? stake : cap;
        if (tight) amount = amount / 2n;
        if (amount < MIN_COUNTED_BUY) continue;
        if (free < amount + tx) continue;
        const buy: BuyInput = { side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS };
        orders.push(buy);
        buysPerMint.set(c.mint, (buysPerMint.get(c.mint) ?? 0) + 1);
        totalBuys += 1;
        free -= amount + tx;
        openSlots -= 1;
      }
    }

    return orders;
  },
});

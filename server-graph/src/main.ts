import type { PlayerEntity } from 'genshin-ts/definitions/entity_helpers'
import { RandomOrder, SettlementStatus, SortBy } from 'genshin-ts/definitions/enum'
import { g } from 'genshin-ts/runtime/core'
import type { EntityValue } from 'genshin-ts/runtime/value'

import { Signal } from './resources/signals'

// ============================================================================
// 第六张 · 服务器权威节点图 (genshin-ts port of ../../lua/core.lua)
//
// STATUS: code preparation, NOT yet verified against the real editor. See
// ../../docs/server-contract.md and the OBSTACLES block at the bottom of this
// file for exactly what still needs manual editor work before injection.
//
// Design (2026-09-25 revision):
// - STATE OUT = custom variables, not signals. The client-script API reads
//   custom variables (game.GetGlobalCustomVariableValue, list types supported)
//   and can listen for their changes, with a PlayerSelf scope for per-player
//   data. So public state goes on the Level entity (nimmt_pub / nimmt_text /
//   nimmt_rev) and each seat's private hand on that player's own entity
//   (nimmt_me). The old 56-param NimmtSnapshot signal is gone: the Signal
//   Manager has no list type, and `sendSignal` is documented as "向关卡全局
//   发送" — a level-wide broadcast, never private to one player.
// - Because the state lives on the server, a client that drops and reconnects
//   re-reads it (lua/client.lua OnStart) and the match continues.
// - INTENTS IN = signals from clients (NimmtStart/Submit/ChooseRow/Vote/Sync).
//   Seat identity comes from `evt.signalSourceEntity` compared against
//   `player(p)`, never from a value the client sends — UNVERIFIED with a real
//   second client.
// - Seats: players on the field at NimmtStart take seats 1..humans (seat p is
//   player(p)); bots fill the rest. Every tick checks the on-field player list:
//   a human who is gone is taken over by the bot immediately (bot flag 2), and
//   gets the seat back when they return.
// - Votes: humans vote to end the match now (kind 1) or, at game over, to run
//   the official level settlement (kind 2). A strict majority of present
//   humans passes — a lone human passes instantly.
// - No recursion, no string concatenation, no JSON/Object ops: all confirmed
//   unavailable in the real compiler. Log lines are fixed literal strings.
// ============================================================================

const MAX_SEATS = 8n
const HAND_SLOTS = 10n
const ROW_SLOTS = 5n

// Level.nimmt_pub layout (0-based). MUST match lua/client.lua viewFromVars()
// and tests/simulator.test.mjs publish().
// 0 n, 1 handNo, 2 round, 3 token, 4 revision, 5 cursor, 6 waiting, 7 humans,
// 8 votesEnd, 9 votesLeave, 10 secondsLeft, 11 reserved, then 8-wide blocks:
const PUB_ROWS = 12n // 20 slots: row r slot j at PUB_ROWS + (r-1)*5 + (j-1)
const PUB_SCORES = 32n
const PUB_READY = 48n
const PUB_BOT = 56n // 0 human, 1 bot, 2 human left → bot playing for them
const PUB_VOTED = 64n // 0 none, 1 end-match vote, 2 settle-level vote
const PUB_QCARD = 72n
const PUB_QPLAYER = 80n

// NODE BUDGET: the editor rejects graphs over 3000 nodes, and genshin-ts inlines
// every gstsServer* function at EACH call site. So every heavy function has
// exactly one call site: signal handlers only change state and set `dirty`;
// the tick alone deals, reveals, steps, auto-plays and publishes.
const TICK_MS = 300
// 32 s at TICK_MS. Clients are told 2 s less (secondsLeft below), so a card
// or row picked as their countdown hits 0 still reaches the server in time.
const SELECT_TICKS = 107n
const SHOWN_GRACE_S = 2n
// Result screen: 30 s (100 ticks) to click play again.
const RESULT_TICKS = 100n
const HAND_END_TICKS = 20n // ~6 s on the hand-end scoreboard before the next deal (4 s too short to read, 8 s too long)

function gstsServerHandIdx(seat: bigint, slot: bigint) {
  return (seat - 1n) * HAND_SLOTS + slot
}

function gstsServerRowIdx(row: bigint, slot: bigint) {
  return (row - 1n) * ROW_SLOTS + slot
}

// core.lua's M.points
function gstsServerPoints(card: bigint) {
  let pts = 1n
  if (card === 55n) {
    pts = 7n
  } else if (card % 11n === 0n) {
    pts = 5n
  } else if (card % 10n === 0n) {
    pts = 3n
  } else if (card % 5n === 0n) {
    pts = 2n
  }
  return pts
}

// core.lua's M.rowPoints + M.bestRow for all four rows at once: fills rowPts
// and bestRow. Called ONCE per tick before anything reads them — the only
// place a row's points are summed (see NODE BUDGET at the top).
function gstsServerScoreRows() {
  const rows = gsts.f.get('rows') as unknown as bigint[]
  const rowCount = gsts.f.get('rowCount') as unknown as bigint[]
  const rowPts = gsts.f.get('rowPts') as unknown as bigint[]
  let best = 1n
  let bestPts = 1000n
  for (let r = 1n; r <= 4n; r++) {
    const cnt = rowCount[idx(r - 1n)]
    let total = 0n
    for (let i = 0n; i < cnt; i++) {
      total = total + gstsServerPoints(rows[idx(gstsServerRowIdx(r, i))])
    }
    rowPts[idx(r - 1n)] = total
    if (total < bestPts) {
      best = r
      bestPts = total
    }
  }
  gsts.f.set('bestRow', best)
}

// Client identity. On the real server a client signal's signalSourceEntity
// does NOT match the sender's player entity (2026-09-26 log: seat found only
// via the sole-human fallback), so the server cannot tell who sent a signal.
// Instead each human seat gets a random key written ONLY into that player's
// own nimmt_me; every NimmtAct carries (seat, key) and is accepted only if the
// key matches. Returns the seat, or 0 if rejected.
function gstsServerAuth(seat: bigint, key: bigint) {
  let ok = 0n
  if (seat >= 1n && seat <= MAX_SEATS) {
    const keys = gsts.f.get('keys') as unknown as bigint[]
    const bot = gsts.f.get('bot') as unknown as bigint[]
    // 0 = human, 3 = human on autopilot (托管); both may still send intents
    const b = bot[idx(seat - 1n)]
    if (key !== 0n && keys[idx(seat - 1n)] === key && (b === 0n || b === 3n)) {
      ok = seat
    }
  }
  return ok
}

// Lobby seating: everyone on the field takes seats 1..humans in field-list
// order (the entity is kept in seatEnt, so later writes and presence checks
// never assume seat p == player(p)). Their seat + key reach them through the
// next publish (stage 3 writes nimmt_me onto seatEnt[p]).
function gstsServerLobbySeat() {
  const field = gsts.f.getListOfPlayerEntitiesOnTheField()
  let humans = gsts.f.getListLength(field)
  if (humans > MAX_SEATS) {
    humans = MAX_SEATS
  }
  gsts.f.set('seatEnt', field)
  gsts.f.set('humans', humans)
  // Players the match expects (room / matchmaking size). Slow loaders are not on
  // the field yet, so the lobby waits for them before starting.
  gsts.f.set('expected', gsts.f.queryGameModeAndPlayerNumber().playerCount)
  gsts.f.set('n', humans)
  const bot = gsts.f.get('bot') as unknown as bigint[]
  const handCount = gsts.f.get('handCount') as unknown as bigint[]
  const text = gsts.f.get('text') as unknown as string[]
  const pending = gsts.f.get('pending') as unknown as bigint[]
  const clear = gsts.f.get('clearReady') as unknown as boolean
  for (let s = 0n; s < MAX_SEATS; s++) {
    let b = 1n
    if (s < humans) {
      b = 0n
    }
    bot[idx(s)] = b
    handCount[idx(s)] = 0n
    // Seat nicknames for the table (published with nimmt_text).
    let name = ''
    if (s < humans) {
      name = gsts.f.getPlayerNickname(field[idx(s)])
    }
    text[idx(s + 6n)] = name
    if (clear) {
      pending[idx(s)] = 0n
    }
  }
  gsts.f.set('clearReady', false)
  gsts.f.set('meDirty', true)
}

function gstsServerShuffle() {
  const deck = gsts.f.get('deck') as unknown as bigint[]
  // Grow 100 → 104 exactly once (default-value lists are capped at 100). A
  // fixed count guarded by a flag: a loop bound read from the list's own
  // length is re-evaluated as the list grows (real run stopped at 102).
  if (!(gsts.f.get('deckGrown') as unknown as boolean)) {
    for (let i = 0n; i < 4n; i++) {
      gsts.f.insertValueIntoList(deck, 0n, 0n)
    }
    gsts.f.set('deckGrown', true)
  }
  for (let i = 0n; i < 104n; i++) {
    deck[idx(i)] = i + 1n
  }
  gsts.f.randomDeckSelectorSelectionList(deck, RandomOrder.Random)
  gsts.f.set('dealSeat', 1n)
  gsts.f.set('phase', 'dealing')
}

function gstsServerDealSome() {
  const n = gsts.f.get('n') as unknown as bigint
  const deck = gsts.f.get('deck') as unknown as bigint[]
  const hands = gsts.f.get('hands') as unknown as bigint[]
  const handCount = gsts.f.get('handCount') as unknown as bigint[]
  const scratch10 = gsts.f.get('scratch10') as unknown as bigint[]
  // One seat per tick; the four starting rows get a tick of their own.
  const p = gsts.f.get('dealSeat') as unknown as bigint
  if (p <= n) {
    for (let i = 0n; i < HAND_SLOTS; i++) {
      scratch10[idx(i)] = deck[idx((p - 1n) * HAND_SLOTS + i)]
    }
    gsts.f.listSorting(scratch10, SortBy.Ascending)
    for (let i = 0n; i < HAND_SLOTS; i++) {
      hands[idx(gstsServerHandIdx(p, i))] = scratch10[idx(i)]
    }
    handCount[idx(p - 1n)] = HAND_SLOTS
    gsts.f.set('dealSeat', p + 1n)
  } else {
    const rows = gsts.f.get('rows') as unknown as bigint[]
    const rowCount = gsts.f.get('rowCount') as unknown as bigint[]
    const scratch4 = gsts.f.get('scratch4') as unknown as bigint[]
    for (let i = 0n; i < 4n; i++) {
      scratch4[idx(i)] = deck[idx(n * HAND_SLOTS + i)]
    }
    gsts.f.listSorting(scratch4, SortBy.Ascending)
    for (let r = 1n; r <= 4n; r++) {
      for (let i = 0n; i < ROW_SLOTS; i++) {
        rows[idx(gstsServerRowIdx(r, i))] = 0n
      }
      rows[idx(gstsServerRowIdx(r, 0n))] = scratch4[idx(r - 1n)]
      rowCount[idx(r - 1n)] = 1n
    }
    const pending = gsts.f.get('pending') as unknown as bigint[]
    const want = gsts.f.get('want') as unknown as bigint[]
    for (let p = 1n; p <= MAX_SEATS; p++) {
      pending[idx(p - 1n)] = 0n
      want[idx(p - 1n)] = 0n
    }
    gsts.f.set('handNo', (gsts.f.get('handNo') as unknown as bigint) + 1n)
    gsts.f.set('round', 1n)
    gsts.f.set('token', (gsts.f.get('token') as unknown as bigint) + 1n)
    gsts.f.set('revision', (gsts.f.get('revision') as unknown as bigint) + 1n)
    gsts.f.set('rowsDirty', true)
    gsts.f.set('meDirty', true)
    gsts.f.set('phase', 'select')
    gsts.f.set('queueLen', 0n)
    gsts.f.set('cursor', 1n)
    gsts.f.set('waiting', 0n)
    gsts.f.set('endReason', '')
    gsts.f.set('deadlineTicks', 0n)
  }
}

// core.lua's M.target
function gstsServerTarget(card: bigint) {
  const rows = gsts.f.get('rows') as unknown as bigint[]
  const rowCount = gsts.f.get('rowCount') as unknown as bigint[]
  let best = 0n
  let tail = 0n
  for (let r = 1n; r <= 4n; r++) {
    const cnt = rowCount[idx(r - 1n)]
    const c = rows[idx(gstsServerRowIdx(r, cnt - 1n))]
    if (c < card && c > tail) {
      best = r
      tail = c
    }
  }
  return best
}

// core.lua's take(): row -> scorer, row resets to just the triggering card.
function gstsServerTake(seat: bigint, row: bigint, newCard: bigint) {
  const pts = (gsts.f.get('rowPts') as unknown as bigint[])[idx(row - 1n)]
  const scores = gsts.f.get('scores') as unknown as bigint[]
  scores[idx(seat - 1n)] = scores[idx(seat - 1n)] + pts
  const rows = gsts.f.get('rows') as unknown as bigint[]
  const rowCount = gsts.f.get('rowCount') as unknown as bigint[]
  for (let i = 0n; i < ROW_SLOTS; i++) {
    rows[idx(gstsServerRowIdx(row, i))] = 0n
  }
  rows[idx(gstsServerRowIdx(row, 0n))] = newCard
  rowCount[idx(row - 1n)] = 1n
  gsts.f.set('rowsDirty', true)
}

// core.lua's M.submit. Returns true/false; on full round, kicks off reveal.
function gstsServerSubmit(seat: bigint, card: bigint, token: bigint) {
  let ok = true
  if (seat < 1n || seat > (gsts.f.get('n') as unknown as bigint)) {
    ok = false
  }
  if (ok && token !== (gsts.f.get('token') as unknown as bigint)) {
    ok = false
  }
  if (ok && (gsts.f.get('phase') as unknown as string) !== 'select') {
    ok = false
  }
  const pending = gsts.f.get('pending') as unknown as bigint[]
  if (ok && pending[idx(seat - 1n)] !== 0n) {
    ok = false
  }
  if (ok) {
    const hands = gsts.f.get('hands') as unknown as bigint[]
    const handCount = gsts.f.get('handCount') as unknown as bigint[]
    const cnt = handCount[idx(seat - 1n)]
    let found = false
    for (let i = 0n; i < cnt; i++) {
      if (hands[idx(gstsServerHandIdx(seat, i))] === card) {
        found = true
      }
    }
    if (!found) {
      ok = false
    }
  }
  if (ok) {
    pending[idx(seat - 1n)] = card
    gsts.f.set('revision', (gsts.f.get('revision') as unknown as bigint) + 1n)
    gsts.f.set('meDirty', true) // publish the locked card to its owner (nimmt_me[12])
    // "Played" mark for everyone at once (own variable; the table publish is slow).
    const live = gsts.f.get('emo') as unknown as bigint[]
    live[idx(7n + seat)] = token
    gsts.f.setCustomVariable(level, 'nimmt_emo', live)
  }
  return ok
}

// True once every seat has locked a card this round (the tick then reveals).
function gstsServerAllIn() {
  const n = gsts.f.get('n') as unknown as bigint
  const pending = gsts.f.get('pending') as unknown as bigint[]
  let allIn = true
  for (let p = 1n; p <= n; p++) {
    if (pending[idx(p - 1n)] === 0n) {
      allIn = false
    }
  }
  return allIn
}

// Locks in this round's queue, ONE SEAT PER TICK (phase 'revealing', seat in
// revealSeat): that seat's card leaves its hand and joins the queue. A final
// tick sorts the queue by card and opens phase 'reveal'. Doing all seats in one
// execution stalled the real server at 8 players (2026-09-26).
function gstsServerRevealStep() {
  const n = gsts.f.get('n') as unknown as bigint
  const p = gsts.f.get('revealSeat') as unknown as bigint
  const queueCard = gsts.f.get('queueCard') as unknown as bigint[]
  const queuePlayer = gsts.f.get('queuePlayer') as unknown as bigint[]
  if (p <= n) {
    const pending = gsts.f.get('pending') as unknown as bigint[]
    const hands = gsts.f.get('hands') as unknown as bigint[]
    const handCount = gsts.f.get('handCount') as unknown as bigint[]
    const card = pending[idx(p - 1n)]
    queueCard[idx(p - 1n)] = card
    queuePlayer[idx(p - 1n)] = p
    const cnt = handCount[idx(p - 1n)]
    let writeIdx = 0n
    for (let i = 0n; i < cnt; i++) {
      const v = hands[idx(gstsServerHandIdx(p, i))]
      if (v !== card) {
        hands[idx(gstsServerHandIdx(p, writeIdx))] = v
        writeIdx = writeIdx + 1n
      }
    }
    hands[idx(gstsServerHandIdx(p, writeIdx))] = 0n
    handCount[idx(p - 1n)] = writeIdx
    gsts.f.set('revealSeat', p + 1n)
  } else {
    // Sort the queue by card with ONE list-sort node: key = card*10 + seat
    // (seat < 10), unused slots get a key larger than any card.
    const qkey = gsts.f.get('qkey') as unknown as bigint[]
    for (let s = 0n; s < MAX_SEATS; s++) {
      let key = 99999n
      if (s < n) {
        key = queueCard[idx(s)] * 10n + queuePlayer[idx(s)]
      }
      qkey[idx(s)] = key
    }
    gsts.f.listSorting(qkey, SortBy.Ascending)
    for (let s = 0n; s < n; s++) {
      queueCard[idx(s)] = qkey[idx(s)] / 10n
      queuePlayer[idx(s)] = qkey[idx(s)] % 10n
    }
    gsts.f.set('queueLen', n)
    gsts.f.set('phase', 'reveal')
    gsts.f.set('cursor', 1n)
    gsts.f.set('revision', (gsts.f.get('revision') as unknown as bigint) + 1n)
    gsts.f.set('dirty', true)
    gsts.f.set('meDirty', true)
  }
}

// Ends the match (natural end, or a passed end-match vote). Clears the votes
// so the settle-level vote on the result screen starts from zero.
function gstsServerFinish(reason: string) {
  gsts.f.set('phase', 'gameOver')
  // A finished game counts as success straight away (leaving needs no 90 s wait).
  const onField = gsts.f.getListOfPlayerEntitiesOnTheField()
  for (const pl of onField) {
    gsts.f.setPlayerSettlementSuccessStatus(pl, SettlementStatus.Victory)
  }
  gsts.f.set('endReason', reason)
  gsts.f.set('deadlineTicks', 0n) // result-screen countdown
  gsts.f.set('waiting', 0n)
  const voted = gsts.f.get('voted') as unknown as bigint[]
  for (let p = 1n; p <= MAX_SEATS; p++) {
    voted[idx(p - 1n)] = 0n
  }
  gsts.f.set('revision', (gsts.f.get('revision') as unknown as bigint) + 1n)
}

// core.lua's M.step, minus the "return false,'wrong_phase'" — the caller
// (the tick timer) only invokes this when phase is already reveal/resolve.
function gstsServerStep() {
  gsts.f.set('phase', 'resolve')
  gsts.f.set('revision', (gsts.f.get('revision') as unknown as bigint) + 1n)
  const cursor = gsts.f.get('cursor') as unknown as bigint
  const queueLen = gsts.f.get('queueLen') as unknown as bigint

  if (cursor > queueLen) {
    const round = gsts.f.get('round') as unknown as bigint
    if (round === 10n) {
      const mode = gsts.f.get('mode') as unknown as string
      const n = gsts.f.get('n') as unknown as bigint
      const scores = gsts.f.get('scores') as unknown as bigint[]
      let over = mode === 'quick'
      let limit = 66n
      if (mode === 'short') {
        limit = 33n
      }
      for (let p = 1n; p <= n; p++) {
        if (scores[idx(p - 1n)] >= limit) {
          over = true
        }
      }
      if (over) {
        let reason = 'score'
        if (mode === 'quick') {
          reason = 'rounds'
        }
        gstsServerFinish(reason)
      } else {
        gsts.f.set('phase', 'handEnd')
        gsts.f.set('deadlineTicks', 0n)
      }
    } else {
      gsts.f.set('round', round + 1n)
      gsts.f.set('token', (gsts.f.get('token') as unknown as bigint) + 1n)
      const n2 = gsts.f.get('n') as unknown as bigint
      const pending2 = gsts.f.get('pending') as unknown as bigint[]
      for (let p = 1n; p <= n2; p++) {
        pending2[idx(p - 1n)] = 0n
      }
      gsts.f.set('queueLen', 0n)
      gsts.f.set('cursor', 1n)
      gsts.f.set('phase', 'select')
      gsts.f.set('deadlineTicks', 0n)
    }
  } else {
    const queueCard = gsts.f.get('queueCard') as unknown as bigint[]
    const queuePlayer = gsts.f.get('queuePlayer') as unknown as bigint[]
    const card = queueCard[idx(cursor - 1n)]
    const player_ = queuePlayer[idx(cursor - 1n)]
    // a row picked in chooseRow (forcedRow) is taken here: single Take call site
    const forced = gsts.f.get('forcedRow') as unknown as bigint
    let row = forced
    if (forced === 0n) {
      row = gstsServerTarget(card)
    }
    gsts.f.set('forcedRow', 0n)
    if (row === 0n) {
      gsts.f.set('phase', 'chooseRow')
      gsts.f.set('waiting', player_)
      gsts.f.set('deadlineTicks', 0n)
    } else {
      const rowCount = gsts.f.get('rowCount') as unknown as bigint[]
      const cnt = rowCount[idx(row - 1n)]
      if (cnt === ROW_SLOTS || forced !== 0n) {
        gstsServerTake(player_, row, card)
      } else {
        const rows = gsts.f.get('rows') as unknown as bigint[]
        rows[idx(gstsServerRowIdx(row, cnt))] = card
        rowCount[idx(row - 1n)] = cnt + 1n
        gsts.f.set('rowsDirty', true)
      }
      gsts.f.set('cursor', cursor + 1n)
    }
  }
}

// core.lua's M.choose
function gstsServerChoose(seat: bigint, row: bigint, token: bigint) {
  let ok = true
  if (token !== (gsts.f.get('token') as unknown as bigint)) {
    ok = false
  }
  if (ok && (gsts.f.get('phase') as unknown as string) !== 'chooseRow') {
    ok = false
  }
  if (ok && seat !== (gsts.f.get('waiting') as unknown as bigint)) {
    ok = false
  }
  if (ok && (row < 1n || row > 4n)) {
    ok = false
  }
  if (ok) {
    // the next Step takes this row for the waiting card (single Take call site)
    gsts.f.set('forcedRow', row)
    gsts.f.set('waiting', 0n)
    gsts.f.set('phase', 'resolve')
    gsts.f.set('revision', (gsts.f.get('revision') as unknown as bigint) + 1n)
  }
  return ok
}

// Automatic moves, ONE SEAT PER TICK (round-robin via autoSeat) to keep each
// execution light: a seat that has not locked a card submits the human's pick
// (from NimmtSubmit, in `want`), or - if it is a bot / its human left / the
// ~30 s deadline passed - a random card from its hand. The heuristic bot
// (core.lua's M.bot) was dropped: evaluating every card against every row in
// one tick stalled the real server (2026-09-26). The ONLY call site of Submit.
// In chooseRow, a bot/timeout records the cheapest row for the tick to apply.
function gstsServerAutoAct() {
  const bot = gsts.f.get('bot') as unknown as bigint[]
  const n = gsts.f.get('n') as unknown as bigint
  const timedOut = (gsts.f.get('deadlineTicks') as unknown as bigint) >= SELECT_TICKS
  if ((gsts.f.get('phase') as unknown as string) === 'select') {
    let p = gsts.f.get('autoSeat') as unknown as bigint
    if (p < 1n || p > n) {
      p = 1n
    }
    gsts.f.set('autoSeat', p + 1n)
    const pending = gsts.f.get('pending') as unknown as bigint[]
    const want = gsts.f.get('want') as unknown as bigint[]
    // A human's submitted card is applied on the very next tick instead of
    // waiting up to n ticks for its seat's round-robin turn (felt laggy).
    for (let s = 0n; s < n; s++) {
      if (want[idx(s)] !== 0n && pending[idx(s)] === 0n) {
        p = s + 1n
      }
    }
    if (pending[idx(p - 1n)] === 0n) {
      let card = want[idx(p - 1n)]
      if (card === 0n && (bot[idx(p - 1n)] !== 0n || timedOut)) {
        const handCount = gsts.f.get('handCount') as unknown as bigint[]
        const hands = gsts.f.get('hands') as unknown as bigint[]
        const pick = gsts.f.getRandomInteger(0n, handCount[idx(p - 1n)] - 1n)
        card = hands[idx((p - 1n) * HAND_SLOTS + pick)]
      }
      if (card !== 0n) {
        gstsServerSubmit(p, card, gsts.f.get('token') as unknown as bigint)
        want[idx(p - 1n)] = 0n
      }
    }
  } else if ((gsts.f.get('phase') as unknown as string) === 'chooseRow') {
    const w = gsts.f.get('waiting') as unknown as bigint
    if (w > 0n && (bot[idx(w - 1n)] !== 0n || timedOut)) {
      gsts.f.set('chosenRow', gsts.f.get('bestRow') as unknown as bigint)
    }
  }
}

// Escape / reconnect detection: compares every human seat against the list of
// players currently on the field. Gone → bot takes over at once (flag 2);
// back → the human gets the seat back. Returns true if any seat changed.
function gstsServerPresence() {
  const n = gsts.f.get('n') as unknown as bigint
  const bot = gsts.f.get('bot') as unknown as bigint[]
  const field = gsts.f.getListOfPlayerEntitiesOnTheField()
  const len = gsts.f.getListLength(field)
  const seatEnt = gsts.f.get('seatEnt') as unknown as EntityValue[]
  let changed = false
  let humans = 0n
  for (let p = 1n; p <= n; p++) {
    if (bot[idx(p - 1n)] !== 1n) {
      let present = false
      for (let i = 0n; i < len; i++) {
        if (field[idx(i)] === seatEnt[idx(p - 1n)]) {
          present = true
        }
      }
      if (bot[idx(p - 1n)] !== 2n && !present) {
        bot[idx(p - 1n)] = 2n
        changed = true
      } else if (bot[idx(p - 1n)] === 2n && present) {
        bot[idx(p - 1n)] = 0n
        changed = true
      }
      if (bot[idx(p - 1n)] !== 2n) {
        humans = humans + 1n
      }
    }
  }
  gsts.f.set('humans', humans)
  return changed
}

// Start from the lobby once every seated human is ready: bots fill up to
// humans + botCount (2–8 seats in total).
function gstsServerStart(botCount: bigint, modeInt: bigint) {
  const phase = gsts.f.get('phase') as unknown as string
  let ok = false
  if (phase === 'lobby') {
    ok = true
    const humans = gsts.f.get('humans') as unknown as bigint
    let total = humans + botCount
    if (total < 2n) {
      total = 2n
    }
    if (total > MAX_SEATS) {
      total = MAX_SEATS
    }
    gsts.f.set('n', total)
    const bot = gsts.f.get('bot') as unknown as bigint[]
    const scores = gsts.f.get('scores') as unknown as bigint[]
    const voted = gsts.f.get('voted') as unknown as bigint[]
    for (let p = 1n; p <= MAX_SEATS; p++) {
      if (p <= humans) {
        bot[idx(p - 1n)] = 0n
      } else {
        bot[idx(p - 1n)] = 1n
      }
      scores[idx(p - 1n)] = 0n
      voted[idx(p - 1n)] = 0n
    }
    if (modeInt === 1n) {
      gsts.f.set('mode', 'standard') // ends at 66
    } else if (modeInt === 2n) {
      gsts.f.set('mode', 'short') // ends at 33
    } else {
      gsts.f.set('mode', 'quick') // 10 rounds
    }
    gsts.f.set('handNo', 0n)
    gsts.f.set('phase', 'deal') // the tick deals (single Deal call site)
  }
  return ok
}

// Publishes the table into custom variables, ONE STAGE PER TICK: a whole
// publish costs ~4000 load units and the real server aborts an execution at
// roughly 4400 (2026-09-26 load monitor), so it is spread out:
//   1 header + rows + nimmt_text   2 seats/queue/winners -> nimmt_pub
//   3 one seat's private hand (nimmt_me) per tick   4 bump nimmt_rev (clients
//   listen to it, so it goes last). Every slot is written explicitly - no
//   clear-all loop. Layout: see PUB_* at the top.
function gstsServerPublishStep() {
  const stage = gsts.f.get('pubStage') as unknown as bigint
  const n = gsts.f.get('n') as unknown as bigint
  const phase = gsts.f.get('phase') as unknown as string
  const pub = gsts.f.get('pub') as unknown as bigint[]
  if (stage === 1n) {
    pub[idx(0n)] = n
    pub[idx(1n)] = gsts.f.get('handNo') as unknown as bigint
    pub[idx(2n)] = gsts.f.get('round') as unknown as bigint
    pub[idx(3n)] = gsts.f.get('token') as unknown as bigint
    pub[idx(4n)] = gsts.f.get('revision') as unknown as bigint
    pub[idx(5n)] = gsts.f.get('cursor') as unknown as bigint
    pub[idx(6n)] = gsts.f.get('waiting') as unknown as bigint
    pub[idx(7n)] = gsts.f.get('humans') as unknown as bigint
    pub[idx(8n)] = gsts.f.get('expected') as unknown as bigint // players the match expects
    let secondsLeft = 0n
    if (phase === 'select' || phase === 'chooseRow' || phase === 'gameOver') {
      let limitTicks = SELECT_TICKS
      if (phase === 'gameOver') {
        limitTicks = RESULT_TICKS + 7n // same 2 s grace as the turns
      }
      secondsLeft =
        ((limitTicks - (gsts.f.get('deadlineTicks') as unknown as bigint)) * 3n) / 10n -
        SHOWN_GRACE_S
      if (secondsLeft < 0n) {
        secondsLeft = 0n
      }
    }
    pub[idx(10n)] = secondsLeft
    // Lobby settings shared by every client: bots + 10*mode.
    pub[idx(11n)] = gsts.f.get('settings') as unknown as bigint
    const rows = gsts.f.get('rows') as unknown as bigint[]
    for (let i = 0n; i < 20n; i++) {
      pub[idx(PUB_ROWS + i)] = rows[idx(i)]
    }
    const text = gsts.f.get('text') as unknown as string[]
    text[idx(0n)] = phase
    text[idx(1n)] = gsts.f.get('mode') as unknown as string
    text[idx(2n)] = gsts.f.get('endReason') as unknown as string
    // event1..3 stay empty: the server-side event log was dropped to fit the
    // node budget (the client shows no log lines in multiplayer).
    text[idx(3n)] = ''
    text[idx(4n)] = ''
    text[idx(5n)] = ''
    gsts.f.setCustomVariable(level, 'nimmt_text', text)
    gsts.f.set('pubStage', 2n)
  } else if (stage === 2n) {
    const scores = gsts.f.get('scores') as unknown as bigint[]
    const pending = gsts.f.get('pending') as unknown as bigint[]
    const bot = gsts.f.get('bot') as unknown as bigint[]
    const voted = gsts.f.get('voted') as unknown as bigint[]
    const queueCard = gsts.f.get('queueCard') as unknown as bigint[]
    const queuePlayer = gsts.f.get('queuePlayer') as unknown as bigint[]
    const queueLen = gsts.f.get('queueLen') as unknown as bigint
    // Only slots that can go back to empty need clearing; seats 1..n are
    // all rewritten below and the client never reads seats beyond n.
    for (let s = 0n; s < MAX_SEATS; s++) {
      pub[idx(PUB_QCARD + s)] = 0n
      pub[idx(PUB_QPLAYER + s)] = 0n
    }
    for (let s = 0n; s < n; s++) {
      pub[idx(PUB_SCORES + s)] = scores[idx(s)]
      let ready = 0n
      if (pending[idx(s)] !== 0n) {
        ready = 1n
      }
      pub[idx(PUB_READY + s)] = ready
      pub[idx(PUB_BOT + s)] = bot[idx(s)]
      pub[idx(PUB_VOTED + s)] = voted[idx(s)]
    }
    for (let s = 0n; s < queueLen; s++) {
      pub[idx(PUB_QCARD + s)] = queueCard[idx(s)]
      pub[idx(PUB_QPLAYER + s)] = queuePlayer[idx(s)]
    }
    // 8/9 (vote counts) and the hand-count block are no longer published:
    // the client counts votes from the voted/bot blocks itself.
    // Winners are no longer published: clients rank by score themselves.
    gsts.f.setCustomVariable(level, 'nimmt_pub', pub)
    // Private hands only when they changed (deal, reveal, seating): during the
    // card-by-card resolve a publish is then 3 ticks instead of 3 + seats.
    if (gsts.f.get('meDirty') as unknown as boolean) {
      gsts.f.set('meDirty', false)
      gsts.f.set('pubSeat', 1n)
      gsts.f.set('pubStage', 3n)
    } else {
      gsts.f.set('pubStage', 4n)
    }
  } else if (stage === 3n) {
    // Private hands: only onto the seat's own player entity, only while that
    // human is present. One seat per tick.
    const p = gsts.f.get('pubSeat') as unknown as bigint
    const bot = gsts.f.get('bot') as unknown as bigint[]
    if (p <= n && (bot[idx(p - 1n)] === 0n || bot[idx(p - 1n)] === 3n)) {
      const seatEnt = gsts.f.get('seatEnt') as unknown as EntityValue[]
      const keys = gsts.f.get('keys') as unknown as bigint[]
      const hands = gsts.f.get('hands') as unknown as bigint[]
      const handCount = gsts.f.get('handCount') as unknown as bigint[]
      const me = gsts.f.get('me') as unknown as bigint[]
      const cnt = handCount[idx(p - 1n)]
      me[idx(0n)] = p
      for (let i = 0n; i < HAND_SLOTS; i++) {
        let c = 0n
        if (i < cnt) {
          c = hands[idx((p - 1n) * HAND_SLOTS + i)]
        }
        me[idx(i + 1n)] = c
      }
      me[idx(11n)] = keys[idx(p - 1n)]
      // [12] = the card this seat has locked in this round (0 = none), so the
      // player sees which card the AI / timeout picked for them
      const pendingMe = gsts.f.get('pending') as unknown as bigint[]
      me[idx(12n)] = pendingMe[idx(p - 1n)]
      gsts.f.setCustomVariable(seatEnt[idx(p - 1n)], 'nimmt_me', me)
    }
    gsts.f.set('pubSeat', p + 1n)
    if (p >= n) {
      gsts.f.set('pubStage', 4n)
    }
  } else {
    gsts.f.set('rev', (gsts.f.get('rev') as unknown as bigint) + 1n)
    gsts.f.setCustomVariable(level, 'nimmt_rev', gsts.f.get('rev') as unknown as bigint)
    gsts.f.set('pubStage', 0n)
  }
}

// The scheduler body (one call site). phase is read once per tick: the
// else-if chain runs before any job changes it, except right after
// RevealStep, which re-reads it. Saves ~20 nodes of repeated reads.
function gstsServerTick() {
  const ph = gsts.f.get('phase') as unknown as string
  // every seat has a card / is ready (one AllIn call site for lobby and select)
  const allIn = gstsServerAllIn()
  // Tick counter for the every-10-ticks jobs (lobby seating, presence).
  const tn = (gsts.f.get('tickNo') as unknown as bigint) + 1n
  gsts.f.set('tickNo', tn)
  // Phase clock in REAL ticks: it also runs while a publish occupies the tick
  // (it used to count only job ticks, so a 30 s turn took ~40-57 s of wall
  // time). Every transition into select/chooseRow/handEnd resets it.
  const dt = (gsts.f.get('deadlineTicks') as unknown as bigint) + 1n
  gsts.f.set('deadlineTicks', dt)
  // ONE heavy job per tick: the real server silently killed the timer
  // when finishing the deal, placing rows and publishing ran in the same
  // execution (per-execution load budget, 2026-09-26).
  // start a publish when something changed (single PublishStep call site below)
  if (
    (gsts.f.get('pubStage') as unknown as bigint) === 0n &&
    (gsts.f.get('dirty') as unknown as boolean) &&
    ph !== 'deal' &&
    ph !== 'dealing'
  ) {
    gsts.f.set('dirty', false)
    gsts.f.set('pubStage', 1n)
  }
  if ((gsts.f.get('pubStage') as unknown as bigint) > 0n) {
    gstsServerPublishStep()
  } else if (ph === 'lobby') {
    if (tn % 10n === 0n || (gsts.f.get('clearReady') as unknown as boolean)) {
      gstsServerLobbySeat()
      gsts.f.set('dirty', true)
    }
    // Single Start call site. Everyone seated is ready: start once everyone the
    // match expects has loaded, or anyway after ~60 s (200 ticks) so one stuck
    // loader cannot block the room.
    if (allIn) {
      const waited = (gsts.f.get('loadWait') as unknown as bigint) + 1n
      gsts.f.set('loadWait', waited)
      if (
        (gsts.f.get('humans') as unknown as bigint) >=
          (gsts.f.get('expected') as unknown as bigint) ||
        waited >= 200n
      ) {
        gsts.f.set('loadWait', 0n)
        gstsServerStart(
          (gsts.f.get('settings') as unknown as bigint) % 10n,
          (gsts.f.get('settings') as unknown as bigint) / 10n
        )
      }
    } else {
      gsts.f.set('loadWait', 0n)
    }
  } else if (ph === 'deal') {
    gstsServerShuffle()
  } else if (ph === 'dealing') {
    gstsServerDealSome()
    gsts.f.set('dirty', true)
  } else if (ph === 'gameOver') {
    // Result screen: once every human answered, or after RESULT_TICKS, more
    // than half voting "play again" reopens the lobby; otherwise the level is
    // settled for everyone.
    const voted = gsts.f.get('voted') as unknown as bigint[]
    const botR = gsts.f.get('bot') as unknown as bigint[]
    let again = 0n
    let answered = 0n
    for (let s = 0n; s < MAX_SEATS; s++) {
      if (botR[idx(s)] === 0n || botR[idx(s)] === 3n) {
        if (voted[idx(s)] !== 0n) {
          answered = answered + 1n
        }
        if (voted[idx(s)] === 1n) {
          again = again + 1n
        }
      }
    }
    const humansR = gsts.f.get('humans') as unknown as bigint
    // A play-again majority decides at once; if time runs out (or everyone
    // answered) without one, everyone is settled.
    if (again * 2n > humansR || answered >= humansR || dt >= RESULT_TICKS) {
      if (again * 2n > humansR) {
        gsts.f.set('phase', 'lobby')
        gsts.f.set('clearReady', true)
      } else {
        gsts.f.set('phase', 'settled')
        gsts.f.settleStage()
      }
      gsts.f.set('dirty', true)
    } else if (dt % 10n === 0n) {
      gsts.f.set('dirty', true) // refresh the vote count / countdown
    }
  } else if (ph !== 'lobby' && ph !== 'settled') {
    if (tn % 10n === 0n) {
      if (gstsServerPresence()) {
        gsts.f.set('dirty', true)
        gsts.f.set('meDirty', true)
      }
    }
    if (gsts.f.get('rowsDirty') as unknown as boolean) {
      // Row penalties are only re-summed after the rows changed.
      gstsServerScoreRows()
      gsts.f.set('rowsDirty', false)
    }
    if (ph === 'reveal' || ph === 'resolve') {
      gstsServerStep()
      gsts.f.set('dirty', true)
    } else if (ph === 'revealing') {
      gstsServerRevealStep()
    } else if (ph === 'handEnd') {
      if (dt >= HAND_END_TICKS) {
        gsts.f.set('phase', 'deal')
      }
    } else {
      // select / chooseRow — at most one of: apply a row pick, reveal, auto-play
      if (ph === 'chooseRow' && (gsts.f.get('chosenRow') as unknown as bigint) > 0n) {
        // Single Choose call site: the waiting human (via the signal) or the
        // bot/timeout (via AutoAct) only recorded which row to take.
        gstsServerChoose(
          gsts.f.get('waiting') as unknown as bigint,
          gsts.f.get('chosenRow') as unknown as bigint,
          gsts.f.get('token') as unknown as bigint
        )
        gsts.f.set('chosenRow', 0n)
        gsts.f.set('dirty', true)
      } else if (ph === 'select' && allIn) {
        // Everyone locked a card: reveal over the next ticks.
        gsts.f.set('revealSeat', 1n)
        gsts.f.set('phase', 'revealing')
      } else {
        // Bot/timeout moves only flip "ready" flags; the periodic refresh
        // below publishes them (a publish takes several ticks).
        gstsServerAutoAct()
      }
      if (dt % 10n === 0n) {
        gsts.f.set('dirty', true) // refresh countdown + ready flags every ~3 s
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Entry: server authority graph. `id` is a placeholder — see obstacles below.
// ----------------------------------------------------------------------------
g.server({
  id: 1073741825,
  variables: {
    n: 2n,
    humans: 0n,
    mode: 'quick',
    handNo: 0n,
    round: 0n,
    token: 0n,
    revision: 0n,
    rev: 0n,
    dirty: false,
    rowPts: list('int', new Array(4).fill(0n)),
    bestRow: 1n,
    chosenRow: 0n,
    revealSeat: 1n,
    keys: list('int', new Array(8).fill(0n)),
    seatEnt: list('entity', []),
    // Lobby settings, bots + 10*mode (published as nimmt_pub[11]).
    settings: 0n, // 0 bots by default (Start still seats at least 2)
    forcedRow: 0n, // row picked in chooseRow, taken by the next Step
    emo: list('int', new Array(16).fill(0n)), // Level.nimmt_emo: [0-7] per seat seq*10 + last emote (1-8); [8-15] token of the round the seat locked a card in
    expected: 1n, // players the match expects (queryGameModeAndPlayerNumber)
    loadWait: 0n, // lobby checks spent waiting for slow loaders
    // Set when everyone must un-ready (settings changed / back from results);
    // the next tick's LobbySeat clears the ready flags.
    clearReady: false,
    // Private hands need re-publishing (see PublishStep stage 2).
    meDirty: true,
    seatVia: 0n,
    autoSeat: 1n,
    tickNo: 0n,
    rowsDirty: true,
    qkey: list('int', new Array(8).fill(0n)),
    pubStage: 0n,
    pubSeat: 1n,
    deckGrown: false,
    pub: list('int', new Array(96).fill(0n)),
    dealSeat: 1n,
    want: list('int', new Array(8).fill(0n)),
    phase: 'lobby',
    waiting: 0n,
    cursor: 0n,
    endReason: '',
    deadlineTicks: 0n,
    scores: list('int', new Array(8).fill(0n)),
    pending: list('int', new Array(8).fill(0n)),
    bot: list('int', new Array(8).fill(1n)),
    voted: list('int', new Array(8).fill(0n)),
    handCount: list('int', new Array(8).fill(0n)),
    hands: list('int', new Array(80).fill(0n)),
    rowCount: list('int', new Array(4).fill(0n)),
    rows: list('int', new Array(20).fill(0n)),
    queueCard: list('int', new Array(8).fill(0n)),
    queuePlayer: list('int', new Array(8).fill(0n)),
    queueLen: 0n,
    // Default-value lists are capped at 100 items by the editor; Deal grows it to 104.
    deck: list('int', new Array(100).fill(0n)),
    // Publish buffers (written into custom variables by gstsServerPublish).
    // phase, mode, endReason, 3 unused, then seat 1..8 nicknames ('' = bot)
    text: list('str', new Array(14).fill('')),
    me: list('int', new Array(13).fill(0n)),
    // Reusable scratch buffers, so per-seat/per-row operations never need a
    // dynamically-named variable (string concatenation doesn't compile).
    scratch10: list('int', new Array(10).fill(0n)),
    scratch4: list('int', new Array(4).fill(0n))
  }
})
  .on('whenEntityIsCreated', (_evt, f) => {
    const keys = f.get('keys')
    for (let s = 0n; s < MAX_SEATS; s++) {
      keys[idx(s)] = f.getRandomInteger(1n, 999999n)
    }
    f.set('dirty', true)
    // Settlement status (user request 2026-10-02): leaving must not require
    // finishing a match. Every 90 s from level start everyone on the field is
    // (re)marked Victory, finished game or not (a finished game marks it too,
    // see gstsServerFinish). The stage itself is NOT settled here - each player
    // is settled with that status when they leave.
    setInterval(() => {
      const everyone = f.getListOfPlayerEntitiesOnTheField()
      for (const pl of everyone) {
        f.setPlayerSettlementSuccessStatus(pl, SettlementStatus.Victory)
      }
    }, 90000)
    // Single central scheduler (see NODE BUDGET at the top): presence, deal,
    // automatic moves, reveal, stepping, the hand-end pause and the ONLY
    // publish. f.get() is read inline at each use — caching it in a local
    // const inside this callback failed to compile ("Generic parameter not
    // matched").
    setInterval(() => {
      gstsServerTick()
    }, TICK_MS)
  })
  // Signal handlers only change state and mark it dirty; the tick publishes
  // within TICK_MS.
  .onSignal(Signal.NimmtSync, (_evt, f) => {
    f.set('dirty', true)
  })
  // Every client intent: NimmtAct(seat, key, kind, token, value).
  //   kind 1 submit a card (value = card)   2 take a row (value = row 1-4)
  //   3 vote to settle the level (result screen)   4 lobby ready (value = ready 0/1;
  //   a ready from the result screen reopens the lobby)
  //   5 lobby settings (value = 10*bots + 100*mode), published in nimmt_pub[11]
  //   6 托管 autopilot (value 1 on / 0 off; bot flag 3)
  //   7 music: value = background-music ID, 0 = pause (only for the sender)
  //   8 emote 1-8 (shown to everyone next to the sender's ranking box)
  // Handlers only record intents and mark dirty; the tick does the work.
  .onSignal(Signal.NimmtAct, (evt, f) => {
    const seat = gstsServerAuth(evt.params.seat, evt.params.key)
    const kind = evt.params.kind
    const value = evt.params.value
    if (seat > 0n) {
      if (kind === 1n && evt.params.token === f.get('token')) {
        const want = f.get('want')
        want[idx(seat - 1n)] = value
      } else if (
        kind === 2n &&
        seat === f.get('waiting') &&
        f.get('phase') === 'chooseRow' &&
        evt.params.token === f.get('token') &&
        value >= 1n &&
        value <= 4n
      ) {
        f.set('chosenRow', value)
      } else if (kind === 3n && f.get('phase') === 'gameOver') {
        // Result screen: value 1 = play again, 2 = settle. The tick decides
        // once everyone answered or the countdown (RESULT_TICKS) runs out.
        const voted = f.get('voted')
        voted[idx(seat - 1n)] = value
        f.set('dirty', true)
      } else if (kind === 6n && f.get('phase') !== 'lobby' && f.get('phase') !== 'gameOver') {
        // 托管: value 1 hands the seat to the AI (AutoAct plays it), 0 takes it back.
        const botA = f.get('bot')
        let flag = 0n
        if (value === 1n) {
          flag = 3n
        }
        botA[idx(seat - 1n)] = flag
        // No timer change here (a grace period could be chained by several
        // players toggling). Near the timeout the normal timeout auto-play
        // applies; the owner sees the locked card via nimmt_me[12].
        f.set('dirty', true)
      } else if (kind === 8n && value >= 1n && value <= 8n) {
        // Emote: remember seq*10 + emote for the seat (the seq digit lets the
        // same emote twice in a row still show again); published at once in Level.nimmt_emo.
        const emo = f.get('emo')
        const seq = ((emo[idx(seat - 1n)] / 10n + 1n) % 10n) * 10n
        emo[idx(seat - 1n)] = seq + value
        // Published at once on its own Level variable (nimmt_emo, IntList 8):
        // going through the multi-tick table publish made emotes 1-3 s late.
        f.setCustomVariable(level, 'nimmt_emo', emo)
      } else if (kind === 7n) {
        // Music (per player): value = a background-music ID from the editor's
        // music library (the client cycles its list), 0 = pause.
        const ents = f.get('seatEnt') as unknown as EntityValue[]
        const who = ents[idx(seat - 1n)] as unknown as PlayerEntity
        if (value > 0n) {
          f.modifyPlayerBackgroundMusic(who, value, 0, 9999, 100n, true, 0, 1, true)
          f.startPausePlayerBackgroundMusic(who, true)
        } else {
          f.startPausePlayerBackgroundMusic(who, false)
        }
      } else if (kind === 4n) {
        if (f.get('phase') === 'lobby') {
          const pending = f.get('pending')
          pending[idx(seat - 1n)] = value % 10n
          f.set('dirty', true)
          // the lobby tick starts the match (single Start call site)
        }
      } else if (kind === 5n && seat === 1n && f.get('phase') === 'lobby') {
        // Only the host (seat 1 = first player on the field) may change the settings.
        // Lobby settings (value = 10*bots + 100*mode) are shared: any player
        // may change them, which un-readies everyone. From the result screen
        // (player went Home -> Start instead of Replay) it also reopens the
        // lobby - before, the change was dropped and the old bot count used.
        f.set('settings', value / 10n)
        f.set('clearReady', true)
      }
    }
  })

/* ============================================================================
 * OBSTACLES — 需要你在编辑器里手动完成，我这边做不了 (see AGENTS.md/CLAUDE.md
 * "Hard Rules": every non-trivial feature must separate code vs editor setup)
 * ============================================================================
 *
 * 1. 【服务器信号管理器】只需要注册 5 个"客户端 → 服务端"信号（参数顺序 = Lua
 *    AddInt 的顺序）。之前那个 56 参数的 NimmtSnapshot 和 NimmtError 都不要了：
 *
 *    NimmtSync       (无参数)
 *    NimmtStart      bots(整数), mode(整数: 0 快速局 / 1 标准局)
 *    NimmtSubmit     token(整数), card(整数)
 *    NimmtChooseRow  token(整数), row(整数)
 *    NimmtVote       token(整数), kind(整数: 1 提前结算本局 / 2 结算离开)
 *
 * 2. 定义 4 个自定义变量（服务端写、客户端 Lua 读）：
 *    关卡实体： nimmt_pub  整数列表（96 项）
 *               nimmt_text 字符串列表（6 项）
 *               nimmt_rev  整数
 *    玩家实体： nimmt_me   整数列表（11 项）
 *    列表长度以实际写入为准；如果编辑器要求填默认值，填空列表/0 即可。
 *
 * 3. 关卡设置 → 结算：把【排名数值比较顺序】设成"越小越靠前"（罚分越低越好）。
 *
 * 4. 【已完成 2026-09-25：mapId 见本地配置，节点图 1073741825（关卡实体上的
 *    empty_node），已提取 Signal 并注入成功】
 *    新建一个空的服务器节点图，保存关卡，记下节点图 ID；跑 `npm run maps` 找到
 *    mapId；把 gsts.config.ts 的 inject 配置填好，并把本文件 `id: 1073741825`
 *    换成真实节点图 ID。跑 `npm run build` 首次注入，会生成
 *    src/resources/signals.ts —— 然后把各个 `.onSignal('NimmtXxx', ...)` 换成
 *    `Signal.NimmtXxx`，删掉 `evt.params.参数_1/参数_2` 那几处占位 cast，按你在
 *    信号管理器里起的参数名读取（token/card/row/bots/mode/kind），再编译一次。
 *    这一步我没法替你做：字符串字面量形式的 onSignal 没有类型化的 params。
 *
 * 5. 两个真实客户端交叉测试，重点验证这些从文档推断、从未真机跑过的假设：
 *    - evt.signalSourceEntity 对比 player(p) 能否可信地认出座位；
 *    - 在场玩家列表里的玩家是否正好是 player(1..人数)（座位映射）；
 *    - 玩家实体上的 nimmt_me 是否只有本人能读到（A 读不到 B 的手牌）；
 *    - 客户端的 RegisterCustomVariableChangedHandler 是否在服务端写入时触发；
 *    - 列表类型自定义变量在 Lua 里是否是 1 开始的普通表（client.lua 按此假设）；
 *    - 掉线再进入：同一局是否还在、player(p) 序号是否不变、手牌能否恢复；
 *    - 【结算关卡】之后的官方结算界面与排名是否正确。
 * ==========================================================================*/

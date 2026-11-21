'use strict';

// eフィーバー妖怪ウォッチ シミュレーター（画面と状態遷移）。確率は logic.js。
// 流れ：通常時 →（入賞時フラッシュ）→ 大当たり
//   ├ 3000個（7図柄）→ RUSH「ヨーデルSONIC怪闘」
//   └ 妖怪FEVER 300個 → 妖怪ガシャチャレンジ → 成功：RUSH ／ 失敗：コマチャレンジ
// RUSH：直撃当たり（SONIC FEVER・ピン刺し・エンマインパクト・ウバウネ決戦）で継続、
//       最終決戦で負けたら転落 → コマチャレンジ（時短100回）→ 引き戻せばRUSHへ、外せば通常へ

const game = {
  state: 'normal_idle',
  mode: 'normal', // normal / rush / koma
  spinRate: DEFAULT_SPIN_RATE,
  flash: DEFAULT_FLASH,
  mochiDama: 0,
  toushi: 0,
  totalSpins: 0,
  currentSpins: 0,
  lastHitSpins: 0,
  normalHitCount: 0,
  rushEntryCount: 0,
  komaPullbackCount: 0,
  komaStreak: 0,     // 初当たりでコマチャレンジに行った連続回数（初当たりでRUSHに入るとリセット）
  lastRushSpins: 0,  // 最後に初当たりでRUSHに入ったときの通常時総回転数
  totalRushHits: 0,
  rushAllStats: { totalSpins: 0, finalBattles: 0, finalWins: 0 },
  session: null, // 初当たりから通常に戻るまでの1回分 { hits, nominalBalls, actualBalls, everRush, cycleSpins }
  komaRemaining: 0,
  pending: {},
  eigyoAlertShown: false,
  detailsExpanded: false,
  lastRankResult: null,
  hitHistory: [], // 大当たり履歴 [{games, chain}]（新しい順。chain=null は結果待ち、0は単発）
  slump: [{ x: 0, y: 0 }],
  log: [],
};

function addLog(text, type = '') {
  game.log.unshift({ text, type });
  if (game.log.length > 50) game.log.pop();
  renderLog();
}

// ---- ランキング ----

const RANK_KEY = 'youkaiwatchRankingV1';

function loadRanking() {
  try {
    const raw = localStorage.getItem(RANK_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveRanking(list) {
  try {
    localStorage.setItem(RANK_KEY, JSON.stringify(list));
  } catch (e) {}
}

function recordRanking(balls, renchan) {
  const list = loadRanking();
  const d = new Date();
  const entry = { balls, renchan, date: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` };
  list.push(entry);
  list.sort((a, b) => b.balls - a.balls);
  const trimmed = list.slice(0, 10);
  saveRanking(trimmed);
  return { list: trimmed, entry, madeList: trimmed.includes(entry) };
}

function renderRankingList(list, highlightEntry) {
  if (list.length === 0) return `<div class="rr-label" style="text-align:center;">まだ記録がありません</div>`;
  return list.map((r, i) => {
    const isNew = r === highlightEntry;
    return `<div class="result-row${isNew ? ' rank-new' : ''}">
      <span class="rr-label">${i + 1}位${isNew ? ' 🆕' : ''}</span>
      <span class="rr-val${isNew ? ' gold' : ''}">${r.balls.toLocaleString()}球（${r.renchan}連）<span class="rank-date">${r.date}</span></span>
    </div>`;
  }).join('');
}

function handleShowRanking() {
  setState('ranking_view');
}

function handleRankingBack() {
  setState('normal_idle');
}

// ---- 設定 ----

function handleSpinRateChange(value) {
  game.spinRate = Number(value);
  render();
}

function handleFlashChange(value) {
  game.flash = value;
  render();
}

// ---- 球数・投資（等価：1000円=250玉） ----

function consumeSpinCost() {
  const cost = calcSpinCost(game.spinRate);
  if (game.mochiDama >= cost) {
    game.mochiDama -= cost;
  } else {
    const shortfall = cost - game.mochiDama;
    const perThousand = 1000 / YEN_PER_BALL;
    const units = Math.ceil(shortfall / perThousand);
    game.toushi += units * 1000;
    game.mochiDama = units * perThousand - shortfall;
  }
  recordSlump();
}

function addBalls(n) {
  game.mochiDama += n;
}

// 当たりの出玉を払い出し、今回のセッションの合計にも足す
function award(nominal) {
  const actual = toActualBalls(nominal);
  addBalls(actual);
  if (game.session) {
    game.session.nominalBalls += nominal;
    game.session.actualBalls += actual;
  }
  return actual;
}

// ---- 通常時 ----

function checkEigyoAlert() {
  if (!game.eigyoAlertShown && game.totalSpins >= 2000) {
    game.eigyoAlertShown = true;
    setState('eigyo_alert');
    return true;
  }
  return false;
}

// 1回転処理。フラッシュが出たら true を返す（外れは何も起きず回転数だけ進む）
function runNormalSpin() {
  game.totalSpins++;
  game.currentSpins++;
  consumeSpinCost();
  const outcome = spinNormal(game.flash);
  if (outcome === 'miss') return false;

  const interval = game.totalSpins - game.lastHitSpins;
  if (outcome === 'false_flash') {
    game.pending = { isHit: false, interval };
  } else {
    const type = rollNormalHitType();
    const gasha = type === 'youkai' ? rollGasha() : null;
    game.pending = { isHit: true, interval, type, gasha };
    // EXのときは、フラッシュ＝RUSH確定。RUSHにならない当たりはフラッシュなしで「通常当たり」として出す
    if (game.flash === 'EX' && type === 'youkai' && !gasha.success) {
      startSession(interval);
      markFirstHitKoma();
      const actual = award(300);
      addLog(`${interval}回転で通常当たり ＋${actual}球`, 'win');
      setState('ex_normal');
      return true;
    }
  }
  addLog(`${interval}回転で入賞時フラッシュ！`);
  setState('flash');
  return true;
}

function handleStart() {
  if (checkEigyoAlert()) return;
  if (!runNormalSpin()) setState('normal_idle');
}

function autoSpin(count) {
  for (let i = 0; i < count; i++) {
    if (checkEigyoAlert()) return;
    if (runNormalSpin()) return;
  }
  setState('normal_idle');
}

function startSession(interval) {
  game.normalHitCount++;
  game.hitHistory.unshift({ games: interval, chain: null });
  game.currentSpins = 0;
  game.lastHitSpins = game.totalSpins;
  game.session = { hits: 1, nominalBalls: 0, actualBalls: 0, everRush: false, cycleSpins: 0 };
}

// 初当たりの行き先を記録：RUSHならコマ連続をリセット、コマチャレンジなら+1
function markFirstHitRush() {
  game.komaStreak = 0;
  game.lastRushSpins = game.totalSpins;
}
function markFirstHitKoma() {
  game.komaStreak++;
}

function handleFlashJudge() {
  const p = game.pending;
  if (!p.isHit) {
    addLog('はずれ');
    setState('flash_miss');
    return;
  }
  startSession(p.interval);
  if (p.type === 'legend') {
    markFirstHitRush();
    const actual = award(3000);
    addLog(`${p.interval}回転で大当たり！ レジェンドヨーデルエクストラ ＋${actual}球`, 'win');
    setState('legend_hit');
    return;
  }
  const actual = award(300);
  if (game.flash === 'EX') {
    // EXのフラッシュはRUSHになる当たりだけ
    markFirstHitRush();
    addLog(`${p.interval}回転で大当たり！ 妖怪FEVER ＋${actual}球 RUSH確定`, 'win');
    setState('ex_rush');
    return;
  }
  addLog(`${p.interval}回転で大当たり！ 妖怪FEVER ＋${actual}球`, 'win');
  setState('youkai_fever');
}

function backToNormal() {
  game.mode = 'normal';
  setState('normal_idle');
}

// ---- 妖怪ガシャチャレンジ ----

function handleGashaChallenge() {
  setState('gasha');
}

function handleGashaPush() {
  if (game.pending.gasha.success) {
    markFirstHitRush();
    addLog('妖怪ガシャチャレンジ 成功！', 'rush');
    setState('gasha_success');
  } else {
    markFirstHitKoma();
    addLog('妖怪ガシャチャレンジ 失敗');
    setState('gasha_fail');
  }
}

// ---- RUSH「ヨーデルSONIC怪闘」 ----

function enterRush() {
  if (!game.session.everRush) {
    game.session.everRush = true;
    game.rushEntryCount++;
  }
  game.mode = 'rush';
  game.session.cycleSpins = 0;
  setState('rush_idle');
}

function rushHit(kind) {
  game.totalRushHits++;
  game.session.hits++;
  const spins = game.session.cycleSpins;
  game.session.cycleSpins = 0;
  return spins;
}

const RUSH_HIT_LABELS = {
  sonic: 'SONIC FEVER',
  pin_fail: 'SONIC FEVER',
  pin_success: 'SONIC FEVER',
  enma: 'エンマインパクト',
  ubaune: 'ウバウネ決戦',
};

// 1回転処理。画面遷移が起きたら true を返す
function runRushSpin(opts = {}) {
  game.rushAllStats.totalSpins++;
  game.session.cycleSpins++;
  const outcome = spinRush();

  if (outcome === 'miss') {
    // 外れは「外れ」画面を出さず、そのまま続けて押せるようにする
    if (!opts.silent) {
      setState('rush_idle');
      return true;
    }
    return false;
  }

  if (outcome === 'final_battle') {
    game.rushAllStats.finalBattles++;
    game.pending = { spins: game.session.cycleSpins };
    addLog(`${game.session.cycleSpins}回転で最終決戦！`, 'rush');
    setState('final_battle');
    return true;
  }

  const type = rollRushHitType();
  const spins = rushHit(type);
  if (type === 'ubaune') {
    award(UBAUNE_BASE);
    game.pending = { type, spins, total: UBAUNE_BASE, wins: 0, last: null };
    addLog(`${spins}回転で当選！ ウバウネ決戦 ${UBAUNE_BASE}個`, 'rush');
    setState('ubaune_intro');
    playUbauneIntro();
    return true;
  }
  const nominal = type === 'enma' ? 3000 : 1500; // ピン刺し成功分の1500個はジャッジ後に足す
  const actual = award(nominal);
  game.pending = { type, spins, nominal };
  addLog(`${spins}回転で当選！ ${RUSH_HIT_LABELS[type]} ＋${actual}球`, 'rush');
  setState('rush_hit');
  return true;
}

// ウバウネ決戦の入り：SONIC FEVERを見せて（次へは押せない）、1秒後に画面全体を暗転してウバウネ決戦へ
const UBAUNE_INTRO_WAIT_MS = 1000;
const BLACKOUT_FADE_MS = 500;
const BLACKOUT_HOLD_MS = 300;

function playUbauneIntro() {
  setTimeout(() => {
    if (game.state !== 'ubaune_intro') return;
    const overlay = document.createElement('div');
    overlay.className = 'blackout';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('on'));
    setTimeout(() => {
      setState('ubaune');
      overlay.classList.remove('on');
      setTimeout(() => overlay.remove(), BLACKOUT_FADE_MS);
    }, BLACKOUT_FADE_MS + BLACKOUT_HOLD_MS);
  }, UBAUNE_INTRO_WAIT_MS);
}

function handleRushSpin() {
  runRushSpin();
}

function handleRushSpin10() {
  for (let i = 0; i < 10; i++) {
    if (runRushSpin({ silent: true })) return;
  }
  setState('rush_idle');
}

// 当たりか最終決戦まで一気に回す
function handleRushSkip() {
  while (!runRushSpin({ silent: true })) { /* 外れは飛ばす */ }
}

function handleRushHitContinue() {
  const t = game.pending.type;
  if (t === 'pin_fail' || t === 'pin_success') {
    setState('pin_chance');
    return;
  }
  setState('rush_idle');
}

function handlePinJudge() {
  if (game.pending.type === 'pin_success') {
    const actual = award(1500);
    game.pending.nominal = 3000;
    addLog(`ピン刺しチャンス成功！ レジェンドヨーデルエクストラ ＋${actual}球`, 'rush');
    setState('pin_success');
  } else {
    addLog('ピン刺しチャンス 失敗');
    setState('pin_fail');
  }
}

function handleUbauneBattle() {
  const p = game.pending;
  if (rollUbauneBattle()) {
    p.wins++;
    p.total += UBAUNE_ADD;
    p.last = 'win';
    const actual = award(UBAUNE_ADD);
    addLog(`ウバウネ決戦 勝利！ ＋${actual}球（合計${p.total.toLocaleString()}個）`, 'rush');
    render();
  } else {
    p.last = 'lose';
    addLog(`ウバウネ決戦 終了（合計${p.total.toLocaleString()}個）`, 'rush');
    setState('ubaune_end');
  }
}

function handleFinalBattle() {
  if (rollFinalBattle()) {
    game.rushAllStats.finalWins++;
    rushHit('final');
    const actual = award(1500);
    addLog(`最終決戦 勝利！ ＋${actual}球 RUSH継続`, 'rush');
    setState('final_win');
  } else {
    addLog('最終決戦 敗北… RUSH終了');
    setState('final_lose');
  }
}

// ---- コマチャレンジ（時短100回） ----

function enterKoma() {
  game.mode = 'koma';
  game.komaRemaining = KOMA_SPINS;
  addLog(`コマチャレンジ突入（時短${KOMA_SPINS}回）`);
  setState('koma_idle');
}

// 1回転処理。画面遷移が起きたら true を返す
function runKomaSpin(opts = {}) {
  game.komaRemaining--;
  game.session.cycleSpins++;
  if (spinKoma() === 'hit') {
    game.komaPullbackCount++;
    const spins = rushHit('koma');
    const actual = award(1500);
    game.pending = { spins };
    addLog(`コマチャレンジ${KOMA_SPINS - game.komaRemaining}回転目で引き戻し！ ＋${actual}球`, 'rush');
    setState('koma_hit');
    return true;
  }
  if (game.komaRemaining <= 0) {
    endSession();
    return true;
  }
  if (!opts.silent) {
    setState('koma_idle');
    return true;
  }
  return false;
}

function handleKomaSpin() {
  runKomaSpin();
}

function handleKomaSpin10() {
  for (let i = 0; i < 10; i++) {
    if (runKomaSpin({ silent: true })) return;
  }
  setState('koma_idle');
}

// 当たりか、残り10回まで一気に回す
function handleKomaSkip() {
  for (;;) {
    if (runKomaSpin({ silent: true })) return;
    if (game.komaRemaining <= 10) {
      setState('koma_idle');
      return;
    }
  }
}

// コマチャレンジを外して通常へ戻るとき
function endSession() {
  const s = game.session;
  const last = game.hitHistory[0];
  if (last && last.chain === null) last.chain = s.everRush ? s.hits : 0;
  if (s.everRush) {
    game.lastRankResult = recordRanking(Math.round(s.actualBalls), s.hits);
    addLog(`コマチャレンジ終了 → ${s.hits}連で終了`);
    setState('session_result');
  } else {
    addLog('コマチャレンジ終了 → 通常時へ');
    setState('koma_end');
  }
}

function handleSessionEnd() {
  game.mode = 'normal';
  game.session = null;
  setState('normal_idle');
}

// ---- 営業終了・退店 ----

function idleStateForMode() {
  if (game.mode === 'rush') return 'rush_idle';
  if (game.mode === 'koma') return 'koma_idle';
  return 'normal_idle';
}

function handleEigyoHai() {
  setState(idleStateForMode());
}

function handleEigyoIie() {
  setState('taiten_result');
}

function handleTaiten() {
  setState('taiten_result');
}

function resetGame() {
  Object.assign(game, {
    state: 'normal_idle',
    mode: 'normal',
    spinRate: DEFAULT_SPIN_RATE,
    flash: DEFAULT_FLASH,
    mochiDama: 0,
    toushi: 0,
    totalSpins: 0,
    currentSpins: 0,
    lastHitSpins: 0,
    normalHitCount: 0,
    rushEntryCount: 0,
    komaPullbackCount: 0,
    komaStreak: 0,
    lastRushSpins: 0,
    totalRushHits: 0,
    rushAllStats: { totalSpins: 0, finalBattles: 0, finalWins: 0 },
    session: null,
    komaRemaining: 0,
    pending: {},
    eigyoAlertShown: false,
    detailsExpanded: false,
    lastRankResult: null,
    hitHistory: [],
    slump: [{ x: 0, y: 0 }],
    log: [],
  });
  renderLog();
  render();
}

// ---- 状態セット & レンダリング ----

function setState(state) {
  game.state = state;
  render();
}

// ---- 大当たり履歴グラフ ----
const HIST_BLOCK = 100;
const HIST_MAX_BLOCKS = 7;
function renderHitGraph() {
  const el = document.getElementById('hist-cols');
  if (!el) return;
  const col = (cls, games, label, idx) => {
    const blocks = Math.min(HIST_MAX_BLOCKS, Math.max(1, Math.ceil(games / HIST_BLOCK)));
    const more = games >= HIST_BLOCK * HIST_MAX_BLOCKS ? '<div class="hist-more">▲</div>' : '';
    return `<div class="hist-col ${cls}">
      <div class="hist-g">${games}</div>${more}
      ${'<div class="hist-block"></div>'.repeat(blocks)}
      <div class="hist-type">${label}</div>
      <div class="hist-idx">${idx}</div>
    </div>`;
  };
  let html = col('now', game.currentSpins, '現在', '');
  game.hitHistory.forEach((h, i) => {
    let cls, label;
    if (h.chain === null) { cls = 'pending'; label = '…'; }
    else if (h.chain >= 1) { cls = h.chain >= 10 ? 'big-chain' : 'rush'; label = `${h.chain}連`; }
    else { cls = 'zugar'; label = '単発'; }
    html += col(cls, h.games, label, i + 1);
  });
  if (game.hitHistory.length === 0) html += '<div class="hist-empty">まだ大当たりがありません</div>';
  el.innerHTML = html;
}

// ---- 差玉推移グラフ ----
// 差玉 = 持ち玉 − 投資玉（投資は4円/玉で玉に換算）。横軸は通常時の総回転数
function currentDiffBalls() {
  return Math.round(game.mochiDama - game.toushi / YEN_PER_BALL);
}
function recordSlump() {
  if (!game.slump) game.slump = [{ x: 0, y: 0 }];
  const y = currentDiffBalls();
  const pts = game.slump;
  const last = pts[pts.length - 1];
  if (last.x === game.totalSpins && last.y === y) return;
  pts.push({ x: game.totalSpins, y });
  if (pts.length > 40000) game.slump = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
}
function slumpNiceStep(range) {
  const raw = range / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
function renderSlumpGraph() {
  const el = document.getElementById('slump-svg');
  if (!el) return;
  recordSlump();
  const pts = game.slump;
  const W = 360, H = 170, L = 46, R = 8, T = 10, B = 22;
  const maxX = Math.max(100, pts[pts.length - 1].x);
  let minY = 0, maxY = 0;
  pts.forEach((p) => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  if (maxY - minY < 1000) { maxY += 500; minY -= 500; }
  const step = slumpNiceStep(maxY - minY);
  minY = Math.floor(minY / step) * step;
  maxY = Math.ceil(maxY / step) * step;
  const sx = (x) => L + (x / maxX) * (W - L - R);
  const sy = (y) => T + (1 - (y - minY) / (maxY - minY)) * (H - T - B);
  let grid = '';
  for (let v = minY; v <= maxY + 1e-9; v += step) {
    const y = sy(v).toFixed(1);
    grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="${v === 0 ? 'sl-zero' : 'sl-grid'}"/>`;
    grid += `<text x="${L - 4}" y="${(+y + 3).toFixed(1)}" class="sl-ylab">${v.toLocaleString()}</text>`;
  }
  const xStep = slumpNiceStep(maxX);
  for (let v = 0; v <= maxX + 1e-9; v += xStep) {
    const anchor = sx(v) > W - R - 16 ? ' style="text-anchor:end"' : '';
    grid += `<text x="${sx(v).toFixed(1)}" y="${H - 6}" class="sl-xlab"${anchor}>${v.toLocaleString()}</text>`;
  }
  const maxPts = (W - L - R) * 2;
  const stride = Math.max(1, Math.floor(pts.length / maxPts));
  const line = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1)
    .map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const cur = pts[pts.length - 1];
  const cls = cur.y >= 0 ? 'plus' : 'minus';
  // 0より上はプラス色、下はマイナス色で塗り分ける
  const zeroOff = Math.min(1, Math.max(0, (sy(0) - T) / (H - T - B))).toFixed(4);
  el.innerHTML = `<defs><linearGradient id="sl-grad" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - B}">
      <stop offset="${zeroOff}" stop-color="#2e9e5e"/><stop offset="${zeroOff}" stop-color="#d64545"/>
    </linearGradient></defs>
    ${grid}
    <polyline points="${line}" class="sl-line" stroke="url(#sl-grad)"/>
    <circle cx="${sx(cur.x).toFixed(1)}" cy="${sy(cur.y).toFixed(1)}" r="3" class="sl-dot ${cls}"/>`;
  document.getElementById('slump-now').innerHTML =
    `現在 <b class="${cls}">${cur.y >= 0 ? '+' : ''}${cur.y.toLocaleString()}玉</b>（${game.totalSpins.toLocaleString()}回転）`;
}

function render() {
  renderHeader();
  renderModeBadge();
  renderMainScreen();
  renderRushStats();
  renderHitGraph();
  renderSlumpGraph();
}

function handleToggleDetails() {
  game.detailsExpanded = !game.detailsExpanded;
  render();
}

function renderHeader() {
  const mochiInt = Math.floor(game.mochiDama);
  document.getElementById('mochi-dama').textContent = mochiInt.toLocaleString();
  document.getElementById('toushi-value').textContent = game.toushi.toLocaleString();

  const shuushi = Math.round(mochiInt * YEN_PER_BALL) - game.toushi;
  const shuushiEl = document.getElementById('shuushi-value');
  shuushiEl.textContent = (shuushi >= 0 ? '+' : '') + shuushi.toLocaleString();
  shuushiEl.className = 'money-value ' + (shuushi >= 0 ? 'green' : 'red');
  document.getElementById('current-spins').textContent = game.currentSpins.toLocaleString();
  document.getElementById('total-spins-disp').textContent = game.totalSpins.toLocaleString();

  const esupLabel = document.getElementById('esup-label');
  const esupValue = document.getElementById('rush-count');
  if (game.mode === 'koma') {
    esupLabel.textContent = '時短残り';
    esupValue.textContent = `${game.komaRemaining}回`;
  } else if (game.mode === 'rush') {
    esupLabel.textContent = '連チャン';
    esupValue.textContent = `${game.session.hits}連`;
  } else {
    esupLabel.textContent = '残り';
    esupValue.textContent = '－';
  }

  document.getElementById('total-hit-count').textContent = (game.normalHitCount + game.totalRushHits) + '回';
  document.getElementById('normal-first-hit').textContent = game.normalHitCount + '回';
  document.getElementById('normal-first-prob').textContent = game.normalHitCount > 0 && game.totalSpins > 0
    ? '1/' + Math.round(game.totalSpins / game.normalHitCount).toLocaleString()
    : '1/―';

  document.getElementById('rush-entry-count').textContent = game.rushEntryCount + '回';
  const rushEntryRate = game.normalHitCount > 0 ? Math.round(game.rushEntryCount / game.normalHitCount * 100) : 0;
  document.getElementById('rush-entry-info').textContent = `(突入率 ${rushEntryRate}%)`;
  document.getElementById('koma-pullback-count').textContent = game.komaPullbackCount + '回';

  document.getElementById('hrow2-detail').style.display = game.detailsExpanded ? 'flex' : 'none';
  document.getElementById('details-toggle').textContent = game.detailsExpanded ? '詳細▴' : '詳細▾';
}

function renderModeBadge() {
  const el = document.getElementById('mode-badge');
  if (game.mode === 'rush') {
    el.textContent = 'RUSH中';
    el.className = 'rush';
  } else if (game.mode === 'koma') {
    el.textContent = 'コマチャレンジ';
    el.className = 'koma';
  } else {
    el.textContent = '通常時';
    el.className = '';
  }
}

function renderMainScreen() {
  document.getElementById('main-screen').innerHTML = buildScreen(game.state);
}

function tenThousandYenSpins() {
  return game.spinRate * 10;
}

function spinRateOptionsHtml() {
  return SPIN_RATE_OPTIONS.map((rate) => {
    const note = rate === DEFAULT_SPIN_RATE ? '（ボーダー）' : '';
    return `<option value="${rate}" ${rate === game.spinRate ? 'selected' : ''}>${rate}回転${note}</option>`;
  }).join('');
}

function flashOptionsHtml() {
  return FLASH_OPTIONS.map((opt) => {
    const label = opt === 'EX' ? 'EX（RUSH確定）' : `信頼度${opt}%`;
    return `<option value="${opt}" ${opt === game.flash ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

function flashLabel() {
  return game.flash === 'EX' ? 'EX（RUSH確定）' : `${game.flash}%`;
}

// ---- 出現率の表示（他機種と同じ形） ----
function pctText(prob) {
  const pct = prob * 100;
  return pct >= 1 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : pct.toPrecision(2);
}
function rareText(prob) {
  return prob * 100 < 1 ? `<br>約${Math.round(1 / prob).toLocaleString()}回に1回の割合です` : '';
}
function rareNote(html) {
  return `<p class="rare-note">${html}</p>`;
}

// 初当たりのハマり：1000回転超・100回転未満は出現率を表示
function hitIntervalProbHtml(n) {
  if (n > 1000) {
    const p = hitIntervalProbability(n).atLeast;
    return rareNote(`${n.toLocaleString()}回転以上ハマる確率 ${pctText(p)}%${rareText(p)}`);
  }
  if (n < 100) {
    const p = hitIntervalProbability(n).within;
    return rareNote(`${n}回転以内に当たる確率 ${pctText(p)}%${rareText(p)}`);
  }
  return '';
}

// コマチャレンジの連続（5回連続目から）＋前回の初当たりRUSHからのハマり
const KOMA_STREAK_NOTICE_MIN = 5;
function komaStreakNoticeHtml() {
  const n = game.komaStreak;
  if (n < KOMA_STREAK_NOTICE_MIN) return '';
  const p = Math.pow(P_KOMA_FROM_HIT, n);
  const hamari = game.totalSpins - game.lastRushSpins;
  return rareNote(`コマチャレンジ　${n}回連続中<br>発生率 ${pctText(p)}%${rareText(p)}<br>前回の初当たりRUSHから ${hamari.toLocaleString()}回転ハマり`);
}

const P_NORMAL_HIT_DISPLAY = '1/319.7';
const P_RUSH_DISPLAY = '図柄揃い 1/41.9（直撃 1/47.6・最終決戦 1/88.0）';
const P_KOMA_DISPLAY = '1/399.6';

function rushIdleScreen() {
  return `<div class="screen">
    <p class="yodel-label">ヨーデルSONIC怪闘</p>
    <p class="chain-label">${game.session.hits}連チャン中</p>
    <p class="rush-sub">獲得出玉 <span>${game.session.nominalBalls.toLocaleString()}</span> 個</p>
    <p class="rush-spins">${game.session.cycleSpins}回転</p>
    <div class="rush-spin-btns">
      <button class="btn-rush-spin" onclick="handleRushSpin()">1回転</button>
      <button class="btn-rush-spin" onclick="handleRushSpin10()">10回転</button>
      <button class="btn-rush-spin skip" onclick="handleRushSkip()">スキップ</button>
    </div>
    <p class="prob-hint">${P_RUSH_DISPLAY}</p>
    <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
  </div>`;
}

function komaIdleScreen() {
  const skipDisabled = game.komaRemaining <= 10;
  const chain = game.session.everRush ? `<p class="chain-label">${game.session.hits}連チャン中</p>` : '';
  return `<div class="screen">
    <p class="koma-label">コマチャレンジ</p>
    ${chain}
    <p class="rush-sub">時短残り <span>${game.komaRemaining}</span> 回</p>
    <div class="rush-spin-btns">
      <button class="btn-rush-spin" onclick="handleKomaSpin()">1回転</button>
      <button class="btn-rush-spin" onclick="handleKomaSpin10()">10回転</button>
      <button class="btn-rush-spin skip" ${skipDisabled ? 'disabled' : 'onclick="handleKomaSkip()"'}>スキップ</button>
    </div>
    <p class="prob-hint">大当たり確率 ${P_KOMA_DISPLAY}（引き戻すとRUSHへ）</p>
    <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
  </div>`;
}

function bonusBox(title, nominal, cls = 'standard', sub = '') {
  return `<div class="vibun-box rush-box">
    <p class="bonus-main ${cls}">${title}</p>
    <p class="bonus-sub">${nominal.toLocaleString()}個（＋${toActualBalls(nominal).toLocaleString()}球）</p>
    ${sub}
  </div>`;
}

function buildScreen(state) {
  const p = game.pending;
  switch (state) {

    case 'normal_idle':
      return `<div class="screen">
        <button class="btn-start" onclick="handleStart()">START</button>
        <p class="prob-hint">大当たり確率 ${P_NORMAL_HIT_DISPLAY}</p>
        <div class="spin-rate-block">
          <span class="spin-rate-label">入賞時フラッシュ</span>
          <select class="spin-rate-select" onchange="handleFlashChange(this.value)">${flashOptionsHtml()}</select>
        </div>
        <div class="spin-rate-block">
          <span class="spin-rate-label">1000円あたりの回転数</span>
          <select class="spin-rate-select" onchange="handleSpinRateChange(this.value)">${spinRateOptionsHtml()}</select>
        </div>
        <div class="auto-spin-btns">
          <div class="auto-spin-wrap">
            <button class="btn-auto" onclick="autoSpin(${tenThousandYenSpins()})">1万円分回す</button>
            <p class="spin-cost-hint">約${tenThousandYenSpins()}回転分</p>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
          <button class="btn-taiten" onclick="handleShowRanking()">🏆 ランキング</button>
        </div>
      </div>`;

    case 'ranking_view':
      return `<div class="screen">
        <p class="rush-result-title">🏆 最高出玉ランキング</p>
        <button class="btn-sub" onclick="handleRankingBack()">戻る</button>
        <div class="rush-result-box">
          ${renderRankingList(loadRanking())}
        </div>
      </div>`;

    case 'flash':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転</p>
        <div class="flash-box">入賞時フラッシュ！</div>
        <p class="shinraido">信頼度 ${flashLabel()}</p>
        <button class="btn-action" onclick="handleFlashJudge()">▶ 判定</button>
      </div>`;

    case 'flash_miss':
      return `<div class="screen">
        <p class="result-main lose">はずれ</p>
        <button class="btn-sub" onclick="backToNormal()" style="margin-top:8px;">続ける</button>
      </div>`;

    case 'legend_hit':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で大当たり</p>
        ${bonusBox('レジェンドヨーデルエクストラ', 3000, 'premium', '<p class="judge-label">RUSH直行！</p>')}
        ${hitIntervalProbHtml(p.interval)}
        <button class="btn-action" onclick="enterRush()">▶ ヨーデルSONIC怪闘へ</button>
      </div>`;

    case 'ex_rush':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で大当たり</p>
        ${bonusBox('妖怪FEVER', 300, 'standard', '<p class="judge-label">RUSH確定！</p>')}
        ${hitIntervalProbHtml(p.interval)}
        <button class="btn-action" onclick="enterRush()">▶ ヨーデルSONIC怪闘へ</button>
      </div>`;

    case 'ex_normal':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で当たり</p>
        <div class="vibun-box">
          <p class="bonus-main normal-hit">通常当たり</p>
          <p class="bonus-sub">300個（＋${toActualBalls(300)}球）</p>
        </div>
        ${hitIntervalProbHtml(p.interval)}
        <p class="result-sub">コマチャレンジ（時短${KOMA_SPINS}回）へ</p>
        ${komaStreakNoticeHtml()}
        <button class="btn-sub" onclick="enterKoma()" style="margin-top:8px;">▶ コマチャレンジへ</button>
      </div>`;

    case 'youkai_fever':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で大当たり</p>
        ${bonusBox('妖怪FEVER', 300)}
        ${hitIntervalProbHtml(p.interval)}
        <button class="btn-action" onclick="handleGashaChallenge()">妖怪ガシャチャレンジへ</button>
      </div>`;

    case 'gasha':
      if (p.gasha.kind === 'lever') {
        return `<div class="screen">
          <p class="gasha-title">運命の妖怪ガシャチャレンジ</p>
          <p class="gasha-order">引け！</p>
          <button class="gasha-lever" onclick="handleGashaPush()" aria-label="レバーを引く">
            <span class="lever-knob"></span><span class="lever-stick"></span><span class="lever-base"></span>
          </button>
        </div>`;
      }
      return `<div class="screen">
        <p class="gasha-title">運命の妖怪ガシャチャレンジ</p>
        <p class="gasha-order">押せ！</p>
        <button class="gasha-button" onclick="handleGashaPush()">PUSH</button>
      </div>`;

    case 'gasha_success':
      return `<div class="screen">
        <p class="judge-win">成功！</p>
        <p class="yodel-label">ヨーデルSONIC怪闘 突入！</p>
        <button class="btn-action" onclick="enterRush()">▶ RUSHへ</button>
      </div>`;

    case 'gasha_fail':
      return `<div class="screen">
        <p class="result-main lose">失敗…</p>
        <p class="result-sub">コマチャレンジ（時短${KOMA_SPINS}回）へ</p>
        ${komaStreakNoticeHtml()}
        <button class="btn-sub" onclick="enterKoma()" style="margin-top:8px;">▶ 次へ</button>
      </div>`;

    case 'rush_idle':
      return rushIdleScreen();

    case 'rush_hit': {
      const isPin = p.type === 'pin_fail' || p.type === 'pin_success';
      const sub = isPin ? '<p class="judge-label">ピン刺しチャンス発生！</p>' : '';
      const cls = p.type === 'enma' ? 'premium' : 'standard';
      return `<div class="screen">
        <p class="result-sub">${p.spins}回転で当選</p>
        <p class="chain-label">${game.session.hits}連チャン</p>
        ${bonusBox(RUSH_HIT_LABELS[p.type], p.nominal, cls, sub)}
        <button class="btn-action" onclick="handleRushHitContinue()">${isPin ? 'ピン刺しチャンスへ' : '▶ 次へ'}</button>
      </div>`;
    }

    case 'pin_chance':
      return `<div class="screen">
        <p class="gasha-title">ピン刺しチャンス</p>
        <p class="gasha-order">トドメ</p>
        <button class="gasha-button" onclick="handlePinJudge()">PUSH</button>
      </div>`;

    case 'pin_success':
      return `<div class="screen">
        <p class="judge-win">成功！</p>
        ${bonusBox('レジェンドヨーデルエクストラ', 3000, 'premium')}
        <button class="btn-action" onclick="setState('rush_idle')">▶ RUSHへ</button>
      </div>`;

    case 'pin_fail':
      return `<div class="screen">
        <p class="result-main lose small">失敗…</p>
        ${bonusBox('SONIC FEVER', 1500)}
        <button class="btn-sub" onclick="setState('rush_idle')" style="margin-top:8px;">▶ RUSHへ</button>
      </div>`;

    case 'ubaune_intro':
      return `<div class="screen">
        <p class="result-sub">${p.spins}回転で当選</p>
        <p class="chain-label">${game.session.hits}連チャン</p>
        ${bonusBox('SONIC FEVER', 1500)}
        <button class="btn-action" type="button" aria-disabled="true">▶ 次へ</button>
      </div>`;

    case 'ubaune': {
      const msg = p.last === 'win'
        ? `<p class="judge-win small">勝利！ ＋${UBAUNE_ADD.toLocaleString()}個</p>`
        : `<p class="result-sub">${p.spins}回転で当選</p>`;
      return `<div class="screen">
        ${msg}
        <p class="ubaune-title">ウバウネ決戦</p>
        <p class="rush-sub">合計 <span>${p.total.toLocaleString()}</span> 個</p>
        <p class="prob-hint">勝てば ＋${UBAUNE_ADD.toLocaleString()}個（勝率${Math.round(UBAUNE_WIN * 100)}%）</p>
        <button class="btn-action" onclick="handleUbauneBattle()">▶ ${p.wins === 0 ? '決戦' : '次の決戦'}</button>
      </div>`;
    }

    case 'ubaune_end':
      return `<div class="screen">
        <p class="result-sub">ウバウネ決戦 終了（${p.wins}勝）</p>
        ${bonusBox('ウバウネ決戦', p.total, 'premium')}
        <button class="btn-action" onclick="setState('rush_idle')">▶ RUSHへ</button>
      </div>`;

    case 'final_battle':
      return `<div class="screen">
        <p class="result-sub">${p.spins}回転</p>
        <p class="final-title">最終決戦</p>
        <p class="prob-hint">勝てば 1500個＋RUSH継続 ／ 負ければRUSH終了</p>
        <button class="btn-action" onclick="handleFinalBattle()">▶ 勝負！</button>
      </div>`;

    case 'final_win':
      return `<div class="screen">
        <p class="judge-win">勝利！</p>
        <p class="chain-label">${game.session.hits}連チャン</p>
        ${bonusBox('SONIC FEVER', 1500, 'standard', '<p class="judge-label">RUSH継続！</p>')}
        <button class="btn-action" onclick="setState('rush_idle')">▶ RUSHへ</button>
      </div>`;

    case 'final_lose':
      return `<div class="screen">
        <p class="result-main lose">敗北…</p>
        <p class="result-sub">RUSH終了（${game.session.hits}連）</p>
        <button class="btn-sub" onclick="enterKoma()" style="margin-top:8px;">▶ コマチャレンジへ</button>
      </div>`;

    case 'koma_idle':
      return komaIdleScreen();

    case 'koma_hit':
      return `<div class="screen">
        <p class="judge-win">引き戻し！</p>
        ${bonusBox('SONIC FEVER', 1500, 'standard', '<p class="judge-label">ヨーデルSONIC怪闘へ！</p>')}
        <button class="btn-action" onclick="enterRush()">▶ RUSHへ</button>
      </div>`;

    case 'koma_end':
      return `<div class="screen">
        <p class="result-main lose small">コマチャレンジ終了</p>
        <p class="result-sub">通常時へ戻ります</p>
        <button class="btn-sub" onclick="handleSessionEnd()" style="margin-top:8px;">▶ 通常へ戻る</button>
      </div>`;

    case 'session_result': {
      const s = game.session;
      const rank = game.lastRankResult;
      return `<div class="screen">
        <p class="rush-result-title">RUSH リザルト</p>
        <div class="rush-result-box">
          <div class="result-row highlight">
            <span class="rr-label">連チャン数（初当たり含む）</span>
            <span class="rr-val gold">${s.hits}連</span>
          </div>
          <div class="result-row">
            <span class="rr-label">TOTAL</span>
            <span class="rr-val gold">${s.nominalBalls.toLocaleString()}個</span>
          </div>
          <div class="result-row">
            <span class="rr-label">獲得出玉</span>
            <span class="rr-val">${Math.round(s.actualBalls).toLocaleString()}球</span>
          </div>
        </div>
        <button class="btn-action" onclick="handleSessionEnd()">▶ 通常へ戻る</button>
        <div class="rush-result-box">
          <p class="rr-section">🏆 最高出玉ランキング</p>
          ${rank && rank.madeList ? '<p class="rank-madelist">ランクイン！</p>' : ''}
          ${renderRankingList(rank ? rank.list : loadRanking(), rank ? rank.entry : null)}
        </div>
      </div>`;
    }

    case 'eigyo_alert':
      return `<div class="screen">
        <p style="font-size:22px; font-weight:bold; color:var(--c-ruri); text-align:center; line-height:1.6;">
          営業時間終了になりました
        </p>
        <p style="font-size:16px; color:#666; text-align:center;">このまま居座り続けますか？</p>
        <div style="display:flex; gap:16px; margin-top:8px;">
          <button class="btn-action" style="flex:1;" onclick="handleEigyoHai()">はい</button>
          <button class="btn-action" style="flex:1; background:linear-gradient(135deg,#999,#666); border-color:#ccc;"
            onclick="handleEigyoIie()">いいえ</button>
        </div>
      </div>`;

    case 'taiten_result': {
      const mochi = Math.floor(game.mochiDama);
      const mochiYen = Math.round(mochi * YEN_PER_BALL);
      const shuushi = mochiYen - game.toushi;
      const shuushiColor = shuushi >= 0 ? '#2e9e5b' : '#d24141';
      const shuushiSign = shuushi >= 0 ? '＋' : '';
      return `<div class="screen">
        <p style="font-size:24px; font-weight:bold; color:#666;">退店します</p>
        <div class="rush-result-box" style="max-width:320px;">
          <p class="rr-section" style="margin-bottom:8px;">収支発表</p>
          <div class="result-row">
            <span class="rr-label">総回転数</span>
            <span class="rr-val">${game.totalSpins.toLocaleString()}回</span>
          </div>
          <div class="result-row">
            <span class="rr-label">投資金額</span>
            <span class="rr-val" style="color:#d24141;">${game.toushi.toLocaleString()}円</span>
          </div>
          <div class="result-row">
            <span class="rr-label">持ち球換算</span>
            <span class="rr-val">${mochiYen.toLocaleString()}円</span>
          </div>
          <hr class="result-hr">
          <div class="result-row highlight">
            <span class="rr-label" style="font-weight:bold;">収支</span>
            <span class="rr-val" style="color:${shuushiColor}; font-size:22px;">
              ${shuushiSign}${shuushi.toLocaleString()}円
            </span>
          </div>
          <hr class="result-hr">
          <div class="result-row">
            <span class="rr-label">初当たり</span>
            <span class="rr-val">${game.normalHitCount}回</span>
          </div>
          <div class="result-row">
            <span class="rr-label">RUSH突入</span>
            <span class="rr-val">${game.rushEntryCount}回</span>
          </div>
        </div>
        <button class="btn-action" onclick="resetGame()" style="margin-top:8px;">▶ 最初の画面に戻る</button>
      </div>`;
    }

    default:
      return `<div class="screen"><p>...</p></div>`;
  }
}

function renderRushStats() {
  const hits = game.totalRushHits - game.komaPullbackCount; // RUSH中に引いた当たり（最終決戦勝利を含む）
  const spins = game.rushAllStats.totalSpins;
  const prob = hits > 0 && spins > 0 ? '1/' + (spins / hits).toFixed(1) : '1/―';
  document.getElementById('rs-chain').textContent = hits + '回';
  document.getElementById('rs-prob').textContent = prob;
  document.getElementById('rs-spins').textContent = spins + '回';
  document.getElementById('rs-final').textContent =
    `${game.rushAllStats.finalBattles}回（勝利${game.rushAllStats.finalWins}）`;
}

function renderLog() {
  const el = document.getElementById('log-list');
  el.innerHTML = game.log.map(item =>
    `<div class="log-item ${item.type}">${item.text}</div>`
  ).join('');
}

render();

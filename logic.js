'use strict';

// eフィーバー妖怪ウォッチ（SANKYO）の確率・振り分け。DOMに依存しない純粋なロジックだけを置く。
// 数値の出典と決め方は docs/spec.md を参照。

// ---- 遊技条件 ----
// 等価（4円/玉）固定。1000円=250玉。回転数はボーダー17回転を基準に5択。
const YEN_PER_BALL = 4;
const SPIN_RATE_OPTIONS = [13, 15, 17, 19, 20];
const DEFAULT_SPIN_RATE = 17;

function calcSpinCost(spinRate) {
  return 250 / spinRate;
}

// 表示出玉 → 実際の獲得球（1500→1400、300→280、3000→2800）
function toActualBalls(nominal) {
  return nominal - nominal / 15;
}

// ---- 通常時 ----
const P_NORMAL_HIT = 1 / 319.7;
// ヘソ振り分け：7図柄3000個（RUSH直行）0.5%、それ以外は妖怪FEVER 300個（ガシャチャレンジへ）
const LEGEND_SHARE = 0.005;

// 入賞時フラッシュ：当たりは必ずフラッシュから。信頼度を選べる
// EX＝フラッシュならRUSH確定（外れフラッシュなし）。RUSHにならない当たりはフラッシュなしで来る（script.js側で分岐）
const FLASH_OPTIONS = ['25', '40', 'EX'];
const DEFAULT_FLASH = '40';

function flashConfidence(option) {
  return option === 'EX' ? 100 : Number(option);
}

// 外れなのにフラッシュが出る確率
function falseFlashProbability(option) {
  const c = flashConfidence(option);
  return P_NORMAL_HIT * ((100 - c) / c);
}

// 通常時1回転：'hit' / 'false_flash' / 'miss'
function spinNormal(flashOption) {
  const r = Math.random();
  if (r < P_NORMAL_HIT) return 'hit';
  if (r < P_NORMAL_HIT + falseFlashProbability(flashOption)) return 'false_flash';
  return 'miss';
}

// 当たりの種類：'legend'（3000個・RUSH直行）/ 'youkai'（300個・ガシャチャレンジ）
function rollNormalHitType() {
  return Math.random() < LEGEND_SHARE ? 'legend' : 'youkai';
}

// ---- 運命の妖怪ガシャチャレンジ ----
// 成功率は、ヘソ300個のうちRUSHへ行く割合 49.5 ÷ 99.5。
// 15%でレバー（引け／成功92%）、残りはボタン（押せ）。ボタンの成功率は合計が合うように逆算する。
const GASHA_SUCCESS = 49.5 / 99.5;
const GASHA_LEVER_SHARE = 0.15;
const GASHA_LEVER_SUCCESS = 0.92;
const GASHA_BUTTON_SUCCESS = (GASHA_SUCCESS - GASHA_LEVER_SHARE * GASHA_LEVER_SUCCESS) / (1 - GASHA_LEVER_SHARE);

// ガシャチャレンジ：{ kind: 'button'|'lever', success }
function rollGasha() {
  const kind = Math.random() < GASHA_LEVER_SHARE ? 'lever' : 'button';
  const p = kind === 'lever' ? GASHA_LEVER_SUCCESS : GASHA_BUTTON_SUCCESS;
  return { kind, success: Math.random() < p };
}

// ---- RUSH「ヨーデルSONIC怪闘」（転落タイプ） ----
// 1回転ごとに、直撃当たり 1/47.6 と 最終決戦 1/88.0 を同時に抽選する（同じ1回で両方は起きない）。
// 最終決戦は1/4で勝利（1500個＋継続）、3/4で敗北＝転落。
// 合算：図柄揃い 1/47.6 + 1/352 ≒ 1/41.9、転落 3/352 ≒ 1/117.3
const P_RUSH_DIRECT = 1 / 47.6;
const P_FINAL_BATTLE = 1 / 88.0;
const FINAL_BATTLE_WIN = 1 / 4;

// 直撃当たりの振り分け（％）。公表の振り分けから「最終決戦の勝利（全部1500個）」を抜いて割り直したもの。
const RUSH_HIT_TABLE = [
  { type: 'sonic', pct: 42.45 },       // 1500個
  { type: 'pin_fail', pct: 25.31 },    // ピン刺しチャンス失敗 1500個
  { type: 'pin_success', pct: 21.80 }, // ピン刺しチャンス成功 3000個
  { type: 'enma', pct: 3.97 },         // エンマインパクト 3000個
  { type: 'ubaune', pct: 6.47 },       // ウバウネ決戦 3000個＋α
];

// RUSH中1回転：'hit' / 'final_battle' / 'miss'
function spinRush() {
  const r = Math.random();
  if (r < P_RUSH_DIRECT) return 'hit';
  if (r < P_RUSH_DIRECT + P_FINAL_BATTLE) return 'final_battle';
  return 'miss';
}

function rollRushHitType() {
  const r = Math.random() * 100;
  let acc = 0;
  for (const row of RUSH_HIT_TABLE) {
    acc += row.pct;
    if (r < acc) return row.type;
  }
  return RUSH_HIT_TABLE[RUSH_HIT_TABLE.length - 1].type;
}

function rollFinalBattle() {
  return Math.random() < FINAL_BATTLE_WIN;
}

// ウバウネ決戦：3000個から始まり、50%で勝つたびに1500個上乗せ（上限なし）
const UBAUNE_BASE = 3000;
const UBAUNE_ADD = 1500;
const UBAUNE_WIN = 0.5;

function rollUbauneBattle() {
  return Math.random() < UBAUNE_WIN;
}

// ---- コマチャレンジ（時短100回） ----
const KOMA_SPINS = 100;
const P_KOMA_HIT = 1 / 399.6;

// コマチャレンジ1回転：'hit'（1500個＋RUSH）/ 'miss'
function spinKoma() {
  return Math.random() < P_KOMA_HIT ? 'hit' : 'miss';
}

// 100回のうちに引き戻す確率（約22.1%）
function komaPullbackProbability() {
  return 1 - Math.pow(1 - P_KOMA_HIT, KOMA_SPINS);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    YEN_PER_BALL,
    SPIN_RATE_OPTIONS,
    DEFAULT_SPIN_RATE,
    calcSpinCost,
    toActualBalls,
    P_NORMAL_HIT,
    LEGEND_SHARE,
    FLASH_OPTIONS,
    DEFAULT_FLASH,
    flashConfidence,
    falseFlashProbability,
    spinNormal,
    rollNormalHitType,
    GASHA_SUCCESS,
    GASHA_LEVER_SHARE,
    GASHA_LEVER_SUCCESS,
    GASHA_BUTTON_SUCCESS,
    rollGasha,
    P_RUSH_DIRECT,
    P_FINAL_BATTLE,
    FINAL_BATTLE_WIN,
    RUSH_HIT_TABLE,
    spinRush,
    rollRushHitType,
    rollFinalBattle,
    UBAUNE_BASE,
    UBAUNE_ADD,
    UBAUNE_WIN,
    rollUbauneBattle,
    KOMA_SPINS,
    P_KOMA_HIT,
    spinKoma,
    komaPullbackProbability,
  };
}

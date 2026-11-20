'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../logic.js');

function withMockRandom(values, fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('回転コストは等価で 250 ÷ 回転数', () => {
  assert.equal(logic.calcSpinCost(17), 250 / 17);
  assert.deepEqual(logic.SPIN_RATE_OPTIONS, [13, 15, 17, 19, 20]);
  assert.equal(logic.DEFAULT_SPIN_RATE, 17);
});

test('実際の獲得球：1500→1400、300→280、3000→2800', () => {
  assert.equal(logic.toActualBalls(1500), 1400);
  assert.equal(logic.toActualBalls(300), 280);
  assert.equal(logic.toActualBalls(3000), 2800);
});

test('通常時の大当たり確率は 1/319.7', () => {
  assert.equal(logic.P_NORMAL_HIT, 1 / 319.7);
});

test('フラッシュ信頼度：当たり ÷ (当たり＋偽フラッシュ) が選んだ信頼度になる', () => {
  for (const opt of ['25', '40']) {
    const p = logic.P_NORMAL_HIT;
    const conf = p / (p + logic.falseFlashProbability(opt));
    assert.ok(close(conf, Number(opt) / 100, 1e-12), opt);
  }
  assert.equal(logic.falseFlashProbability('EX'), 0);
});

test('spinNormal：小さい乱数は当たり、その次の帯は偽フラッシュ、残りは外れ', () => {
  assert.equal(withMockRandom([0], () => logic.spinNormal('40')), 'hit');
  const mid = logic.P_NORMAL_HIT + logic.falseFlashProbability('40') / 2;
  assert.equal(withMockRandom([mid], () => logic.spinNormal('40')), 'false_flash');
  assert.equal(withMockRandom([mid], () => logic.spinNormal('EX')), 'miss');
  assert.equal(withMockRandom([0.999], () => logic.spinNormal('25')), 'miss');
});

test('ヘソ振り分け：0.5%が3000個（legend）、残りは妖怪FEVER', () => {
  assert.equal(withMockRandom([0.004], () => logic.rollNormalHitType()), 'legend');
  assert.equal(withMockRandom([0.006], () => logic.rollNormalHitType()), 'youkai');
});

test('ガシャチャレンジ：レバー15%×92% と ボタン の合計が 49.5/99.5 になる', () => {
  const total = logic.GASHA_LEVER_SHARE * logic.GASHA_LEVER_SUCCESS
    + (1 - logic.GASHA_LEVER_SHARE) * logic.GASHA_BUTTON_SUCCESS;
  assert.ok(close(total, 49.5 / 99.5, 1e-12));
  assert.ok(close(logic.GASHA_BUTTON_SUCCESS, 0.4229, 1e-3));
});

test('rollGasha：レバー/ボタンと当落', () => {
  assert.deepEqual(withMockRandom([0.1, 0.91], () => logic.rollGasha()), { kind: 'lever', success: true });
  assert.deepEqual(withMockRandom([0.1, 0.93], () => logic.rollGasha()), { kind: 'lever', success: false });
  assert.deepEqual(withMockRandom([0.5, 0.40], () => logic.rollGasha()), { kind: 'button', success: true });
  assert.deepEqual(withMockRandom([0.5, 0.45], () => logic.rollGasha()), { kind: 'button', success: false });
});

test('RUSH：直撃と最終決戦勝利の合算が約1/41.9、転落が約1/117.3', () => {
  const zorome = logic.P_RUSH_DIRECT + logic.P_FINAL_BATTLE * logic.FINAL_BATTLE_WIN;
  assert.ok(close(1 / zorome, 41.9, 0.05));
  const tenraku = logic.P_FINAL_BATTLE * (1 - logic.FINAL_BATTLE_WIN);
  assert.ok(close(1 / tenraku, 117.3, 0.05));
});

test('spinRush：直撃 → 最終決戦 → 外れ の順に帯が並ぶ', () => {
  assert.equal(withMockRandom([0], () => logic.spinRush()), 'hit');
  assert.equal(withMockRandom([logic.P_RUSH_DIRECT + 0.001], () => logic.spinRush()), 'final_battle');
  assert.equal(withMockRandom([0.5], () => logic.spinRush()), 'miss');
});

test('直撃振り分けは合計100%、最終決戦勝利を戻すと公表の振り分けに一致する', () => {
  const sum = logic.RUSH_HIT_TABLE.reduce((a, r) => a + r.pct, 0);
  assert.ok(close(sum, 100, 1e-9));
  const pd = logic.P_RUSH_DIRECT;
  const pw = logic.P_FINAL_BATTLE * logic.FINAL_BATTLE_WIN;
  const share = (type) => logic.RUSH_HIT_TABLE.find((r) => r.type === type).pct * pd / (pd + pw);
  assert.ok(close(share('sonic') + 100 * pw / (pd + pw), 49.3, 0.05));
  assert.ok(close(share('pin_fail'), 22.3, 0.05));
  assert.ok(close(share('pin_success'), 19.2, 0.05));
  assert.ok(close(share('enma'), 3.5, 0.05));
  assert.ok(close(share('ubaune'), 5.7, 0.05));
});

test('rollRushHitType：帯の境目', () => {
  assert.equal(withMockRandom([0], () => logic.rollRushHitType()), 'sonic');
  assert.equal(withMockRandom([0.43], () => logic.rollRushHitType()), 'pin_fail');
  assert.equal(withMockRandom([0.68], () => logic.rollRushHitType()), 'pin_success');
  assert.equal(withMockRandom([0.9], () => logic.rollRushHitType()), 'enma');
  assert.equal(withMockRandom([0.95], () => logic.rollRushHitType()), 'ubaune');
  assert.equal(withMockRandom([0.9999999], () => logic.rollRushHitType()), 'ubaune');
});

test('最終決戦は1/4で勝利', () => {
  assert.equal(withMockRandom([0.24], () => logic.rollFinalBattle()), true);
  assert.equal(withMockRandom([0.26], () => logic.rollFinalBattle()), false);
});

test('ウバウネ決戦は50%で勝利', () => {
  assert.equal(withMockRandom([0.49], () => logic.rollUbauneBattle()), true);
  assert.equal(withMockRandom([0.51], () => logic.rollUbauneBattle()), false);
});

test('コマチャレンジ：1/399.6 を100回で引き戻し約22.1%', () => {
  assert.equal(logic.KOMA_SPINS, 100);
  assert.ok(close(logic.komaPullbackProbability(), 0.221, 0.001));
  assert.equal(withMockRandom([0], () => logic.spinKoma()), 'hit');
  assert.equal(withMockRandom([0.5], () => logic.spinKoma()), 'miss');
});

test('全体の流れ（モンテカルロ）：実質RUSH突入率 約61%、トータル継続率 約80%', () => {
  const N = 200000;
  let entered = 0;
  for (let i = 0; i < N; i++) {
    const type = logic.rollNormalHitType();
    let rush = type === 'legend' || logic.rollGasha().success;
    if (!rush && Math.random() < logic.komaPullbackProbability()) rush = true;
    if (rush) entered++;
  }
  assert.ok(close(entered / N, 0.61, 0.01));

  // RUSH中の当たり1回あたりの継続：直撃 or 最終決戦勝利 が 転落 より先に来る率 ＋ 転落後のコマ引き戻し
  const pd = logic.P_RUSH_DIRECT + logic.P_FINAL_BATTLE * logic.FINAL_BATTLE_WIN;
  const pt = logic.P_FINAL_BATTLE * (1 - logic.FINAL_BATTLE_WIN);
  const keep = pd / (pd + pt);
  assert.ok(close(keep, 0.74, 0.005));
  const total = keep + (1 - keep) * logic.komaPullbackProbability();
  assert.ok(close(total, 0.80, 0.01));
});

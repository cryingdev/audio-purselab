import {
  renderComposition, compositionLength, compositionChannels,
  appendStartSec, wrapLoopEnds, clipEndSec, placeOnNewLanes,
  splitClipAt, rippleInsert, rippleDelete, moveTrack, removeTrack, placeClips
} from './node_modules/.pulselab/composer.mjs';
import { suggestAssetName, applyReverse, applyGainCapped, peakOfRange, applySpeedChange, timeStretch, barSeconds, TIME_STRETCH_FRAME_MS_DEFAULT } from './node_modules/.pulselab/audioUtils.mjs';

const SR = 48000;

// --- 최소 AudioBuffer / AudioContext 흉내 ---
class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._d = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(c) { return this._d[c]; }
}
const ctx = { createBuffer: (c, l, sr) => new FakeBuffer(c, l, sr) };

function tone(freq, durSec, channels = 1, amp = 0.5) {
  const n = Math.round(durSec * SR);
  const b = new FakeBuffer(channels, n, SR);
  for (let c = 0; c < channels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * (i / SR)) * amp;
  }
  return b;
}
function dc(value, durSec, channels = 1) {
  const n = Math.round(durSec * SR);
  const b = new FakeBuffer(channels, n, SR);
  for (let c = 0; c < channels; c++) b.getChannelData(c).fill(value);
  return b;
}
const clip = (o) => ({ id: 'x', name: 'x', lane: 0, startSec: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, ...o });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\n[1] 등출력 이어 붙이기 — 서로 다른 클립(무상관)에서 음량이 파이지 않는가');
{
  // 실제 쓰임새는 "서로 다른 Veo 클립을 잇는 것"이라 두 소리는 무상관이다.
  // 무상관 신호는 제곱합으로 더해지므로 등출력(sin/cos)이 맞고, 선형 페이드를
  // 쓰면 겹친 한가운데가 −3 dB 파인다. 그 성질을 RMS 로 확인한다.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const noise = (durSec) => {
    const n = Math.round(durSec * SR);
    const b = new FakeBuffer(1, n, SR);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = rnd() * 0.5;
    return b;
  };

  const XF_MS = 500;
  const a = clip({ id: 'a', buffer: noise(4), fadeOutMs: XF_MS });
  const startB = appendStartSec([a], 0, XF_MS);
  const b = clip({ id: 'b', buffer: noise(4), startSec: startB, fadeInMs: XF_MS });
  const out = renderComposition([a, b], ctx, SR);
  const d = out.getChannelData(0);

  check('시작 오프셋 = 앞 끝 − 크로스페이드', Math.abs(startB - 3.5) < 1e-9, `${startB}s`);

  const rms = (from, to) => {
    let s = 0;
    for (let i = from; i < to; i++) s += d[i] * d[i];
    return Math.sqrt(s / (to - from));
  };
  const s = Math.round(startB * SR), e = s + Math.round((XF_MS / 1000) * SR);
  const solo = rms(0, s - SR);                       // 겹치기 전 구간
  const mid = rms(Math.floor((s + e) / 2) - 2000, Math.floor((s + e) / 2) + 2000); // 겹침 한가운데
  const drop = 20 * Math.log10(mid / solo);
  check('겹침 한가운데 RMS 유지 (±0.5 dB)', Math.abs(drop) < 0.5, `${drop >= 0 ? '+' : ''}${drop.toFixed(3)} dB`);

  // 선형 페이드였다면 여기가 −3 dB 파였을 것이다. 대조군으로 계산해 둔다.
  const linearDip = 20 * Math.log10(Math.sqrt(0.5 * 0.5 + 0.5 * 0.5) / 1);
  check('대조: 선형 페이드였다면 파였을 양', Math.abs(linearDip - (-3.0103)) < 0.01, `${linearDip.toFixed(3)} dB`);
}

console.log('\n[1b] 상관 있는 자료를 겹치면 +3 dB 솟는다 (등출력의 대가)');
{
  // 같은 소리를 자기 자신과 겹치면 진폭이 더해져 √2 배가 된다. 클리핑 위험이
  // 여기서 나오고, 합친 뒤 -3 dBFS 정규화를 기본으로 켜 두는 이유다.
  const XF_MS = 500;
  const a = clip({ id: 'a', buffer: dc(1, 4), fadeOutMs: XF_MS });
  const startB = appendStartSec([a], 0, XF_MS);
  const b = clip({ id: 'b', buffer: dc(1, 4), startSec: startB, fadeInMs: XF_MS });
  const d = renderComposition([a, b], ctx, SR).getChannelData(0);

  const s = Math.round(startB * SR), e = s + Math.round((XF_MS / 1000) * SR);
  let max = -Infinity;
  for (let i = s; i < e; i++) if (d[i] > max) max = d[i];
  check('상관 자료 겹침 피크 = √2', Math.abs(max - Math.SQRT2) < 1e-5,
    `${max.toFixed(6)} (+${(20 * Math.log10(max)).toFixed(2)} dB)`);
}

console.log('\n[2] 길이 산술 — 크로스페이드만큼 짧아지는가');
{
  const XF_MS = 1000;
  let clips = [];
  let lengths = [8, 8, 8, 8];
  for (const L of lengths) {
    const st = appendStartSec(clips, 0, clips.length === 0 ? 0 : XF_MS);
    clips.push(clip({ id: 's' + clips.length, buffer: dc(0.5, L), startSec: st,
      fadeInMs: clips.length === 0 ? 0 : XF_MS, fadeOutMs: XF_MS }));
  }
  const total = compositionLength(clips, SR) / SR;
  const expected = 8 * 4 - 1 * 3; // 합계 32초 − 겹침 3군데 × 1초
  check('Veo 8초 4개 + 1초 크로스페이드 = 29초', Math.abs(total - expected) < 1e-9, `${total}s (기대 ${expected}s)`);
}

console.log('\n[3] 겹쳐 쌓기 (레이어) — 합산과 채널');
{
  const a = clip({ id: 'a', buffer: dc(0.3, 5), lane: 0 });
  const b = clip({ id: 'b', buffer: dc(0.4, 3), lane: 1 });
  const out = renderComposition([a, b], ctx, SR);
  check('길이 = 가장 긴 클립', Math.abs(out.length / SR - 5) < 1e-9, `${out.length / SR}s`);
  const d = out.getChannelData(0);
  check('겹친 동안 합산', Math.abs(d[SR] - 0.7) < 1e-6, `${d[SR].toFixed(4)}`);
  check('b 끝난 뒤 a 만', Math.abs(d[Math.round(4 * SR)] - 0.3) < 1e-6, `${d[Math.round(4 * SR)].toFixed(4)}`);
}

console.log('\n[4] 모노 → 스테레오 승격');
{
  const mono = clip({ id: 'm', buffer: dc(0.5, 2, 1) });
  const st = clip({ id: 's', buffer: dc(0.2, 2, 2), lane: 1 });
  check('결과 채널 = 최대치', compositionChannels([mono, st]) === 2);
  const out = renderComposition([mono, st], ctx, SR);
  check('모노가 양 채널에 동일하게',
    Math.abs(out.getChannelData(0)[100] - out.getChannelData(1)[100]) < 1e-9,
    `L=${out.getChannelData(0)[100].toFixed(3)} R=${out.getChannelData(1)[100].toFixed(3)}`);
  check('모노끼리면 모노 유지', compositionChannels([mono]) === 1);
}

console.log('\n[5] 끝→시작 말아들기 (wrapLoopEnds)');
{
  // 비정수 주기라 그냥 자르면 이음매가 튀는 구간
  const src = tone(443.7, 3.0, 1, 0.8);
  const WRAP_MS = 500;
  const before = Math.abs(src.getChannelData(0)[0] - src.getChannelData(0)[src.length - 1]);

  const out = wrapLoopEnds(src, WRAP_MS, ctx);
  const d = out.getChannelData(0);
  const wrap = Math.round((WRAP_MS / 1000) * SR);

  check('길이가 wrap 만큼 줄어듦', out.length === src.length - wrap,
    `${src.length} → ${out.length} (−${wrap})`);

  // 루프 이음매: 마지막 표본 → 첫 표본
  const seam = Math.abs(d[0] - d[out.length - 1]);
  // 이웃 표본 최대 변화량과 비교해야 "튀는지" 판정이 된다
  let maxStep = 0;
  for (let i = 1; i < out.length; i++) {
    const s = Math.abs(d[i] - d[i - 1]);
    if (s > maxStep) maxStep = s;
  }
  check('이음매 불연속 < 이웃 표본 최대 변화량', seam < maxStep,
    `이음매 ${seam.toFixed(4)} vs 최대 변화량 ${maxStep.toFixed(4)} (자르기만 했다면 ${before.toFixed(4)})`);

  check('첫 표본 = src[len−wrap] (표본 단위 연속)',
    Math.abs(d[0] - src.getChannelData(0)[out.length]) < 1e-6,
    `${d[0].toFixed(6)} vs ${src.getChannelData(0)[out.length].toFixed(6)}`);

  // 말아드는 구간에서 얼마나 솟는지 — 정현파는 자기 자신과 상관이 있어 부풀 수 있다.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  check('말아든 뒤 피크가 원본 대비 +3 dB 이내', peak <= 0.8 * Math.SQRT2 + 1e-6,
    `원본 0.8 → ${peak.toFixed(4)} (+${(20 * Math.log10(peak / 0.8)).toFixed(2)} dB)`);
}

console.log('\n[6] 경계 조건');
{
  check('빈 목록 → null', renderComposition([], ctx, SR) === null);
  const tiny = clip({ id: 't', buffer: dc(1, 0.01), fadeInMs: 500, fadeOutMs: 500 });
  const out = renderComposition([tiny], ctx, SR);
  const d = out.getChannelData(0);
  let bad = false;
  for (let i = 0; i < d.length; i++) if (!isFinite(d[i]) || Math.abs(d[i]) > 1.0001) bad = true;
  check('클립보다 긴 페이드에도 폭주 없음', !bad);
  check('wrap 이 길이 절반을 넘으면 잘림', wrapLoopEnds(dc(1, 1), 10000, ctx).length === Math.round(SR * 1) - Math.floor(Math.round(SR * 1) / 2));
}

console.log('\n[6b] 트랙 추가 — 파일마다 새 트랙에 나란히 얹는다');
{
  const mk = (id) => ({ id, name: id, buffer: dc(0.4, 5) });
  const first = placeOnNewLanes([], [mk('a'), mk('b')]);
  check('빈 상태에서 트랙 0,1', first.map(c => c.lane).join(',') === '0,1', first.map(c => c.lane).join(','));
  check('전부 0초에서 시작', first.every(c => c.startSec === 0));
  check('이음매가 없으니 페이드도 없음', first.every(c => c.fadeInMs === 0 && c.fadeOutMs === 0));

  // 이미 트랙 0,1 이 있으면 다음은 2,3
  const more = placeOnNewLanes(first, [mk('c'), mk('d')]);
  check('기존 뒤로 트랙 2,3', more.map(c => c.lane).join(',') === '0,1,2,3', more.map(c => c.lane).join(','));

  // 길이는 늘지 않는다 (같은 시간대에 쌓는 것이므로)
  check('길이는 가장 긴 클립 그대로', Math.abs(compositionLength(more, SR) / SR - 5) < 1e-9,
    `${compositionLength(more, SR) / SR}s`);

  // 트랙 번호가 띄엄띄엄해도 최대값 다음으로 간다
  const sparse = [{ ...mk('x'), lane: 7, startSec: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0 }];
  check('최대 트랙 번호 다음으로', placeOnNewLanes(sparse, [mk('y')])[1].lane === 8);
}

console.log('\n[6c] 자르고 끼워넣기 — 분할 · 자리 벌리기 · 틈 닫기 · 트랙 옮기기');
{
  // 실제 crop 과 같은 방식으로 자른다 (표본 단위)
  const crop = (buf, from, to) => {
    const sr = buf.sampleRate;
    const s = Math.floor(from * sr), e = Math.floor(to * sr);
    if (e - s <= 0) return null;
    const out = new FakeBuffer(buf.numberOfChannels, e - s, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(s, e));
    return out;
  };
  let seq = 0;
  const nid = () => `n${seq++}`;
  const clip = (o) => ({ id: 'x', name: 'x', lane: 0, startSec: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, ...o });

  // --- 분할 ---
  const a = clip({ id: 'a', name: 'a', buffer: dc(0.5, 10), fadeInMs: 30, fadeOutMs: 40 });
  const split = splitClipAt([a], 'a', 4, crop, nid);
  check('둘로 쪼개진다', split.length === 2, `${split.length}개`);
  check('앞 조각 0→4초', Math.abs(split[0].buffer.duration - 4) < 1e-6 && split[0].startSec === 0,
    `${split[0].buffer.duration.toFixed(3)}초 @ ${split[0].startSec}`);
  check('뒤 조각 4→10초', Math.abs(split[1].buffer.duration - 6) < 1e-6 && split[1].startSec === 4,
    `${split[1].buffer.duration.toFixed(3)}초 @ ${split[1].startSec}`);
  check('표본 총합이 유지된다', split[0].buffer.length + split[1].buffer.length === a.buffer.length,
    `${split[0].buffer.length}+${split[1].buffer.length} = ${a.buffer.length}`);
  check('접합면에는 페이드를 안 문다', split[0].fadeOutMs === 0 && split[1].fadeInMs === 0);
  check('바깥쪽 페이드는 남는다', split[0].fadeInMs === 30 && split[1].fadeOutMs === 40);
  check('경계 밖에서는 안 쪼갠다', splitClipAt([a], 'a', 0, crop, nid).length === 1 &&
    splitClipAt([a], 'a', 10, crop, nid).length === 1);

  // --- 자리 벌리기 ---
  const two = [
    clip({ id: 'p', name: 'p', buffer: dc(0.5, 4), startSec: 0 }),
    clip({ id: 'q', name: 'q', buffer: dc(0.5, 4), startSec: 4 }),
    clip({ id: 'r', name: 'r', buffer: dc(0.5, 4), startSec: 0, lane: 1 }),
  ];
  const opened = rippleInsert(two, 0, 4, 3);
  check('4초 지점부터 3초 밀린다', opened.find(c=>c.id==='q').startSec === 7, `${opened.find(c=>c.id==='q').startSec}`);
  check('앞쪽 클립은 안 움직인다', opened.find(c=>c.id==='p').startSec === 0);
  check('다른 트랙은 안 건드린다', opened.find(c=>c.id==='r').startSec === 0);

  // --- 빼고 당기기 ---
  const closed = rippleDelete(two, 'p');
  check('뒤엣것이 빠진 자리로 당겨온다', closed.length === 2 && closed.find(c=>c.id==='q').startSec === 0,
    `${closed.find(c=>c.id==='q').startSec}`);
  check('다른 트랙은 그대로', closed.find(c=>c.id==='r').startSec === 0);
  check('맨 뒤를 빼면 앞은 안 움직인다',
    rippleDelete(two, 'q').find(c=>c.id==='p').startSec === 0);

  /*
   * 크로스페이드로 이은 사슬에서 가운데를 빼도 이음매가 유지되어야 한다.
   * 클립 **길이**만큼 당기면 겹침이 두 배가 된다 — 실제로 그 버그가 있었다.
   */
  let chain = [];
  for (let i = 0; i < 3; i++) {
    chain = placeClips(chain, [{ id: 'x' + i, name: 'x' + i, buffer: dc(0.4, 8) }], 0, i === 0 ? 0 : 750);
  }
  const XF = 0.75;
  const cut = rippleDelete(chain, 'x1');
  const first = cut.find(c => c.id === 'x0'), third = cut.find(c => c.id === 'x2');
  const overlap = clipEndSec(first) - third.startSec;
  check('크로스페이드 사슬에서 겹침이 유지된다', Math.abs(overlap - XF) < 1e-6,
    `겹침 ${overlap.toFixed(3)}초 (기대 ${XF})`);
  check('전체 길이가 크로스페이드 규칙대로', Math.abs(compositionLength(cut, SR) / SR - (8 * 2 - XF)) < 1e-6,
    `${(compositionLength(cut, SR) / SR).toFixed(3)}초 (기대 ${(8 * 2 - XF).toFixed(3)})`);

  // --- 트랙 옮기기 ---
  const three = [
    clip({ id: 'l0', buffer: dc(0.5, 1), lane: 0 }),
    clip({ id: 'l1', buffer: dc(0.5, 1), lane: 1 }),
    clip({ id: 'l2', buffer: dc(0.5, 1), lane: 2 }),
  ];
  const moved = moveTrack(three, 2, 0);   // 맨 아래를 맨 위로
  const laneOf = (arr, id) => arr.find(c=>c.id===id).lane;
  check('옮긴 트랙이 목표 자리로', laneOf(moved,'l2') === 0);
  check('나머지가 한 칸씩 밀린다', laneOf(moved,'l0') === 1 && laneOf(moved,'l1') === 2,
    `l0=${laneOf(moved,'l0')} l1=${laneOf(moved,'l1')}`);
  const back = moveTrack(moved, 0, 2);
  check('되돌리면 원래대로', laneOf(back,'l0') === 0 && laneOf(back,'l1') === 1 && laneOf(back,'l2') === 2);
}

console.log('\n[6e] 트랙 빼기 — 클립까지 지우고 아래를 끌어올린다');
{
  const c = (id, lane) => ({ id, name: id, lane, startSec: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, buffer: dc(0.4, 2) });
  const three = [c('a',0), c('b',1), c('b2',1), c('d',2)];

  const gone = removeTrack(three, 1);
  check('그 트랙의 클립이 사라진다', gone.length === 2 && !gone.some(x => x.id.startsWith('b')),
    gone.map(x=>x.id).join(','));
  check('아래 트랙이 한 칸 올라온다', gone.find(x=>x.id==='d').lane === 1,
    `d=${gone.find(x=>x.id==='d').lane}`);
  check('위 트랙은 그대로', gone.find(x=>x.id==='a').lane === 0);
  check('번호에 구멍이 없다',
    [...new Set(gone.map(x=>x.lane))].sort((p,q)=>p-q).join(',') === '0,1',
    [...new Set(gone.map(x=>x.lane))].join(','));

  check('맨 위를 빼도 나머지가 올라온다',
    removeTrack(three, 0).every(x => x.lane === (x.id === 'd' ? 1 : 0)));
  check('없는 트랙을 빼면 그대로', removeTrack(three, 9).length === three.length);
  check('마지막 하나를 빼면 빈 목록', removeTrack([c('only',0)], 0).length === 0);
}

console.log('\n[6d] 앞뒤 뒤집기');
{
  // 0,1,2,... 로 채운 램프를 뒤집어 순서를 확인한다
  const ramp = (n, ch = 1) => {
    const b = new FakeBuffer(ch, n, SR);
    for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = i; }
    return b;
  };
  const a = ramp(8);
  applyReverse(a);
  check('통째로 뒤집힌다', [...a.getChannelData(0)].join(',') === '7,6,5,4,3,2,1,0',
    [...a.getChannelData(0)].join(','));

  const b = ramp(8);
  const two = 2 / SR, six = 6 / SR;
  applyReverse(b, two, six);          // [2,6) 만 뒤집는다
  check('구간만 뒤집고 바깥은 그대로', [...b.getChannelData(0)].join(',') === '0,1,5,4,3,2,6,7',
    [...b.getChannelData(0)].join(','));

  const c = ramp(9, 2);
  applyReverse(c);
  check('채널마다 각각 뒤집힌다',
    [...c.getChannelData(0)].join(',') === '8,7,6,5,4,3,2,1,0' &&
    [...c.getChannelData(1)].join(',') === '8,7,6,5,4,3,2,1,0');

  const d = ramp(8);
  const before = d.length;
  applyReverse(d);
  applyReverse(d);
  check('두 번 뒤집으면 제자리', [...d.getChannelData(0)].join(',') === '0,1,2,3,4,5,6,7');
  check('표본 수가 그대로', d.length === before, `${d.length}`);

  // 홀수 길이·경계 밖 구간에도 안 깨진다
  const e = ramp(7);
  applyReverse(e, -1, 999);
  check('경계를 넘겨도 잘린 데 없이 뒤집힌다', [...e.getChannelData(0)].join(',') === '6,5,4,3,2,1,0',
    [...e.getChannelData(0)].join(','));
}

console.log('\n[7] 내보내기 이름 제안 (소문자 kebab-case + -v1)');
{
  const cases = [
    ['Rain_falling_on_wheat_field_202608131645.mp4', 'rain-falling-on-wheat-field-v1'],
    ['music-race-v1.wav', 'music-race-v1'],           // 이미 맞으면 그대로
    ['sfx_hoof_v2.wav', 'sfx-hoof-v2'],               // 버전이 있으면 유지
    ['Horse Whinny 03.wav', 'horse-whinny-03-v1'],    // 짧은 숫자는 이름의 일부
    ['amb  forest__night.mp3', 'amb-forest-night-v1'],// 구분자 겹침 정리
    ['....mp4', 'untitled-v1'],                        // 남는 글자가 없을 때
  ];
  for (const [input, expected] of cases) {
    const got = suggestAssetName(input);
    check(`${input} → ${expected}`, got === expected, got === expected ? '' : `실제 ${got}`);
  }
}


console.log('\n[8] 넘침 막기 — 자르지 말고 배수를 깎는다');
{

  /** 값 하나로 채운 모노 버퍼. 피크가 곧 그 값이다. */
  const flat = (v, sec = 1) => {
    const b = dc(v, sec);
    return b;
  };

  // 0.25 (-12.04 dBFS) 를 8배(+18 dB) 로 키우려 하면 4배에서 멈춘다.
  {
    const b = flat(0.25);
    const r = applyGainCapped(b, 8, 1);
    check('넘칠 배수는 천장에 닿게 깎인다', Math.abs(r.applied - 4) < 1e-9, `걸린 배수 ${r.applied}`);
    check('깎였다고 알린다', r.capped === true);
    check('결과 피크가 정확히 천장', Math.abs(peakOfRange(b) - 1) < 1e-6, `${peakOfRange(b)}`);
  }

  // 넘치지 않는 배수는 손대지 않는다.
  {
    const b = flat(0.25);
    const r = applyGainCapped(b, 2, 1);
    check('안 넘치면 그대로 건다', Math.abs(r.applied - 2) < 1e-9 && r.capped === false, `${r.applied}`);
    check('결과 피크 0.5', Math.abs(peakOfRange(b) - 0.5) < 1e-6, `${peakOfRange(b)}`);
  }

  // 줄이는 쪽은 깎을 일이 없다 — 이미 넘어 있어도 요청한 만큼만 줄인다.
  {
    const b = flat(1.2);
    const r = applyGainCapped(b, 0.5, 1);
    check('줄이기는 요청대로', Math.abs(r.applied - 0.5) < 1e-9 && r.capped === false, `${r.applied}`);
    check('이미 넘은 것을 억지로 안 내린다', Math.abs(peakOfRange(b) - 0.6) < 1e-6, `${peakOfRange(b)}`);
  }

  // 이미 넘어 있는데 더 키우려 하면 — 더 나쁘게만 안 만든다.
  {
    const b = flat(1.2);
    const r = applyGainCapped(b, 2, 1);
    check('넘은 자료는 더 안 키운다', Math.abs(r.applied - 1) < 1e-9 && r.capped === true, `${r.applied}`);
    check('피크가 그대로 1.2', Math.abs(peakOfRange(b) - 1.2) < 1e-6, `${peakOfRange(b)}`);
  }

  // 구간만 걸 때는 그 구간의 피크로 판단한다.
  {
    const b = dc(0.1, 2);
    const d = b.getChannelData(0);
    for (let i = SR; i < 2 * SR; i++) d[i] = 0.5; // 뒤 1초만 크다
    const r = applyGainCapped(b, 8, 1, 1, 2);     // 뒤 1초에만 +18 dB
    check('구간 피크로 깎는다', Math.abs(r.applied - 2) < 1e-9, `${r.applied}`);
    check('구간 밖은 안 건드린다', Math.abs(peakOfRange(b, 0, 1) - 0.1) < 1e-6, `${peakOfRange(b, 0, 1)}`);
    check('구간 안은 천장까지', Math.abs(peakOfRange(b, 1, 2) - 1) < 1e-6, `${peakOfRange(b, 1, 2)}`);
  }

  // 무음은 나눗셈이 터지지 않아야 한다.
  {
    const b = dc(0, 1);
    const r = applyGainCapped(b, 8, 1);
    check('무음은 그대로 통과', r.applied === 8 && peakOfRange(b) === 0);
  }

  // 한 번에 걸리는 최대치는 200% (+6.02 dB) — 화면 쪽 상수와 같은 값이다.
  {
    const MAX_DB = Math.round(20 * Math.log10(2) * 100) / 100;
    check('200% 는 +6.02 dB', MAX_DB === 6.02, `${MAX_DB}`);
    const back = Math.round(Math.pow(10, MAX_DB / 20) * 100);
    check('6.02 dB 는 다시 200%', back === 200, `${back}%`);
  }
}


console.log('\n[9] 길이 바꾸기 — 속도 바꾸기와 타임 스트레치');
{
  /** 주파수를 재 본다 — 영교차 횟수로 대략의 음정을 잡는다. */
  const zeroCrossHz = (b, ch = 0) => {
    const d = b.getChannelData(ch);
    let n = 0;
    for (let i = 1; i < d.length; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) n++;
    return (n / 2) / (d.length / b.sampleRate);
  };
  const rms = (b, ch = 0) => {
    const d = b.getChannelData(ch);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / d.length);
  };

  // --- 속도 바꾸기: 길이가 준 만큼 음정이 올라간다 ---
  {
    const src = tone(440, 2);
    const half = applySpeedChange(src, 0.5, ctx);
    check('속도: 길이가 절반', half.length === Math.round(src.length * 0.5), `${half.length}`);
    const hz = zeroCrossHz(half);
    check('속도: 음정이 두 배 (440 → 880)', Math.abs(hz - 880) < 15, `${hz.toFixed(1)} Hz`);
  }
  {
    const src = tone(440, 2);
    const slow = applySpeedChange(src, 2, ctx);
    check('속도: 두 배 길이', slow.length === src.length * 2, `${slow.length}`);
    const hz = zeroCrossHz(slow);
    check('속도: 음정이 절반 (440 → 220)', Math.abs(hz - 220) < 10, `${hz.toFixed(1)} Hz`);
  }
  {
    const st = new FakeBuffer(2, SR, SR);
    st.getChannelData(0).fill(0.5);
    st.getChannelData(1).fill(-0.5);
    const out = applySpeedChange(st, 0.5, ctx);
    check('속도: 채널 수가 유지된다', out.numberOfChannels === 2);
    check('속도: 채널이 안 섞인다', out.getChannelData(0)[10] > 0.4 && out.getChannelData(1)[10] < -0.4);
  }

  // --- 타임 스트레치: 길이만 바뀌고 음정은 그대로 ---
  {
    const src = tone(440, 2);
    for (const r of [1.25, 0.8]) {
      const out = timeStretch(src, r, ctx);
      const want = Math.round(src.length * r);
      check(`스트레치 ×${r}: 길이가 맞는다`, Math.abs(out.length - want) < 2, `${out.length} (기대 ${want})`);
      const hz = zeroCrossHz(out);
      check(`스트레치 ×${r}: 음정이 그대로 (440)`, Math.abs(hz - 440) < 12, `${hz.toFixed(1)} Hz`);
      const dropDb = 20 * Math.log10(rms(out) / rms(src));
      check(`스트레치 ×${r}: 음량이 안 파인다`, Math.abs(dropDb) < 1.5, `${dropDb.toFixed(2)} dB`);
    }
  }
  {
    // 가장자리가 페이드처럼 파이면 안 된다 — 창 합으로 나눠서 막았다.
    const src = dc(0.5, 1);
    const out = timeStretch(src, 1.2, ctx);
    const d = out.getChannelData(0);
    const mid = d[Math.floor(d.length / 2)];
    check('스트레치: 한가운데가 원래 크기', Math.abs(mid - 0.5) < 0.02, `${mid.toFixed(4)}`);
    check('스트레치: 시작 100표본 뒤도 원래 크기', Math.abs(d[100] - 0.5) < 0.05, `${d[100].toFixed(4)}`);
    check('스트레치: 끝 100표본 앞도 원래 크기', Math.abs(d[d.length - 100] - 0.5) < 0.05, `${d[d.length-100].toFixed(4)}`);
  }
  {
    const src = tone(440, 1, 2);
    const out = timeStretch(src, 1.3, ctx);
    check('스트레치: 스테레오 채널 수 유지', out.numberOfChannels === 2);
    // 두 채널이 같은 자리에서 잘려야 음상이 안 찢어진다 — 같은 입력이면 출력도 같아야 한다.
    let maxDiff = 0;
    for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out.getChannelData(0)[i] - out.getChannelData(1)[i]));
    check('스트레치: 두 채널이 같은 자리에서 이어진다', maxDiff < 1e-6, `최대 차 ${maxDiff.toExponential(1)}`);
  }
  {
    /*
     * 끝이 무음으로 남으면 안 된다. 탐색 결과를 다음 기준으로 되먹였더니
     * 어긋남이 쌓여 입력이 먼저 바닥났고, 뒤 10.6%가 무음이 됐던 자리다.
     */
    for (const r of [1.25, 1.6, 0.7]) {
      const out = timeStretch(tone(440, 2), r, ctx);
      const d = out.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-4) last = i;
      const filled = last / d.length;
      check(`스트레치 ×${r}: 끝까지 채운다`, filled > 0.995, `${(filled * 100).toFixed(1)}% 까지 소리가 있다`);
    }
  }
  {
    const src = tone(440, 1);
    const same = timeStretch(src, 1, ctx);
    check('스트레치 ×1 은 그대로 통과', same.length === src.length && Math.abs(same.getChannelData(0)[500] - src.getChannelData(0)[500]) < 1e-9);
  }

  // --- 조각 길이 ---
  {
    /** 특정 주파수 성분의 세기 (한 점 DFT). 조각이 한 주기보다 짧으면 죽는다. */
    const at = (b, hz) => {
      const x = b.getChannelData(0);
      let re = 0, im = 0;
      for (let i = 0; i < x.length; i++) {
        const w = (2 * Math.PI * hz * i) / SR;
        re += x[i] * Math.cos(w); im += x[i] * Math.sin(w);
      }
      return Math.sqrt(re * re + im * im) / x.length;
    };
    /** 포락선 흔들림(%) — 이어 붙인 자리가 거칠수록 커진다. */
    const ripple = (b) => {
      const x = b.getChannelData(0), H = 480, n = Math.floor(x.length / H), e = [];
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = i * H; j < (i + 1) * H; j++) s += x[j] * x[j];
        e.push(Math.sqrt(s / H));
      }
      const m = e.reduce((a, v) => a + v, 0) / e.length;
      return (Math.sqrt(e.reduce((a, v) => a + (v - m) ** 2, 0) / e.length) / m) * 100;
    };
    // 50 Hz(주기 20 ms) 저역이 든 자료
    const lowMat = () => {
      const b = dc(0, 2), d = b.getChannelData(0);
      let seed = 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
      for (let i = 0; i < d.length; i++) {
        d[i] = Math.sin((2 * Math.PI * 50 * i) / SR) * 0.45 + Math.sin((2 * Math.PI * 400 * i) / SR) * 0.2 + rnd() * 0.05;
      }
      return b;
    };

    const src50 = at(lowMat(), 50);
    const short5 = at(timeStretch(lowMat(), 1.3, ctx, 5), 50);
    const ok20 = at(timeStretch(lowMat(), 1.3, ctx, 20), 50);
    check('조각이 한 주기보다 짧으면 저역이 죽는다 (5 ms · 50 Hz)',
      short5 < src50 * 0.05, `${src50.toFixed(4)} → ${short5.toFixed(4)}`);
    check('한 주기를 담으면 저역이 남는다 (20 ms · 50 Hz)',
      ok20 > src50 * 0.95, `${src50.toFixed(4)} → ${ok20.toFixed(4)}`);

    const r20 = ripple(timeStretch(lowMat(), 1.3, ctx, 20));
    const r200 = ripple(timeStretch(lowMat(), 1.3, ctx, 200));
    check('조각이 길수록 거칠어진다 (20 ms < 200 ms)', r20 < r200 / 3, `${r20.toFixed(2)}% vs ${r200.toFixed(2)}%`);

    check('기본 조각은 20 ms', TIME_STRETCH_FRAME_MS_DEFAULT === 20, `${TIME_STRETCH_FRAME_MS_DEFAULT}`);

    // 폭 밖의 값은 묶인다 — 길이는 그래도 정확해야 한다
    for (const fm of [0, -5, 5000]) {
      const out = timeStretch(tone(440, 1), 1.2, ctx, fm);
      check(`조각 ${fm} ms 를 줘도 길이는 맞는다`, Math.abs(out.length - Math.round(SR * 1.2)) < 2, `${out.length}`);
    }
  }

  // --- 마디 스냅 ---
  {
    const bar = barSeconds(120, 4);
    check('120 BPM 4/4 한 마디는 2초', Math.abs(bar - 2) < 1e-9, `${bar}`);
    const snap = (sec) => Math.max(1, Math.round(sec / bar)) * bar;
    check('7.70초는 4마디(8초)로 붙는다', Math.abs(snap(7.7) - 8) < 1e-9, `${snap(7.7)}`);
    check('8.90초는 4마디(8초)로 붙는다', Math.abs(snap(8.9) - 8) < 1e-9, `${snap(8.9)}`);
    check('9.10초는 5마디(10초)로 붙는다', Math.abs(snap(9.1) - 10) < 1e-9, `${snap(9.1)}`);
    check('아주 짧아도 한 마디 밑으로는 안 간다', Math.abs(snap(0.2) - bar) < 1e-9, `${snap(0.2)}`);
  }
}

console.log(`\n${fail === 0 ? '전부 통과' : '실패 있음'}: ${pass} pass, ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);

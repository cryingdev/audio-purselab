/**
 * 여러 클립을 한 트랙으로 굽는다 (병합 작업대).
 *
 * 모델은 클립마다 **레인 + 시작 오프셋** 둘뿐이고, "이어 붙이기"와 "겹치기"를
 * 따로 만들지 않는다. 둘은 같은 모델의 두 배치일 뿐이다:
 *
 *   이어 붙이기 = 시작 오프셋이 (앞 클립 끝 − 크로스페이드) 인 배치
 *   겹치기      = 다른 레인에 같은 오프셋인 배치
 *
 * 레인은 소리에 영향을 주지 않는다 — 렌더는 전부 합산이다. 레인은 화면에서
 * 겹친 클립을 알아보기 위한 것이고, 같은 레인 안에서만 "뒤에 붙이기"의
 * 기준점을 잡는다.
 */

import { PROJECT_SAMPLE_RATE } from './audioUtils';

export interface CompClip {
  id: string;
  name: string;
  buffer: AudioBuffer;
  /** 화면상의 줄. 합산에는 영향이 없고 "뒤에 붙이기"의 기준으로만 쓴다. */
  lane: number;
  /** 타임라인 시작 위치(초). */
  startSec: number;
  /** 선형 배수. */
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
}

/** 등출력 페이드. sin²+cos²=1 이라 겹친 구간에서 음량이 파이지 않는다. */
function fadeInGain(t: number): number {
  return Math.sin(t * (Math.PI / 2));
}
function fadeOutGain(t: number): number {
  return Math.cos(t * (Math.PI / 2));
}

export function clipEndSec(clip: CompClip): number {
  return clip.startSec + clip.buffer.duration;
}

/** 결과 길이(표본). 가장 늦게 끝나는 클립이 정한다. */
export function compositionLength(clips: CompClip[], sampleRate = PROJECT_SAMPLE_RATE): number {
  let end = 0;
  for (const c of clips) {
    const e = Math.round(c.startSec * sampleRate) + c.buffer.length;
    if (e > end) end = e;
  }
  return end;
}

/**
 * 결과 채널 수는 클립 중 최대치다. 모노 클립은 전 채널에 복사해 가운데로 놓는다.
 * 저장소 규격상 음악·환경음은 스테레오, 효과음·말 상태음은 모노이므로,
 * 모노 자산을 만들 때 스테레오 클립을 섞지 않았는지 이 값으로 확인해야 한다.
 */
export function compositionChannels(clips: CompClip[]): number {
  let n = 1;
  for (const c of clips) {
    if (c.buffer.numberOfChannels > n) n = c.buffer.numberOfChannels;
  }
  return n;
}

/**
 * 다음 클립을 같은 레인 뒤에 이어 붙일 때의 시작 오프셋.
 * 크로스페이드만큼 앞으로 당겨 겹치므로 전체 길이는 합계보다 짧아진다.
 */
export function appendStartSec(clips: CompClip[], lane: number, crossfadeMs: number): number {
  const inLane = clips.filter(c => c.lane === lane);
  if (inLane.length === 0) return 0;
  const end = Math.max(...inLane.map(clipEndSec));
  return Math.max(0, end - crossfadeMs / 1000);
}

/**
 * 클립을 같은 레인 뒤에 이어 붙인 새 목록을 낸다.
 *
 * 이음매마다 앞 클립에는 페이드아웃, 뒤 클립에는 페이드인을 물려 등출력으로
 * 마주 보게 한다. 첫 클립은 겹칠 상대가 없으므로 페이드를 물리지 않는다.
 */
export function placeClips(
  existing: CompClip[],
  incoming: { id: string; name: string; buffer: AudioBuffer }[],
  lane: number,
  crossfadeMs: number
): CompClip[] {
  const clips = [...existing];

  for (const item of incoming) {
    const inLane = clips.filter(c => c.lane === lane);
    const first = inLane.length === 0;
    const xf = first ? 0 : crossfadeMs;
    const startSec = appendStartSec(clips, lane, xf);

    if (!first) {
      // 이 레인에서 가장 늦게 끝나는 클립이 이음매의 앞쪽이다.
      let prevIdx = -1;
      for (let i = 0; i < clips.length; i++) {
        if (clips[i].lane !== lane) continue;
        if (prevIdx < 0 || clipEndSec(clips[i]) > clipEndSec(clips[prevIdx])) prevIdx = i;
      }
      if (prevIdx >= 0) clips[prevIdx] = { ...clips[prevIdx], fadeOutMs: xf };
    }

    clips.push({
      id: item.id,
      name: item.name,
      buffer: item.buffer,
      lane,
      startSec,
      gain: 1,
      fadeInMs: xf,
      fadeOutMs: 0,
    });
  }
  return clips;
}

/**
 * 클립마다 **새 트랙(레인)** 을 하나씩 내주고 전부 0 초에 놓는다.
 *
 * `placeClips` 가 "뒤에 이어 붙이기"라면 이쪽은 "나란히 얹기"다 — 트랙 추가는
 * 길이를 늘리는 게 아니라 같은 시간대에 소리를 한 겹 더 쌓는 일이라서,
 * 이음매가 없고 따라서 페이드도 물리지 않는다.
 */
export function placeOnNewLanes(
  existing: CompClip[],
  incoming: { id: string; name: string; buffer: AudioBuffer }[]
): CompClip[] {
  const clips = [...existing];
  let lane = clips.length ? Math.max(...clips.map(c => c.lane)) + 1 : 0;

  for (const item of incoming) {
    clips.push({
      id: item.id,
      name: item.name,
      buffer: item.buffer,
      lane,
      startSec: 0,
      gain: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
    });
    lane++;
  }
  return clips;
}

/**
 * 클립을 타임라인 시각 `atSec` 에서 둘로 쪼갠다.
 *
 * 끼워넣기의 출발점이다 — 트랙 중간에 무언가를 넣으려면 먼저 그 자리를 갈라야 한다.
 * 페이드는 바깥쪽만 남긴다: 앞쪽은 원래 페이드인을, 뒤쪽은 원래 페이드아웃을 가져가고
 * 새로 생긴 접합면에는 페이드를 물리지 않는다. 물리면 붙여 놨을 때 가운데가 파인다.
 */
export function splitClipAt(
  clips: CompClip[],
  clipId: string,
  atSec: number,
  crop: (buffer: AudioBuffer, from: number, to: number) => AudioBuffer | null,
  newId: () => string
): CompClip[] {
  const clip = clips.find(c => c.id === clipId);
  if (!clip) return clips;

  const local = atSec - clip.startSec;
  // 양쪽 다 표본이 남아야 쪼갠 뜻이 있다.
  if (local <= 0 || local >= clip.buffer.duration) return clips;

  const left = crop(clip.buffer, 0, local);
  const right = crop(clip.buffer, local, clip.buffer.duration);
  if (!left || !right) return clips;

  return clips.flatMap(c => c.id !== clipId ? [c] : [
    { ...c, buffer: left, fadeOutMs: 0 },
    { ...c, id: newId(), name: `${c.name} (뒤)`, buffer: right, startSec: atSec, fadeInMs: 0 },
  ]);
}

/**
 * 트랙에 자리를 벌린다 — `atSec` 이후의 클립을 `secs` 만큼 뒤로 민다.
 *
 * 이게 없으면 중간에 무언가를 끼워 넣을 때 뒤엣것을 손으로 하나하나 밀어야 하고,
 * 그러다 한 개만 빠뜨려도 이음매가 어긋난다.
 */
export function rippleInsert(clips: CompClip[], lane: number, atSec: number, secs: number): CompClip[] {
  if (secs <= 0) return clips;
  return clips.map(c =>
    c.lane === lane && c.startSec >= atSec - 1e-9
      ? { ...c, startSec: Math.round((c.startSec + secs) * 1e4) / 1e4 }
      : c
  );
}

/**
 * 클립을 빼고 그 트랙의 뒤엣것을 앞으로 당겨 틈을 닫는다.
 *
 * 그냥 지우면 소리가 빠진 자리에 침묵이 남는다 — 그걸 원할 때도 있지만,
 * 잘라내고 이어 붙이는 흐름에서는 대개 닫히기를 바란다.
 */
export function rippleDelete(clips: CompClip[], clipId: string): CompClip[] {
  const gone = clips.find(c => c.id === clipId);
  if (!gone) return clips;

  /*
   * 당기는 양은 **뒤 클립이 빠진 클립의 시작 자리로 미끄러져 들어오는 만큼**이다.
   *
   * 클립 길이만큼 당기면 안 된다 — 크로스페이드로 이은 사슬에서는 클립이 이웃과
   * 겹쳐 있어서, 그 클립이 실제로 차지한 타임라인은 길이보다 크로스페이드만큼 짧다.
   * 8초 클립 셋을 750 ms 로 이어 붙인 뒤 가운데를 길이(8초)만큼 당겼더니 겹침이
   * 0.750 이 아니라 **1.500 초**가 됐다. 시작 자리를 기준으로 하면 크로스페이드로
   * 이었든 딱 붙였든 틈이 있든 한 규칙으로 맞는다.
   */
  const nextStart = clips
    .filter(c => c.lane === gone.lane && c.id !== clipId && c.startSec > gone.startSec + 1e-9)
    .reduce<number | null>((min, c) => (min === null || c.startSec < min ? c.startSec : min), null);
  const shift = nextStart === null ? 0 : nextStart - gone.startSec;

  return clips
    .filter(c => c.id !== clipId)
    .map(c =>
      c.lane === gone.lane && c.startSec >= gone.startSec - 1e-9
        ? { ...c, startSec: Math.max(0, Math.round((c.startSec - shift) * 1e4) / 1e4) }
        : c
    );
}

/**
 * 트랙 하나를 위나 아래로 옮긴다 — 트랙 사이에 끼워 넣을 때 쓴다.
 * 두 트랙의 번호를 맞바꾸는 게 아니라, 사이에 밀어 넣고 나머지를 한 칸씩 민다.
 */
export function moveTrack(clips: CompClip[], fromLane: number, toLane: number): CompClip[] {
  if (fromLane === toLane) return clips;
  return clips.map(c => {
    if (c.lane === fromLane) return { ...c, lane: toLane };
    if (fromLane < toLane && c.lane > fromLane && c.lane <= toLane) return { ...c, lane: c.lane - 1 };
    if (fromLane > toLane && c.lane >= toLane && c.lane < fromLane) return { ...c, lane: c.lane + 1 };
    return c;
  });
}

/**
 * 트랙 하나를 통째로 뺀다 — 그 위의 클립까지 함께 지우고, **아래 트랙을 한 칸씩 끌어올린다.**
 *
 * 끌어올리지 않으면 번호에 구멍이 남아 빈 줄이 생기고, 그 뒤로 트랙을 세는 값
 * (`max(lane)+1`)이 실제 트랙 수와 어긋난다. `moveTrack` 이 자리를 바꾸는 것과 달리
 * 여기서는 자리 자체가 없어진다.
 */
export function removeTrack(clips: CompClip[], lane: number): CompClip[] {
  return clips
    .filter(c => c.lane !== lane)
    .map(c => (c.lane > lane ? { ...c, lane: c.lane - 1 } : c));
}

/** 페이드가 클립 길이를 넘지 않게 자른다. 넘치면 서로 곱해져 가운데가 파인다. */
function clampFades(lengthSamples: number, inS: number, outS: number): [number, number] {
  let fin = Math.max(0, Math.min(inS, lengthSamples));
  let fout = Math.max(0, Math.min(outS, lengthSamples));
  if (fin + fout > lengthSamples) {
    const room = lengthSamples - fin;
    fout = Math.max(0, room);
  }
  return [fin, fout];
}

/**
 * 전부 합산해 한 버퍼로 만든다.
 *
 * 겹친 구간에서 양쪽이 등출력 페이드를 마주 보고 있으면 합이 일정하게 유지된다 —
 * 이어 붙이기의 이음매가 이 성질에 기대고 있다.
 */
export function renderComposition(
  clips: CompClip[],
  audioCtx: AudioContext,
  sampleRate = PROJECT_SAMPLE_RATE
): AudioBuffer | null {
  if (clips.length === 0) return null;
  const length = compositionLength(clips, sampleRate);
  if (length <= 0) return null;

  const channels = compositionChannels(clips);
  const out = audioCtx.createBuffer(channels, length, sampleRate);

  for (const clip of clips) {
    const src = clip.buffer;
    const offset = Math.max(0, Math.round(clip.startSec * sampleRate));
    const [fadeIn, fadeOut] = clampFades(
      src.length,
      Math.round((clip.fadeInMs / 1000) * sampleRate),
      Math.round((clip.fadeOutMs / 1000) * sampleRate)
    );

    for (let ch = 0; ch < channels; ch++) {
      // 모노 클립은 모든 출력 채널에 같은 것을 넣는다.
      const srcCh = ch < src.numberOfChannels ? ch : 0;
      const data = src.getChannelData(srcCh);
      const dst = out.getChannelData(ch);

      for (let i = 0; i < src.length; i++) {
        const at = offset + i;
        if (at >= length) break;

        let g = clip.gain;
        if (fadeIn > 0 && i < fadeIn) g *= fadeInGain(i / fadeIn);
        if (fadeOut > 0 && i >= src.length - fadeOut) g *= fadeOutGain((i - (src.length - fadeOut)) / fadeOut);

        dst[at] += data[i] * g;
      }
    }
  }
  return out;
}

/**
 * 끝을 앞머리에 접어 도는 루프로 만든다 (끝→시작 크로스페이드).
 *
 * `makeSeamlessLoop` 은 루프 뒤에 남은 원본을 접지만, 합쳐서 만든 트랙은 뒤에
 * 남은 것이 없다. 그래서 여기서는 **마지막 wrapMs 를 앞머리에 겹치고 그만큼
 * 길이를 줄인다.** i=0 의 출력이 정확히 src[len-wrap] 이 되므로
 * src[len-wrap-1] → src[len-wrap] 로 이어져 이음매가 표본 단위로 연속이다.
 *
 * 길이가 wrapMs 만큼 줄어드는 점에 주의 — 마디 수를 지켜야 하는 음악에는
 * `makeSeamlessLoop` 를 쓰고, 길이가 자유로운 환경음에 이것을 쓴다.
 */
export function wrapLoopEnds(
  buffer: AudioBuffer,
  wrapMs: number,
  audioCtx: AudioContext
): AudioBuffer | null {
  const sr = buffer.sampleRate;
  const wrap = Math.min(
    Math.round((wrapMs / 1000) * sr),
    Math.floor(buffer.length / 2)
  );
  if (wrap <= 0) return buffer;

  const length = buffer.length - wrap;
  if (length <= 0) return null;

  const out = audioCtx.createBuffer(buffer.numberOfChannels, length, sr);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, length));
    for (let i = 0; i < wrap; i++) {
      const t = i / wrap;
      dst[i] = src[i] * fadeInGain(t) + src[length + i] * fadeOutGain(t);
    }
  }
  return out;
}

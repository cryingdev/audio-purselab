/**
 * Business logic for audio processing, WAV encoding, and buffer manipulation.
 *
 * Malworld 확장 (2026-08-11): 영상 임포트 · 48 kHz 고정 · 마디 격자 · 루프 제작 ·
 * 목표 dBFS 정규화. 근거와 규격은 Tools/Audio/suno-music-prompts.md 에 있다.
 */

/** 이 저장소의 오디오 규격. AudioContext 를 이 값으로 고정해야 장치 레이트를 안 따라간다. */
export const PROJECT_SAMPLE_RATE = 48000;

export function makeContext(sampleRate = PROJECT_SAMPLE_RATE): AudioContext {
  const Ctor = window.AudioContext || (window as any).webkitAudioContext;
  return new Ctor({ sampleRate });
}

export interface DecodedInfo {
  duration: number;
  channels: number;
  sampleRate: number;
  sourceKind: 'audio' | 'video';
}

/**
 * 어떤 파일이든 48 kHz PCM WAV Blob 으로 만든다.
 *
 * mp4(Veo)·mp3(Suno)·wav 를 가리지 않는 이유는 브라우저 미디어 스택이 컨테이너에서
 * 오디오 트랙만 뽑아 주기 때문이다 — ffmpeg 이 필요 없다. 영상 트랙은 그냥 버려진다.
 * 임포트 시점에 레이트를 고정하므로 이후 편집·내보내기가 전부 48 kHz 다.
 */
export async function decodeFileToWav(
  file: File,
  sampleRate = PROJECT_SAMPLE_RATE
): Promise<{ blob: Blob; info: DecodedInfo }> {
  const ctx = makeContext(sampleRate);
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return {
      blob: audioBufferToWav(buffer),
      info: {
        duration: buffer.duration,
        channels: buffer.numberOfChannels,
        sampleRate: buffer.sampleRate,
        sourceKind: file.type.startsWith('video/') ? 'video' : 'audio',
      },
    };
  } finally {
    void ctx.close();
  }
}

/**
 * 파일을 48 kHz AudioBuffer 로 연다. 병합 작업대처럼 여러 클립을 동시에
 * 들고 있어야 하는 쪽은 Blob 이 아니라 버퍼가 필요하다.
 *
 * AudioBuffer 는 만들어진 컨텍스트와 수명을 같이하지 않으므로 여기서 컨텍스트를
 * 닫아도 버퍼는 계속 쓸 수 있다.
 */
export async function decodeFileToBuffer(
  file: File,
  sampleRate = PROJECT_SAMPLE_RATE
): Promise<AudioBuffer> {
  const ctx = makeContext(sampleRate);
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    void ctx.close();
  }
}

/**
 * 원본 파일명을 저장소 관례(소문자 kebab-case + `-v1`)로 고친 **제안**을 만든다.
 *
 * Veo 와 Suno 가 주는 이름은 관례와 전혀 안 맞는다 —
 * `Rain_falling_on_wheat_field_202608131645.mp4` 를 그대로 내보내면 자산 30개를
 * 손으로 다시 이름 붙여야 한다. 뒤에 붙은 긴 숫자는 생성기가 찍은 시각이라 버린다.
 *
 * 어디까지나 제안이고 화면에서 고칠 수 있다 — 규칙이 못 맞히는 이름이 있기 때문이다.
 */
export function suggestAssetName(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, '');
  let s = noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // 생성기가 붙인 시각(8자리 이상 숫자)은 자산 이름이 아니다.
  s = s.replace(/-\d{8,}$/, '');
  if (!s) s = 'untitled';

  // 이미 버전이 있으면 그대로 둔다.
  return /-v\d+$/.test(s) ? s : `${s}-v1`;
}

// --- 마디 격자 ---

export function barSeconds(bpm: number, beatsPerBar = 4): number {
  return (60 / bpm) * beatsPerBar;
}

/** 가장 가까운 마디선으로 당긴다. offset 은 첫 다운비트 위치(초). */
export function snapToBar(time: number, bpm: number, beatsPerBar = 4, offset = 0): number {
  const bar = barSeconds(bpm, beatsPerBar);
  return Math.max(0, offset + Math.round((time - offset) / bar) * bar);
}

/** 구간이 몇 마디인지 (반올림 안 한 실수). 격자에 맞았는지 보는 용도다. */
export function barsBetween(start: number, end: number, bpm: number, beatsPerBar = 4): number {
  return (end - start) / barSeconds(bpm, beatsPerBar);
}

// --- 정규화 ---

export function peakOf(buffer: AudioBuffer): number {
  let maxVal = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > maxVal) maxVal = abs;
    }
  }
  return maxVal;
}

/**
 * 피크를 목표 dBFS 로 맞춘다. 저장소 규격이 -3 dBFS 다.
 *
 * 피크를 0 dBFS 로 올리는 판(`applyNormalization`)이 따로 있었는데 지웠다 —
 * 믹서에 남길 헤드룸을 없애서 규격을 어겼고, 화면에도 `Max` 라는 이름으로
 * 이것과 나란히 놓여 어느 쪽이 규격인지 알 수 없었다.
 */
export function applyNormalizeToDbfs(buffer: AudioBuffer, targetDbfs: number): AudioBuffer {
  const peak = peakOf(buffer);
  if (peak === 0) return buffer;
  return applyGain(buffer, Math.pow(10, targetDbfs / 20) / peak);
}

// --- 루프 제작 ---

/**
 * [start, end) 를 잘라 내되, 그 뒤 foldMs 만큼을 루프 앞머리에 등출력으로 겹쳐 섞는다.
 *
 * 왜 이렇게 하는가: 마디에서 그냥 자르면 마지막 화음의 잔향이 함께 잘려 나가서,
 * 루프가 도는 순간 잔향이 뚝 끊긴다. 루프 끝 다음의 foldMs 를 앞머리에 접어 넣으면
 * i=0 에서 출력이 정확히 buffer[end] 가 되므로 buffer[end-1] → buffer[end] 로 이어져
 * 이음매가 표본 단위로 연속이 된다. 길이는 정확히 end-start 로 유지되므로
 * 마디 수가 흐트러지지 않는다.
 *
 * foldMs 를 10~30 으로 두면 클릭 제거, 200~500 으로 두면 잔향 접기가 된다.
 */
export function makeSeamlessLoop(
  buffer: AudioBuffer,
  start: number,
  end: number,
  foldMs: number,
  audioCtx: AudioContext
): AudioBuffer | null {
  const sr = buffer.sampleRate;
  const startOffset = Math.floor(start * sr);
  const endOffset = Math.floor(end * sr);
  const length = endOffset - startOffset;
  if (length <= 0) return null;

  // 접을 꼬리는 루프 뒤에 실제로 남아 있는 만큼까지만.
  const fold = Math.min(
    Math.floor((foldMs / 1000) * sr),
    Math.max(0, buffer.length - endOffset),
    length
  );

  const out = audioCtx.createBuffer(buffer.numberOfChannels, length, sr);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(startOffset, endOffset));
    for (let i = 0; i < fold; i++) {
      const t = (i / fold) * (Math.PI / 2);
      dst[i] = dst[i] * Math.sin(t) + src[endOffset + i] * Math.cos(t);
    }
  }
  return out;
}

export function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const bufferLength = buffer.length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + bufferLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, bufferLength, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = buffer.getChannelData(channel)[i];
      sample = Math.max(-1, Math.min(1, sample));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function applyFade(buffer: AudioBuffer, start: number, end: number, type: 'in' | 'out'): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const startOffset = Math.floor(start * sampleRate);
  const endOffset = Math.floor(end * sampleRate);
  const durationSamples = endOffset - startOffset;

  if (durationSamples <= 0) return buffer;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < durationSamples; i++) {
      const index = startOffset + i;
      if (index >= data.length) break;

      let multiplier = type === 'in' ? i / durationSamples : 1 - (i / durationSamples);
      data[index] *= multiplier;
    }
  }
  return buffer;
}

/*
 * `analyzeNoiseProfile` 과 `applySpectralSubtraction`(UI 의 Clean Atmosphere)은
 * 2026-08-11 에 지웠다. 이름과 달리 스펙트럼 처리가 아니었다 — 빈을 `i % 128` 로
 * 잡았는데 그건 주파수가 아니라 표본 인덱스라서 FFT 가 한 줄도 없었고, 노이즈를
 * 지우는 대신 128표본 주기(48 kHz 에서 375 Hz)의 왜곡을 넣었다. 되살리려면
 * 진짜 STFT 로 다시 쓰는 수밖에 없다.
 */

/** [start, end) 안의 피크. 구간을 안 주면 통째. */
export function peakOfRange(buffer: AudioBuffer, start?: number, end?: number): number {
  const sr = buffer.sampleRate;
  const s = start !== undefined ? Math.max(0, Math.floor(start * sr)) : 0;
  const e = end !== undefined ? Math.min(buffer.length, Math.floor(end * sr)) : buffer.length;
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = s; i < e; i++) {
      const abs = Math.abs(data[i]);
      if (abs > max) max = abs;
    }
  }
  return max;
}

/**
 * 넘치지 않게 키운다 — **배수를 깎지, 파형을 자르지 않는다.**
 *
 * 그냥 곱하면 1 을 넘은 표본이 화면에는 남아 있다가 16-bit 로 쓸 때 ±1 로
 * 잘린다. 잘린 파형은 되돌릴 수 없고 배음이 생겨 소리가 뭉갠다. 그래서
 * **곱하기 전에** 결과 피크를 계산해서, 넘칠 배수면 천장에 딱 닿는 배수로 깎는다.
 * 선형 배수만 바뀌므로 소리의 성질은 그대로다.
 *
 * 이미 천장을 넘어 있는 자료는 **더 나쁘게만 안 만든다** — 억지로 끌어내리지
 * 않는다. 사용자가 -3 dB 를 걸었는데 -5 dB 가 걸리면 그게 더 놀랍기 때문이다.
 * 줄이는 쪽(배수 < 1)은 애초에 깎을 일이 없다.
 */
export function applyGainCapped(
  buffer: AudioBuffer,
  multiplier: number,
  ceiling: number,
  start?: number,
  end?: number
): { buffer: AudioBuffer; requested: number; applied: number; capped: boolean; peakBefore: number } {
  const peakBefore = peakOfRange(buffer, start, end);
  // 천장은 "지금 피크"와 "규정 천장" 중 큰 쪽 — 이미 넘은 것을 끌어내리지 않으려는 것이다.
  const allowed = Math.max(ceiling, peakBefore);
  const applied = peakBefore > 0 ? Math.min(multiplier, allowed / peakBefore) : multiplier;
  applyGain(buffer, applied, start, end);
  return { buffer, requested: multiplier, applied, capped: applied < multiplier - 1e-9, peakBefore };
}

export function applyGain(buffer: AudioBuffer, multiplier: number, start?: number, end?: number): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const startOffset = start !== undefined ? Math.floor(start * sampleRate) : 0;
  const endOffset = end !== undefined ? Math.floor(end * sampleRate) : buffer.length;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = startOffset; i < endOffset; i++) {
      if (i >= data.length) break;
      data[i] *= multiplier;
    }
  }
  return buffer;
}

/**
 * 앞뒤를 뒤집는다. 구간을 주면 그 안만, 안 주면 통째로.
 *
 * 표본 순서만 거꾸로 돌리므로 **표본 수도 피크도 그대로**다 — 잘려 나가는 것이 없다.
 * 구간만 뒤집을 때는 그 바깥이 손대지지 않으므로 경계에서 파형이 튈 수 있는데,
 * 그건 페이드로 다듬을 몫이다.
 */
/**
 * 속도를 바꿔 길이를 맞춘다 — **음정도 같이 바뀐다.**
 *
 * `ratio` 는 "새 길이 ÷ 옛 길이"다. 0.5 면 절반 길이가 되고 두 배 빨라지며
 * 음정이 한 옥타브 올라간다. 테이프를 빨리 돌리는 것과 같다.
 *
 * 선형 보간으로 다시 뽑는다. 빨리 돌릴 때(ratio < 1) 원본의 높은 쪽이
 * 나이키스트를 넘어 되접히는데(에일리어싱), 선형 보간이 약한 저역통과 노릇을
 * 해서 실제로는 거의 안 들린다. 음정을 지키고 싶으면 `timeStretch` 를 쓴다.
 */
export function applySpeedChange(buffer: AudioBuffer, ratio: number, audioCtx: AudioContext): AudioBuffer {
  const outLen = Math.max(1, Math.round(buffer.length * ratio));
  const out = audioCtx.createBuffer(buffer.numberOfChannels, outLen, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    const last = src.length - 1;
    for (let i = 0; i < outLen; i++) {
      const at = i / ratio;
      const i0 = Math.floor(at);
      if (i0 >= last) { dst[i] = src[last] ?? 0; continue; }
      const frac = at - i0;
      dst[i] = src[i0] + (src[i0 + 1] - src[i0]) * frac;
    }
  }
  return out;
}

/**
 * 타임 스트레치의 조각 길이. 자료에 맞춰 고른다 — 짧으면 타격음이 안 번지고,
 * 길면 지속음이 매끄럽다. 화면과 함수가 같은 값을 봐야 하므로 여기 둔다.
 */
export const TIME_STRETCH_FRAME_MS_DEFAULT = 20;
export const TIME_STRETCH_FRAME_MS_MIN = 5;
export const TIME_STRETCH_FRAME_MS_MAX = 200;

/** 50% 겹침에서 합이 1 이 되는 창. 겹쳐 더한 뒤 창 합으로 나누므로 가장자리도 안 파인다. */
function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * 음정은 그대로 두고 길이만 바꾼다 (WSOLA).
 *
 * `ratio` 는 "새 길이 ÷ 옛 길이"다. 1.04 면 4% 늘어난다.
 *
 * 왜 겹쳐 붙이는가: 그냥 잘라 이으면 이음매에서 파형의 위상이 어긋나 딸깍거린다.
 * WSOLA 는 **다음 조각을 가져올 자리를 ±10 ms 안에서 옮겨 가며 찾아**, 앞 조각이
 * 자연스럽게 이어질 파형과 가장 닮은 자리를 고른다. 그래서 위상이 맞물린다.
 *
 * **스테레오는 두 채널을 같은 자리에서 가져온다.** 채널마다 따로 찾으면 좌우가
 * 다른 지점을 쓰게 되어 음상이 찢어진다 — 닮은 정도는 두 채널을 더한 것에서 잰다.
 *
 * **조각 길이(`frameMs`)가 품질을 가른다.** 아래위로 이유가 다르다:
 *
 * - **아래쪽 한계는 저역이 정한다.** 조각이 한 주기보다 짧으면 그 주파수가 통째로
 *   사라진다. 실측: 50 Hz(주기 20 ms)가 든 자료를 5 ms 조각으로 늘렸더니 50 Hz
 *   성분이 0.2250 → 0.0023 으로 **약 40 dB 죽었다.** 20 ms 조각에서는 그대로였다.
 * - **위쪽은 길수록 거칠어진다.** 50% 겹침에서 한 번의 정렬로 긴 구간을 다 맞출 수
 *   없기 때문이다. 실측(×1.3, 포락선 흔들림): 20 ms 0.34% · 43 ms 3.14% ·
 *   80 ms 6.09% · 200 ms 8.97% (원본 0.35%). 탐색 폭을 조각에 비례시켜도
 *   그대로였으므로(8.96%) 탐색 범위 탓이 아니라 겹쳐 붙이기의 성질이다.
 * - 긴 조각은 **타격음도 번진다.** 홀로 있는 타격음을 2.5배로 늘렸을 때 120 ms
 *   조각에서는 봉우리가 **두 개**가 됐고, 20 ms 에서는 하나로 남았다.
 *
 * 그래서 기본은 **20 ms** 다 — 50 Hz 까지 담으면서 가장 매끄러웠다. 더 깊은 저역이
 * 든 자료(20 Hz 대 럼블)라면 40~60 ms 로 올린다. 저역이 아예 없는 자료라면
 * 10 ms 로 내려도 된다.
 */
export function timeStretch(
  buffer: AudioBuffer,
  ratio: number,
  audioCtx: AudioContext,
  frameMs = TIME_STRETCH_FRAME_MS_DEFAULT
): AudioBuffer {
  const chans = buffer.numberOfChannels;
  const inLen = buffer.length;
  const outLen = Math.max(1, Math.round(inLen * ratio));

  // 길이가 그대로면 손대지 않는다 — 괜히 겹쳐 붙이면 소리만 흐려진다.
  if (Math.abs(ratio - 1) < 1e-6 || inLen === 0) {
    const same = audioCtx.createBuffer(chans, inLen, buffer.sampleRate);
    for (let c = 0; c < chans; c++) same.getChannelData(c).set(buffer.getChannelData(c));
    return same;
  }

  /*
   * 조각은 **짝수 표본**이어야 한다 — 절반씩 겹치므로 홀수면 겹침이 어긋난다.
   * 아래위로 묶는다: 5 ms 밑은 조각이 파형 한 주기도 못 담고, 200 ms 위는
   * 어느 자료에서든 번져서 쓸 수가 없다.
   */
  const ms = Math.min(TIME_STRETCH_FRAME_MS_MAX, Math.max(TIME_STRETCH_FRAME_MS_MIN, frameMs));
  const FRAME = Math.max(128, Math.round((ms / 1000) * buffer.sampleRate / 2) * 2);
  const HOP_OUT = FRAME >> 1;     // 50% 겹침
  const OVERLAP = FRAME - HOP_OUT;
  // 찾는 폭은 ±10 ms (100 Hz 주기까지 덮는다). 조각보다 넓게 찾을 이유는 없다.
  const SEARCH = Math.min(Math.round(0.010 * buffer.sampleRate), FRAME);
  const COARSE = 8;               // 성기게 훑고 그 근처만 촘촘히 — 전수 탐색은 너무 느리다

  const out = audioCtx.createBuffer(chans, outLen, buffer.sampleRate);
  const src: Float32Array[] = [];
  const dst: Float32Array[] = [];
  for (let c = 0; c < chans; c++) { src.push(buffer.getChannelData(c)); dst.push(out.getChannelData(c)); }

  const win = hannWindow(FRAME);
  const winSum = new Float32Array(outLen);

  /** 두 자리의 닮은 정도. 채널을 더해서 재므로 스테레오가 한 몸으로 움직인다. */
  const similarity = (a: number, b: number): number => {
    let dot = 0, energy = 0;
    for (let i = 0; i < OVERLAP; i += 2) {   // 두 표본에 하나씩만 봐도 최댓값 자리는 안 바뀐다
      let va = 0, vb = 0;
      for (let c = 0; c < chans; c++) { va += src[c][a + i] ?? 0; vb += src[c][b + i] ?? 0; }
      dot += va * vb;
      energy += vb * vb;
    }
    // 에너지로 나눠야 큰 소리가 난 자리로만 쏠리지 않는다.
    return dot / Math.sqrt(energy + 1e-9);
  };

  const hopIn = HOP_OUT / ratio;
  /*
   * `nominal` 은 **탐색 결과를 되먹이지 않는** 기준 위치다. 찾아낸 자리를 다음
   * 기준으로 삼았더니 어긋남이 쌓여 입력이 먼저 바닥났고, 2초를 1.25배로 늘렸을 때
   * **뒤 10.6%가 무음**이 됐다 (음정을 재면 440 Hz 가 393 Hz 로 읽혔다).
   * 기준을 따로 두면 inPos/outPos 비가 정확히 1/ratio 로 유지되어 끝에서 딱 맞는다.
   */
  let nominal = 0;
  let inPos = 0;
  let outPos = 0;

  while (outPos < outLen) {
    const take = Math.min(FRAME, outLen - outPos, inLen - inPos);
    if (take <= 0) break;
    for (let c = 0; c < chans; c++) {
      const s = src[c], d = dst[c];
      for (let i = 0; i < take; i++) d[outPos + i] += s[inPos + i] * win[i];
    }
    for (let i = 0; i < take; i++) winSum[outPos + i] += win[i];

    /*
     * 다음 조각을 어디서 가져올까. 이 조각 뒤에 **자연스럽게 이어질** 파형은
     * `inPos + HOP_OUT` 부터다. 그것과 가장 닮은 자리를 기준 위치 근처에서 찾는다.
     */
    nominal += hopIn;
    const ideal = Math.round(nominal);
    const template = inPos + HOP_OUT;
    const lo = Math.max(0, ideal - SEARCH);
    const hi = Math.min(inLen - OVERLAP - 1, ideal + SEARCH);

    // 끝머리라 찾을 자리가 없으면 **멈추지 않고** 기준 자리를 그냥 쓴다.
    // 멈추면 남은 출력이 무음으로 남는다.
    let best = Math.min(ideal, Math.max(0, inLen - 1));
    if (hi > lo && template + OVERLAP < inLen) {
      let bestScore = -Infinity;
      for (let q = lo; q <= hi; q += COARSE) {
        const sc = similarity(template, q);
        if (sc > bestScore) { bestScore = sc; best = q; }
      }
      for (let q = Math.max(lo, best - COARSE); q <= Math.min(hi, best + COARSE); q++) {
        const sc = similarity(template, q);
        if (sc > bestScore) { bestScore = sc; best = q; }
      }
    }

    inPos = best;
    outPos += HOP_OUT;
  }

  /*
   * 창 합으로 나눈다. 한 조각만 덮은 가장자리에서도 원래 크기가 그대로 살아난다
   * (같은 창으로 곱했다가 그 창으로 나누므로). 안 나누면 앞뒤가 페이드처럼 파인다.
   */
  for (let c = 0; c < chans; c++) {
    const d = dst[c];
    for (let i = 0; i < outLen; i++) {
      const w = winSum[i];
      if (w > 1e-3) d[i] /= w;
    }
  }
  return out;
}

export function applyReverse(buffer: AudioBuffer, start?: number, end?: number): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const rawFrom = start !== undefined ? Math.floor(start * sampleRate) : 0;
  const rawTo = end !== undefined ? Math.floor(end * sampleRate) : buffer.length;
  const from = Math.max(0, Math.min(rawFrom, buffer.length));
  const to = Math.max(from, Math.min(rawTo, buffer.length));

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = from, j = to - 1; i < j; i++, j--) {
      const tmp = data[i];
      data[i] = data[j];
      data[j] = tmp;
    }
  }
  return buffer;
}

/**
 * 공간음(잔향)을 눌러 내리는 **다운워드 익스팬더**.
 *
 * 잔향은 타격 뒤에 남는 감쇠부다. 소리가 클 때는 손대지 않고 **문턱 아래로
 * 내려간 만큼을 비율만큼 더 눌러** 내리면 꼬리가 짧아지고 방이 물러난다.
 *
 * 게이트(`applyNoiseGate`)와 무엇이 다른가: 게이트는 문턱 아래를 표본마다
 * **0 으로 떨군다.** 어택·릴리스가 없어 꼬리가 뚝 끊기고 지퍼 노이즈가 난다.
 * 익스팬더는 0 으로 떨구지 않고 **비율만큼** 내리며, 그 변화도 시간을 두고
 * 움직인다. 그래서 잔향에 걸 수 있다.
 *
 *   문턱(`thresholdDb`)  — 이 아래를 누른다. 잔향 꼬리가 걸릴 자리로 잡는다.
 *   비율(`ratio`)        — 2:1 이면 문턱 아래 6 dB 가 12 dB 로 벌어진다. 클수록 세다.
 *   어택(`attackMs`)     — 소리가 올 때 손을 떼는 속도. 짧아야 타격이 안 뭉갠다.
 *   릴리스(`releaseMs`)  — 소리가 멎은 뒤 누르기까지. **잔향을 얼마나 남길지가 여기다.**
 *
 * **스테레오는 두 채널을 묶는다.** 채널마다 따로 누르면 좌우가 다른 양으로
 * 움직여 음상이 흔들린다 — 큰 쪽 채널로 재서 같은 이득을 건다. `timeStretch` 와 같은 이유다.
 */
export function applyExpander(
  buffer: AudioBuffer,
  opts: { thresholdDb?: number; ratio?: number; attackMs?: number; releaseMs?: number } = {}
): AudioBuffer {
  const thresholdDb = opts.thresholdDb ?? -30;
  const ratio = Math.max(1, opts.ratio ?? 3);
  const attackMs = Math.max(0.1, opts.attackMs ?? 2);
  const releaseMs = Math.max(1, opts.releaseMs ?? 80);
  if (ratio <= 1.0001) return buffer;

  const sr = buffer.sampleRate;
  const chans = buffer.numberOfChannels;
  const data: Float32Array[] = [];
  for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));

  /* 한 표본 지날 때 남는 비율. 시간이 길수록 1 에 가까워 천천히 움직인다. */
  const coef = (ms: number) => Math.exp(-1 / ((ms / 1000) * sr));
  const aEnv = coef(attackMs);
  const rEnv = coef(releaseMs);
  // 이득 자체도 살짝 미끄러뜨린다 — 계단으로 움직이면 지퍼 노이즈가 난다.
  const gSmooth = coef(3);

  let env = 0;
  let gain = 1;
  for (let i = 0; i < buffer.length; i++) {
    // 채널을 묶어 잰다 — 큰 쪽이 기준이다.
    let level = 0;
    for (let c = 0; c < chans; c++) { const v = Math.abs(data[c][i]); if (v > level) level = v; }

    // 올라갈 때는 어택, 내려갈 때는 릴리스.
    env = level > env ? aEnv * (env - level) + level : rEnv * (env - level) + level;

    const envDb = 20 * Math.log10(Math.max(env, 1e-9));
    // 문턱 위는 손대지 않는다. 아래로 내려간 만큼을 (ratio-1) 배로 더 누른다.
    const targetDb = envDb < thresholdDb ? (envDb - thresholdDb) * (ratio - 1) : 0;
    const target = Math.pow(10, Math.max(targetDb, -80) / 20);
    gain = gSmooth * (gain - target) + target;

    for (let c = 0; c < chans; c++) data[c][i] *= gain;
  }
  return buffer;
}

export function applyNoiseGate(buffer: AudioBuffer, threshold = 0.005): AudioBuffer {
  const numChannels = buffer.numberOfChannels;
  for (let c = 0; c < numChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      // Direct thresholding for noise gating
      if (Math.abs(data[i]) < threshold) {
        data[i] = 0;
      }
    }
  }
  return buffer;
}

export function applyCut(buffer: AudioBuffer, start: number, end: number, audioCtx: AudioContext): AudioBuffer | null {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const startOffset = Math.floor(start * sampleRate);
  const endOffset = Math.floor(end * sampleRate);
  const cutSamples = endOffset - startOffset;
  const newLength = buffer.length - cutSamples;
  
  if (newLength <= 0) return null;

  const newBuffer = audioCtx.createBuffer(numChannels, newLength, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const oldData = buffer.getChannelData(channel);
    const newData = newBuffer.getChannelData(channel);
    newData.set(oldData.subarray(0, startOffset));
    newData.set(oldData.subarray(endOffset), startOffset);
  }
  return newBuffer;
}

export function applyCrop(buffer: AudioBuffer, start: number, end: number, audioCtx: AudioContext): AudioBuffer | null {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const startOffset = Math.floor(start * sampleRate);
  const endOffset = Math.floor(end * sampleRate);
  const newLength = endOffset - startOffset;
  
  if (newLength <= 0) return null;

  const newBuffer = audioCtx.createBuffer(numChannels, newLength, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const oldData = buffer.getChannelData(channel);
    const newData = newBuffer.getChannelData(channel);
    newData.set(oldData.subarray(startOffset, endOffset));
  }
  return newBuffer;
}

export function applyExtractChannel(buffer: AudioBuffer, channelIndex: number, audioCtx: AudioContext): AudioBuffer {
  const newBuffer = audioCtx.createBuffer(1, buffer.length, buffer.sampleRate);
  if (channelIndex < buffer.numberOfChannels) {
    newBuffer.getChannelData(0).set(buffer.getChannelData(channelIndex));
  }
  return newBuffer;
}

export function applySilenceChannel(buffer: AudioBuffer, channelIndex: number): AudioBuffer {
  if (channelIndex < buffer.numberOfChannels) {
    const data = buffer.getChannelData(channelIndex);
    data.fill(0);
  }
  return buffer;
}

/**
 * 좌우가 얼마나 다른가. `RMS(L−R) ÷ RMS(L+R)` 다.
 *
 * 0 이면 두 채널이 완전히 같다 — **모노를 스테레오 그릇에 담아 온 것**이고,
 * 모노로 내려도 잃는 것이 하나도 없다. 진짜 스테레오는 0.1~1 쯤 나온다.
 * 실측: Veo 가 준 낟알 붓는 소리(2ch)가 **0.0007** 이었다.
 */
export function channelDifference(buffer: AudioBuffer): number {
  if (buffer.numberOfChannels < 2) return 0;
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  let diff = 0, sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const d = L[i] - R[i], m = L[i] + R[i];
    diff += d * d; sum += m * m;
  }
  if (sum === 0) return 0;
  return Math.sqrt(diff / sum);
}

/**
 * 이 아래면 "좌우가 사실상 같다"고 본다. -40 dB 다.
 * 진짜 스테레오는 이 값의 백 배쯤 나오므로 잘못 내릴 걱정이 없다.
 */
export const MONO_IDENTICAL_THRESHOLD = 0.01;

/**
 * 채널을 평균해 1채널로 내린다. Web Audio 의 기본 다운믹스와 같은 규칙이다.
 *
 * `mixBufferToMono` 와 결과는 같지만 이쪽은 **순수 함수**라 테스트로 지킬 수 있고
 * `OfflineAudioContext` 를 안 띄운다 — 담을 때마다 파일 수만큼 띄울 이유가 없다.
 */
export function downmixToMono(buffer: AudioBuffer, audioCtx: AudioContext): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const out = audioCtx.createBuffer(1, buffer.length, buffer.sampleRate);
  const d = out.getChannelData(0);
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const s = buffer.getChannelData(c);
    for (let i = 0; i < buffer.length; i++) d[i] += s[i] / n;
  }
  return out;
}

export async function mixBufferToMono(buffer: AudioBuffer, audioCtx: AudioContext): Promise<AudioBuffer> {
  const offlineCtx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start();
  return await offlineCtx.startRendering();
}

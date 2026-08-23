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

export async function mixBufferToMono(buffer: AudioBuffer, audioCtx: AudioContext): Promise<AudioBuffer> {
  const offlineCtx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start();
  return await offlineCtx.startRendering();
}

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
 * 피크를 목표 dBFS 로 맞춘다. 저장소 규격이 -3 dBFS 이고, 0 으로 올리는
 * applyNormalization 은 믹서에 남길 헤드룸을 없앤다.
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

export function analyzeNoiseProfile(buffer: AudioBuffer, start: number, end: number): Float32Array {
  const sampleRate = buffer.sampleRate;
  const startOffset = Math.floor(start * sampleRate);
  const endOffset = Math.floor(end * sampleRate);
  
  const data = buffer.getChannelData(0).subarray(startOffset, endOffset);
  const profileSize = 128;
  const profile = new Float32Array(profileSize);
  
  for (let i = 0; i < data.length; i++) {
    const bin = Math.floor((i % profileSize));
    profile[bin] += Math.abs(data[i]);
  }
  for (let i = 0; i < profileSize; i++) {
    profile[i] /= (data.length / profileSize);
  }
  return profile;
}

export function applySpectralSubtraction(buffer: AudioBuffer, profile: Float32Array): AudioBuffer {
  const numChannels = buffer.numberOfChannels;
  const profileSize = profile.length;
  
  for (let c = 0; c < numChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const bin = Math.floor((i % profileSize));
      const noiseEnergy = profile[bin];
      const sign = Math.sign(data[i]);
      let val = Math.abs(data[i]);
      
      if (val < noiseEnergy * 1.5) {
        val *= 0.1;
      } else {
        val -= noiseEnergy * 0.5;
      }
      data[i] = sign * Math.max(0, val);
    }
  }
  return buffer;
}

export function applyNormalization(buffer: AudioBuffer): AudioBuffer {
  const numChannels = buffer.numberOfChannels;
  let maxVal = 0;
  for (let c = 0; c < numChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > maxVal) maxVal = abs;
    }
  }
  if (maxVal === 0) return buffer;
  const multiplier = 1.0 / maxVal;
  for (let c = 0; c < numChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      data[i] *= multiplier;
    }
  }
  return buffer;
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

export async function mixToMono(originalUrl: string): Promise<Blob> {
  const response = await fetch(originalUrl);
  const arrayBuffer = await response.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const monoBuffer = await mixBufferToMono(audioBuffer, audioCtx);
  return audioBufferToWav(monoBuffer);
}

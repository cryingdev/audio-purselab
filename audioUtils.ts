/**
 * Business logic for audio processing, WAV encoding, and buffer manipulation.
 */

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

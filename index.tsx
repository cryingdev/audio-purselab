import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { 
  Play, 
  Pause, 
  Upload, 
  Scissors, 
  RotateCcw, 
  Volume2, 
  Maximize,
  FileAudio,
  Merge,
  Columns,
  Loader2,
  Download,
  X,
  Activity,
  Wind,
  Fingerprint,
  Sparkles,
  TrendingUp,
  TrendingDown,
  SkipBack,
  History,
  Minimize2,
  Volume1,
  VolumeX,
  AudioWaveform,
  Crop,
  Undo2,
  Redo2,
  PlayCircle,
  SlidersHorizontal,
  Check,
  Zap,
  Split,
  Plus,
  Repeat,
  Grid3x3,
  Film,
  Gauge,
  Magnet
} from 'lucide-react';

import {
  audioBufferToWav,
  applyFade,
  analyzeNoiseProfile,
  applySpectralSubtraction,
  applyNormalization,
  applyNoiseGate,
  applyCut,
  applyCrop,
  mixBufferToMono,
  applyExtractChannel,
  applySilenceChannel,
  applyGain,
  makeContext,
  decodeFileToWav,
  barSeconds,
  snapToBar,
  barsBetween,
  applyNormalizeToDbfs,
  makeSeamlessLoop,
  peakOf,
  PROJECT_SAMPLE_RATE
} from './audioUtils';

// --- Types ---

interface AudioState {
  file: File | null;
  originalUrl: string | null;
  currentUrl: string | null;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  isReady: boolean;
  isMono: boolean;
  isProcessing: boolean;
  processingMsg: string;
  noiseProfile: Float32Array | null;
  volume: number;
  undoStack: string[];
  redoStack: string[];
  gateThreshold: number;
  showGateSettings: boolean;
  gainMultiplier: number;
  showGainSettings: boolean;
  sourceKind: 'audio' | 'video' | null;
  channels: number;
}

/** 마디 격자와 루프 제작 설정. Malworld 확장. */
interface LoopState {
  bpm: number;
  beatsPerBar: number;
  /** 첫 다운비트 위치(초). Suno 곡은 인트로가 없어 0 이 대개 맞다. */
  downbeat: number;
  bars: number;
  foldMs: number;
  targetDbfs: number;
  snapEnabled: boolean;
  previewLooping: boolean;
}

// --- App Component ---

const App: React.FC = () => {
  const [audio, setAudio] = useState<AudioState>({
    file: null,
    originalUrl: null,
    currentUrl: null,
    duration: 0,
    currentTime: 0,
    isPlaying: false,
    isReady: false,
    isMono: false,
    isProcessing: false,
    processingMsg: '',
    noiseProfile: null,
    volume: 1.0,
    undoStack: [],
    redoStack: [],
    gateThreshold: 0.01,
    showGateSettings: false,
    gainMultiplier: 1.0,
    showGainSettings: false,
    sourceKind: null,
    channels: 0,
  });

  const [zoom, setZoom] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [activeRegion, setActiveRegion] = useState<any>(null);
  const [showChannelSettings, setShowChannelSettings] = useState(false);

  const [loop, setLoop] = useState<LoopState>({
    bpm: 120,
    beatsPerBar: 4,
    downbeat: 0,
    bars: 32,
    foldMs: 20,
    targetDbfs: -3,
    snapEnabled: true,
    previewLooping: false,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<any>(null);

  // 루프 재생은 timeupdate 콜백 안에서 판정하므로, 클로저가 낡지 않게 ref 로 읽는다.
  const loopPlaybackRef = useRef<{ active: boolean; start: number; end: number }>({
    active: false, start: 0, end: 0,
  });

  // Initialize WaveSurfer
  useEffect(() => {
    if (!containerRef.current || !audio.currentUrl) return;

    const currentTime = wavesurferRef.current?.getCurrentTime() || 0;
    const wasPlaying = wavesurferRef.current?.isPlaying() || false;

    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
    }

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: 'rgb(129, 140, 248)',
      progressColor: 'rgb(99, 102, 241)',
      cursorColor: '#ffffff',
      barWidth: 2,
      barGap: 1,
      height: 300,
      normalize: true,
      splitChannels: (!audio.isMono) as any,
      url: audio.currentUrl,
      minPxPerSec: zoom,
      autoScroll: true,
      hideScrollbar: false,
    });

    const regions = ws.registerPlugin(RegionsPlugin.create());
    regionsRef.current = regions;

    ws.on('ready', () => {
      setAudio(prev => ({ ...prev, duration: ws.getDuration(), isReady: true, isProcessing: false, processingMsg: '' }));
      ws.setTime(currentTime > ws.getDuration() ? 0 : currentTime);
      ws.setVolume(audio.volume);
      if (wasPlaying) ws.play();
    });

    ws.on('play', () => setAudio(prev => ({ ...prev, isPlaying: true })));
    ws.on('pause', () => setAudio(prev => ({ ...prev, isPlaying: false })));
    ws.on('timeupdate', (time) => {
      // 루프 미리듣기: 끝을 지나면 시작으로 되돌린다. 이음매를 실제로 들어 보는
      // 유일한 방법이고, 이게 없으면 루프가 맞는지 판정할 수가 없다.
      const lp = loopPlaybackRef.current;
      if (lp.active && time >= lp.end) {
        ws.setTime(lp.start);
        return;
      }
      setAudio(prev => ({ ...prev, currentTime: time }));
    });

    regions.enableDragSelection({
      color: 'rgba(99, 102, 241, 0.3)',
    });

    regions.on('region-created', (region) => {
      regions.getRegions().forEach(r => {
        if (r !== region) r.remove();
      });
      setActiveRegion(region);
    });

    regions.on('region-updated', (region) => {
      setActiveRegion(region);
    });

    wavesurferRef.current = ws;

    return () => {
      ws.destroy();
    };
  }, [audio.currentUrl, audio.isMono]);

  /**
   * 오디오든 영상이든 받아서 48 kHz PCM WAV 로 바꿔 놓고 시작한다.
   *
   * Veo 는 mp4, Suno 는 mp3 를 주는데 둘 다 브라우저가 오디오 트랙만 디코드해 주므로
   * ffmpeg 이 필요 없다. 임포트에서 레이트를 못 박아 두면 이후 모든 편집과 내보내기가
   * 48 kHz 로 유지된다 — 원래는 출력 장치 레이트를 따라가서 44.1 kHz 가 조용히 섞였다.
   */
  const handleFileUpload = async (file: File) => {
    if (!file) return;
    const isMedia = file.type.startsWith('audio/') || file.type.startsWith('video/');
    if (!isMedia) {
      alert(`오디오나 영상 파일이 아닙니다: ${file.type || '알 수 없는 형식'}`);
      return;
    }

    if (audio.originalUrl) URL.revokeObjectURL(audio.originalUrl);
    audio.undoStack.forEach(url => url !== audio.originalUrl && URL.revokeObjectURL(url));
    audio.redoStack.forEach(url => URL.revokeObjectURL(url));

    setAudio(prev => ({
      ...prev,
      isProcessing: true,
      processingMsg: file.type.startsWith('video/')
        ? '영상에서 오디오 트랙 추출 중…'
        : '48 kHz 로 디코드 중…',
    }));

    try {
      const { blob, info } = await decodeFileToWav(file, PROJECT_SAMPLE_RATE);
      const url = URL.createObjectURL(blob);
      setAudio({
        file,
        originalUrl: url,
        currentUrl: url,
        duration: info.duration,
        currentTime: 0,
        isPlaying: false,
        isReady: false,
        isMono: info.channels === 1,
        isProcessing: false,
        processingMsg: '',
        noiseProfile: null,
        volume: 1.0,
        undoStack: [],
        redoStack: [],
        gateThreshold: 0.01,
        showGateSettings: false,
        gainMultiplier: 1.0,
        showGainSettings: false,
        sourceKind: info.sourceKind,
        channels: info.channels,
      });
      setActiveRegion(null);
      setShowChannelSettings(false);
      loopPlaybackRef.current = { active: false, start: 0, end: 0 };
      setLoop(prev => ({ ...prev, previewLooping: false, downbeat: 0 }));
    } catch (e: any) {
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
      alert(`디코드할 수 없습니다: ${e?.message ?? e}\n\n브라우저가 못 여는 코덱이면 이 파일만 ffmpeg 으로 wav 를 뽑아 주십시오.`);
    }
  };

  const handleUndo = () => {
    if (audio.undoStack.length === 0 || !audio.currentUrl) return;
    
    const newUndoStack = [...audio.undoStack];
    const previousUrl = newUndoStack.pop()!;
    const currentUrl = audio.currentUrl;

    setAudio(prev => ({
      ...prev,
      currentUrl: previousUrl,
      undoStack: newUndoStack,
      redoStack: [currentUrl, ...prev.redoStack],
      isProcessing: false,
      processingMsg: ''
    }));
    setActiveRegion(null);
  };

  const handleRedo = () => {
    if (audio.redoStack.length === 0 || !audio.currentUrl) return;

    const newRedoStack = [...audio.redoStack];
    const nextUrl = newRedoStack.shift()!;
    const currentUrl = audio.currentUrl;

    setAudio(prev => ({
      ...prev,
      currentUrl: nextUrl,
      redoStack: newRedoStack,
      undoStack: [...prev.undoStack, currentUrl],
      isProcessing: false,
      processingMsg: ''
    }));
    setActiveRegion(null);
  };

  const handleRevert = () => {
    if (!audio.originalUrl || !confirm("Discard all edits and revert to original source?")) return;
    
    const currentUrl = audio.currentUrl;
    
    setAudio(prev => ({
      ...prev,
      currentUrl: prev.originalUrl,
      isMono: false,
      noiseProfile: null,
      isProcessing: false,
      processingMsg: '',
      undoStack: currentUrl ? [...prev.undoStack, currentUrl] : prev.undoStack,
      redoStack: [],
      showGateSettings: false,
      showGainSettings: false
    }));
    setActiveRegion(null);
    setShowChannelSettings(false);
    regionsRef.current?.clearRegions();
  };

  const performProcessing = async (msg: string, processor: (buffer: AudioBuffer, ctx: AudioContext) => AudioBuffer | null | Promise<AudioBuffer | null>) => {
    if (!audio.currentUrl) return;
    setAudio(prev => ({ ...prev, isProcessing: true, processingMsg: msg }));
    
    try {
      const response = await fetch(audio.currentUrl);
      const arrayBuffer = await response.arrayBuffer();
      const audioCtx = makeContext(); // 48 kHz 고정 — 장치 레이트를 따라가면 조용히 리샘플링된다
      const sourceBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      
      const newBuffer = await processor(sourceBuffer, audioCtx);
      if (!newBuffer) {
        setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
        return;
      }
      
      const newBlob = audioBufferToWav(newBuffer);
      const newUrl = URL.createObjectURL(newBlob);
      const oldUrl = audio.currentUrl;
      
      setAudio(prev => ({
        ...prev,
        currentUrl: newUrl,
        isProcessing: false,
        processingMsg: '',
        isMono: newBuffer.numberOfChannels === 1,
        undoStack: [...prev.undoStack, oldUrl],
        redoStack: [],
        showGateSettings: false,
        showGainSettings: false
      }));
      setActiveRegion(null);
      setShowChannelSettings(false);
    } catch (error) {
      console.error("Processing failed", error);
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
    }
  };

  const handleFadeAction = (type: 'in' | 'out') => {
    if (!activeRegion) return;
    performProcessing(`Fading ${type}...`, (buffer) => 
      applyFade(buffer, activeRegion.start, activeRegion.end, type)
    );
  };

  const handleAnalyzeNoiseAction = async () => {
    if (!activeRegion || !audio.currentUrl) return;
    setAudio(prev => ({ ...prev, isProcessing: true, processingMsg: 'Sampling Noise Fingerprint...' }));

    try {
      const response = await fetch(audio.currentUrl);
      const arrayBuffer = await response.arrayBuffer();
      const audioCtx = makeContext(); // 48 kHz 고정 — 장치 레이트를 따라가면 조용히 리샘플링된다
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      
      const profile = analyzeNoiseProfile(buffer, activeRegion.start, activeRegion.end);

      setAudio(prev => ({
        ...prev,
        noiseProfile: profile,
        isProcessing: false,
        processingMsg: ''
      }));
    } catch (error) {
      console.error("Analysis failed", error);
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
    }
  };

  const handleCleanAtmosphereAction = () => {
    if (!audio.noiseProfile) return;
    performProcessing('Spectral Subtraction...', (buffer) => 
      applySpectralSubtraction(buffer, audio.noiseProfile!)
    );
  };

  const handleNormalizeAction = () => {
    performProcessing('Normalizing Peaks...', applyNormalization);
  };

  const handleGainAction = () => {
    const isSelection = !!activeRegion;
    const msg = isSelection ? `Amplifying Selection (${audio.gainMultiplier}x)...` : `Amplifying Full Track (${audio.gainMultiplier}x)...`;
    performProcessing(msg, (buffer) => 
      applyGain(buffer, audio.gainMultiplier, activeRegion?.start, activeRegion?.end)
    );
  };

  const handleDenoiseAction = () => {
    performProcessing(`Applying Gate (Thresh: ${audio.gateThreshold.toFixed(3)})...`, (buffer) => 
      applyNoiseGate(buffer, audio.gateThreshold)
    );
  };

  const handleCutAction = () => {
    if (!activeRegion) return;
    performProcessing('Destructive Cut...', (buffer, ctx) => 
      applyCut(buffer, activeRegion.start, activeRegion.end, ctx)
    );
  };

  const handleCropAction = () => {
    if (!activeRegion) return;
    performProcessing('Cropping Selection...', (buffer, ctx) => 
      applyCrop(buffer, activeRegion.start, activeRegion.end, ctx)
    );
  };

  // --- Malworld: 마디 격자 · 루프 · 규격 정규화 ---

  /** 구간을 초 단위로 직접 놓는다. 마디 경계는 마우스로 못 찍으므로 이게 있어야 한다. */
  const setRegionExact = (start: number, end: number) => {
    const regions = regionsRef.current;
    if (!regions) return;
    const lo = Math.max(0, Math.min(start, audio.duration));
    const hi = Math.max(lo, Math.min(end, audio.duration));
    regions.clearRegions();
    const region = regions.addRegion({
      start: lo, end: hi, color: 'rgba(99, 102, 241, 0.3)', drag: true, resize: true,
    });
    setActiveRegion(region);
    if (loopPlaybackRef.current.active) {
      loopPlaybackRef.current = { active: true, start: lo, end: hi };
    }
    return region;
  };

  /** 현재 선택의 양 끝을 가장 가까운 마디선으로 당긴다. */
  const handleSnapRegion = () => {
    if (!activeRegion) return;
    const s = snapToBar(activeRegion.start, loop.bpm, loop.beatsPerBar, loop.downbeat);
    const e = snapToBar(activeRegion.end, loop.bpm, loop.beatsPerBar, loop.downbeat);
    setRegionExact(s, e === s ? s + barSeconds(loop.bpm, loop.beatsPerBar) : e);
  };

  /** 선택 시작(없으면 다운비트)에서 N 마디를 잡는다. */
  const handleSelectBars = () => {
    const rawStart = activeRegion ? activeRegion.start : loop.downbeat;
    const start = loop.snapEnabled
      ? snapToBar(rawStart, loop.bpm, loop.beatsPerBar, loop.downbeat)
      : rawStart;
    setRegionExact(start, start + loop.bars * barSeconds(loop.bpm, loop.beatsPerBar));
  };

  /** 재생 위치를 첫 다운비트로 삼는다. 첫 박이 0 이 아닌 곡에 필요하다. */
  const handleSetDownbeatHere = () => {
    setLoop(prev => ({ ...prev, downbeat: audio.currentTime }));
  };

  const toggleLoopPreview = () => {
    if (!activeRegion) return;
    const next = !loop.previewLooping;
    loopPlaybackRef.current = next
      ? { active: true, start: activeRegion.start, end: activeRegion.end }
      : { active: false, start: 0, end: 0 };
    setLoop(prev => ({ ...prev, previewLooping: next }));
    const ws = wavesurferRef.current;
    if (ws && next) {
      ws.setTime(activeRegion.start);
      if (!ws.isPlaying()) ws.play();
    }
  };

  /** 선택을 루프로 확정한다. 뒤쪽 foldMs 를 앞머리에 접어 이음매를 잇는다. */
  const handleMakeLoopAction = () => {
    if (!activeRegion) return;
    const bars = barsBetween(activeRegion.start, activeRegion.end, loop.bpm, loop.beatsPerBar);
    const off = Math.abs(bars - Math.round(bars));
    if (off > 0.01 && !confirm(
      `선택이 ${bars.toFixed(3)} 마디입니다 — 마디 경계에 안 맞습니다.\n` +
      `이대로 자르면 루프가 돌 때 박자가 어긋납니다. 계속할까요?`
    )) return;
    performProcessing(`루프 제작 (${Math.round(bars)}마디, 꼬리 ${loop.foldMs} ms)…`, (buffer, ctx) =>
      makeSeamlessLoop(buffer, activeRegion.start, activeRegion.end, loop.foldMs, ctx)
    );
  };

  const handleNormalizeToTargetAction = () => {
    performProcessing(`피크를 ${loop.targetDbfs} dBFS 로…`, (buffer) =>
      applyNormalizeToDbfs(buffer, loop.targetDbfs)
    );
  };

  const handleExtractChannelAction = (channel: 0 | 1) => {
    performProcessing(`Extracting ${channel === 0 ? 'Left' : 'Right'} Channel...`, (buffer, ctx) => 
      applyExtractChannel(buffer, channel, ctx)
    );
  };

  const handleSilenceChannelAction = (channel: 0 | 1) => {
    performProcessing(`Removing ${channel === 0 ? 'Left' : 'Right'} Channel...`, (buffer) => 
      applySilenceChannel(buffer, channel)
    );
  };

  const handleToggleMono = async () => {
    if (!audio.currentUrl) return;
    if (!audio.isMono) {
      performProcessing('Downmixing to Mono...', (buffer, ctx) => mixBufferToMono(buffer, ctx));
    } else {
      alert("Note: Returning to stereo after downmix can be done via 'Undo' or 'Reset Project'.");
    }
  };

  const handleDownloadAction = () => {
    if (!audio.currentUrl) return;
    const link = document.createElement('a');
    link.href = audio.currentUrl;
    const originalName = audio.file?.name || 'studio_export';
    const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.')) || originalName;
    // 저장소 관례는 소문자 kebab-case 에 -v1 접미사다. `_edited` 를 붙이면 손으로 다시 고쳐야 한다.
    link.download = `${nameWithoutExt}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setAudio(prev => ({ ...prev, volume: val }));
    wavesurferRef.current?.setVolume(val);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileUpload(file);
  }, []);

  const togglePlay = () => {
    if (activeRegion && !audio.isPlaying) {
      activeRegion.play();
    } else {
      wavesurferRef.current?.playPause();
    }
  };
  const playRegion = () => activeRegion?.play();
  const seekToStart = () => wavesurferRef.current?.setTime(0);
  const clearRegion = () => {
    regionsRef.current?.clearRegions();
    setActiveRegion(null);
  };

  const handleZoomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    setZoom(value);
    wavesurferRef.current?.zoom(value);
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  // 마디 격자 파생값. 선택이 격자에 맞았는지를 화면에 계속 보여 줘야 손으로 맞출 수 있다.
  const oneBar = barSeconds(loop.bpm, loop.beatsPerBar);
  const selBars = activeRegion
    ? barsBetween(activeRegion.start, activeRegion.end, loop.bpm, loop.beatsPerBar)
    : 0;
  const selOnGrid = !!activeRegion && Math.abs(selBars - Math.round(selBars)) < 0.01;

  const numField = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    opts: { step?: number; min?: number; suffix?: string; width?: string } = {}
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          step={opts.step ?? 1}
          min={opts.min}
          onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
          className={`${opts.width ?? 'w-20'} bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-sm font-bold text-white focus:border-indigo-500 focus:outline-none`}
        />
        {opts.suffix && <span className="text-[9px] font-bold text-slate-600 uppercase">{opts.suffix}</span>}
      </div>
    </label>
  );

  return (
    <div 
      className={`min-h-screen flex flex-col p-8 transition-all duration-500 ${isDragging ? 'bg-indigo-950/40 ring-4 ring-indigo-500 ring-inset' : 'bg-[#0b0f19]'}`}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
    >
      <header className="flex justify-between items-center mb-10 bg-slate-900/40 p-4 rounded-2xl border border-slate-800/60 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 p-2.5 rounded-xl shadow-[0_0_20px_rgba(99,102,241,0.3)]">
            <AudioWaveform className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tighter text-white uppercase italic">Pulse<span className="text-indigo-400">Lab</span></h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Spectral Audio Engine v2.4</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {audio.currentUrl && (
            <>
              <div className="flex bg-slate-800 rounded-xl p-1 border border-slate-700 mr-2">
                <button 
                  onClick={handleUndo}
                  disabled={audio.undoStack.length === 0 || audio.isProcessing}
                  className="p-2 text-slate-400 hover:text-indigo-400 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  title="Undo (Ctrl+Z)"
                >
                  <Undo2 className="w-5 h-5" />
                </button>
                <button 
                  onClick={handleRedo}
                  disabled={audio.redoStack.length === 0 || audio.isProcessing}
                  className="p-2 text-slate-400 hover:text-indigo-400 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  title="Redo (Ctrl+Y)"
                >
                  <Redo2 className="w-5 h-5" />
                </button>
              </div>
              <button 
                onClick={handleRevert}
                className="flex items-center gap-2 bg-slate-800 hover:bg-rose-900/30 text-slate-400 hover:text-rose-400 px-4 py-2.5 rounded-xl transition-all border border-slate-700 hover:border-rose-700/50 text-xs font-bold uppercase tracking-wider"
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </button>
              <button 
                onClick={handleDownloadAction}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-indigo-600/20 border border-indigo-400/30 text-xs font-bold uppercase tracking-wider"
              >
                <Download className="w-4 h-4" />
                Export
              </button>
            </>
          )}
          <label className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl cursor-pointer transition-all border border-emerald-400/30 shadow-lg shadow-emerald-600/20 text-xs font-bold uppercase tracking-wider">
            <Upload className="w-4 h-4" />
            Import
            <input type="file" className="hidden" accept="audio/*,video/*" onChange={(e) => e.target.files && handleFileUpload(e.target.files[0])} />
          </label>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center gap-8">
        {!audio.currentUrl ? (
          <div className="text-center p-20 border-2 border-dashed border-slate-800 rounded-[40px] max-w-2xl w-full bg-slate-900/20 backdrop-blur-sm group hover:border-indigo-500/50 transition-all">
            <div className="w-24 h-24 bg-slate-800/50 rounded-full flex items-center justify-center mx-auto mb-8 group-hover:scale-110 transition-transform">
              <FileAudio className="w-12 h-12 text-slate-600 group-hover:text-indigo-400 transition-colors" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-4 tracking-tight">오디오 또는 영상을 놓으십시오</h2>
            <p className="text-slate-500 mb-8 max-w-md mx-auto">
              WAV · MP3 · OGG 와 <span className="text-emerald-400 font-bold">MP4 영상</span>을 받습니다.
              영상은 오디오 트랙만 뽑아 씁니다 — Veo 클립을 그대로 놓으면 됩니다.
              임포트할 때 48 kHz 로 고정됩니다.
            </p>
            <div className="inline-flex items-center gap-2 px-6 py-3 bg-slate-800 rounded-2xl text-slate-400 font-mono text-sm border border-slate-700">
               <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
               Ready for Input
            </div>
          </div>
        ) : (
          <div className="w-full max-w-7xl space-y-8 animate-in fade-in zoom-in duration-500">
            {/* Waveform Visualization Block */}
            <div className="bg-[#111827] border border-slate-800/80 rounded-[32px] p-8 shadow-2xl relative overflow-hidden ring-1 ring-white/5">
              {audio.isProcessing && (
                <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-md flex flex-col items-center justify-center">
                  <div className="relative">
                    <Loader2 className="w-16 h-16 text-indigo-500 animate-spin" />
                    <div className="absolute inset-0 blur-xl bg-indigo-500/20"></div>
                  </div>
                  <p className="text-white font-black uppercase tracking-[0.3em] mt-8 text-sm">{audio.processingMsg}</p>
                </div>
              )}

              {/* HUD / Info Display */}
              <div className="flex justify-between items-end mb-10">
                <div className="flex items-center gap-6">
                  <div className="bg-slate-800/50 px-4 py-2 rounded-2xl border border-slate-700/50 flex flex-col">
                    <span className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Filename</span>
                    <span className="text-white text-sm font-bold truncate max-w-[200px]">{audio.file?.name}</span>
                  </div>
                  <div className="bg-slate-800/50 px-4 py-2 rounded-2xl border border-slate-700/50 flex flex-col">
                    <span className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Format</span>
                    <span className="text-white text-sm font-bold uppercase tracking-tighter">
                      {audio.isMono ? 'Mono (1CH)' : 'Stereo (2CH)'} · {(PROJECT_SAMPLE_RATE / 1000).toFixed(0)} kHz
                    </span>
                  </div>
                  {audio.sourceKind === 'video' && (
                    <div className="bg-emerald-500/10 px-4 py-2 rounded-2xl border border-emerald-500/30 flex flex-col">
                      <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-1">
                        <Film className="w-3 h-3" /> Source
                      </span>
                      <span className="text-emerald-300 text-sm font-bold uppercase tracking-tighter">영상에서 추출</span>
                    </div>
                  )}
                </div>

                <div className="bg-black/40 px-6 py-3 rounded-3xl border border-indigo-500/20 flex flex-col items-end shadow-inner">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">Time Elapsed</span>
                    <span className="text-3xl font-mono font-bold text-white tabular-nums tracking-tighter">
                      {formatTime(audio.currentTime)} <span className="text-slate-600 text-xl">/ {formatTime(audio.duration)}</span>
                    </span>
                </div>
              </div>

              {/* Waveform Viewport */}
              <div className="relative group">
                <div className="absolute top-4 right-4 z-10 flex gap-2">
                   <div className="bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/5 text-[9px] font-bold text-slate-400 uppercase">Interactive Layer</div>
                </div>
                <div ref={containerRef} className="waveform-container rounded-[24px] bg-[#0d1117] p-6 border border-slate-800/50 shadow-inner" />
              </div>
            </div>

            {/* Bottom Controls Panel */}
            <div className="grid grid-cols-12 gap-6">
              {/* Main Transport */}
              <div className="col-span-12 lg:col-span-5 bg-slate-900/60 border border-slate-800 rounded-[28px] p-6 flex items-center justify-between shadow-xl backdrop-blur-md">
                <div className="flex items-center gap-4">
                  <button 
                    onClick={seekToStart} 
                    title="Skip to Start"
                    className="w-12 h-12 flex items-center justify-center rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all hover:-translate-y-1"
                  >
                    <SkipBack className="w-5 h-5" />
                  </button>
                  <button 
                    onClick={togglePlay} 
                    disabled={!audio.isReady || audio.isProcessing}
                    className="w-16 h-16 flex items-center justify-center rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-[0_0_20px_rgba(99,102,241,0.4)] disabled:opacity-50 hover:-translate-y-1 active:scale-95"
                  >
                    {audio.isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 ml-1 fill-current" />}
                  </button>
                </div>

                <div className="flex flex-col items-center gap-2 flex-1 mx-8">
                  <div className="flex justify-between w-full text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">
                    <VolumeX className="w-3 h-3" />
                    <Volume2 className="w-3 h-3" />
                  </div>
                  <input 
                    type="range" 
                    min="0" max="1" step="0.01" 
                    value={audio.volume} 
                    onChange={handleVolumeChange} 
                    className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer hover:bg-slate-700 transition-colors"
                  />
                </div>

                <div className="flex gap-2">
                  <button 
                    onClick={() => setShowChannelSettings(!showChannelSettings)}
                    disabled={audio.isMono || audio.isProcessing}
                    className={`flex flex-col items-center justify-center w-20 h-16 rounded-2xl transition-all border ${
                      showChannelSettings 
                      ? 'bg-blue-600 text-white border-blue-400' 
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    <Split className="w-5 h-5 mb-1" />
                    <span className="text-[9px] font-black uppercase tracking-tighter">Channels</span>
                  </button>
                  <button 
                    onClick={handleToggleMono}
                    disabled={audio.isProcessing}
                    className={`flex flex-col items-center justify-center w-20 h-16 rounded-2xl transition-all border ${
                      audio.isMono 
                      ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30' 
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    {audio.isMono ? <Columns className="w-5 h-5 mb-1" /> : <Merge className="w-5 h-5 mb-1" />}
                    <span className="text-[9px] font-black uppercase tracking-tighter">{audio.isMono ? 'Split' : 'Downmix'}</span>
                  </button>
                </div>
              </div>

              {/* Viewport/Zoom Control */}
              <div className="col-span-12 lg:col-span-3 bg-slate-900/60 border border-slate-800 rounded-[28px] p-6 flex flex-col justify-center gap-3 shadow-xl backdrop-blur-md">
                <div className="flex justify-between items-center text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  <div className="flex items-center gap-2"><Minimize2 className="w-3 h-3" /> Overview</div>
                  <div className="flex items-center gap-2">Detail <Maximize className="w-3 h-3" /></div>
                </div>
                <input 
                  type="range" 
                  min="10" max="1000" 
                  value={zoom} 
                  onChange={handleZoomChange} 
                  className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer" 
                />
              </div>

              {/* Malworld: 마디 격자 · 루프 · 규격 정규화 */}
              <div className="col-span-12 bg-slate-900/60 border border-emerald-800/40 rounded-[28px] p-6 shadow-xl backdrop-blur-md">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2 text-[10px] font-black text-emerald-400 uppercase tracking-widest">
                    <Grid3x3 className="w-3.5 h-3.5" /> Loop Lab · 마디 격자
                  </div>
                  <div className="text-[10px] font-mono text-slate-500">
                    1마디 = {oneBar.toFixed(4)}초 · {loop.bars}마디 = {(oneBar * loop.bars).toFixed(3)}초
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-4">
                  {numField('BPM', loop.bpm, v => setLoop(p => ({ ...p, bpm: Math.max(1, v) })), { step: 0.1 })}
                  {numField('박자/마디', loop.beatsPerBar, v => setLoop(p => ({ ...p, beatsPerBar: Math.max(1, Math.round(v)) })), { width: 'w-16' })}
                  {numField('다운비트', loop.downbeat, v => setLoop(p => ({ ...p, downbeat: Math.max(0, v) })), { step: 0.001, suffix: 's', width: 'w-24' })}
                  <button
                    onClick={handleSetDownbeatHere}
                    disabled={!audio.isReady}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                    title="재생 위치를 첫 다운비트로 삼는다"
                  >
                    여기를 1박으로
                  </button>

                  <div className="w-px h-10 bg-slate-800" />

                  {numField('마디 수', loop.bars, v => setLoop(p => ({ ...p, bars: Math.max(1, Math.round(v)) })), { width: 'w-20' })}
                  <button
                    onClick={handleSelectBars}
                    disabled={!audio.isReady}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white rounded-xl border border-indigo-400 text-[10px] font-black uppercase tracking-widest transition-all"
                  >
                    {loop.bars}마디 선택
                  </button>
                  <button
                    onClick={handleSnapRegion}
                    disabled={!activeRegion}
                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                    title="선택 양 끝을 가장 가까운 마디선으로"
                  >
                    <Magnet className="w-3 h-3" /> 마디에 맞춤
                  </button>

                  <div className="w-px h-10 bg-slate-800" />

                  <button
                    onClick={toggleLoopPreview}
                    disabled={!activeRegion}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-30 ${
                      loop.previewLooping
                        ? 'bg-emerald-500 text-white border-emerald-300 shadow-lg shadow-emerald-500/30'
                        : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                    }`}
                    title="선택 구간을 반복 재생해 이음매를 듣는다"
                  >
                    <Repeat className="w-3.5 h-3.5" /> {loop.previewLooping ? '루프 재생 중' : '루프 미리듣기'}
                  </button>

                  {numField('꼬리 접기', loop.foldMs, v => setLoop(p => ({ ...p, foldMs: Math.max(0, v) })), { suffix: 'ms', width: 'w-20' })}
                  <button
                    onClick={handleMakeLoopAction}
                    disabled={!activeRegion || audio.isProcessing}
                    className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-30 text-white rounded-xl border border-violet-400 text-[10px] font-black uppercase tracking-widest transition-all"
                    title="선택을 루프로 확정하고 뒤쪽 꼬리를 앞머리에 접는다"
                  >
                    <Scissors className="w-3.5 h-3.5" /> 루프 제작
                  </button>

                  <div className="w-px h-10 bg-slate-800" />

                  {numField('목표 피크', loop.targetDbfs, v => setLoop(p => ({ ...p, targetDbfs: v })), { step: 0.5, suffix: 'dBFS', width: 'w-20' })}
                  <button
                    onClick={handleNormalizeToTargetAction}
                    disabled={!audio.isReady || audio.isProcessing}
                    className="flex items-center gap-1.5 px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-30 text-amber-400 rounded-xl border border-amber-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                    title="저장소 규격은 -3 dBFS 다"
                  >
                    <Gauge className="w-3.5 h-3.5" /> 정규화
                  </button>
                </div>

                {/* 선택 판독 — 격자에 맞았는지를 계속 보여 준다 */}
                <div className="mt-5 pt-4 border-t border-slate-800 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] font-mono">
                  {activeRegion ? (
                    <>
                      <span className="text-slate-500">시작 <span className="text-white font-bold">{activeRegion.start.toFixed(4)}s</span></span>
                      <span className="text-slate-500">끝 <span className="text-white font-bold">{activeRegion.end.toFixed(4)}s</span></span>
                      <span className="text-slate-500">길이 <span className="text-white font-bold">{(activeRegion.end - activeRegion.start).toFixed(4)}s</span></span>
                      <span className={`font-bold px-2 py-0.5 rounded-lg ${selOnGrid ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                        {selBars.toFixed(3)}마디 {selOnGrid ? '· 격자에 맞음' : '· 격자에서 벗어남'}
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-600">파형을 드래그하거나 위의 “{loop.bars}마디 선택”을 누르십시오.</span>
                  )}
                </div>
              </div>

              {/* Contextual Actions Panel */}
              <div className="col-span-12 lg:col-span-4 flex items-center gap-3 relative">
                {activeRegion ? (
                  <div className="flex items-center gap-2 w-full bg-indigo-900/20 border border-indigo-500/30 p-3 rounded-[28px] backdrop-blur-md shadow-lg">
                    <button 
                      onClick={playRegion}
                      className="flex-1 flex flex-col items-center gap-1 p-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-2xl transition-all border border-emerald-500/20"
                      title="Play Only Selection"
                    >
                      <PlayCircle className="w-4 h-4" />
                      <span className="text-[8px] font-bold uppercase">Listen</span>
                    </button>
                    <button 
                      onClick={handleAnalyzeNoiseAction}
                      className="flex-1 flex flex-col items-center gap-1 p-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded-2xl transition-all border border-amber-500/20"
                      title="Sample Noise"
                    >
                      <Fingerprint className="w-4 h-4" />
                      <span className="text-[8px] font-bold uppercase">Sample</span>
                    </button>
                    <button 
                      onClick={() => handleFadeAction('in')}
                      className="flex-1 flex flex-col items-center gap-1 p-2 bg-slate-800/80 hover:bg-indigo-600 hover:text-white rounded-2xl transition-all border border-slate-700"
                    >
                      <TrendingUp className="w-4 h-4" />
                      <span className="text-[8px] font-bold uppercase">In</span>
                    </button>
                    <button 
                      onClick={() => handleFadeAction('out')}
                      className="flex-1 flex flex-col items-center gap-1 p-2 bg-slate-800/80 hover:bg-indigo-600 hover:text-white rounded-2xl transition-all border border-slate-700"
                    >
                      <TrendingDown className="w-4 h-4" />
                      <span className="text-[8px] font-bold uppercase">Out</span>
                    </button>
                    <button 
                      onClick={handleCropAction}
                      className="flex-1 flex flex-col items-center gap-1 p-2 bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 rounded-2xl transition-all border border-violet-500/20"
                      title="Show Only Selection"
                    >
                      <Crop className="w-4 h-4" />
                      <span className="text-[8px] font-bold uppercase">Crop</span>
                    </button>
                    <button 
                      onClick={handleCutAction}
                      className="flex-1 flex flex-col items-center gap-1 p-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-2xl transition-all border border-rose-500/20"
                    >
                      <Scissors className="w-4 h-4" />
                      <span className="text-[8px] font-bold uppercase">Cut</span>
                    </button>
                    <button 
                      onClick={clearRegion} 
                      className="p-3 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-full transition-all border border-slate-700"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 w-full">
                    <div className="flex-1 relative">
                       <button 
                        onClick={handleNormalizeAction}
                        className="w-full flex items-center justify-center gap-2 py-4 bg-slate-900/60 hover:bg-slate-800 text-slate-300 rounded-[28px] border border-slate-800 transition-all font-bold uppercase tracking-widest text-xs"
                      >
                        <Activity className="w-4 h-4 text-indigo-400" /> Max
                      </button>
                    </div>

                    <div className="flex-1 relative">
                      <button 
                        onClick={() => setAudio(prev => ({ ...prev, showGainSettings: !prev.showGainSettings, showGateSettings: false }))}
                        className={`w-full flex items-center justify-center gap-2 py-4 transition-all font-bold uppercase tracking-widest text-xs rounded-[28px] border ${
                          audio.showGainSettings 
                          ? 'bg-purple-600 text-white border-purple-400 shadow-lg shadow-purple-600/20' 
                          : 'bg-slate-900/60 hover:bg-slate-800 text-slate-300 border-slate-800'
                        }`}
                      >
                        <Plus className={`w-4 h-4 ${audio.showGainSettings ? 'text-white' : 'text-purple-500'}`} /> Gain
                      </button>

                      {audio.showGainSettings && (
                        <div className="absolute bottom-full left-0 w-full mb-4 bg-[#1e293b]/95 backdrop-blur-xl border border-purple-500/30 p-6 rounded-[28px] shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200 z-[100]">
                          <div className="flex justify-between items-center mb-4">
                            <span className="text-[10px] font-black text-purple-400 uppercase tracking-widest">Gain Multiplier</span>
                            <span className="text-[10px] font-mono text-white bg-purple-500/20 px-2 py-1 rounded-md">
                              {audio.gainMultiplier.toFixed(2)}x
                            </span>
                          </div>
                          <input 
                            type="range" 
                            min="0.1" max="5.0" step="0.1" 
                            value={audio.gainMultiplier} 
                            onChange={(e) => setAudio(prev => ({ ...prev, gainMultiplier: parseFloat(e.target.value) }))}
                            className="w-full accent-purple-500 h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer mb-6" 
                          />
                          <div className="flex gap-2">
                            <button 
                              onClick={() => setAudio(prev => ({ ...prev, showGainSettings: false }))}
                              className="flex-1 py-2 rounded-xl bg-slate-800 text-slate-400 text-[10px] font-bold uppercase hover:bg-slate-700 border border-slate-700 transition-colors"
                            >
                              Cancel
                            </button>
                            <button 
                              onClick={handleGainAction}
                              className="flex-[2] py-2 rounded-xl bg-purple-600 text-white text-[10px] font-bold uppercase hover:bg-purple-500 transition-colors flex items-center justify-center gap-2"
                            >
                              <Check className="w-3 h-3" /> Apply Gain
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {audio.noiseProfile ? (
                       <button 
                        onClick={handleCleanAtmosphereAction}
                        className="flex-1 flex items-center justify-center gap-2 py-4 bg-indigo-600 text-white hover:bg-indigo-500 rounded-[28px] transition-all border border-indigo-400 shadow-xl shadow-indigo-600/30 animate-pulse-subtle font-bold uppercase tracking-widest text-xs"
                      >
                        <Sparkles className="w-4 h-4" /> Clear
                      </button>
                    ) : (
                      <div className="flex-1 relative">
                        <button 
                          onClick={() => setAudio(prev => ({ ...prev, showGateSettings: !prev.showGateSettings, showGainSettings: false }))}
                          className={`w-full flex items-center justify-center gap-2 py-4 transition-all font-bold uppercase tracking-widest text-xs rounded-[28px] border ${
                            audio.showGateSettings 
                            ? 'bg-indigo-600 text-white border-indigo-400 shadow-lg shadow-indigo-600/20' 
                            : 'bg-slate-900/60 hover:bg-slate-800 text-slate-300 border-slate-800'
                          }`}
                        >
                          {audio.showGateSettings ? <SlidersHorizontal className="w-4 h-4" /> : <Wind className="w-4 h-4 text-slate-500" />}
                          Gate
                        </button>

                        {audio.showGateSettings && (
                          <div className="absolute bottom-full left-0 w-full mb-4 bg-[#1e293b]/95 backdrop-blur-xl border border-indigo-500/30 p-6 rounded-[28px] shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200 z-[100]">
                            <div className="flex justify-between items-center mb-4">
                              <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Gate Thresh</span>
                              <span className="text-[10px] font-mono text-white bg-indigo-500/20 px-2 py-1 rounded-md">
                                {Math.round(audio.gateThreshold * 1000) / 10}%
                              </span>
                            </div>
                            <input 
                              type="range" 
                              min="0.001" max="0.1" step="0.001" 
                              value={audio.gateThreshold} 
                              onChange={(e) => setAudio(prev => ({ ...prev, gateThreshold: parseFloat(e.target.value) }))}
                              className="w-full accent-indigo-500 h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer mb-6" 
                            />
                            <div className="flex gap-2">
                              <button 
                                onClick={() => setAudio(prev => ({ ...prev, showGateSettings: false }))}
                                className="flex-1 py-2 rounded-xl bg-slate-800 text-slate-400 text-[10px] font-bold uppercase hover:bg-slate-700 border border-slate-700 transition-colors"
                              >
                                Cancel
                              </button>
                              <button 
                                onClick={handleDenoiseAction}
                                className="flex-[2] py-2 rounded-xl bg-indigo-600 text-white text-[10px] font-bold uppercase hover:bg-indigo-500 transition-colors flex items-center justify-center gap-2"
                              >
                                <Check className="w-3 h-3" /> Apply Gate
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                
                {/* Channel Controls Dropdown Overlay */}
                {showChannelSettings && !audio.isMono && (
                   <div className="absolute bottom-full left-0 w-full mb-4 bg-slate-900/95 backdrop-blur-2xl border border-blue-500/30 p-6 rounded-[32px] shadow-[0_20px_50px_rgba(0,0,0,0.5)] animate-in fade-in slide-in-from-bottom-4 duration-300 z-[101]">
                      <div className="flex items-center gap-3 mb-6">
                        <div className="p-2 bg-blue-500/20 rounded-lg text-blue-400">
                          <Zap className="w-4 h-4" />
                        </div>
                        <h3 className="text-xs font-black text-white uppercase tracking-[0.2em]">Spatial Processor</h3>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-blue-400 uppercase tracking-widest block mb-2 px-1">Left Channel [0]</span>
                          <button 
                            onClick={() => handleExtractChannelAction(0)}
                            className="w-full py-3 bg-blue-600/10 hover:bg-blue-600/30 text-blue-300 rounded-2xl border border-blue-500/20 text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2"
                          >
                            <Volume2 className="w-3 h-3" /> Isolate (Mono)
                          </button>
                          <button 
                             onClick={() => handleSilenceChannelAction(0)}
                             className="w-full py-3 bg-slate-800/80 hover:bg-rose-600/20 text-slate-400 hover:text-rose-400 rounded-2xl border border-slate-700 hover:border-rose-500/30 text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2"
                          >
                            <VolumeX className="w-3 h-3" /> Remove (Mute)
                          </button>
                        </div>
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-purple-400 uppercase tracking-widest block mb-2 px-1">Right Channel [1]</span>
                          <button 
                             onClick={() => handleExtractChannelAction(1)}
                             className="w-full py-3 bg-purple-600/10 hover:bg-purple-600/30 text-purple-300 rounded-2xl border border-purple-500/20 text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2"
                          >
                            <Volume2 className="w-3 h-3" /> Isolate (Mono)
                          </button>
                          <button 
                             onClick={() => handleSilenceChannelAction(1)}
                             className="w-full py-3 bg-slate-800/80 hover:bg-rose-600/20 text-slate-400 hover:text-rose-400 rounded-2xl border border-slate-700 hover:border-rose-500/30 text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2"
                          >
                            <VolumeX className="w-3 h-3" /> Remove (Mute)
                          </button>
                        </div>
                      </div>
                      
                      <button 
                        onClick={() => setShowChannelSettings(false)}
                        className="w-full py-3 bg-slate-800 rounded-2xl text-slate-500 hover:text-white transition-all text-[10px] font-bold uppercase mt-4"
                      >
                        Close Tools
                      </button>
                   </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="mt-12 flex items-center justify-center gap-10">
        <div className="flex items-center gap-2 text-slate-600">
           <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,1)]"></div>
           <span className="text-[9px] font-black uppercase tracking-[0.2em]">Engine Stable</span>
        </div>
        <span className="text-[9px] text-slate-700 font-bold uppercase tracking-[0.3em]">Hardware Accelerated Processing Node</span>
        <div className="flex items-center gap-2 text-slate-600">
           <span className="text-[9px] font-black uppercase tracking-[0.2em]">{audio.duration.toFixed(2)}s Cache</span>
           <div className="w-1.5 h-1.5 rounded-full bg-slate-700"></div>
        </div>
      </footer>

      <style>{`
        @keyframes pulse-subtle {
          0%, 100% { opacity: 1; transform: scale(1); filter: brightness(1); }
          50% { opacity: 0.9; transform: scale(1.02); filter: brightness(1.2); }
        }
        .animate-pulse-subtle {
          animation: pulse-subtle 3s infinite ease-in-out;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 16px;
          width: 16px;
          border-radius: 50%;
          background: #6366f1;
          cursor: pointer;
          box-shadow: 0 0 10px rgba(99,102,241,0.5);
          border: 2px solid white;
        }
        .waveform-container canvas {
          border-radius: 12px;
        }
      `}</style>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

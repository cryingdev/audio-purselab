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
  Plus
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
  applyGain
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
  });

  const [zoom, setZoom] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [activeRegion, setActiveRegion] = useState<any>(null);
  const [showChannelSettings, setShowChannelSettings] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<any>(null);

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
    ws.on('timeupdate', (time) => setAudio(prev => ({ ...prev, currentTime: time })));

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

  const handleFileUpload = (file: File) => {
    if (file && file.type.startsWith('audio/')) {
      if (audio.originalUrl) URL.revokeObjectURL(audio.originalUrl);
      audio.undoStack.forEach(url => url !== audio.originalUrl && URL.revokeObjectURL(url));
      audio.redoStack.forEach(url => URL.revokeObjectURL(url));

      const url = URL.createObjectURL(file);
      setAudio({
        file,
        originalUrl: url,
        currentUrl: url,
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
      });
      setActiveRegion(null);
      setShowChannelSettings(false);
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
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
    link.download = `${nameWithoutExt}_edited.wav`;
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
            <input type="file" className="hidden" accept="audio/*" onChange={(e) => e.target.files && handleFileUpload(e.target.files[0])} />
          </label>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center gap-8">
        {!audio.currentUrl ? (
          <div className="text-center p-20 border-2 border-dashed border-slate-800 rounded-[40px] max-w-2xl w-full bg-slate-900/20 backdrop-blur-sm group hover:border-indigo-500/50 transition-all">
            <div className="w-24 h-24 bg-slate-800/50 rounded-full flex items-center justify-center mx-auto mb-8 group-hover:scale-110 transition-transform">
              <FileAudio className="w-12 h-12 text-slate-600 group-hover:text-indigo-400 transition-colors" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-4 tracking-tight">Drop Audio to Initialize</h2>
            <p className="text-slate-500 mb-8 max-w-sm mx-auto">Supports Stereo WAV, MP3, and OGG for non-destructive spectral editing.</p>
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
                    <span className="text-white text-sm font-bold uppercase tracking-tighter">{audio.isMono ? 'Mono (1CH)' : 'Stereo (2CH)'}</span>
                  </div>
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

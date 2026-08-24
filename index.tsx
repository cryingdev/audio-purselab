import './index.css';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
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
  FileAudio,
  Merge,
  Columns,
  Loader2,
  Download,
  X,
  Wind,
  Ruler,
  AlertTriangle,
  Info,
  SkipBack,
  History,
  Volume1,
  VolumeX,
  AudioWaveform,
  Crop,
  Undo2,
  Redo2,
  Check,
  Zap,
  Repeat,
  Grid3x3,
  Film,
  Gauge,
  Magnet,
  Layers,
  Trash2,
  FlipHorizontal,
  SeparatorVertical,
  Copy,
  ClipboardPaste,
  Combine
} from 'lucide-react';

import {
  audioBufferToWav,
  applyFade,
  applyNoiseGate,
  applyReverse,
  applyCut,
  applyCrop,
  mixBufferToMono,
  channelDifference,
  downmixToMono,
  MONO_IDENTICAL_THRESHOLD,
  applyGainCapped,
  applySpeedChange,
  timeStretch,
  TIME_STRETCH_FRAME_MS_DEFAULT,
  TIME_STRETCH_FRAME_MS_MIN,
  TIME_STRETCH_FRAME_MS_MAX,
  makeContext,
  decodeFileToBuffer,
  suggestAssetName,
  barSeconds,
  snapToBar,
  barsBetween,
  applyNormalizeToDbfs,
  makeSeamlessLoop,
  peakOf,
  PROJECT_SAMPLE_RATE
} from './audioUtils';

import {
  CompClip,
  renderComposition,
  compositionLength,
  compositionChannels,
  placeClips,
  placeOnNewLanes,
  clipEndSec,
  wrapLoopEnds,
  splitClipAt,
  rippleInsert,
  rippleDelete,
  moveTrack,
  removeTrack,
} from './composer';
import CompositionTimeline, { TrackSelection } from './CompositionTimeline';
import { useCompositionPlayback } from './useCompositionPlayback';
import { Knob } from './Knob';
import { Switch } from './Switch';

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
  volume: number;
  undoStack: string[];
  redoStack: string[];
  gateThreshold: number;
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

/** 병합 작업대. 클립을 계속 더해 가며 짜고, 마지막에 한 트랙으로 굽는다. */
interface ComposerState {
  clips: CompClip[];
  /** 이어 붙일 때 이음매를 얼마나 겹칠지. */
  crossfadeMs: number;
  /** 끝→시작 말아들기. 0 이면 안 한다. */
  wrapMs: number;
  normalizeAfter: boolean;
  /** 마지막으로 구운 결과의 피크. 1 을 넘었으면 잘렸다는 뜻이다. */
  lastPeak: number | null;
  /**
   * 복사해 둔 클립. 붙여넣으면 새 레인에 같은 자리로 들어간다.
   * 버퍼는 참조로 공유한다 — 렌더가 클립 버퍼를 읽기만 하므로 안전하고,
   * 같은 소리를 여러 겹 쌓아도 메모리가 늘지 않는다.
   */
  clipboard: CompClip | null;
  /** 무음 클립을 담을 때 쓸 길이(초). */
  silenceSec: number;
  /**
   * 클립이 없어도 유지할 트랙 수. 트랙은 원래 클립에서 파생되므로
   * (`max(clip.lane)+1`) 이 값이 없으면 빈 트랙이 존재할 수 없다.
   */
  minLanes: number;
  /** 클립 편집 되돌리기. 버퍼는 참조로 공유하므로 스냅샷이 싸다. */
  undo: CompClip[][];
  redo: CompClip[][];
}

// --- App Component ---

/*
 * 한 번에 걸 수 있는 음량은 **0~200%** 다. 두 배(+6.02 dB)까지만 걸리고,
 * 더 키우려면 한 번 더 건다.
 */
const GAIN_MAX_PCT = 200;
const GAIN_MAX_DB = Math.round(20 * Math.log10(GAIN_MAX_PCT / 100) * 100) / 100; // 6.02
const GAIN_MIN_DB = -100; // 0% — 16-bit 로 쓰면 어차피 0 이다

/** 넘침 천장. 선형 1.0 = 0 dBFS — 이 위는 16-bit 로 쓸 때 잘려 나간다. */
const CLIP_CEILING = 1;

/*
 * 길이를 바꿀 수 있는 폭. 4배 밖은 어느 방식으로도 소리가 남아나지 않는다 —
 * 속도 바꾸기는 음정이 두 옥타브 튀고, 타임 스트레치는 물결친다.
 */
const LEN_RATIO_MIN = 0.25;
const LEN_RATIO_MAX = 4;

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
    volume: 1.0,
    undoStack: [],
    redoStack: [],
    gateThreshold: 0.01,
    sourceKind: null,
    channels: 0,
  });

  /** 내보낼 이름(확장자 제외). 임포트할 때 관례에 맞게 제안하고, 손으로 고칠 수 있다. */
  const [exportName, setExportName] = useState('');
  /** 지금 트랙의 피크(선형). 규격(-3 dBFS)에 맞는지 화면에서 바로 보려고 잰다. */
  const [currentPeak, setCurrentPeak] = useState<number | null>(null);
  /** 편집 대상 클립. 클립이 문서이므로 편집은 이 클립에 걸린다. */
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  /**
   * 줌은 하나다. **1× 이 "폭에 맞춤"** 이고, 트랙 파형과 아래 `합친 결과` 가
   * 같은 값을 따른다. 예전에는 둘이 따로 놀아서 한쪽을 당겨도 다른 쪽은 그대로였다.
   * wavesurfer 는 초당 픽셀을 받으므로 넘길 때 환산한다.
   */
  const [zoomFactor, setZoomFactor] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [activeRegion, setActiveRegion] = useState<any>(null);

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

  const [comp, setComp] = useState<ComposerState>({
    clips: [],
    // veo-sfx-prompts.md 의 환경음 절차가 이음매를 0.5~1초로 잡는다.
    crossfadeMs: 750,
    wrapMs: 0,
    normalizeAfter: true,
    lastPeak: null,
    clipboard: null,
    silenceSec: 4,
    minLanes: 0,
    undo: [],
    redo: [],
  });

  /** 트랙 위에서 고른 구간. 편집이 걸리는 자리다. */
  const [selection, setSelection] = useState<TrackSelection | null>(null);
  /** 마디 격자는 음악 루프에서만 쓰므로 접어 둘 수 있다. 기본은 접힘. */
  const [loopLabOpen, setLoopLabOpen] = useState(false);
  /**
   * 음량을 얼마나 올리고 내릴지, **dB 로** 잡는다.
   * 기존 게인은 0.1~5.0 배수라 "6 dB 줄이기"를 0.501 배로 환산해야 했다 —
   * 오디오 작업에서 쓰는 단위로 말하게 한다.
   */
  const [gainDb, setGainDbRaw] = useState(0);
  /** 걸다가 천장에 부딪혀 깎였을 때 얼마나 걸렸는지 알린다. */
  const [gainNotice, setGainNotice] = useState<string | null>(null);
  const setGainDb = (v: number) => {
    setGainDbRaw(Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, v)));
    setGainNotice(null);
  };

  /*
   * 음량을 **백분율과 dB 두 가지로** 보여 준다 — 같은 값의 두 얼굴이다.
   * 귀에 익은 쪽은 백분율(200% = 두 배)이고, 규격(-3 dBFS)을 맞출 때 필요한 쪽은 dB 다.
   *
   * 참값은 dB 로 들고 슬라이더가 거기서 백분율을 뽑아 쓴다. 반대로 두면
   * **슬라이더를 건드리지도 않았는데 dB 칸의 숫자가 반올림 때문에 흔들린다**
   * (6 을 넣으면 199.53% 를 거쳐 5.9997 로 되돌아온다).
   *
   * 슬라이더 범위는 **한 번에 0~200%** (= -무한대 ~ +6.02 dB). 두 배까지만 걸리고,
   * 더 키우려면 한 번 더 건다 — 한 번에 크게 걸수록 천장에 부딪혀 깎이는 양이
   * 커지고, 얼마나 걸렸는지 감을 잃는다. 숫자 칸도 같은 범위로 묶는다.
   * 0% 는 -100 dB 로 접는다 — -무한대를 숫자 칸에 넣을 수 없고,
   * -100 dB 는 16-bit 로 쓰면 어차피 0 이다.
   */
  const gainPct = Math.round(Math.min(GAIN_MAX_PCT, Math.max(0, Math.pow(10, gainDb / 20) * 100)));
  const setGainPct = (pct: number) =>
    /*
     * 소수 **두** 자리로 접는다. 한 자리로 접었더니 200% 가 6.0 dB 가 되어
     * 실제로는 199.5% 가 걸렸고, 슬라이더를 400 까지 밀면 라벨이 **398%** 로
     * 읽혔다 (12.0412 → 12.0 → 398.1). 두 자리면 6.02 · 12.04 라 백분율이
     * 그대로 되돌아온다 — 라벨이 거짓말을 하지 않는다.
     */
    setGainDb(pct <= 0 ? -100 : Math.round(20 * Math.log10(pct / 100) * 100) / 100);
  /** 병합 작업대도 접힌다 — 한 번 정해 두면 자주 안 만지는 설정과 클립 목록이다. */
  const [mergePanelOpen, setMergePanelOpen] = useState(true);

  /*
   * 편집면을 **작업 단계**로 가른다.
   *
   * 한 카드에 묶음 여섯이 붙어 있었다 — 담을 때 설정, 붙이는 곳, 무음 담기,
   * 길이 바꾸기, 잔 소리, 이음매·굽기. 하는 일의 **때가 다른 것들**이라
   * 서로 섞여 있으면 지금 무엇을 해야 하는지가 안 보이고, 넓은 화면에서도
   * 두 줄로 접혀 파형이 밀려났다.
   *
   * 단계는 순서가 있다: 담고 → 놓고 → 다듬고 → 낸다. 그 순서대로 늘어놓는다.
   */
  const STAGES = ['담기', '배치', '다듬기', '내보내기'] as const;
  type Stage = (typeof STAGES)[number];
  const [stage, setStage] = useState<Stage>('배치');
  /**
   * 도크가 실제로 차지하는 높이. 좁은 화면에서는 두세 줄로 접혀 135 px 까지 커지는데
   * 비워 두는 자리를 128 px 로 **고정해 뒀더니 아래 내용이 가려졌다.** 재서 그만큼 비운다.
   */
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);

  /*
   * 알림 줄. `alert()` 아홉 군데를 여기로 옮겼다.
   *
   * 네이티브 대화상자는 **막히는 자리에서 통째로 사라진다** — 초기화·트랙 빼기가
   * 그래서 안 되는 것처럼 보였다. 안내는 동작을 막지는 않지만, 막히면 왜 안 되는지
   * 알 길이 없어진다. 게다가 대화상자는 초점을 빼앗아 편집 흐름을 끊는다.
   *
   * **도크 위에 띄운다** — 도크가 없는 빈 상태(첫 임포트가 실패하는 자리가 바로
   * 여기다)에서도 보여야 하므로 화면 아래에 못 박고, 도크가 있으면 그 높이만큼
   * 올린다. 어긋난 값 하나를 알리려고 화면 한가운데를 가릴 이유가 없다.
   */
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setNotice({ text, kind });
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    // 오류는 읽을 것이 많다 — 안내보다 오래 둔다.
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === 'error' ? 9000 : 5000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current !== null) clearTimeout(noticeTimer.current); }, []);
  useEffect(() => {
    const el = dockRef.current;
    if (!el) { setDockHeight(0); return; }
    const ro = new ResizeObserver(() => setDockHeight(el.offsetHeight));
    ro.observe(el);
    setDockHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [comp.clips.length]);

  /**
   * 구간을 그으면 그 구간이 덮는 클립을 편집 대상으로도 기억해 둔다.
   * 구간 선택 중에는 클립이 포인터를 받지 않으므로(구간을 클립 위에서도 그어야 한다)
   * 이렇게 해 두지 않으면, 편집 뒤 구간이 풀렸을 때 대상이 사라져
   * 전체 대상 편집(정규화·게이트)이 "클립을 고르십시오"로 막힌다.
   */
  const handleSelectionChange = useCallback((sel: TrackSelection | null) => {
    setSelection(sel);
    if (!sel) return;
    const hit = comp.clips.find(c =>
      c.lane === sel.lane && clipEndSec(c) > sel.start && c.startSec < sel.end
    );
    if (hit) setSelectedClipId(hit.id);
  }, [comp.clips]);

  /** 트랙을 합치지 않고 그대로 들려준다 — 배치는 귀로 맞추는 일이다. */
  const playback = useCompositionPlayback(comp.clips, audio.volume, comp.wrapMs);

  /*
   * 되풀이 중에 구간을 다시 그으면 루프도 따라간다. 안 그러면 옛 구간이 계속
   * 돌아서, 방금 고친 이음매가 아니라 엉뚱한 데를 듣게 된다.
   * 구간이 사라지면 되풀이를 끈다.
   */
  useEffect(() => {
    if (!loop.previewLooping) return;
    if (selection && selection.end > selection.start) {
      playback.setLoopRange({ start: selection.start, end: selection.end });
    } else {
      playback.setLoopRange(null);
      setLoop(prev => ({ ...prev, previewLooping: false }));
    }
  }, [loop.previewLooping, selection, playback.setLoopRange]);

  /**
   * 편집 대상 클립. 구간을 그었으면 그 구간이 덮는 클립이고, 아니면 눌러 둔 클립이다.
   * 구간이 우선인 이유는, 구간을 긋는 행위 자체가 "여기를 고치겠다"는 뜻이라서다.
   */
  const editTargetClip = useMemo(() => {
    if (selection) {
      const hit = comp.clips.find(c =>
        c.lane === selection.lane && clipEndSec(c) > selection.start && c.startSec < selection.end
      );
      if (hit) return hit;
    }
    return comp.clips.find(c => c.id === selectedClipId) ?? null;
  }, [comp.clips, selection, selectedClipId]);

  /**
   * 고른 구간을 클립 안쪽 시간으로 옮긴다. 타임라인 시간과 클립 버퍼의 시간은
   * 클립 시작 오프셋만큼 어긋나 있어서, 그대로 넘기면 엉뚱한 데가 잘린다.
   */
  const clipRegion = useMemo(() => {
    if (!selection || !editTargetClip) return null;
    const s = Math.max(0, selection.start - editTargetClip.startSec);
    const e = Math.min(editTargetClip.buffer.duration, selection.end - editTargetClip.startSec);
    return e > s ? { start: s, end: e } : null;
  }, [selection, editTargetClip]);

  /** 편집 연산이 볼 구간. 클립이 있으면 클립 안쪽 좌표, 없으면 옛 wavesurfer 구간. */
  const editRegion: { start: number; end: number } | null =
    comp.clips.length > 0 ? clipRegion : (activeRegion ? { start: activeRegion.start, end: activeRegion.end } : null);

  /*
   * 트랙이 바뀔 때마다 피크를 다시 잰다. 원본 Veo 클립은 -20 dBFS 언저리로
   * 오는 일이 흔한데, 값이 화면에 없으면 규격(-3 dBFS)에 맞는지를 내보내
   * 재 보기 전까지 알 수가 없다.
   */
  useEffect(() => {
    // 클립이 문서이므로 피크도 지금 들리는 믹스에서 잰다.
    if (comp.clips.length > 0) {
      setCurrentPeak(playback.mix ? peakOf(playback.mix) : null);
      return;
    }
    if (!audio.currentUrl) { setCurrentPeak(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const arrayBuffer = await (await fetch(audio.currentUrl!)).arrayBuffer();
        const ctx = makeContext();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        void ctx.close();
        if (!cancelled) setCurrentPeak(peakOf(buffer));
      } catch {
        if (!cancelled) setCurrentPeak(null);
      }
    })();
    return () => { cancelled = true; };
  }, [audio.currentUrl, comp.clips.length, playback.mix]);

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
      /*
        `splitChannels` 를 켜면 이 값이 **채널마다** 걸린다 — 300 이면 스테레오가
        600 px 이 되어, 보조 화면인 `합친 결과` 가 정작 편집면인 트랙보다 커진다.
        지금은 마디 격자용 확인 화면이므로 그만큼만 준다.
      */
      height: 96,
      normalize: true,
      /*
        좌우를 나눠 그리지 않는다. 채널을 살펴보는 자리는 이제 트랙별 파형이고,
        여기는 마디 격자용 구간을 끄는 자리다 — 같은 것을 두 번 보여 줄 이유가 없고,
        나누면 높이가 채널 수만큼 곱해져 보조 화면이 또 커진다.
      */
      splitChannels: false as any,
      url: audio.currentUrl,
      minPxPerSec: Math.max(1, zoomFactor * 40),
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
    // 좌우를 안 나누게 된 뒤로 `isMono` 는 이 화면에 영향이 없다 — 넣어 두면
    // 모노로 바꿀 때마다 파형을 쓸데없이 다시 만든다.
  }, [audio.currentUrl]);

  /**
   * 오디오든 영상이든 받아서 48 kHz PCM WAV 로 바꿔 놓고 시작한다.
   *
   * Veo 는 mp4, Suno 는 mp3 를 주는데 둘 다 브라우저가 오디오 트랙만 디코드해 주므로
   * ffmpeg 이 필요 없다. 임포트에서 레이트를 못 박아 두면 이후 모든 편집과 내보내기가
   * 48 kHz 로 유지된다 — 원래는 출력 장치 레이트를 따라가서 44.1 kHz 가 조용히 섞였다.
   */
  /*
   * 되돌리기는 클립이 문서가 된 뒤로 두 갈래다. 트랙에 클립이 있으면 클립
   * 스냅샷을 되돌리고, 아직 트랙이 없을 때만 옛 합친-WAV 스택을 쓴다.
   * 편집이 클립에 걸리는데 되돌리기가 합친 파일만 보고 있으면 되돌 방법이 없다.
   */
  const handleUndo = () => {
    if (comp.undo.length > 0) {
      setComp(prev => {
        if (prev.undo.length === 0) return prev;
        const undo = [...prev.undo];
        const restored = undo.pop()!;
        return { ...prev, clips: restored, undo, redo: [prev.clips, ...prev.redo].slice(0, 30) };
      });
      setSelection(null);
      return;
    }
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
    if (comp.redo.length > 0) {
      setComp(prev => {
        if (prev.redo.length === 0) return prev;
        const redo = [...prev.redo];
        const restored = redo.shift()!;
        return { ...prev, clips: restored, redo, undo: [...prev.undo, prev.clips].slice(-30) };
      });
      setSelection(null);
      return;
    }
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

  /**
   * 처음부터 다시. `트랙 추가` 가 더하기만 하게 된 뒤로 **여기가 유일한 되돌아갈
   * 자리**라, 편집뿐 아니라 쌓아 둔 트랙까지 함께 비운다.
   */
  /*
   * 두 번 눌러야 지워진다. 전에는 `confirm()` 을 띄웠는데, **대화상자가 막히는
   * 자리(웹뷰·데스크톱 앱 안)에서는 `confirm` 이 곧바로 false 를 돌려주므로
   * 버튼을 눌러도 아무 일도 안 일어난 것처럼 보였다.** 확인을 버튼 안으로
   * 들여오면 어디서든 똑같이 동작하고, 초점을 빼앗지도 않는다.
   */
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const nothingToReset = comp.clips.length === 0 && !audio.currentUrl;

  const handleResetClick = () => {
    if (nothingToReset) return;
    if (!resetArmed) {
      setResetArmed(true);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      // 물어본 채로 오래 두지 않는다 — 다음에 눌렀을 때 지워지면 놀란다.
      resetTimer.current = window.setTimeout(() => setResetArmed(false), 4000);
      return;
    }
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setResetArmed(false);
    handleRevert();
  };

  const handleRevert = () => {
    if (nothingToReset) return;

    /*
     * 예전에는 "합친 결과를 처음 것으로 되돌리기"였는데, 그러면 클립은 0 인데
     * 합친 화면에는 옛 오디오가 남는 **반쪽 상태**가 됐다. 되돌리기 스택도 그대로
     * 남아서 몇 번 누르면 지운 줄 알았던 클립이 되살아났다.
     *
     * `트랙 추가` 가 더하기만 하게 된 뒤로 여기가 유일하게 처음으로 가는 문이므로,
     * 정말로 빈 상태까지 간다 — 문서(클립)·기록·화면·이름을 한꺼번에 비운다.
     */
    for (const url of new Set([audio.originalUrl, audio.currentUrl, ...audio.undoStack, ...audio.redoStack])) {
      if (url) URL.revokeObjectURL(url);
    }

    setComp(prev => ({
      ...prev,
      clips: [], clipboard: null, lastPeak: null, minLanes: 0,
      undo: [], redo: [],
    }));
    setAudio(prev => ({
      ...prev,
      file: null, originalUrl: null, currentUrl: null,
      duration: 0, currentTime: 0,
      isPlaying: false, isReady: false, isMono: false,
      isProcessing: false, processingMsg: '',
      undoStack: [], redoStack: [],
      sourceKind: null, channels: 0,
    }));
    setSelection(null);
    setSelectedClipId(null);
    setExportName('');
    setZoomFactor(1);
    setActiveRegion(null);
    setGainDbRaw(0);
    setGainNotice(null);
    regionsRef.current?.clearRegions();
  };

  /**
   * `target: 'merged'` 는 **합친 결과 트랙**에 걸라는 뜻이다.
   *
   * Loop Lab 이 그렇다 — 구간을 wavesurfer(합친 트랙)에서 받으므로 시간이 합친
   * 트랙 기준인데, 클립이 있다고 클립 버퍼에 그 시간을 그대로 들이대면
   * **엉뚱한 자리가 잘린다.** 좌표계가 다른 값을 섞지 않으려는 것이다.
   */
  const performProcessing = async (
    msg: string,
    processor: (buffer: AudioBuffer, ctx: AudioContext) => AudioBuffer | null | Promise<AudioBuffer | null>,
    opts: { target?: 'clip' | 'merged' } = {}
  ) => {
    /*
     * 클립이 문서다 — 트랙이 있으면 편집은 고른 클립의 버퍼에 건다.
     * 연산은 전부 `(buffer, ctx) => buffer` 라서 대상만 바꾸면 그대로 쓸 수 있다.
     *
     * 반드시 **복사본**에 건다. applyGain·applyFade 는 버퍼를 제자리에서 고치므로
     * 원본에 걸면 되돌리기가 남을 것이 없고, 재생 중인 믹스도 함께 바뀐다.
     */
    if (comp.clips.length > 0 && opts.target !== 'merged') {
      const clip = editTargetClip;
      if (!clip) {
        showNotice('편집할 클립을 고르십시오 — 트랙에서 클립을 누르거나 구간을 그으면 됩니다.');
        return;
      }
      setAudio(prev => ({ ...prev, isProcessing: true, processingMsg: msg }));
      try {
        const ctx = makeContext();
        const copy = ctx.createBuffer(clip.buffer.numberOfChannels, clip.buffer.length, clip.buffer.sampleRate);
        for (let c = 0; c < clip.buffer.numberOfChannels; c++) {
          copy.getChannelData(c).set(clip.buffer.getChannelData(c));
        }
        const next = await processor(copy, ctx);
        void ctx.close();
        if (next) {
          setComp(prev => ({
            ...prev,
            undo: [...prev.undo, prev.clips].slice(-30),
            redo: [],
            clips: prev.clips.map(c => (c.id === clip.id ? { ...c, buffer: next } : c)),
          }));
          /*
           * 편집이 끝나면 구간을 놓는다. 자르고 나면 클립 길이가 달라져서 남아
           * 있는 사각형이 더 이상 그 자리를 가리키지 않는다 — 그대로 두면
           * 다음 편집이 엉뚱한 데 걸린다. 고른 클립은 남겨서 이어 손볼 수 있게 한다
           * (구간을 그을 때 `handleSelectionChange` 가 대상 클립을 기억해 둔다).
           */
          setSelection(null);
          setSelectedClipId(clip.id);
        }
      } catch (e) {
        console.error('Clip processing failed', e);
      }
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
      return;
    }

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
        redoStack: []
      }));
      setActiveRegion(null);
    } catch (error) {
      console.error("Processing failed", error);
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
    }
  };

  const handleFadeAction = (type: 'in' | 'out') => {
    if (!editRegion) return;
    performProcessing(`Fading ${type}...`, (buffer) =>
      applyFade(buffer, editRegion.start, editRegion.end, type)
    );
  };

  const handleDenoiseAction = () => {
    performProcessing(`Applying Gate (Thresh: ${audio.gateThreshold.toFixed(3)})...`, (buffer) => 
      applyNoiseGate(buffer, audio.gateThreshold)
    );
  };

  const handleCutAction = () => {
    if (!editRegion) return;
    performProcessing('Destructive Cut...', (buffer, ctx) =>
      applyCut(buffer, editRegion.start, editRegion.end, ctx)
    );
  };

  const handleCropAction = () => {
    if (!editRegion) return;
    performProcessing('Cropping Selection...', (buffer, ctx) =>
      applyCrop(buffer, editRegion.start, editRegion.end, ctx)
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
  /*
   * 마디 격자도 트랙에서 논다. 클립이 있으면 구간을 **트랙 선택**으로 잡고,
   * 트랙이 없을 때만 옛 wavesurfer 구간을 쓴다. 두 좌표계를 섞지 않으려는 것이다.
   */
  const handleSnapRegion = () => {
    if (comp.clips.length > 0) {
      if (!selection) return;
      const s = snapToBar(selection.start, loop.bpm, loop.beatsPerBar, loop.downbeat);
      const e0 = snapToBar(selection.end, loop.bpm, loop.beatsPerBar, loop.downbeat);
      const e = e0 === s ? s + barSeconds(loop.bpm, loop.beatsPerBar) : e0;
      handleSelectionChange({ lane: selection.lane, start: s, end: e });
      return;
    }
    if (!activeRegion) return;
    const s = snapToBar(activeRegion.start, loop.bpm, loop.beatsPerBar, loop.downbeat);
    const e = snapToBar(activeRegion.end, loop.bpm, loop.beatsPerBar, loop.downbeat);
    setRegionExact(s, e === s ? s + barSeconds(loop.bpm, loop.beatsPerBar) : e);
  };

  /** 선택 시작(없으면 다운비트)에서 N 마디를 잡는다. */
  const handleSelectBars = () => {
    const span = loop.bars * barSeconds(loop.bpm, loop.beatsPerBar);
    if (comp.clips.length > 0) {
      // 고른 클립이 있으면 그 트랙에, 없으면 재생 헤드가 놓인 트랙 0 에 잡는다.
      const lane = selection?.lane ?? comp.clips.find(c => c.id === selectedClipId)?.lane ?? 0;
      const rawStart = selection ? selection.start : playback.currentTime;
      const start = loop.snapEnabled
        ? snapToBar(rawStart, loop.bpm, loop.beatsPerBar, loop.downbeat)
        : rawStart;
      handleSelectionChange({ lane, start, end: start + span });
      return;
    }
    const rawStart = activeRegion ? activeRegion.start : loop.downbeat;
    const start = loop.snapEnabled
      ? snapToBar(rawStart, loop.bpm, loop.beatsPerBar, loop.downbeat)
      : rawStart;
    setRegionExact(start, start + span);
  };

  /** 재생 위치를 첫 다운비트로 삼는다. 첫 박이 0 이 아닌 곡에 필요하다. */
  const handleSetDownbeatHere = () => {
    setLoop(prev => ({ ...prev, downbeat: audio.currentTime }));
  };

  const toggleLoopPreview = () => {
    if (comp.clips.length > 0) {
      // 트랙에서는 재생 엔진이 구간을 되풀이한다 — 표본 단위로 브라우저가 이어 준다.
      const next = !loop.previewLooping;
      if (next && selection && selection.end > selection.start) {
        playback.setLoopRange({ start: selection.start, end: selection.end });
        playback.seek(selection.start);
        playback.play();
      } else {
        playback.setLoopRange(null);
        playback.pause();
      }
      setLoop(prev => ({ ...prev, previewLooping: next && !!selection }));
      return;
    }
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

  /*
   * 선택이 마디에 맞는지 미리 재 둔다. 버튼 라벨이 이 값으로 바뀌므로
   * 누르기 전에 어긋난 것을 볼 수 있다 — 전에는 누른 뒤에야 대화상자로 알렸다.
   */
  const loopBars = editRegion ? barsBetween(editRegion.start, editRegion.end, loop.bpm, loop.beatsPerBar) : null;
  const loopOffGrid = loopBars !== null && Math.abs(loopBars - Math.round(loopBars)) > 0.01;
  const [loopArmed, setLoopArmed] = useState(false);
  const loopTimer = useRef<number | null>(null);

  // 구간이 바뀌면 물어본 것을 무른다 — 다른 구간에 대고 답한 셈이 된다.
  useEffect(() => { setLoopArmed(false); }, [editRegion?.start, editRegion?.end]);

  /** 선택을 루프로 확정한다. 뒤쪽 foldMs 를 앞머리에 접어 이음매를 잇는다. */
  const handleMakeLoopAction = () => {
    const region = editRegion;
    if (!region) return;
    /*
     * 마디에 안 맞으면 두 번 눌러야 한다. 전에는 `confirm()` 으로 물었는데,
     * **대화상자가 막히는 자리에서는 곧바로 false 가 돌아와 버튼을 눌러도
     * 아무 일도 안 일어난 것처럼 보였다.** 확인을 버튼 안으로 들여왔다.
     */
    if (loopOffGrid && !loopArmed) {
      setLoopArmed(true);
      if (loopTimer.current !== null) clearTimeout(loopTimer.current);
      loopTimer.current = window.setTimeout(() => setLoopArmed(false), 4000);
      return;
    }
    if (loopTimer.current !== null) clearTimeout(loopTimer.current);
    setLoopArmed(false);
    /*
      구간을 받은 곳과 자르는 곳의 좌표계를 맞춘다 — 트랙에서 골랐으면 클립을,
      합친 트랙에서 골랐으면 합친 트랙을 자른다. 섞으면 엉뚱한 자리가 잘린다.
    */
    performProcessing(`루프 제작 (${Math.round(loopBars ?? 0)}마디, 꼬리 ${loop.foldMs} ms)…`, (buffer, ctx) =>
      makeSeamlessLoop(buffer, region.start, region.end, loop.foldMs, ctx),
      { target: comp.clips.length > 0 ? 'clip' : 'merged' }
    );
  };

  // --- 병합 작업대 ---

  const newClipId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * 클립을 담는다. 기본 배치는 "같은 레인 뒤에 이어 붙이기"다 — 앞 클립 끝에서
   * 크로스페이드만큼 당겨 겹치고, 마주 보는 두 클립에 등출력 페이드를 물린다.
   * 겹쳐 쌓고 싶으면 담은 뒤 "겹치기"로 레인을 옮긴다.
   *
   * `bake` 는 아직 편집 중인 트랙이 없을 때 쓴다 — 클립 여러 개로 처음부터
   * 시작하는 경우, 담자마자 한 번 구워 줘야 편집기가 열린다.
   */
  /** 지금 편집 중인 트랙을 클립 하나로 만든다. 없으면 null. */
  const currentTrackAsClip = async (): Promise<{ id: string; name: string; buffer: AudioBuffer } | null> => {
    if (!audio.currentUrl) return null;
    const arrayBuffer = await (await fetch(audio.currentUrl)).arrayBuffer();
    const ctx = makeContext();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    void ctx.close();
    return { id: newClipId(), name: audio.file?.name ?? 'current.wav', buffer };
  };

  const handleComposerImport = async (files: FileList | null, bake = false) => {
    if (!files || files.length === 0) return;
    setAudio(prev => ({ ...prev, isProcessing: true, processingMsg: '클립 디코드 중…' }));
    try {
      const decoded: { id: string; name: string; buffer: AudioBuffer }[] = [];
      for (const file of Array.from(files)) {
        // Veo mp4 도 그대로 놓으면 된다 — 브라우저가 오디오 트랙만 디코드한다.
        decoded.push({ id: newClipId(), name: file.name, buffer: await decodeFileToBuffer(file, PROJECT_SAMPLE_RATE) });
      }
      const groomCtx = makeContext();
      const groomed = groomImported(decoded, groomCtx);
      void groomCtx.close();

      /*
       * 담긴 클립이 없을 때 편집 중인 트랙을 자동으로 클립 0 으로 넣던 것을 뺐다.
       *
       * `IMPORT` 가 클립 없이 트랙만 열던 시절에는 필요했지만, `트랙 추가` 로 바뀐 뒤로
       * **합친 트랙은 클립에서만 나온다.** 그래서 "클립은 비었는데 합친 트랙은 있다"는
       * 상태는 **사용자가 트랙을 다 지웠을 때뿐**이고, 거기서 자동으로 넣으면
       * 지운 것이 되살아난다. 실제로 그렇게 됐다 — 다 지우고 파일 하나를 더했더니
       * 클립이 2개가 됐다.
       */
      const next = placeClips(comp.clips, decoded, 0, comp.crossfadeMs);
      commitClips(next);
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
      // 아무것도 없던 상태에서 클립으로 시작했으면 첫 클립 이름을 제안으로 쓴다.
      if (!audio.currentUrl && decoded[0]) setExportName(suggestAssetName(decoded[0].name));
      // 말없이 고치지 않는다 — 무엇이 바뀌었는지 적어 준다.
      if (groomed.length) showNotice(`담으면서 ${groomed.join(' · ')}.`);
      if (bake) await bakeComposition(next);
    } catch (e: any) {
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
      showNotice(`디코드할 수 없습니다: ${e?.message ?? e} — 브라우저가 못 여는 코덱이면 이 파일만 ffmpeg 으로 wav 를 뽑아 주십시오.`, 'error');
    }
  };

  /** 지금 편집 중인 트랙을 클립으로 담는다. 편집한 결과 위에 더 얹을 때 쓴다. */
  const handleAddCurrentAsClip = async () => {
    if (!audio.currentUrl) return;
    setAudio(prev => ({ ...prev, isProcessing: true, processingMsg: '현재 트랙을 클립으로…' }));
    try {
      const cur = await currentTrackAsClip();
      if (cur) {
        const next = placeClips(comp.clips, [cur], 0, comp.crossfadeMs);
        commitClips(next);
      }
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
    } catch (e) {
      console.error(e);
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
    }
  };

  /**
   * 되돌리기 스냅샷을 한 장 쌓는다.
   *
   * **편집 동작이 시작될 때 한 번만** 부른다 — 끄는 동안 매 프레임 쌓으면
   * 되돌리기 한 번에 1 픽셀씩 돌아가서 쓸모가 없어진다. 그래서 드래그는
   * 시작 시점에, 숫자 칸은 포커스가 들어올 때 한 장씩 쌓는다.
   *
   * 버퍼는 참조로 공유하므로 스냅샷은 배열 하나 값이다.
   */
  const pushUndo = useCallback(() => {
    setComp(prev => ({ ...prev, undo: [...prev.undo, prev.clips].slice(-30), redo: [] }));
  }, []);

  /** 스냅샷을 쌓고 클립을 갈아 끼운다. 한 번에 끝나는 동작(삭제·붙여넣기 등)용. */
  const commitClips = useCallback((next: CompClip[]) => {
    setComp(prev => ({ ...prev, undo: [...prev.undo, prev.clips].slice(-30), redo: [], clips: next }));
  }, []);

  /** 값만 바꾼다. 스냅샷은 동작 시작 때 `pushUndo` 가 이미 쌓아 뒀다 (드래그가 이쪽). */
  const updateClip = (id: string, patch: Partial<CompClip>) => {
    setComp(prev => ({ ...prev, clips: prev.clips.map(c => (c.id === id ? { ...c, ...patch } : c)) }));
  };

  /** 마지막으로 손댄 칸과 시각. 연속으로 고친 것을 한 번에 되돌리려고 기억한다. */
  const lastFieldEditRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });

  /**
   * 숫자 칸에서 값을 고친다. 스냅샷은 **한 벌의 편집마다 한 장**만 쌓는다.
   *
   * 원래 `onFocus` 로 쌓았는데, 포커스 이벤트는 창이 활성이 아니면 아예 안 뜬다 —
   * 그러면 스냅샷이 빠진 채 값만 바뀌고, 되돌리기가 엉뚱하게 그 이전 상태로
   * 건너뛴다. 이벤트에 기대지 않고 "같은 칸을 0.8초 안에 계속 고치는 중이면
   * 같은 편집"으로 묶는다.
   */
  const updateClipField = (id: string, patch: Partial<CompClip>) => {
    const key = `${id}:${Object.keys(patch).join(',')}`;
    const now = Date.now();
    const isNewGesture = lastFieldEditRef.current.key !== key || now - lastFieldEditRef.current.at > 800;
    lastFieldEditRef.current = { key, at: now };

    setComp(prev => ({
      ...prev,
      ...(isNewGesture ? { undo: [...prev.undo, prev.clips].slice(-30), redo: [] } : {}),
      clips: prev.clips.map(c => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const removeClip = (id: string) => {
    commitClips(comp.clips.filter(c => c.id !== id));
  };

  /**
   * 무음을 클립으로 담는다 — 이것이 결과 길이를 늘리는 방법이다.
   * 길이는 "가장 늦게 끝나는 클립"이 정하므로, 뒤에 무음을 붙이면 그만큼 늘어난다.
   *
   * 무음은 **반드시 모노**로 만든다. 결과 채널 수가 클립 중 최대치라서,
   * 스테레오 무음을 담으면 모노 자산(효과음·말 상태음)이 조용히 스테레오로
   * 승격돼 규격을 어기게 된다. 모노는 최솟값이라 아무것도 바꾸지 않는다.
   */
  const handleAddSilence = () => {
    const sec = Math.max(0.001, comp.silenceSec);
    const ctx = makeContext();
    const buffer = ctx.createBuffer(1, Math.round(sec * PROJECT_SAMPLE_RATE), PROJECT_SAMPLE_RATE);
    void ctx.close();
    // 크로스페이드 없이 딱 붙인다 — 무음과 겹쳐 페이드하면 앞 클립이 깎인다.
    commitClips(placeClips(comp.clips, [{ id: newClipId(), name: `무음 ${sec}초`, buffer }], 0, 0));
  };

  /**
   * 트랙을 더한다 — 고른 파일마다 새 트랙을 하나씩 내주고 0 초에 나란히 얹는다.
   *
   * 예전 `IMPORT` 는 되돌리기까지 싹 비우고 새로 여는 버튼이었다. 트랙을 쌓아
   * 쓰는 도구에서 "파일을 연다"가 "지금 것을 버린다"와 같은 뜻인 것은 맞지 않다.
   * 처음부터 다시 하려면 `RESET` 이 있다.
   */
  const handleAddTrack = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const picked = Array.from(files);
    const notMedia = picked.find(f => !f.type.startsWith('audio/') && !f.type.startsWith('video/'));
    if (notMedia) {
      showNotice(`오디오나 영상 파일이 아닙니다: ${notMedia.name} (${notMedia.type || '알 수 없는 형식'})`, 'error');
      return;
    }
    const anyVideo = picked.some(f => f.type.startsWith('video/'));

    setAudio(prev => ({
      ...prev,
      isProcessing: true,
      processingMsg: anyVideo ? '영상에서 오디오 트랙 추출 중…' : '트랙 추가 중…',
    }));
    try {
      const decoded: { id: string; name: string; buffer: AudioBuffer }[] = [];
      for (const file of picked) {
        decoded.push({ id: newClipId(), name: file.name, buffer: await decodeFileToBuffer(file, PROJECT_SAMPLE_RATE) });
      }
      const groomCtx = makeContext();
      const groomed = groomImported(decoded, groomCtx);
      void groomCtx.close();

      const hadTrack = !!audio.currentUrl;
      // 자동 포함은 뺐다 — 위 `handleComposerImport` 의 주석 참고.
      const next = placeOnNewLanes(comp.clips, decoded);
      commitClips(next);
      setAudio(prev => ({
        ...prev,
        isProcessing: false,
        processingMsg: '',
        // 영상에서 뽑아 온 트랙이 하나라도 있으면 그 표시는 유지한다.
        sourceKind: anyVideo ? 'video' : prev.sourceKind,
        file: prev.file ?? picked[0],
      }));

      if (!hadTrack) {
        // 아무것도 없던 상태였으면 한 번 구워 줘야 편집기가 열린다.
        if (decoded[0]) setExportName(suggestAssetName(decoded[0].name));
        await bakeComposition(next);
      }
      // 말없이 고치지 않는다 — 무엇이 바뀌었는지 적어 준다.
      if (groomed.length) showNotice(`담으면서 ${groomed.join(' · ')}.`);
    } catch (e: any) {
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
      showNotice(`디코드할 수 없습니다: ${e?.message ?? e} — 브라우저가 못 여는 코덱이면 이 파일만 ffmpeg 으로 wav 를 뽑아 주십시오.`, 'error');
    }
  };

  // --- 자르고 끼워넣기 ---

  /** 재생 헤드 자리에서 클립을 둘로 쪼갠다. 끼워넣기의 출발점이다. */
  const handleSplitAtPlayhead = () => {
    const at = playback.currentTime;
    const clip = comp.clips.find(c =>
      c.id === selectedClipId && c.startSec < at && clipEndSec(c) > at
    ) ?? comp.clips.find(c => c.startSec < at && clipEndSec(c) > at);
    if (!clip) {
      showNotice('재생 헤드가 클립 위에 있어야 쪼갤 수 있습니다 — 눈금을 눌러 헤드를 옮기십시오.');
      return;
    }
    const ctx = makeContext();
    const next = splitClipAt(
      comp.clips, clip.id, at,
      (buffer, from, to) => applyCrop(buffer, from, to, ctx),
      newClipId
    );
    void ctx.close();
    if (next !== comp.clips) {
      commitClips(next);
      setSelection(null);
    }
  };

  /** 재생 헤드 자리에 자리를 벌린다 — 뒤엣것을 통째로 민다. */
  const handleRippleInsert = () => {
    const lane = selection?.lane ?? comp.clips.find(c => c.id === selectedClipId)?.lane ?? 0;
    commitClips(rippleInsert(comp.clips, lane, playback.currentTime, comp.silenceSec));
  };

  /** 고른 클립을 빼고 그 트랙의 틈을 닫는다. */
  const handleRippleDelete = () => {
    const clip = comp.clips.find(c => c.id === selectedClipId);
    if (!clip) {
      showNotice('뺄 클립을 먼저 고르십시오.');
      return;
    }
    commitClips(rippleDelete(comp.clips, clip.id));
    setSelection(null);
  };

  /**
   * 고른 **구간**을 새 클립으로 떠서 클립보드에 담는다.
   *
   * 클립 통째로 복사하는 것과는 다른 일이다 — 자르고 끼워넣는 흐름에서는
   * "여기서 여기까지"를 떠다 다른 자리에 놓고 싶지, 클립 전체가 필요한 게 아니다.
   */
  /** 고른 구간을 떠서 클립보드에 담는다. 복사와 잘라내기가 같은 것을 담아야 하므로 한 곳에 둔다. */
  const putRegionOnClipboard = (): boolean => {
    if (!editTargetClip || !clipRegion) return false;
    const ctx = makeContext();
    const piece = applyCrop(editTargetClip.buffer, clipRegion.start, clipRegion.end, ctx);
    void ctx.close();
    if (!piece) return false;
    setComp(prev => ({
      ...prev,
      clipboard: {
        ...editTargetClip,
        id: newClipId(),
        name: `${baseClipName(editTargetClip.name)} (조각)`,
        buffer: piece,
        startSec: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
      },
    }));
    return true;
  };

  const handleCopyRange = () => {
    if (!putRegionOnClipboard()) {
      showNotice('먼저 트랙에서 구간을 그으십시오 — “구간 선택” 모드로 끌면 됩니다.');
    }
  };

  /**
   * 잘라내기 = 담고 나서 그 자리를 지운다.
   *
   * 구간을 골랐으면 그 구간을 떠서 담고 클립에서 도려낸다(뒤가 당겨와 틈이 안 남는다).
   * 구간이 없으면 **고른 클립 통째**를 담고 트랙에서 뺀다 — 이때는 자리를 그대로 두고
   * 빼기만 한다. 뒤엣것까지 당기는 것은 `틈 닫기` 의 몫이라, 한 단추가 두 일을 하면 안 된다.
   */
  const handleCutRange = () => {
    if (clipRegion && editTargetClip) {
      if (!putRegionOnClipboard()) return;
      performProcessing('구간 잘라내기…', (buffer, ctx) =>
        applyCut(buffer, clipRegion.start, clipRegion.end, ctx)
      );
      return;
    }
    const clip = comp.clips.find(c => c.id === selectedClipId);
    if (!clip) {
      showNotice('먼저 구간을 긋거나 클립을 고르십시오.');
      return;
    }
    setComp(prev => ({ ...prev, clipboard: { ...clip, id: newClipId(), startSec: 0 } }));
    commitClips(comp.clips.filter(c => c.id !== clip.id));
    setSelection(null);
  };

  /** 클립보드를 **재생 헤드 자리**에 붙여넣는다. 트랙은 고른 트랙을 따른다. */
  const handlePasteAtPlayhead = () => {
    if (!comp.clipboard) return;
    const lane = selection?.lane ?? comp.clips.find(c => c.id === selectedClipId)?.lane ?? 0;
    const base = baseClipName(comp.clipboard.name);
    const n = comp.clips.filter(c => baseClipName(c.name) === base).length;
    commitClips([...comp.clips, {
      ...comp.clipboard,
      id: newClipId(),
      lane,
      startSec: Math.round(playback.currentTime * 1e4) / 1e4,
      name: `${base} (붙임 ${n})`,
    }]);
  };

  /*
   * 단축키. 늘 최신 상태를 보도록 ref 에 담아 두고 리스너는 한 번만 건다 —
   * 핸들러를 그대로 걸면 렌더마다 새로 만들어져 매번 다시 등록된다.
   */
  const shortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;

    /*
     * 글자를 치는 중이면 손대지 않는다. 이름 칸에서 Ctrl+C 가 막히면
     * 이름을 복사할 방법이 없어진다 — 브라우저 몫으로 넘긴다.
     */
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (comp.clips.length === 0) return;

    const key = e.key.toLowerCase();
    if (key === 'c') {
      // 구간을 그었으면 그 조각을, 아니면 고른 클립을 통째로 담는다.
      if (clipRegion) { e.preventDefault(); handleCopyRange(); }
      else if (selectedClipId) { e.preventDefault(); copyClip(selectedClipId); }
    } else if (key === 'x') {
      if (clipRegion || selectedClipId) { e.preventDefault(); handleCutRange(); }
    } else if (key === 'v') {
      if (comp.clipboard) { e.preventDefault(); handlePasteAtPlayhead(); }
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => shortcutRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  /** 붙여넣을 때 이름이 "(복사) (복사)" 로 겹치지 않게 뿌리 이름을 뽑는다. */
  /**
   * 클립 이름의 뿌리. 쪼개고·뜨고·붙이다 보면 꼬리표가 계속 쌓여
   * `a.wav (뒤) (조각) (붙임 0) (복사 1)` 같은 이름이 된다. 붙일 때마다 걷어 낸다.
   */
  const baseClipName = (name: string) =>
    name.replace(/(?: \((?:복사|붙임)(?: \d+)?\)| \(뒤\)| \(조각\))+$/, '');

  const copyClip = (id: string) => {
    setComp(prev => {
      const c = prev.clips.find(x => x.id === id);
      return c ? { ...prev, clipboard: c } : prev;
    });
  };

  /**
   * 복사해 둔 클립을 새 레인에 붙여넣는다 — 같은 자리에서 겹쳐 울린다.
   * 여러 번 붙여넣으면 레인이 계속 늘어나므로, 같은 소리를 오프셋만 달리해
   * 여러 겹 쌓을 수 있다.
   */
  const pasteClipToNewLane = () => {
    if (!comp.clipboard) return;
    const lanes = comp.clips.map(c => c.lane);
    const nextLane = lanes.length ? Math.max(...lanes) + 1 : 0;
    const base = baseClipName(comp.clipboard.name);
    const n = comp.clips.filter(c => baseClipName(c.name) === base).length;
    commitClips([...comp.clips, {
      ...comp.clipboard,
      id: newClipId(),
      lane: nextLane,
      name: `${base} (복사 ${n})`,
    }]);
  };

  /** 클립을 새 레인으로 옮겨 겹치게 한다 (병렬 배치). */
  const stackClip = (id: string) => {
    const lanes = comp.clips.map(c => c.lane);
    const nextLane = lanes.length ? Math.max(...lanes) + 1 : 0;
    commitClips(comp.clips.map(c =>
      c.id === id ? { ...c, lane: nextLane, startSec: 0, fadeInMs: 0, fadeOutMs: 0 } : c
    ));
  };

  /** 전부 합쳐 한 트랙으로 굽고 편집기로 넘긴다. */
  const bakeComposition = async (clips: CompClip[] = comp.clips) => {
    if (clips.length === 0) return;
    setAudio(prev => ({ ...prev, isProcessing: true, processingMsg: '클립 합치는 중…' }));
    try {
      const ctx = makeContext();
      let rendered = renderComposition(clips, ctx, PROJECT_SAMPLE_RATE);
      if (!rendered) {
        setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
        return;
      }
      if (comp.wrapMs > 0) {
        const wrapped = wrapLoopEnds(rendered, comp.wrapMs, ctx);
        if (wrapped) rendered = wrapped;
      }

      /*
       * 합산은 넘칠 수 있다 — 상관 있는 자료가 겹치면 최대 +3 dB 솟는다.
       * 규격 맞추기를 껐더라도 **넘친 채로 내보내지는 않는다.** 잘라 내는 대신
       * 0 dBFS 로 눌러 담는다 — 선형 배수만 바뀌므로 소리는 그대로다.
       */
      const rawPeak = peakOf(rendered);
      if (comp.normalizeAfter) rendered = applyNormalizeToDbfs(rendered, loop.targetDbfs);
      else if (rawPeak > CLIP_CEILING) rendered = applyNormalizeToDbfs(rendered, 0);

      const blob = audioBufferToWav(rendered);
      const url = URL.createObjectURL(blob);
      const oldUrl = audio.currentUrl;

      setComp(prev => ({ ...prev, lastPeak: rawPeak }));
      setAudio(prev => ({
        ...prev,
        currentUrl: url,
        originalUrl: prev.originalUrl ?? url,
        duration: rendered!.duration,
        isReady: false,
        isProcessing: false,
        processingMsg: '',
        isMono: rendered!.numberOfChannels === 1,
        undoStack: oldUrl ? [...prev.undoStack, oldUrl] : prev.undoStack,
        redoStack: [],
        file: prev.file ?? new File([blob], 'composed-v1.wav', { type: 'audio/wav' }),
        channels: rendered!.numberOfChannels,
        sourceKind: prev.sourceKind ?? 'audio',
      }));
      setActiveRegion(null);
    } catch (e) {
      console.error('Composition failed', e);
      setAudio(prev => ({ ...prev, isProcessing: false, processingMsg: '' }));
    }
  };

  /**
   * 앞뒤로 뒤집는다. 구간을 골랐으면 그 구간만, 아니면 클립 통째로 —
   * `applyGain` 과 같은 규칙이다. 표본 수도 피크도 그대로라 길이가 흐트러지지 않는다.
   */
  const handleReverseAction = () => {
    performProcessing(
      editRegion ? '구간 뒤집기…' : '트랙 뒤집기…',
      (buffer) => applyReverse(buffer, editRegion?.start, editRegion?.end)
    );
  };

  /**
   * 고른 구간(없으면 클립 통째)의 음량을 dB 만큼 올리거나 내린다.
   *
   * **넘치면 배수를 깎는다.** 그냥 곱하면 1 을 넘은 표본이 화면에는 남아 있다가
   * 16-bit 로 쓸 때 잘린다 — 되돌릴 수 없고 소리도 뭉갠다. 깎였으면 얼마나
   * 걸렸는지 도크에 적어 준다. 말없이 덜 걸리면 그게 더 나쁘다.
   */
  const handleGainDbAction = () => {
    const factor = Math.pow(10, gainDb / 20);
    performProcessing(
      `${editRegion ? '구간' : '트랙'} ${gainDb > 0 ? '+' : ''}${gainDb} dB…`,
      (buffer) => {
        const r = applyGainCapped(buffer, factor, CLIP_CEILING, editRegion?.start, editRegion?.end);
        const appliedDb = Math.round(20 * Math.log10(r.applied) * 100) / 100;
        setGainNotice(
          !r.capped
            ? null
            : appliedDb <= 0.01
              // 천장에 이미 닿아 있으면 걸린 양이 0 이다. "0 dB 까지만"은
              // 아무것도 안 걸렸다는 뜻인데 그렇게 안 읽힌다.
              ? '이미 0 dBFS — 더 못 키운다'
              : `+${appliedDb} dB 까지만 — 0 dBFS 에 닿았다`
        );
        return r.buffer;
      }
    );
  };

  /* ---- 길이 바꾸기 ---- */

  /** 목표 길이(초). 클립을 바꾸면 그 클립의 길이로 다시 맞춘다. */
  const [targetLenSec, setTargetLenSec] = useState(0);
  const [keepPitch, setKeepPitch] = useState(true);
  /*
   * 겹쳐 붙일 조각의 길이. 자료가 정한다 — 아래쪽 한계는 **저역의 한 주기**이고
   * (그보다 짧으면 그 주파수가 통째로 사라진다), 위로 갈수록 거칠어진다.
   */
  const [stretchFrameMs, setStretchFrameMs] = useState(TIME_STRETCH_FRAME_MS_DEFAULT);

  /*
   * 담을 때 자동으로 손질한다. Veo 가 주는 것이 늘 같은 모양으로 어긋나 있어서,
   * 담을 때마다 손으로 두 번 누르게 되기 때문이다. 실측한 낟알 붓는 소리는
   * 피크 **-25.12 dBFS**(규격까지 +22 dB)에 2채널이지만 좌우 차이가 **0.0007** 이었다.
   *
   * **모노는 좌우가 사실상 같을 때만 내린다.** 규격은 효과음·말 상태음만 모노이고
   * 음악·환경음은 스테레오여야 한다 — 무턱대고 내리면 규격을 어긴다. 좌우가 같은
   * 것을 내리는 것은 잃을 것이 없는 일(파형이 그대로다)이라 안전하다.
   */
  const [autoMono, setAutoMono] = useState(true);
  const [autoNormalize, setAutoNormalize] = useState(true);

  const groomImported = useCallback((
    decoded: { id: string; name: string; buffer: AudioBuffer }[],
    ctx: AudioContext
  ): string[] => {
    const notes: string[] = [];
    let monoed = 0, gained = 0;
    for (const clip of decoded) {
      if (autoMono && clip.buffer.numberOfChannels > 1 && channelDifference(clip.buffer) < MONO_IDENTICAL_THRESHOLD) {
        clip.buffer = downmixToMono(clip.buffer, ctx);
        monoed++;
      }
      if (autoNormalize) {
        const before = peakOf(clip.buffer);
        if (before > 0 && Math.abs(20 * Math.log10(before) - loop.targetDbfs) > 0.05) {
          clip.buffer = applyNormalizeToDbfs(clip.buffer, loop.targetDbfs);
          gained++;
        }
      }
    }
    if (monoed) notes.push(`${monoed}개는 좌우가 같아 모노로 내렸습니다`);
    if (gained) notes.push(`${gained}개를 ${loop.targetDbfs} dBFS 로 맞췄습니다`);
    return notes;
  }, [autoMono, autoNormalize, loop.targetDbfs]);
  const editClipDur = editTargetClip?.buffer.duration ?? null;
  useEffect(() => {
    if (editClipDur !== null) setTargetLenSec(Math.round(editClipDur * 1000) / 1000);
  }, [editClipDur, editTargetClip?.id]);

  const lenRatio = editClipDur && editClipDur > 0 && targetLenSec > 0 ? targetLenSec / editClipDur : null;
  const lenBars = targetLenSec > 0 ? targetLenSec / barSeconds(loop.bpm, loop.beatsPerBar) : null;
  const lenRatioOk = lenRatio !== null && lenRatio >= LEN_RATIO_MIN && lenRatio <= LEN_RATIO_MAX;

  /** 목표 길이를 **마디 수**에 붙인다 — 루프는 마디에 맞아야 돌 때 박자가 안 어긋난다. */
  const snapLenToBar = () => {
    const bar = barSeconds(loop.bpm, loop.beatsPerBar);
    const bars = Math.max(1, Math.round(targetLenSec / bar));
    setTargetLenSec(Math.round(bars * bar * 1000) / 1000);
  };

  const handleLengthAction = () => {
    if (lenRatio === null) { showNotice('먼저 트랙에서 클립을 고르십시오.'); return; }
    if (Math.abs(lenRatio - 1) < 1e-4) { showNotice('길이가 이미 같습니다.'); return; }
    if (!lenRatioOk) {
      showNotice(`길이는 ${LEN_RATIO_MIN}~${LEN_RATIO_MAX}배 안에서만 바꿉니다 — 지금은 ×${lenRatio.toFixed(2)} 입니다.`, 'error');
      return;
    }
    /*
     * 둘은 다른 물건이다. `음정 유지` 를 끄면 테이프를 빨리 돌리는 것과 같아
     * 음정이 함께 바뀌고(정확·빠름), 켜면 조각을 겹쳐 붙여 음정을 지킨다
     * (환경음은 잘 되고, 짧은 타격음은 ±10% 를 넘으면 두 번 친 것처럼 들린다).
     */
    performProcessing(
      `${keepPitch ? `길이만 (조각 ${stretchFrameMs} ms)` : '속도'} ${targetLenSec.toFixed(3)}초로…`,
      (buffer, ctx) =>
        keepPitch ? timeStretch(buffer, lenRatio, ctx, stretchFrameMs) : applySpeedChange(buffer, lenRatio, ctx)
    );
  };

  const handleNormalizeToTargetAction = () => {
    performProcessing(`피크를 ${loop.targetDbfs} dBFS 로…`, (buffer) =>
      applyNormalizeToDbfs(buffer, loop.targetDbfs)
    );
  };



  /**
   * 고른 클립을 모노로 내린다.
   *
   * 예전에는 **합친 트랙**(`audio.isMono`)을 보고 "이미 모노"라고 판단했는데, 편집
   * 대상은 고른 클립이라 둘이 어긋났다 — 모노 트랙에 스테레오를 얹은 상태에서
   * 그 스테레오 클립을 고르면, 합친 트랙이 아직 모노라 **아무 일도 안 하고 경고만 떴다.**
   * 이제 고른 클립의 채널 수를 본다.
   */
  const handleToggleMono = async () => {
    const clip = editTargetClip;
    if (comp.clips.length > 0 && !clip) {
      showNotice('먼저 트랙에서 클립을 고르십시오.');
      return;
    }
    performProcessing('모노로 내리는 중…', (buffer, ctx) => mixBufferToMono(buffer, ctx));
  };

  /**
   * 내보내기는 **지금 들리는 것**을 낸다. 클립이 문서이므로 합치기를 눌러 두지
   * 않았어도 트랙에서 바로 구워야 하고, 재생과 같은 `renderComposition` 을 쓰므로
   * 들은 것과 나가는 것이 어긋날 수 없다.
   */
  const handleDownloadAction = () => {
    let href = audio.currentUrl;
    if (comp.clips.length > 0 && playback.mix) {
      const ctx = makeContext();
      // 정규화(applyGain)는 버퍼를 제자리에서 고친다 — 재생 중인 믹스를 그대로
      // 넘기면 들리는 소리가 함께 커진다. 반드시 복사본에 건다.
      let out = ctx.createBuffer(playback.mix.numberOfChannels, playback.mix.length, playback.mix.sampleRate);
      for (let c = 0; c < playback.mix.numberOfChannels; c++) {
        out.getChannelData(c).set(playback.mix.getChannelData(c));
      }
      // 말아들기는 재생 믹스에 이미 걸려 있다 — 여기서 또 걸면 두 번 말린다.
      if (comp.normalizeAfter) out = applyNormalizeToDbfs(out, loop.targetDbfs);
      // 규격 맞추기를 껐어도 넘친 채로는 안 쓴다. 자르지 않고 0 dBFS 로 눌러 담는다.
      else if (peakOf(out) > CLIP_CEILING) out = applyNormalizeToDbfs(out, 0);
      void ctx.close();
      href = URL.createObjectURL(audioBufferToWav(out));
    }
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    // 화면의 이름 칸이 진실이다. 비었으면 원본에서 관례대로 지어 준다.
    const name = exportName.trim() || suggestAssetName(audio.file?.name ?? 'untitled.wav');
    link.download = `${name}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 끌어다 놓는 것도 버튼과 같은 뜻이다 — 지금 것을 버리지 않고 트랙으로 더한다.
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    void handleAddTrack(e.dataTransfer.files);
  }, [handleAddTrack]);

  /*
   * 재생은 트랙을 실시간으로 섞어 들려준다. 합쳐진 파일이 아니라 클립이 문서라서,
   * 합치기를 누르지 않아도 지금 배치가 그대로 들려야 한다.
   * 클립이 아직 없을 때만 예전 wavesurfer 재생으로 넘긴다.
   */
  const togglePlay = () => {
    if (comp.clips.length > 0) { playback.toggle(); return; }
    if (activeRegion && !audio.isPlaying) activeRegion.play();
    else wavesurferRef.current?.playPause();
  };
  const seekToStart = () => {
    if (comp.clips.length > 0) { playback.seek(0); return; }
    wavesurferRef.current?.setTime(0);
  };
  const clearRegion = () => {
    regionsRef.current?.clearRegions();
    setActiveRegion(null);
  };

  /*
   * 합친 결과 파형도 같은 배율을 따르게 한다. wavesurfer 는 "초당 픽셀"이라
   * 폭÷길이 로 폭에 맞는 값을 구한 뒤 배율을 곱한다.
   */
  useEffect(() => {
    const ws = wavesurferRef.current;
    const el = containerRef.current;
    if (!ws || !el || !audio.isReady) return;
    const dur = ws.getDuration();
    if (!dur) return;
    const fit = Math.max(1, (el.clientWidth - 48) / dur);
    ws.zoom(fit * zoomFactor);
  }, [zoomFactor, audio.isReady, audio.currentUrl]);

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  // 마디 격자 파생값. 선택이 격자에 맞았는지를 화면에 계속 보여 줘야 손으로 맞출 수 있다.
  const oneBar = barSeconds(loop.bpm, loop.beatsPerBar);
  // 판독줄도 지금 고른 구간을 따른다 (트랙이면 트랙 선택, 아니면 합친 트랙 구간).
  const readoutRegion = comp.clips.length > 0
    ? (selection && selection.end > selection.start ? { start: selection.start, end: selection.end } : null)
    : (activeRegion ? { start: activeRegion.start, end: activeRegion.end } : null);
  const selBars = readoutRegion
    ? barsBetween(readoutRegion.start, readoutRegion.end, loop.bpm, loop.beatsPerBar)
    : 0;
  const selOnGrid = !!readoutRegion && Math.abs(selBars - Math.round(selBars)) < 0.01;

  // 병합 파생값. 말아들기는 그만큼 길이를 줄이므로 결과 길이에 미리 반영해 보여 준다.
  const compChannels = compositionChannels(comp.clips);
  const compRawSec = compositionLength(comp.clips, PROJECT_SAMPLE_RATE) / PROJECT_SAMPLE_RATE;
  const compResultSec = Math.max(0, compRawSec - (comp.clips.length > 0 ? comp.wrapMs / 1000 : 0));
  const compLanes = comp.clips.length ? new Set(comp.clips.map(c => c.lane)).size : 0;
  /** 실제로 클립이 올라가 있는 트랙 수. 빈 트랙을 뺄 때 이 아래로는 못 내려간다. */
  const usedLanes = comp.clips.length ? Math.max(...comp.clips.map(c => c.lane)) + 1 : 0;

  /*
   * 화면에 보이는 시간·재생 상태는 클립이 있으면 트랙 재생을 따른다.
   * 클립이 문서이므로 그쪽이 진실이고, 합쳐진 파일은 확인용이다.
   */
  const composing = comp.clips.length > 0;
  const playbackTime = composing ? playback.currentTime : audio.currentTime;
  const playbackDuration = composing ? playback.duration : audio.duration;
  const isPlayingNow = composing ? playback.isPlaying : audio.isPlaying;

  /**
   * 컨트롤 묶음. 한 줄에 열 개 넘게 흘려 두면 무엇이 무엇과 한 벌인지 안 보인다.
   * `accent` 는 패널 색을 따라간다 — Loop Lab 은 emerald, 병합 작업대는 sky.
   */
  const group = (label: string, accent: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <span className={`text-[9px] font-black uppercase tracking-widest px-1 ${accent}`}>{label}</span>
      <div className="flex flex-wrap items-end gap-2 bg-slate-950/40 border border-slate-800/80 rounded-2xl px-3 py-2.5 h-full">
        {children}
      </div>
    </div>
  );

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
        {/* 단위는 **대문자로 바꾸지 않는다** — `ms` 가 `MS` 로, `dBFS` 가 `DBFS` 로 찍힌다. */}
        {opts.suffix && <span className="text-[9px] font-bold text-slate-600">{opts.suffix}</span>}
      </div>
    </label>
  );

  return (
    <div 
      /* 도크가 화면 아래에 붙어 있으므로 그만큼 아래를 비워 둬야 마지막 줄이 안 가린다. */
      /*
        도크가 화면 아래에 붙어 있으므로 그 **실제 높이**만큼 아래를 비운다.
        예전에는 `pb-32`(128 px)로 고정해 뒀는데, 좁은 화면에서 도크가 세 줄로
        접혀 135 px 이 되면 그만큼이 모자라 아래 내용이 가려졌다.
      */
      style={composing ? { paddingBottom: dockHeight + 24 } : undefined}
      className={`min-h-screen flex flex-col p-6 transition-all duration-500 ${isDragging ? 'bg-indigo-950/40 ring-4 ring-indigo-500 ring-inset' : 'bg-[#0b0f19]'}`}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
    >
      <header className="flex justify-between items-center mb-6 bg-slate-900/40 p-3 rounded-2xl border border-slate-800/60 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 p-2.5 rounded-xl shadow-[0_0_20px_rgba(99,102,241,0.3)]">
            <AudioWaveform className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tighter text-white uppercase italic">Pulse<span className="text-indigo-400">Lab</span></h1>
            {/*
              "Spectral Audio Engine" 이었다. 스펙트럴 처리는 가짜였고 지웠는데
              이름만 남아 있었다 — 화면이 없는 기능을 광고하면 안 된다.
              대신 지키기로 한 규격을 적는다. 늘 맞는 말이다.
            */}
            <p className="text-[10px] text-slate-500 tracking-widest font-bold">48 kHz · 16-bit · 멀티트랙</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {audio.currentUrl && (
            <>
              <div className="flex bg-slate-800 rounded-xl p-1 border border-slate-700 mr-2">
                <button 
                  onClick={handleUndo}
                  disabled={(comp.undo.length === 0 && audio.undoStack.length === 0) || audio.isProcessing}
                  className="p-2 text-slate-400 hover:text-indigo-400 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  title="Undo (Ctrl+Z)"
                >
                  <Undo2 className="w-5 h-5" />
                </button>
                <button 
                  onClick={handleRedo}
                  disabled={(comp.redo.length === 0 && audio.redoStack.length === 0) || audio.isProcessing}
                  className="p-2 text-slate-400 hover:text-indigo-400 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  title="Redo (Ctrl+Y)"
                >
                  <Redo2 className="w-5 h-5" />
                </button>
              </div>
              <button
                onClick={handleResetClick}
                onBlur={() => setResetArmed(false)}
                disabled={nothingToReset}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all border text-xs font-bold uppercase tracking-wider disabled:opacity-30 ${
                  resetArmed
                    ? 'bg-rose-600 text-white border-rose-400 shadow-lg shadow-rose-600/25'
                    : 'bg-slate-800 hover:bg-rose-900/30 text-slate-400 hover:text-rose-400 border-slate-700 hover:border-rose-700/50'
                }`}
                title={
                  nothingToReset
                    ? '지울 것이 없습니다'
                    : resetArmed
                      ? '한 번 더 누르면 트랙과 되돌리기 기록이 모두 지워집니다'
                      : '트랙과 편집을 모두 버리고 빈 상태로 돌아갑니다 — 두 번 눌러야 지워집니다'
                }
              >
                <RotateCcw className="w-4 h-4" />
                {resetArmed ? '한 번 더 누르면 지웁니다' : '초기화'}
              </button>
              <button 
                onClick={handleDownloadAction}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-indigo-600/20 border border-indigo-400/30 text-xs font-bold uppercase tracking-wider"
              >
                <Download className="w-4 h-4" />
                내보내기
              </button>
            </>
          )}
          {/* 트랙 추가 — 여는 게 아니라 더한다. 여러 개를 한 번에 고르면 각자 새 트랙이 된다. */}
          <label className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl cursor-pointer transition-all border border-emerald-400/30 shadow-lg shadow-emerald-600/20 text-xs font-bold uppercase tracking-wider">
            <Layers className="w-4 h-4" />
            트랙 추가
            <input
              type="file"
              className="hidden"
              multiple
              accept="audio/*,video/*"
              onChange={(e) => { void handleAddTrack(e.target.files); e.target.value = ''; }}
            />
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

            {/* 클립 여러 개로 처음부터 시작하는 길. Veo 8초 클립 3~4개를 한 번에 고른다. */}
            <div className="mt-8 pt-8 border-t border-slate-800">
              <label className="inline-flex items-center gap-2 px-6 py-3 bg-sky-600 hover:bg-sky-500 text-white rounded-2xl border border-sky-400 text-xs font-black uppercase tracking-widest transition-all cursor-pointer">
                <input
                  type="file"
                  className="hidden"
                  multiple
                  accept="audio/*,video/*"
                  onChange={(e) => { void handleComposerImport(e.target.files, true); e.target.value = ''; }}
                />
                <Layers className="w-4 h-4" /> 여러 클립을 이어 붙여 시작
              </label>
              <p className="text-slate-600 text-xs mt-3">
                고른 순서대로 이어 붙고 이음매는 {comp.crossfadeMs} ms 등출력으로 겹칩니다.
              </p>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-7xl space-y-6 animate-in fade-in zoom-in duration-500">
            {/* Waveform Visualization Block */}
            <div className="bg-[#111827] border border-slate-800/80 rounded-[28px] p-6 shadow-2xl relative overflow-hidden ring-1 ring-white/5">
              {audio.isProcessing && (
                <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-md flex flex-col items-center justify-center">
                  <div className="relative">
                    <Loader2 className="w-16 h-16 text-indigo-500 animate-spin" />
                    <div className="absolute inset-0 blur-xl bg-indigo-500/20"></div>
                  </div>
                  <p className="text-white font-black uppercase tracking-[0.3em] mt-8 text-sm">{audio.processingMsg}</p>
                </div>
              )}

              {/*
                한 줄짜리 정보 띠. 예전에는 칩마다 상자를 두르고 두 줄로 쌓여
                파형보다 자리를 많이 먹었다. 값은 그대로 두고 테두리를 걷어
                **얇은 한 줄**로 만들었다 — 이름은 왼쪽에서 늘어나고, 규격·시간은
                오른쪽에 붙는다.
              */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3 mb-6 pb-4 border-b border-slate-800/70">
                {/* 내보낼 이름 — Veo·Suno 이름은 저장소 관례와 안 맞아 여기서 고친다 */}
                <label className="flex items-baseline gap-2 min-w-[240px] flex-1">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest shrink-0">이름</span>
                  <input
                    value={exportName}
                    onChange={(e) => setExportName(e.target.value)}
                    placeholder={suggestAssetName(audio.file?.name ?? 'untitled.wav')}
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-transparent text-white text-base font-bold focus:outline-none border-b border-slate-800 focus:border-indigo-500 transition-colors"
                    title={`원본: ${audio.file?.name ?? '—'}`}
                  />
                  <span className="text-slate-600 text-sm font-bold shrink-0">.wav</span>
                </label>

                {/*
                  채널 수는 클립에서 읽는다. 합쳐진 옛 트랙을 보면 모노 트랙에
                  스테레오를 얹은 뒤에도 계속 "Mono" 라고 우긴다 — 효과음·말 상태음이
                  모노여야 하는 규격에서 제일 위험한 거짓말이다.
                */}
                <span className="text-xs font-bold text-slate-400 whitespace-nowrap tabular-nums">
                  {composing
                    ? (compChannels === 1 ? '모노 1ch' : `스테레오 ${compChannels}ch`)
                    : (audio.isMono ? '모노 1ch' : '스테레오 2ch')
                  } · {(PROJECT_SAMPLE_RATE / 1000).toFixed(0)} kHz
                </span>

                {audio.sourceKind === 'video' && (
                  <span className="flex items-center gap-1 text-xs font-bold text-emerald-400 whitespace-nowrap">
                    <Film className="w-3 h-3" /> 영상에서 추출
                  </span>
                )}

                {/* 규격 판정 — 값이 없으면 내보내 재 보기 전까지 맞는지 알 수가 없다 */}
                {currentPeak !== null && (() => {
                  const dbfs = 20 * Math.log10(currentPeak || 1e-9);
                  const onSpec = Math.abs(dbfs - loop.targetDbfs) < 0.1;
                  const tooLoud = dbfs > loop.targetDbfs + 0.1;
                  return (
                    <span
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold tabular-nums whitespace-nowrap ${
                        onSpec ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
                      }`}
                      title={onSpec ? '규격에 맞음' : tooLoud ? `${loop.targetDbfs} dBFS 보다 큼` : `${loop.targetDbfs} dBFS 에 모자람`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${onSpec ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                      {dbfs.toFixed(2)} dBFS
                      {/*
                        전에는 옆에 `−31.5 dB` 만 찍혔다. 라벨이 없어서 그게 피크인지
                        여유인지 규격까지의 거리인지 알 수 없었다 — 값 두 개가
                        나란히 있으면 둘 다 피크처럼 읽힌다.
                      */}
                      <span className="font-normal opacity-70">
                        {onSpec
                          ? `규격 ${loop.targetDbfs} dBFS`
                          : tooLoud
                            ? `규격보다 ${(dbfs - loop.targetDbfs).toFixed(1)} dB 큼`
                            : `규격까지 ${Math.abs(dbfs - loop.targetDbfs).toFixed(1)} dB`}
                      </span>
                    </span>
                  );
                })()}

                {/* 도크가 떠 있으면 거기 시계가 늘 보이므로 여기서는 접는다 — 같은 값을 두 번 둘 이유가 없다. */}
                {!composing && (
                  <span className="ml-auto font-mono font-bold text-white tabular-nums text-xl tracking-tight whitespace-nowrap">
                    {formatTime(playbackTime)}
                    <span className="text-slate-600 text-sm"> / {formatTime(playbackDuration)}</span>
                  </span>
                )}
              </div>

              {/*
                작업 단계 띠. **화면 전체의 조직자**라 맨 위에 둔다 — 카드 안에 두면
                자기 카드밖에 못 다스리는데, 마디 격자는 파형 위에 따로 있어서
                그 카드 안의 띠로는 손이 안 닿는다.

                단계는 순서가 있다: 담고 → 놓고 → 다듬고 → 낸다.
              */}
              {composing && (
                <div className="flex items-center gap-1 rounded-2xl bg-slate-900/60 border border-slate-800 p-1.5 mb-6 w-fit">
                  {STAGES.map((st, i) => (
                    <React.Fragment key={st}>
                      {i > 0 && <span className="text-slate-700 text-xs px-0.5">›</span>}
                      <button
                        onClick={() => setStage(st)}
                        aria-pressed={stage === st}
                        className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                          stage === st
                            ? 'bg-sky-600 text-white shadow-lg shadow-sky-600/20'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                        title={{
                          담기: '파일을 가져와 트랙에 얹는다. 담자마자 할 손질도 여기서 정한다.',
                          배치: '어느 트랙 어디에 놓을지. 무음으로 길이를 늘리는 것도 배치다.',
                          다듬기: '소리 자체를 손본다 — 길이·잔 소리·마디 격자·루프.',
                          내보내기: '이음매와 규격을 정해 한 파일로 낸다.',
                        }[st]}
                      >
                        {st}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
              )}

              {/*
                마디 격자는 음악 루프를 만들 때만 쓴다 — 환경음·효과음 작업에서는
                자리만 차지하므로 접어 둘 수 있게 했고, 파형 **위**로 올려
                아래까지 스크롤하지 않아도 손이 닿게 했다.
                마디 격자와 루프 만들기는 **다듬기**, 규격 맞추기는 **내보내기** 단계의 일이다.
                담고 놓는 동안에는 자리만 차지하므로 아예 안 보인다.
              */}
              {(stage === '다듬기' || stage === '내보내기') && (
              <div className="bg-slate-900/60 border border-emerald-800/40 rounded-[28px] px-6 py-4 shadow-xl backdrop-blur-md mb-6">
                <div className={`flex items-center justify-between ${loopLabOpen ? 'mb-5' : ''}`}>
                  <button
                    onClick={() => setLoopLabOpen(v => !v)}
                    className="flex items-center gap-2 text-[10px] font-black text-emerald-400 uppercase tracking-widest hover:text-emerald-300 transition-colors"
                    title={loopLabOpen ? '마디 격자 접기' : '마디 격자 펴기'}
                  >
                    <Grid3x3 className="w-3.5 h-3.5" /> Loop Lab · 마디 격자
                    <span className="text-slate-500">{loopLabOpen ? '▾' : '▸'}</span>
                  </button>
                  <div className="text-[10px] font-mono text-slate-500">
                    1마디 = {oneBar.toFixed(4)}초 · {loop.bars}마디 = {(oneBar * loop.bars).toFixed(3)}초
                  </div>
                </div>

                {loopLabOpen && (<>
                <div className="flex flex-wrap items-stretch gap-3">
                  {stage === '다듬기' && group('격자 잡기', 'text-emerald-500/70', <>
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
                  </>)}

                  {stage === '다듬기' && group('구간 고르기', 'text-emerald-500/70', <>
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
                      disabled={!readoutRegion}
                      className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                      title="선택 양 끝을 가장 가까운 마디선으로"
                    >
                      <Magnet className="w-3 h-3" /> 마디에 맞춤
                    </button>
                  </>)}

                  {stage === '다듬기' && group('루프 만들기', 'text-emerald-500/70', <>
                    <button
                      onClick={toggleLoopPreview}
                      disabled={!readoutRegion}
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
                      onBlur={() => setLoopArmed(false)}
                      disabled={!editRegion || audio.isProcessing}
                      className={`flex items-center gap-1.5 px-4 py-2 disabled:opacity-30 text-white rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                        loopArmed
                          ? 'bg-amber-600 hover:bg-amber-500 border-amber-400'
                          : 'bg-violet-600 hover:bg-violet-500 border-violet-400'
                      }`}
                      title={
                        loopArmed
                          ? `선택이 ${loopBars?.toFixed(3)} 마디라 경계에 안 맞습니다. 이대로 자르면 루프가 돌 때 박자가 어긋납니다 — 한 번 더 누르면 그대로 자릅니다.`
                          : loopOffGrid
                            ? `선택이 ${loopBars?.toFixed(3)} 마디입니다 — 마디 경계에 안 맞습니다. 두 번 눌러야 잘립니다.`
                            : '선택을 루프로 확정하고 뒤쪽 꼬리를 앞머리에 접는다'
                      }
                    >
                      <Scissors className="w-3.5 h-3.5" />
                      {loopArmed ? '마디가 안 맞습니다 — 한 번 더' : '루프 제작'}
                    </button>
                  </>)}

                  {stage === '내보내기' && group('규격 맞추기', 'text-amber-500/70', <>
                    {numField('목표 피크', loop.targetDbfs, v => setLoop(p => ({ ...p, targetDbfs: v })), { step: 0.5, suffix: 'dBFS', width: 'w-20' })}
                    <button
                      onClick={handleNormalizeToTargetAction}
                      disabled={!audio.isReady || audio.isProcessing}
                      className="flex items-center gap-1.5 px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-30 text-amber-400 rounded-xl border border-amber-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                      title="저장소 규격은 -3 dBFS 다"
                    >
                      <Gauge className="w-3.5 h-3.5" /> 정규화
                    </button>
                  </>)}
                </div>

                {/* 선택 판독 — 격자에 맞았는지를 계속 보여 준다 */}
                <div className="mt-5 pt-4 border-t border-slate-800 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] font-mono">
                  {readoutRegion ? (
                    <>
                      <span className="text-slate-500">시작 <span className="text-white font-bold">{readoutRegion.start.toFixed(4)}s</span></span>
                      <span className="text-slate-500">끝 <span className="text-white font-bold">{readoutRegion.end.toFixed(4)}s</span></span>
                      <span className="text-slate-500">길이 <span className="text-white font-bold">{(readoutRegion.end - readoutRegion.start).toFixed(4)}s</span></span>
                      <span className={`font-bold px-2 py-0.5 rounded-lg ${selOnGrid ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                        {selBars.toFixed(3)}마디 {selOnGrid ? '· 격자에 맞음' : '· 격자에서 벗어남'}
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-600">파형을 드래그하거나 위의 “{loop.bars}마디 선택”을 누르십시오.</span>
                  )}
                </div>
                </>)}
              </div>
              )}

              {/*
                Interactive Layer — 트랙이 편집점이다.
                클립이 문서이므로 여기가 배치·선택·재생이 모두 일어나는 자리고,
                아래 wavesurfer 는 합쳐진 결과를 확인하는 보조 화면으로 내려갔다.
              */}
              <div className="relative group">
                <div className="absolute top-4 right-4 z-20 flex gap-2">
                   <div className="bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/5 text-[9px] font-bold text-slate-400 uppercase">
                     멀티트랙 · 트랙 {Math.max(usedLanes, comp.minLanes)}개
                   </div>
                </div>
                <div className="rounded-[24px] bg-[#0d1117] px-6 pt-6 pb-2 border border-slate-800/50 shadow-inner">
                  {comp.clips.length === 0 && comp.minLanes === 0 ? (
                    <div className="py-14 text-center text-slate-600 text-sm">
                      위쪽 <span className="text-emerald-400 font-bold">트랙 추가</span> 로 트랙을 얹으십시오.
                      끌어다 놓아도 됩니다.
                    </div>
                  ) : (
                    <CompositionTimeline
                      clips={comp.clips}
                      crossfadeMs={comp.crossfadeMs}
                      minLanes={comp.minLanes}
                      onChange={updateClip}
                      onBeginEdit={pushUndo}
                      onAddLane={() => setComp(p => ({ ...p, minLanes: Math.max(usedLanes, p.minLanes) + 1 }))}
                      onRemoveLane={() => setComp(p => ({ ...p, minLanes: Math.max(usedLanes, p.minLanes - 1) }))}
                      onMoveLane={(from, to) => commitClips(moveTrack(comp.clips, from, to))}
                      /* 확인은 ✕ 버튼 안에서 두 번 눌러 받는다 — 대화상자에 기대지 않는다. */
                      onRemoveTrack={(lane) => {
                        commitClips(removeTrack(comp.clips, lane));
                        setComp(p => ({ ...p, minLanes: Math.max(0, p.minLanes - 1) }));
                        setSelection(null);
                      }}
                      canRemoveLane={comp.minLanes > usedLanes}
                      currentTime={playback.currentTime}
                      onSeek={playback.seek}
                      zoom={zoomFactor}
                      onZoomChange={setZoomFactor}
                      selectedClipId={selectedClipId}
                      onSelectClip={setSelectedClipId}
                      selection={selection}
                      onSelectionChange={handleSelectionChange}
                    />
                  )}
                </div>
              </div>

              {/*
                합친 결과 — 편집면이 아니라 보조 화면이다.
                내보내기는 트랙에서 바로 굽기 때문에 이걸 만들지 않아도 되고,
                남아 있는 이유는 마디 격자(Loop Lab)가 트랙 하나를 전제로 해서다.
              */}
              {/*
                합친 결과는 마디 격자를 쓸 때만 필요하다 — 이름에도 그렇게 적혀 있다.
                마디 격자가 나오는 단계(다듬기·내보내기)에서, 그마저 펴 두었을 때만
                띄운다. 담고 놓는 동안에는 130 px 을 돌려받는다.
              */}
              {loopLabOpen && (stage === '다듬기' || stage === '내보내기') && (
              <div className="relative group mt-6">
                <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
                   <div className="bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/5 text-[9px] font-bold text-slate-500 uppercase">
                     합친 결과 · 마디 격자용
                   </div>
                </div>
                {comp.clips.length > 0 && !audio.currentUrl && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                    <span className="text-slate-600 text-xs">
                      “합친 결과 만들기”를 누르면 여기에 놓입니다 — 내보내기에는 필요 없습니다.
                    </span>
                  </div>
                )}
                <div ref={containerRef} className="waveform-container rounded-[24px] bg-[#0d1117] px-6 py-4 border border-slate-800/50 shadow-inner" />
              </div>
              )}
            </div>

            {/* 재생·볼륨·모노는 화면 아래 도크로 옮겼다 — 중간에 또 두면 같은 것이 두 군데가 된다. */}
            <div className="grid grid-cols-12 gap-6">
              {/* Malworld: 병합 작업대 — 클립을 더해 가며 한 트랙으로 굽는다 */}
              <div className="col-span-12 bg-slate-900/60 border border-sky-800/40 rounded-[24px] p-5 shadow-xl backdrop-blur-md">
                <div className={`flex items-center justify-between ${mergePanelOpen ? 'mb-5' : ''}`}>
                  <button
                    onClick={() => setMergePanelOpen(v => !v)}
                    className="flex items-center gap-2 text-[10px] font-black text-sky-400 uppercase tracking-widest hover:text-sky-300 transition-colors"
                    title={mergePanelOpen ? '병합 작업대 접기' : '병합 작업대 펴기'}
                  >
                    <Layers className="w-3.5 h-3.5" /> 편집 · 클립 {comp.clips.length}개
                    <span className="text-slate-500">{mergePanelOpen ? '▾' : '▸'}</span>
                  </button>
                  <div className="text-[10px] font-mono text-slate-500">
                    {comp.clips.length > 0
                      ? `결과 ${compResultSec.toFixed(3)}초 · ${compChannels === 1 ? '모노' : `${compChannels}채널`} · 48 kHz`
                      : '클립을 담으십시오'}
                  </div>
                </div>

                {mergePanelOpen && (<>
                <div className="flex flex-wrap items-stretch gap-3 mb-5">
                  {stage === '담기' && group('같은 트랙에 이어 붙이기', 'text-sky-500/70', <>
                    <label
                      className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl border border-sky-400 text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer"
                      title="트랙 0 뒤에 이음매를 겹쳐 이어 붙인다 (길이가 늘어난다). 위쪽 “트랙 추가”는 새 트랙에 나란히 얹는다."
                    >
                      <input
                        type="file"
                        className="hidden"
                        multiple
                        accept="audio/*,video/*"
                        onChange={(e) => { void handleComposerImport(e.target.files, false); e.target.value = ''; }}
                      />
                      뒤에 이어 담기
                    </label>
                    <button
                      onClick={handleAddCurrentAsClip}
                      disabled={!audio.isReady || audio.isProcessing}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                      title="지금 편집 중인 트랙을 한 번 더 담는다 (담긴 게 없으면 자동으로 들어간다)"
                    >
                      현재 트랙
                    </button>
                    
                  </>)}

                  {/* 빈 트랙 +/− 는 타임라인의 `새 트랙` 줄로 옮겼다 — 트랙을 보고 있는
                      자리에 두는 편이 낫고, 같은 버튼이 두 군데 있으면 어느 쪽이 진짜인지 헷갈린다. */}
                  {stage === '배치' && group('길이 늘리기', 'text-sky-500/70', <>
                    {numField('무음', comp.silenceSec, v => setComp(p => ({ ...p, silenceSec: Math.max(0.001, v) })), { step: 0.5, suffix: 's', width: 'w-20' })}
                    <button
                      onClick={handleAddSilence}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                      title="트랙 0 뒤에 무음을 붙여 결과 길이를 늘린다 (모노라 채널 수는 안 바뀐다)"
                    >
                      뒤에 무음
                    </button>
                    
                  </>)}

                  {/* 자르기·끼워넣기와 굽기 버튼은 화면 아래 도크에 있다 — 같은 것을 두 군데 두지 않는다. */}
                  {stage === '내보내기' && group('이음매 · 굽기 (내보내기에도 적용)', 'text-sky-500/70', <>
                    {numField('크로스페이드', comp.crossfadeMs, v => setComp(p => ({ ...p, crossfadeMs: Math.max(0, v) })), { suffix: 'ms', width: 'w-24' })}
                    {numField('끝→시작 말기', comp.wrapMs, v => setComp(p => ({ ...p, wrapMs: Math.max(0, v) })), { suffix: 'ms', width: 'w-24' })}
                    <Switch
                      checked={comp.normalizeAfter}
                      onChange={(v) => setComp(p => ({ ...p, normalizeAfter: v }))}
                      label={`${loop.targetDbfs} dBFS 로 맞춤`}
                      accent="#fbbf24"
                      title={`피크를 ${loop.targetDbfs} dBFS 로 맞춘다. 내보낼 때도 똑같이 걸린다.`}
                    />
                  </>)}

                  {/*
                    이 묶음은 "굽기"다. 내보내기도 같은 설정을 거치므로 여기 값이
                    곧 내보낼 파일의 값이다 — 그래서 이름에 그렇게 적어 뒀다.
                  */}

                  {/*
                    담을 때 자동으로 하는 일. Veo 가 주는 것이 늘 같은 모양으로
                    어긋나 있어서(조용하고, 스테레오 그릇에 모노가 담겨 온다)
                    담을 때마다 손으로 두 번 누르게 된다.
                  */}
                  {stage === '담기' && group('담을 때', 'text-sky-400/70', <>
                    <Switch
                      checked={autoNormalize}
                      onChange={setAutoNormalize}
                      label={`${loop.targetDbfs} dBFS 로 맞추기`}
                      accent="#38bdf8"
                      title={`담자마자 피크를 ${loop.targetDbfs} dBFS 로 맞춘다. Veo 클립은 -20 dBFS 언저리로 오는 일이 흔하다 — 실측한 낟알 붓는 소리는 -25.12 dBFS 였다.`}
                    />
                    <Switch
                      checked={autoMono}
                      onChange={setAutoMono}
                      label="좌우 같으면 모노로"
                      accent="#38bdf8"
                      title={
                        '좌우가 사실상 같은 스테레오만 1채널로 내린다 (차이 ' + MONO_IDENTICAL_THRESHOLD + ' 미만).\n' +
                        '파형이 그대로라 잃는 것이 없고 파일이 절반이 된다.\n' +
                        '진짜 스테레오는 이 값의 백 배쯤 나오므로 음악·환경음은 안 건드린다 — 규격이 스테레오다.'
                      }
                    />
                  </>)}

                  {/*
                    길이 바꾸기. 자르지 않고 길이를 맞추는 유일한 길이다 —
                    잘라서 맞추면 잔향이 끊긴다. 마디 스냅이 붙어 있는 이유가 그것이다:
                    7.70초짜리를 8.00초(120 BPM 4마디)로 늘려 격자에 맞추면
                    내용을 하나도 안 버리고 루프가 박자에 맞는다.
                  */}
                  {stage === '다듬기' && group('길이 바꾸기', 'text-emerald-500/70', <>
                    {numField('목표 길이', targetLenSec, v => setTargetLenSec(Math.max(0, v)), { step: 0.1, suffix: 's', width: 'w-24' })}
                    <button
                      onClick={snapLenToBar}
                      disabled={!editTargetClip}
                      className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                      title={`목표 길이를 마디 수에 딱 붙인다 (${loop.bpm} BPM · 한 마디 ${barSeconds(loop.bpm, loop.beatsPerBar).toFixed(4)}초)`}
                    >
                      <Grid3x3 className="w-3.5 h-3.5" /> 마디 스냅
                    </button>
                    <Switch
                      checked={keepPitch}
                      onChange={setKeepPitch}
                      label="음정 유지"
                      accent="#34d399"
                      title="켜면 음정을 지키며 길이만 바꾼다(조각을 겹쳐 붙인다). 끄면 테이프를 빨리 돌리듯 음정도 함께 바뀐다 — 정확하고 빠르다."
                    />
                    {/*
                      조각 길이는 **음정 유지일 때만** 뜻이 있다. 속도 바꾸기는
                      겹쳐 붙이지 않으므로 이 값을 안 쓴다 — 안 쓰는 칸을 띄워 두면
                      켜고 끌 때마다 무엇이 살아 있는지 헷갈린다.
                    */}
                    {keepPitch && (
                      <div className="flex items-end">
                        <Knob
                          label="조각"
                          value={stretchFrameMs}
                          min={TIME_STRETCH_FRAME_MS_MIN}
                          max={TIME_STRETCH_FRAME_MS_MAX}
                          step={1}
                          resetTo={TIME_STRETCH_FRAME_MS_DEFAULT}
                          onChange={setStretchFrameMs}
                          size={38}
                          accent="#34d399"
                          format={(v) => `${v} ms · ≥${Math.round(1000 / v)} Hz`}
                          title={
                            '겹쳐 붙일 조각의 길이. 자료가 정한다.\n' +
                            '• 조각이 한 주기보다 짧으면 그 저역이 통째로 사라진다 — 5 ms 는 50 Hz 를 40 dB 죽인다.\n' +
                            '• 길수록 거칠어진다 (실측 ×1.3: 20 ms 0.34% · 43 ms 3.14% · 200 ms 8.97%).\n' +
                            '• 긴 조각은 타격음도 번진다.\n' +
                            '기본 20 ms 는 50 Hz 까지 담는다. 더 깊은 럼블이면 40~60 ms 로 올린다.'
                          }
                        />
                      </div>
                    )}
                    <button
                      onClick={handleLengthAction}
                      disabled={!editTargetClip || audio.isProcessing || !lenRatioOk || (lenRatio !== null && Math.abs(lenRatio - 1) < 1e-4)}
                      className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-30 text-white rounded-xl border border-emerald-400/50 text-[10px] font-black uppercase tracking-widest transition-all"
                      title={
                        !editTargetClip
                          ? '먼저 트랙에서 클립을 고르십시오'
                          : keepPitch
                            ? '음정은 그대로 두고 길이만 바꾼다'
                            : '속도를 바꿔 길이를 맞춘다 — 음정도 함께 바뀐다'
                      }
                    >
                      <Ruler className="w-3.5 h-3.5" /> 길이 바꾸기
                    </button>
                    {/* 무슨 일이 일어날지 누르기 전에 보여 준다 — 배율과 마디 수가 판단의 전부다. */}
                    {editClipDur !== null && lenRatio !== null && (
                      <span className={`text-[10px] font-mono tabular-nums whitespace-nowrap self-center ${
                        !lenRatioOk ? 'text-rose-400' : Math.abs(lenRatio - 1) < 1e-4 ? 'text-slate-500' : 'text-emerald-300'
                      }`}>
                        {editClipDur.toFixed(3)}s → {targetLenSec.toFixed(3)}s
                        {' · '}×{lenRatio.toFixed(3)}
                        {lenBars !== null && ` · ${lenBars.toFixed(2)}마디`}
                        {!lenRatioOk && ` · ${LEN_RATIO_MIN}~${LEN_RATIO_MAX}배 밖`}
                      </span>
                    )}
                  </>)}

                  {/*
                    게이트는 폭을 다 차지하는 알약 버튼으로 패널 **밖에** 떠 있었다.
                    카드 바깥에 홀로 놓이니 어디에 걸리는 것인지 알 수 없었고,
                    혼자 화면 폭을 다 먹어 제일 중요한 것처럼 보였다. 다른 묶음과
                    같은 모양으로 줄여 패널 안에 넣는다.

                    어택·릴리스가 없어 문턱 아래를 표본마다 0 으로 떨군다.
                    디지털 무음을 자르는 데만 쓰고, 게이트로 쓰면 지퍼 노이즈가 난다.
                  */}
                  {stage === '다듬기' && group('잔 소리 다듬기', 'text-slate-500', <>
                    <Knob
                      label="문턱값"
                      value={audio.gateThreshold} min={0.001} max={0.1} step={0.001} resetTo={0.005}
                      onChange={(v) => setAudio(prev => ({ ...prev, gateThreshold: v }))}
                      size={38}
                      accent="#818cf8"
                      format={(v) => `${(v * 100).toFixed(1)}%`}
                      title="이 크기 아래의 표본을 0 으로 떨군다 — 디지털 무음을 자르는 용도다. 위아래로 끌거나 휠, 화살표 키."
                    />
                    <button
                      onClick={handleDenoiseAction}
                      disabled={audio.isProcessing}
                      className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-xl border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                      title="문턱 아래를 0 으로 떨군다. 잔향이 있는 자료에는 쓰지 마십시오 — 꼬리가 뚝 끊긴다."
                    >
                      <Wind className="w-3.5 h-3.5" /> 무음 다듬기
                    </button>
                  </>)}

                </div>

                {/* 트랙별 파형은 위 Interactive Layer 로 올라갔다. 여기는 정확한 값과 합치기 설정 몫이다. */}

                {/*
                  클립 목록 — 정확한 값은 여기서 넣는다. **배치 단계의 몫**이다.
                  늘 펴 두었더니 클립이 늘어날수록 다른 단계에서도 화면을 밀어냈다.
                */}
                {stage === '배치' && comp.clips.length > 0 && (
                  <div className="border-t border-slate-800 pt-4 mt-4 flex flex-col gap-2">
                    {comp.clips.map((c) => (
                      <div key={c.id} className="flex flex-wrap items-center gap-3 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2">
                        <span className="text-[11px] font-bold text-white truncate max-w-[220px]" title={c.name}>{c.name}</span>
                        <span className="text-[10px] font-mono text-slate-500">
                          {c.buffer.duration.toFixed(3)}초 · {c.buffer.numberOfChannels === 1 ? '모노' : '스테레오'}
                        </span>

                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">트랙</span>
                          <input
                            type="number" min={0} value={c.lane}
                            onChange={(e) => updateClipField(c.id, { lane: Math.max(0, parseInt(e.target.value) || 0) })}
                            className="w-14 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs font-bold text-white focus:border-sky-500 focus:outline-none"
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">시작</span>
                          <input
                            type="number" step={0.001} min={0} value={c.startSec}
                            onChange={(e) => updateClipField(c.id, { startSec: Math.max(0, parseFloat(e.target.value) || 0) })}
                            className="w-24 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs font-bold text-white focus:border-sky-500 focus:outline-none"
                          />
                          <span className="text-[9px] text-slate-600">s</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">게인</span>
                          <input
                            type="number" step={0.05} min={0} value={c.gain}
                            onChange={(e) => updateClipField(c.id, { gain: Math.max(0, parseFloat(e.target.value) || 0) })}
                            className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs font-bold text-white focus:border-sky-500 focus:outline-none"
                          />
                        </div>
                        <span className="text-[10px] font-mono text-slate-600">
                          {c.startSec.toFixed(3)} → {clipEndSec(c).toFixed(3)}초
                        </span>

                        <div className="ml-auto flex items-center gap-2">
                          <button
                            onClick={() => copyClip(c.id)}
                            className={`px-2 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest transition-all ${
                              comp.clipboard?.id === c.id
                                ? 'bg-violet-500 text-white border-violet-300'
                                : 'bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 border-violet-500/30'
                            }`}
                            title="이 클립을 복사해 둔다 (⌘/Ctrl+C)"
                          >
                            <Copy className="w-3 h-3 inline mr-1" />
                            {comp.clipboard?.id === c.id ? '담김' : '클립 복사'}
                          </button>
                          <button
                            onClick={() => stackClip(c.id)}
                            className="px-2 py-1 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 rounded-lg border border-sky-500/30 text-[9px] font-black uppercase tracking-widest transition-all"
                            title="새 트랙 0초로 옮겨 겹치게 한다"
                          >
                            겹치기
                          </button>
                          <button
                            onClick={() => removeClip(c.id)}
                            className="p-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-lg border border-rose-500/30 transition-all"
                            title="클립 빼기"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 판독 — 합산이 넘쳤는지 여기서 본다 */}
                <div className="mt-5 pt-4 border-t border-slate-800 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] font-mono">
                  {comp.clips.length === 0 ? (
                    <span className="text-slate-600">
                      담으면 같은 트랙 뒤에 이어 붙습니다 (길이가 늘어남). “겹치기”를 누르면 새 트랙에서 병렬로 울립니다.
                    </span>
                  ) : (
                    <>
                      <span className="text-slate-500">결과 길이 <span className="text-white font-bold">{compResultSec.toFixed(4)}s</span></span>
                      <span className="text-slate-500">트랙 <span className="text-white font-bold">{compLanes}</span></span>
                      {comp.lastPeak !== null && (
                        <span className={`font-bold px-2 py-0.5 rounded-lg ${
                          comp.lastPeak > 1 ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'
                        }`}>
                          합산 피크 {(20 * Math.log10(comp.lastPeak || 1e-9)).toFixed(2)} dBFS
                          {comp.lastPeak > 1
                            ? (comp.normalizeAfter ? ' · 넘쳤지만 정규화로 되돌림' : ' · 넘쳐서 0 dBFS 로 눌러 담음')
                            : ' · 여유 있음'}
                        </span>
                      )}
                      {comp.wrapMs > 0 && (
                        <span className="text-sky-400">끝 {comp.wrapMs} ms 를 앞에 접어 길이가 그만큼 줄어듭니다</span>
                      )}
                    </>
                  )}
                </div>
                </>)}
              </div>


            </div>
          </div>
        )}
      </main>

      {/*
        푸터에 `ENGINE STABLE` · `HARDWARE ACCELERATED PROCESSING NODE` ·
        `n초 CACHE` 가 있었다. 지웠다 — 셋 다 아무 상태도 안 나타내는 장식인데
        도크 바로 위에서 두 줄을 먹었고, 마지막 것은 캐시가 아니라 그냥 길이였다.
      */}

      {/*
        트랙 편집 도크.
        편집 컨트롤이 페이지 맨 아래에 있어서, 파형을 보면서 한 번 자르려면
        **끝까지 스크롤해 내려갔다 다시 올라와야 했다.** 자주 누르는 것만 골라
        화면 아래에 붙여 두고, 나머지 설정(이음매·클립 목록)은 아래 패널에 남겼다.
      */}
      {composing && (
        <div ref={dockRef} className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900/92 backdrop-blur-xl border-t border-slate-700/70 shadow-[0_-8px_30px_rgba(0,0,0,0.5)]">
          <div className="max-w-7xl mx-auto px-3 py-1.5 flex items-center gap-2">
            {/*
              도크를 두 칸으로 나눈다. 왼쪽은 편집 묶음이 폭에 맞춰 접히는 자리,
              오른쪽은 마무리(모노·합치기)를 못 박은 자리다.
              전에는 마무리에 `ml-auto` 만 걸어 뒀는데, 폭이 19 px 모자라면
              **둘만 다음 줄 오른쪽 끝으로 떨어져** 텅 빈 줄에 떠 있었다.
              이제 마무리는 늘 오른쪽 같은 자리에 있고 왼쪽만 접힌다.
            */}
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">

            {/*
              묶음마다 옅은 상자에 담는다. 단추 열일곱 개를 한 줄에 흘려 두면
              무엇이 무엇과 한 벌인지 안 보인다 — 패널에서 쓴 것과 같은 방식이되,
              도크는 높이가 아까우니 이름표 없이 상자만으로 가른다.
            */}

            {/* 듣기 */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-950/50 border border-slate-800 px-1.5 py-1">
              <button
                onClick={seekToStart}
                title="처음으로"
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={togglePlay}
                disabled={audio.isProcessing}
                title="재생 / 멈춤"
                className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white shadow-lg shadow-indigo-600/30 transition-all"
              >
                {isPlayingNow ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 ml-0.5 fill-current" />}
              </button>
              <span className="font-mono font-bold text-white tabular-nums text-xs shrink-0 w-[84px] leading-tight">
                {formatTime(playbackTime)}
                <span className="text-slate-600 block">{formatTime(playbackDuration)}</span>
              </span>
              <button
                onClick={toggleLoopPreview}
                disabled={!selection || selection.end <= selection.start}
                className={`h-8 px-2 shrink-0 flex items-center gap-1 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-30 ${
                  loop.previewLooping
                    ? 'bg-emerald-500 text-white border-emerald-300 shadow-lg shadow-emerald-500/30'
                    : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                }`}
                title={selection ? '고른 구간을 되풀이해 이음매를 듣는다' : '먼저 트랙에서 구간을 고르십시오'}
              >
                <Repeat className="w-3.5 h-3.5" /> {loop.previewLooping ? '반복 중' : '반복'}
              </button>
              <Knob
                ariaLabel="듣기 볼륨"
                value={audio.volume} min={0} max={1} step={0.01} resetTo={1}
                onChange={(v) => {
                  setAudio(prev => ({ ...prev, volume: v }));
                  wavesurferRef.current?.setVolume(v);
                }}
                size={26}
                accent="#818cf8"
                title="듣기 볼륨 — 내보내는 파일과는 무관하다. 두 번 누르면 최대로."
              />
            </div>

            {/* 자르고 붙이기 */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-950/50 border border-slate-800 px-1.5 py-1">
              <button
                onClick={handleSplitAtPlayhead}
                className="h-8 px-2 flex items-center gap-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 rounded-lg border border-rose-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                title="재생 헤드 자리에서 클립을 둘로 쪼갠다"
              >
                <SeparatorVertical className="w-3.5 h-3.5" /> 쪼개기
              </button>
              <button
                onClick={handleCopyRange}
                disabled={!clipRegion}
                className="h-8 px-2 flex items-center gap-1 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-30 text-violet-300 rounded-lg border border-violet-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                title="고른 구간을 조각으로 뜬다 (⌘/Ctrl+C)"
              >
                <Copy className="w-3.5 h-3.5" /> 복사
              </button>
              <button
                onClick={handleCutRange}
                disabled={!clipRegion && !selectedClipId}
                className="h-8 px-2 flex items-center gap-1 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-30 text-violet-300 rounded-lg border border-violet-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                title="담고 나서 그 자리를 지운다 — 구간을 골랐으면 구간만, 아니면 클립 통째 (⌘/Ctrl+X)"
              >
                <Scissors className="w-3.5 h-3.5" /> 잘라내기
              </button>
              <button
                onClick={handlePasteAtPlayhead}
                disabled={!comp.clipboard}
                className="h-8 px-2 flex items-center gap-1 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-30 text-violet-300 rounded-lg border border-violet-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                title={comp.clipboard ? `“${comp.clipboard.name}” 을 헤드 자리에 붙여넣는다 (⌘/Ctrl+V)` : '먼저 구간이나 클립을 복사하십시오 (⌘/Ctrl+C)'}
              >
                <ClipboardPaste className="w-3.5 h-3.5" /> 붙여넣기
              </button>
            </div>

            {/* 자리 · 소리 다듬기 */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-950/50 border border-slate-800 px-1.5 py-1">
              <button
                onClick={handleRippleInsert}
                className="h-8 px-2 flex items-center bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                title={`재생 헤드 자리에 ${comp.silenceSec}초 만큼 빈 자리를 만든다 — 그 트랙에서 헤드 뒤의 클립이 통째로 밀린다. 길이는 병합 작업대의 “무음” 칸에서 바꾼다.`}
              >
                자리 {comp.silenceSec}초 벌리기
              </button>
              <button
                onClick={handleRippleDelete}
                disabled={!selectedClipId}
                className="h-8 px-2 flex items-center bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-30 text-rose-300 rounded-lg border border-rose-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                title="고른 클립을 트랙에서 빼고, 그 트랙의 뒤엣것을 당겨 빈 자리를 없앤다 — “자리 벌리기”의 반대다"
              >
                빼고 당기기
              </button>
            </div>

            {/*
              소리를 다듬는 것은 자리를 옮기는 것과 다른 일이라 묶음을 갈랐다.
              한 묶음이던 때는 도크가 접힐 때 **묶음 한가운데가 잘려서** 음량
              슬라이더만 윗줄에 남고 버튼이 아랫줄로 내려갔다. 이제는 접히더라도
              뜻이 같은 것끼리 함께 내려간다.
            */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-950/50 border border-slate-800 px-1.5 py-1">
              <button
                onClick={handleReverseAction}
                disabled={!selectedClipId && !clipRegion}
                className="h-8 px-2 flex items-center gap-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-lg border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                title="앞뒤로 뒤집는다 — 구간을 골랐으면 그 구간만, 아니면 클립 통째로"
              >
                <FlipHorizontal className="w-3.5 h-3.5" /> 뒤집기
              </button>
              <div className="flex items-center gap-1.5">
                <Knob
                  ariaLabel="음량"
                  value={gainPct} min={0} max={GAIN_MAX_PCT} step={1} resetTo={100}
                  onChange={setGainPct}
                  size={30}
                  accent={gainPct > 100 ? '#fbbf24' : gainPct < 100 ? '#38bdf8' : '#64748b'}
                  format={(v) => `${v}%`}
                  title="음량. 100% 가 원래 크기다 — 한 번에 200%(두 배, +6.02 dB)까지 걸린다. 위아래로 끌거나 휠, 화살표 키. 두 번 누르면 100% 로."
                />
                <input
                  type="number" step={0.5} value={gainDb}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setGainDb(v); }}
                  className="w-14 h-8 bg-slate-950 border border-slate-700 rounded-lg px-2 text-xs font-bold text-white tabular-nums focus:border-indigo-500 focus:outline-none"
                  title="음수면 줄이고 양수면 키운다 — 슬라이더와 같은 값이다"
                />
                <button
                  onClick={handleGainDbAction}
                  disabled={(!selectedClipId && !clipRegion) || gainDb === 0}
                  className="h-8 px-2 flex items-center bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-lg border border-slate-700 text-[11px] font-black tracking-wide transition-all"
                  title="고른 구간(없으면 클립 통째)의 음량을 이만큼 올리거나 내린다. 0 dB(100%)면 바뀔 것이 없어 눌리지 않는다."
                >
                  dB 걸기
                </button>
                {gainNotice && (
                  <span
                    className="text-[10px] font-mono text-amber-400 whitespace-nowrap"
                    title="넘치지 않게 배수를 깎았다 — 파형을 자른 것이 아니다"
                  >
                    {gainNotice}
                  </span>
                )}
              </div>
            </div>

            {/*
              구간을 골랐을 때만 나오는 묶음. 없을 때 자리를 차지할 이유가 없고,
              고른 값이 바로 옆에 붙어 있어야 무엇에 거는지가 분명하다.
            */}
            {editRegion && (
              <div className="flex items-center gap-1 rounded-lg bg-amber-500/10 border border-amber-500/30 px-1.5 py-1">
                {selection && (
                  <span className="text-[10px] font-mono text-amber-200/80 tabular-nums whitespace-nowrap shrink-0 px-1">
                    T{selection.lane} {selection.start.toFixed(2)}–{selection.end.toFixed(2)}s
                  </span>
                )}
                <button
                  onClick={() => handleFadeAction('in')}
                  className="h-8 px-2 flex items-center bg-slate-800/80 hover:bg-indigo-600 text-slate-300 hover:text-white rounded-lg border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                  title="구간을 페이드 인"
                >
                  페이드 인
                </button>
                <button
                  onClick={() => handleFadeAction('out')}
                  className="h-8 px-2 flex items-center bg-slate-800/80 hover:bg-indigo-600 text-slate-300 hover:text-white rounded-lg border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                  title="구간을 페이드 아웃"
                >
                  페이드 아웃
                </button>
                <button
                  onClick={handleCropAction}
                  className="h-8 px-2 flex items-center bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 rounded-lg border border-violet-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                  title="구간만 남긴다"
                >
                  구간만 남기기
                </button>
                <button
                  onClick={handleCutAction}
                  className="h-8 px-2 flex items-center bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 rounded-lg border border-rose-500/30 text-[10px] font-black uppercase tracking-widest transition-all"
                  title="구간을 지운다"
                >
                  구간 지우기
                </button>
              </div>
            )}

            </div>

            {/* 마무리 — 오른쪽에 못 박아 편집과 갈라 놓는다 */}
            <div className="shrink-0 flex items-center gap-1 rounded-lg bg-slate-950/50 border border-slate-800 px-1.5 py-1">
              <button
                onClick={handleToggleMono}
                disabled={audio.isProcessing || !editTargetClip || editTargetClip.buffer.numberOfChannels === 1}
                className="h-8 px-2 flex items-center gap-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-lg border border-slate-700 text-[10px] font-black uppercase tracking-widest transition-all"
                title={editTargetClip && editTargetClip.buffer.numberOfChannels === 1 ? '이 클립은 이미 모노다' : '고른 클립을 2채널에서 1채널로 내린다 (효과음·말 상태음 규격)'}
              >
                <Merge className="w-3.5 h-3.5" /> 모노
              </button>
              <button
                onClick={() => void bakeComposition()}
                disabled={comp.clips.length === 0 || audio.isProcessing}
                className="h-8 px-2 flex items-center gap-1 bg-violet-600 hover:bg-violet-500 disabled:opacity-30 text-white rounded-lg border border-violet-400 text-[10px] font-black uppercase tracking-widest transition-all"
                title="트랙을 한 트랙으로 구워 아래 “합친 결과”에 놓는다. 마디 격자(Loop Lab)를 쓸 때 필요하고, 내보내기에는 필요 없다 — 내보내기는 트랙에서 바로 굽는다."
              >
                <Combine className="w-3.5 h-3.5" /> 합치기
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        알림 줄. 도크 위에 뜨고, 도크가 없는 빈 상태(첫 임포트가 실패하는 자리)에서는
        화면 맨 아래에 붙는다. `alert()` 처럼 초점을 빼앗지 않으므로 편집 흐름이 안 끊긴다.
        누르면 바로 닫힌다 — 읽고 나서 사라질 때까지 기다릴 이유가 없다.
      */}
      {notice && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-50 max-w-[min(92vw,44rem)] px-4"
          style={{ bottom: dockHeight + 14 }}
        >
          <button
            onClick={() => setNotice(null)}
            className={`w-full text-left flex items-start gap-2.5 px-4 py-2.5 rounded-xl border backdrop-blur-xl shadow-2xl text-xs font-bold leading-relaxed transition-all ${
              notice.kind === 'error'
                ? 'bg-rose-950/90 border-rose-500/50 text-rose-200'
                : 'bg-slate-800/95 border-slate-600 text-slate-200'
            }`}
            title="눌러서 닫기"
          >
            {notice.kind === 'error'
              ? <AlertTriangle className="w-4 h-4 shrink-0 mt-px text-rose-400" />
              : <Info className="w-4 h-4 shrink-0 mt-px text-indigo-400" />}
            <span className="min-w-0">{notice.text}</span>
          </button>
        </div>
      )}

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

// HMR 로 이 모듈이 다시 실행돼도 같은 컨테이너에 루트를 두 번 만들지 않는다.
// (index.html 이 index.tsx 를 두 번 걸고 있던 것도 2026-08-11 에 함께 고쳤다.)
const w = window as unknown as { __pulselabRoot?: ReturnType<typeof createRoot> };
w.__pulselabRoot ??= createRoot(document.getElementById('root')!);
w.__pulselabRoot.render(<App />);

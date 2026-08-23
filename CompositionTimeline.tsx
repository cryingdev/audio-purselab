/**
 * 병합 작업대의 트랙별 파형. 클립을 파형 블록으로 그리고 마우스로 옮긴다.
 *
 * 마우스와 숫자 입력이 같은 값을 만진다 — 마우스는 대충 맞추는 데 빠르고,
 * 숫자는 7.25 초 같은 값을 정확히 넣는 데 필요하다. 어느 쪽으로 바꾸든
 * `clips` 하나가 진실이라 둘이 어긋나지 않는다.
 *
 * 버튼마다 하는 일이 다르다:
 *   왼쪽 끌기   — 클립 옮기기 (가로 = 시작 오프셋, 세로 = 트랙)
 *   오른쪽 끌기 — 화면 밀기 (확대해서 넘칠 때 쓴다)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CompClip, clipEndSec } from './composer';

/**
 * 트랙 한 줄 높이. 스테레오는 이 안에서 다시 둘로 나뉘므로, 76 이면 채널당 30 px 밖에
 * 안 남아 파형이 납작해진다. 채널당 50 px 는 있어야 모양이 모양으로 읽힌다.
 */
const LANE_H = 112;
const RULER_H = 22;
/** 이 픽셀 안쪽이면 눈금에 붙는다. */
const SNAP_PX = 7;
/** 트랙 이름이 들어가는 왼쪽 칸. 스크롤에 딸려가지 않게 밖에 둔다. */
const GUTTER = 60;
/** 확대 배율 한계. 1 은 "폭에 맞춤"이라 그 아래로는 내려갈 이유가 없다. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 64;

/** 그릴 수 있는 구간 수의 한계. 이보다 잘게 쪼개도 화면에서 구분되지 않고 점만 늘어난다. */
const MAX_BINS = 2048;
const MIN_BINS = 64;

/**
 * 클립 파형의 윤곽을 SVG 점 문자열로 만든다.
 *
 * 세 가지가 예전과 다르다:
 *  - **구간 수가 그려지는 폭을 따라간다.** 240 개로 고정해 두면 확대해도 그대로라
 *    뭉개진다. 폭(픽셀)만큼 쪼개되 2의 거듭제곱으로 잘라 캐시가 터지지 않게 한다.
 *  - **구간마다 최소·최대를 따로 담는다.** ±최댓값으로 대칭을 그리면 실제 파형이
 *    아니라 봉투만 남아서, 소리가 한쪽으로 치우친 자료가 가운데 있는 것처럼 보인다.
 *  - **채널마다 따로 그린다.** 스테레오인데 한쪽만 보여 주면 좌우가 다른 것을 못 본다.
 *
 * 버퍼는 바뀌지 않으므로 (채널, 구간 수)별로 담아 두고 드래그 중에는 다시 만들지 않는다.
 */
const pointsCache = new WeakMap<AudioBuffer, Map<string, string>>();

/**
 * 원하는 구간 수를 2의 거듭제곱으로 맞춘다. 확대할 때마다 새로 계산하지 않게 하려는 것이고,
 * **점을 만드는 쪽과 viewBox 가 같은 값을 써야 하므로** 한 곳에 둔다.
 */
function quantizeBins(want: number): number {
  return Math.min(MAX_BINS, Math.max(MIN_BINS, 1 << Math.ceil(Math.log2(Math.max(1, want)))));
}

function envelopePoints(buffer: AudioBuffer, channel: number, wantBins: number): string {
  const bins = quantizeBins(wantBins);
  const key = `${channel}:${bins}`;

  let perBuffer = pointsCache.get(buffer);
  if (!perBuffer) { perBuffer = new Map(); pointsCache.set(buffer, perBuffer); }
  const hit = perBuffer.get(key);
  if (hit) return hit;

  const data = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
  const per = Math.max(1, Math.floor(data.length / bins));

  // 위쪽(최댓값)은 왼→오른쪽, 아래쪽(최솟값)은 오른→왼쪽으로 돌아 닫힌 도형을 만든다.
  const top: string[] = [];
  const bottom: string[] = [];
  for (let b = 0; b < bins; b++) {
    const from = b * per;
    const to = Math.min(data.length, from + per);
    let mn = 0, mx = 0;
    for (let i = from; i < to; i++) {
      const v = data[i];
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    top.push(`${b},${(1 - mx).toFixed(3)}`);
    bottom.push(`${b},${(1 - mn).toFixed(3)}`);
  }
  bottom.reverse();
  const pts = top.join(' ') + ' ' + bottom.join(' ');
  perBuffer.set(key, pts);
  return pts;
}

/** 눈금 간격을 보기 좋은 수(1·2·5·10…)로 고른다. */
function niceStep(totalSec: number, width: number): number {
  const target = Math.max(1, Math.floor(width / 90));
  const raw = totalSec / target;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

interface Props {
  clips: CompClip[];
  crossfadeMs: number;
  /** 클립이 없어도 그려 둘 트랙 수. 빈 트랙을 만들 때 쓴다. */
  minLanes: number;
  onChange: (id: string, patch: Partial<CompClip>) => void;
  /** 편집 동작이 시작될 때 한 번 — 되돌리기 스냅샷을 쌓으라는 신호다. */
  onBeginEdit: () => void;
  onAddLane: () => void;
  onRemoveLane: () => void;
  /** 트랙을 통째로 위·아래로 옮긴다 — 트랙 사이에 끼워 넣을 때 쓴다. */
  onMoveLane: (from: number, to: number) => void;
  /** 트랙을 통째로 뺀다 — 그 위의 클립까지 지우고 아래를 끌어올린다. */
  onRemoveTrack: (lane: number) => void;
  /** 클립이 올라간 트랙은 뺄 수 없다. */
  canRemoveLane: boolean;
  /** 재생 위치(초). 눈금을 누르면 여기로 옮긴다. */
  currentTime: number;
  onSeek: (sec: number) => void;
  /** 배율. 1 이 "폭에 맞춤"이고 아래 `합친 결과` 파형도 같은 값을 따른다. */
  zoom: number;
  onZoomChange: (z: number) => void;
  /** 편집 대상. 자르기·페이드·게인이 이 클립에 걸린다. */
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  /** 트랙 위에서 고른 구간. 편집이 걸리는 자리다. */
  selection: TrackSelection | null;
  onSelectionChange: (sel: TrackSelection | null) => void;
}

/** 어느 트랙의 어느 구간인지. 시간은 타임라인 기준(초)이다. */
export interface TrackSelection {
  lane: number;
  start: number;
  end: number;
}

const CompositionTimeline: React.FC<Props> = ({
  clips, crossfadeMs, minLanes, onChange, onBeginEdit, onAddLane, onRemoveLane, onMoveLane, onRemoveTrack, canRemoveLane,
  currentTime, onSeek, zoom, onZoomChange, selectedClipId, onSelectClip, selection, onSelectionChange,
}) => {
  /**
   * 왼쪽 끌기 하나로 옮기기와 구간 고르기를 다 할 수는 없다. 수정키로 가르면
   * 눈에 보이지 않아 못 찾으므로 모드를 드러내 놓는다.
   *
   * 기본은 **구간 선택**이다 — 트랙에 얹고 나서 가장 먼저 하는 일이 "여기부터
   * 여기까지"를 고르는 것이고, 클립을 옮기는 일은 그다음이다.
   */
  const [mode, setMode] = useState<'move' | 'select'>('select');
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  const [drag, setDrag] = useState<{ id: string; startSec: number; lane: number } | null>(null);
  const [panning, setPanning] = useState(false);

  // 폭이 정해져야 초→픽셀 환산이 나온다. 창이 바뀌면 다시 잰다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const usedLanes = clips.length ? Math.max(...clips.map(c => c.lane)) + 1 : 0;
  const laneCount = Math.max(usedLanes, minLanes, 1);
  const totalSec = clips.length ? Math.max(...clips.map(clipEndSec)) : 1;
  // 오른쪽에 조금 여유를 둬야 끝에 붙은 클립을 잡아 끌 수 있다.
  const spanSec = Math.max(totalSec * 1.08, 1);
  const fitPxPerSec = viewWidth > 0 ? viewWidth / spanSec : 0;
  const pxPerSec = fitPxPerSec * zoom;
  const contentWidth = spanSec * pxPerSec;

  const snap = useCallback(
    (sec: number, selfId: string) => {
      if (pxPerSec <= 0) return Math.max(0, sec);
      const tolSec = SNAP_PX / pxPerSec;
      let best = sec;
      let bestD = Infinity;
      for (const c of clips) {
        if (c.id === selfId) continue;
        for (const cand of [c.startSec, clipEndSec(c), Math.max(0, clipEndSec(c) - crossfadeMs / 1000)]) {
          const d = Math.abs(cand - sec);
          if (d < bestD && d <= tolSec) { bestD = d; best = cand; }
        }
      }
      if (Math.abs(sec) <= tolSec && bestD === Infinity) best = 0;
      // 저장소 관례대로 넷째 자리까지만 — 48 kHz 에서 0.0001 초는 약 5 표본이고,
      // 마우스로 그보다 정확히 찍을 일은 없다. 표본 단위가 필요하면 숫자로 넣는다.
      return Math.max(0, Math.round(best * 1e4) / 1e4);
    },
    [clips, crossfadeMs, pxPerSec]
  );

  /** 왼쪽 버튼으로만 클립을 옮긴다. 오른쪽은 화면 밀기 몫이다. */
  const beginClipDrag = (e: React.PointerEvent, clip: CompClip) => {
    if (e.button !== 0 || pxPerSec <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origStart = clip.startSec;
    const origLane = clip.lane;

    // 끄는 동안이 아니라 **잡는 순간** 한 장만 쌓는다.
    onBeginEdit();
    setDrag({ id: clip.id, startSec: origStart, lane: origLane });

    const move = (ev: PointerEvent) => {
      const dSec = (ev.clientX - startX) / pxPerSec;
      const dLane = Math.round((ev.clientY - startY) / LANE_H);
      const nextStart = snap(origStart + dSec, clip.id);
      const nextLane = Math.max(0, origLane + dLane);
      setDrag({ id: clip.id, startSec: nextStart, lane: nextLane });
      onChange(clip.id, { startSec: nextStart, lane: nextLane });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * 트랙 위에서 구간을 고른다 — 여기가 편집이 걸리는 자리다.
   * 고른 구간이 덮는 클립이 편집 대상이 되므로, 트랙을 골라야 무엇을 자를지가 정해진다.
   */
  const beginRangeSelect = (e: React.PointerEvent, lane: number) => {
    if (mode !== 'select' || e.button !== 0 || pxPerSec <= 0) return;
    const box = contentRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();

    const at = (clientX: number) => Math.max(0, Math.round(((clientX - box.left) / pxPerSec) * 1e4) / 1e4);
    const anchor = at(e.clientX);
    onSelectionChange({ lane, start: anchor, end: anchor });

    const move = (ev: PointerEvent) => {
      const b = at(ev.clientX);
      onSelectionChange({ lane, start: Math.min(anchor, b), end: Math.max(anchor, b) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * 고른 구간의 양끝을 잡아 늘리고 줄인다.
   *
   * 다시 긋지 않고 한쪽만 고칠 수 있어야 한다 — 이음매를 맞출 때는 끝을 몇 ms 씩
   * 밀어 보는 일이 대부분인데, 그때마다 처음부터 다시 그으면 반대쪽이 흔들린다.
   * 끌다 반대쪽을 지나치면 두 끝이 뒤바뀐다.
   */
  const beginEdgeDrag = (e: React.PointerEvent, edge: 'start' | 'end') => {
    if (e.button !== 0 || pxPerSec <= 0 || !selection) return;
    const box = contentRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();

    const fixed = edge === 'start' ? selection.end : selection.start;
    const lane = selection.lane;
    const at = (clientX: number) => snap(Math.max(0, (clientX - box.left) / pxPerSec), '');

    const move = (ev: PointerEvent) => {
      const moving = at(ev.clientX);
      onSelectionChange({ lane, start: Math.min(fixed, moving), end: Math.max(fixed, moving) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 오른쪽 끌기로 화면을 민다. 확대해서 넘칠 때 이것 말고는 볼 방법이 없다. */
  const beginPan = (e: React.PointerEvent) => {
    if (e.button !== 2) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    const startX = e.clientX;
    const startLeft = el.scrollLeft;
    setPanning(true);

    const move = (ev: PointerEvent) => {
      // 끄는 방향과 내용이 같이 움직이게 — 오른쪽으로 끌면 앞쪽이 보인다.
      el.scrollLeft = startLeft - (ev.clientX - startX);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPanning(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 확대·축소. 보고 있던 가운데를 유지한 채 배율만 바꾼다. */
  const applyZoom = (next: number) => {
    const el = scrollRef.current;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (el && pxPerSec > 0) {
      const centerSec = (el.scrollLeft + el.clientWidth / 2) / pxPerSec;
      const nextPxPerSec = fitPxPerSec * clamped;
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, centerSec * nextPxPerSec - el.clientWidth / 2);
      });
    }
    onZoomChange(clamped);
  };

  if (clips.length === 0 && minLanes === 0) return null;

  const step = niceStep(spanSec, Math.max(contentWidth, 1));
  const ticks: number[] = [];
  for (let t = 0; t <= spanSec; t += step) ticks.push(t);

  const bodyH = (laneCount + 1) * LANE_H;

  return (
    <div className="border-t border-slate-800 pt-4">
      <div className="flex items-center justify-between mb-2 gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
            트랙별 파형 · 오른쪽 끌기 = 화면 밀기
          </span>
          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={() => setMode('move')}
              className={`px-2 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest transition-all ${
                mode === 'move'
                  ? 'bg-sky-600 text-white border-sky-400'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-400 border-slate-700'
              }`}
              title="왼쪽 끌기로 클립을 옮긴다"
            >
              옮기기
            </button>
            <button
              onClick={() => setMode('select')}
              className={`px-2 py-1 rounded-lg border text-[9px] font-black uppercase tracking-widest transition-all ${
                mode === 'select'
                  ? 'bg-amber-500 text-white border-amber-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-400 border-slate-700'
              }`}
              title="왼쪽 끌기로 구간을 고른다 — 편집이 그 구간에 걸린다"
            >
              구간 선택
            </button>
            {selection && (
              <button
                onClick={() => onSelectionChange(null)}
                className="px-2 py-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 text-[9px] font-black uppercase tracking-widest transition-all"
                title="구간 선택 해제"
              >
                해제
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-500 mr-1">
            {drag ? `트랙 ${drag.lane} · 시작 ${drag.startSec.toFixed(4)}초` : `${zoom.toFixed(zoom < 10 ? 1 : 0)}×`}
          </span>
          <button
            onClick={() => applyZoom(zoom / 1.5)}
            disabled={zoom <= ZOOM_MIN}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-lg border border-slate-700 text-[10px] font-black transition-all"
            title="축소"
          >
            −
          </button>
          <button
            onClick={() => applyZoom(1)}
            disabled={zoom === 1}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-lg border border-slate-700 text-[9px] font-black uppercase tracking-widest transition-all"
            title="폭에 맞춤"
          >
            맞춤
          </button>
          <button
            onClick={() => applyZoom(zoom * 1.5)}
            disabled={zoom >= ZOOM_MAX}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded-lg border border-slate-700 text-[10px] font-black transition-all"
            title="확대"
          >
            +
          </button>
          {/*
            연속 조절. 눈금을 로그로 잡는다 — 1~8× 가 실제로 쓰는 구간인데
            1~64 를 선형으로 펴면 그 구간이 슬라이더 앞머리에 다 몰린다.
          */}
          <input
            type="range"
            min={0} max={100} step={1}
            value={Math.round((Math.log(zoom / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100)}
            onChange={(e) => applyZoom(ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, parseInt(e.target.value) / 100))}
            className="w-24 accent-indigo-500 h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer"
            title="확대 배율"
          />
        </div>
      </div>

      <div className="flex select-none">
        {/* 트랙 이름 칸 — 스크롤 밖에 둬서 밀어도 항상 보인다 */}
        <div style={{ width: GUTTER }} className="shrink-0">
          <div style={{ height: RULER_H }} />
          {Array.from({ length: laneCount + 1 }, (_, lane) => (
            <div
              key={lane}
              style={{ height: LANE_H }}
              className="flex flex-col items-start justify-center gap-1 pr-2"
            >
              <span className={`text-[9px] font-black uppercase tracking-widest whitespace-nowrap ${
                lane === laneCount ? 'text-slate-700' : 'text-sky-500/80'
              }`}>
                {lane === laneCount ? '새 트랙' : `트랙 ${lane}`}
              </span>
              {/* 트랙 순서 바꾸기 — 트랙 사이로 밀어 넣는다 */}
              {lane < laneCount && (
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => onMoveLane(lane, lane - 1)}
                    disabled={lane === 0}
                    className="px-1 leading-none py-0.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-20 text-slate-400 rounded border border-slate-700 text-[9px] font-black transition-all"
                    title="이 트랙을 한 칸 위로"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => onMoveLane(lane, lane + 1)}
                    disabled={lane >= laneCount - 1}
                    className="px-1 leading-none py-0.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-20 text-slate-400 rounded border border-slate-700 text-[9px] font-black transition-all"
                    title="이 트랙을 한 칸 아래로"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => onRemoveTrack(lane)}
                    className="px-1 leading-none py-0.5 bg-rose-500/10 hover:bg-rose-500/25 text-rose-400 rounded border border-rose-500/30 text-[9px] font-black transition-all"
                    title="이 트랙을 통째로 뺀다 (올라간 클립도 함께 지우고 아래 트랙이 올라온다)"
                  >
                    ✕
                  </button>
                </div>
              )}
              {/* 빈 트랙 만들기·빼기를 보고 있는 자리에 둔다 */}
              {lane === laneCount && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={onAddLane}
                    className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 text-[10px] font-black transition-all"
                    title="빈 트랙을 하나 더 만든다"
                  >
                    +
                  </button>
                  <button
                    onClick={onRemoveLane}
                    disabled={!canRemoveLane}
                    className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 rounded border border-slate-700 text-[10px] font-black transition-all"
                    title="클립이 없는 트랙만 뺀다"
                  >
                    −
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 스크롤되는 본문 */}
        <div
          ref={scrollRef}
          onPointerDown={beginPan}
          onContextMenu={(e) => e.preventDefault()}
          className={`relative flex-1 overflow-x-auto overflow-y-hidden ${panning ? 'cursor-grabbing' : ''}`}
          style={{ height: RULER_H + bodyH }}
        >
          <div ref={contentRef} className="relative" style={{ width: Math.max(contentWidth, 1), height: RULER_H + bodyH }}>
            {/* 시간 눈금 — 누르면 그 자리로 재생 위치를 옮긴다 */}
            <div
              className="absolute inset-x-0 top-0 border-b border-slate-800 cursor-text"
              style={{ height: RULER_H }}
              onPointerDown={(e) => {
                if (e.button !== 0 || pxPerSec <= 0) return;
                e.stopPropagation();
                const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onSeek(Math.max(0, (e.clientX - box.left) / pxPerSec));
              }}
            >
              {pxPerSec > 0 && ticks.map(t => (
                <div key={t} className="absolute top-0 h-full" style={{ left: t * pxPerSec }}>
                  <div className="w-px h-2 bg-slate-700" />
                  <span className="absolute left-1 top-1 text-[9px] font-mono text-slate-600 whitespace-nowrap">
                    {t.toFixed(step < 1 ? 2 : 0)}s
                  </span>
                </div>
              ))}
            </div>

            {/* 트랙 줄. 마지막 한 줄은 "여기로 끌면 새 트랙" 이다. */}
            {Array.from({ length: laneCount + 1 }, (_, lane) => (
              <div
                key={lane}
                onPointerDown={(e) => beginRangeSelect(e, lane)}
                className={`absolute inset-x-0 border-b ${
                  lane === laneCount
                    ? 'border-dashed border-slate-800/70 bg-slate-950/30'
                    : 'border-slate-800/60 bg-slate-950/50'
                } ${mode === 'select' && lane < laneCount ? 'cursor-text' : ''}`}
                style={{ top: RULER_H + lane * LANE_H, height: LANE_H }}
              />
            ))}

            {/*
              고른 구간. 몸통은 포인터를 받지 않는다 — 그 위에서 새로 그을 수 있어야
              하기 때문이다. 대신 **양끝 손잡이만** 포인터를 받아 늘리고 줄인다.
            */}
            {pxPerSec > 0 && selection && selection.end > selection.start && (
              <>
                <div
                  className="absolute bg-amber-400/20 border-x-2 border-amber-400 pointer-events-none z-30"
                  style={{
                    left: selection.start * pxPerSec,
                    width: Math.max(1, (selection.end - selection.start) * pxPerSec),
                    top: RULER_H + selection.lane * LANE_H,
                    height: LANE_H,
                  }}
                />
                {(['start', 'end'] as const).map(edge => (
                  <div
                    key={edge}
                    onPointerDown={(e) => beginEdgeDrag(e, edge)}
                    title={edge === 'start' ? '구간 시작을 끌어 옮긴다' : '구간 끝을 끌어 옮긴다'}
                    className="absolute z-40 cursor-ew-resize flex items-center justify-center group/handle"
                    style={{
                      // 손가락으로 잡을 만한 폭을 주되 눈에는 가는 선으로 보이게 한다.
                      left: (selection[edge] * pxPerSec) - 6,
                      width: 12,
                      top: RULER_H + selection.lane * LANE_H,
                      height: LANE_H,
                    }}
                  >
                    <div className="w-[3px] h-1/2 rounded-full bg-amber-300 opacity-80 group-hover/handle:opacity-100 group-hover/handle:h-3/4 transition-all" />
                  </div>
                ))}
              </>
            )}

            {/* 클립 블록 */}
            {pxPerSec > 0 && clips.map(clip => {
              const widthPx = Math.max(2, clip.buffer.duration * pxPerSec);
              // 구간 수를 그려지는 폭에 맞춘다 — 확대할수록 잘게 쪼개진다.
              const bins = Math.round(widthPx);
              const chCount = Math.min(2, clip.buffer.numberOfChannels);
              const active = drag?.id === clip.id;
              const selected = selectedClipId === clip.id;
              return (
                <div
                  key={clip.id}
                  onPointerDown={(e) => { if (e.button === 0) onSelectClip(clip.id); beginClipDrag(e, clip); }}
                  title={`${clip.name} — 눌러서 편집 대상으로, 왼쪽 끌기로 옮기기`}
                  className={`absolute rounded-lg overflow-hidden cursor-grab active:cursor-grabbing transition-shadow ${
                    active
                      ? 'bg-sky-500/40 border-2 border-sky-300 shadow-lg shadow-sky-500/30 z-20'
                      : selected
                        ? 'bg-sky-500/30 border-2 border-amber-400 shadow-lg shadow-amber-500/20 z-20'
                        : 'bg-sky-600/25 border border-sky-500/50 hover:bg-sky-600/35 z-10'
                  }`}
                  style={{
                    left: clip.startSec * pxPerSec,
                    width: widthPx,
                    top: RULER_H + clip.lane * LANE_H + 4,
                    height: LANE_H - 10,
                    // 구간 선택 중에는 클립이 끌기를 가로채면 안 된다 —
                    // 클립 위에서도 구간을 그을 수 있어야 하기 때문이다.
                    pointerEvents: mode === 'select' ? 'none' : undefined,
                  }}
                >
                  {/*
                    채널마다 한 줄씩. 스테레오면 위아래로 나눠 좌우가 다른 것을 보이게 한다.
                    viewBox 의 y 는 0(+1) ~ 2(−1) 이고 1 이 무음이다.
                    non-scaling-stroke 를 쓰므로 strokeWidth 는 픽셀로 읽힌다.
                  */}
                  {Array.from({ length: chCount }, (_, ch) => (
                    <svg
                      key={ch}
                      className="absolute left-0"
                      /*
                        폭을 반드시 못 박아야 한다. SVG 는 width 가 auto 면 viewBox 의
                        가로세로비로 제 크기를 정하므로, 높이 50 px 에 viewBox 1024×2 면
                        폭이 25600 px 로 부풀어 파형의 앞 2 %만 보인다.
                      */
                      style={{ width: '100%', top: `${(ch * 100) / chCount}%`, height: `${100 / chCount}%` }}
                      preserveAspectRatio="none"
                      viewBox={`0 0 ${quantizeBins(bins)} 2`}
                    >
                      <polygon
                        points={envelopePoints(clip.buffer, ch, bins)}
                        fill="rgba(125,211,252,0.45)" stroke="rgb(125,211,252)" strokeWidth="1" vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  ))}
                  {/* 스테레오면 두 채널 사이에 실금을 그어 어디까지가 L 인지 보이게 한다 */}
                  {chCount > 1 && (
                    <div className="absolute inset-x-0 top-1/2 h-px bg-sky-300/25 pointer-events-none" />
                  )}
                  <span className="relative px-2 py-1 block text-[9px] font-bold text-white truncate drop-shadow pointer-events-none">
                    {clip.name}
                  </span>
                </div>
              );
            })}

            {/* 재생 헤드 — 모든 트랙을 가로지른다. 트랙마다 따로 있으면 안 된다. */}
            {pxPerSec > 0 && (
              <div
                className="absolute top-0 w-px bg-amber-400 pointer-events-none z-30"
                style={{ left: currentTime * pxPerSec, height: RULER_H + bodyH }}
              >
                <div className="absolute -top-0.5 -left-[3px] w-[7px] h-[7px] bg-amber-400 rounded-sm" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompositionTimeline;

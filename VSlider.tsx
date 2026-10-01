/**
 * 세로 슬라이더.
 *
 * 음정처럼 **위아래가 뜻을 갖는 값**에 쓴다. 노브는 자리를 덜 먹지만 "어느 쪽이
 * 높은 쪽인가"를 모양으로 말해 주지 못한다 — 세로 슬라이더는 위가 높은 쪽이다.
 *
 * 노브와 조작이 다른 곳이 하나 있다: **누른 자리로 바로 간다(절대 위치).**
 * 슬라이더는 그렇게 동작하는 것이 몸에 익어 있어서, 노브처럼 상대 이동으로
 * 만들면 엉뚱한 데를 누른 것처럼 느껴진다. 대신 곱게 맞추는 수단을 따로 둔다:
 *   - Shift + 끌기: 누른 자리로 안 뛰고 그 자리에서 1/5 로 곱게
 *   - 휠 · 화살표 키: 한 칸씩
 *   - 두 번 누르기: 기본값
 *
 * 값이 음수·양수로 갈리면 가운데(0)에 금을 긋고 거기서부터 채운다 — 어느 쪽으로
 * 얼마나 갔는지는 채워진 길이로 읽는 것이 빠르다.
 */
import React, { useCallback, useRef } from 'react';

interface VSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** 두 번 눌렀을 때 돌아갈 자리. */
  resetTo?: number;
  /** 홈의 높이(px). 폭은 좁게 고정한다. */
  height?: number;
  label?: string;
  ariaLabel?: string;
  format?: (v: number) => string;
  /** 실제 색 문자열. Tailwind 클래스를 조립하면 빌드 스캐너가 못 찾는다. */
  accent?: string;
  title?: string;
  disabled?: boolean;
}

const TRACK_W = 6;
const THUMB_H = 12;

export const VSlider: React.FC<VSliderProps> = ({
  value, min, max, step = 1, onChange, resetTo,
  height = 96, label, ariaLabel, format, accent = '#e879f9', title, disabled = false,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const fineRef = useRef<{ y: number; start: number } | null>(null);

  const clamp = useCallback((v: number) => {
    const snapped = Math.round(v / step) * step;
    const decimals = (String(step).split('.')[1] ?? '').length;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals))));
  }, [min, max, step]);

  /** 화면 y → 값. 위가 큰 쪽이다. */
  const valueAt = (clientY: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return value;
    const t = 1 - (clientY - box.top) / box.height;
    return clamp(min + t * (max - min));
  };

  const begin = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (e.shiftKey) {
      // 곱게 맞추는 중이면 누른 자리로 안 뛴다 — 지금 값에서 이어서 움직인다.
      fineRef.current = { y: e.clientY, start: value };
      return;
    }
    fineRef.current = null;
    onChange(valueAt(e.clientY));
  };
  const move = (e: React.PointerEvent) => {
    if (disabled || e.buttons === 0) return;
    const f = fineRef.current;
    if (f) {
      onChange(clamp(f.start + ((f.y - e.clientY) / 160) * (max - min) * 0.2));
      return;
    }
    onChange(valueAt(e.clientY));
  };
  const end = (e: React.PointerEvent) => {
    fineRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const big = (max - min) / 10;
    const map: Record<string, number> = {
      ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step,
      PageUp: big, PageDown: -big,
    };
    if (e.key in map) { e.preventDefault(); onChange(clamp(value + map[e.key])); return; }
    if (e.key === 'Home') { e.preventDefault(); onChange(min); return; }
    if (e.key === 'End') { e.preventDefault(); onChange(max); }
  };

  const t = max === min ? 0 : (value - min) / (max - min);
  const thumbBottom = t * (height - THUMB_H);
  // 0 이 범위 안에 있으면 거기가 기준점이다. 아니면 아래가 기준이다.
  const bipolar = min < 0 && max > 0;
  const zeroT = bipolar ? (0 - min) / (max - min) : 0;
  const fillLo = Math.min(t, zeroT) * height;
  const fillHi = Math.max(t, zeroT) * height;

  return (
    <div className={`flex flex-col items-center gap-1 select-none ${disabled ? 'opacity-30' : ''}`}>
      {label && (
        <span className="text-[9px] font-black text-slate-500 tracking-widest whitespace-nowrap">{label}</span>
      )}
      <div
        ref={trackRef}
        role="slider"
        aria-orientation="vertical"
        aria-label={label ?? ariaLabel ?? '값'}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={disabled ? -1 : 0}
        title={title}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onWheel={(e) => { if (!disabled) onChange(clamp(value + (e.deltaY < 0 ? step : -step))); }}
        onKeyDown={onKey}
        onDoubleClick={() => resetTo !== undefined && !disabled && onChange(resetTo)}
        className={`relative touch-none outline-none rounded-full focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
          disabled ? 'cursor-not-allowed' : 'cursor-ns-resize'
        }`}
        style={{ width: 18, height }}
      >
        {/* 홈 */}
        <div
          className="absolute rounded-full bg-slate-800"
          style={{ left: (18 - TRACK_W) / 2, top: 0, width: TRACK_W, height }}
        />
        {/* 가운데 금 — 0 이 어디인지 */}
        {bipolar && (
          <div
            className="absolute bg-slate-600"
            style={{ left: 1, width: 16, height: 1, bottom: zeroT * height }}
          />
        )}
        {/* 기준점에서 지금 자리까지 */}
        <div
          className="absolute rounded-full"
          style={{
            left: (18 - TRACK_W) / 2, width: TRACK_W,
            bottom: fillLo, height: Math.max(0, fillHi - fillLo),
            background: accent,
          }}
        />
        {/* 손잡이 */}
        <div
          className="absolute rounded-sm border border-slate-900 shadow"
          style={{ left: 1, width: 16, height: THUMB_H, bottom: thumbBottom, background: accent }}
        />
      </div>
      {format && (
        <span className="text-[9px] font-mono text-slate-400 tabular-nums whitespace-nowrap leading-none">
          {format(value)}
        </span>
      )}
    </div>
  );
};

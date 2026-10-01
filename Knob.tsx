/**
 * 돌리는 손잡이(노브).
 *
 * 슬라이더를 노브로 바꾼 이유는 **자리**다. 슬라이더는 쓸 만한 폭이 최소
 * 80~100 px 인데 도크는 한 줄(59 px)에 열 개 넘는 것을 담고 있어서, 폭을
 * 줄이면 한 픽셀에 값이 몇 단계씩 뛰어 조준이 안 됐다. 노브는 **폭이 높이와
 * 같아서**(36 px) 자리를 훨씬 덜 먹으면서, 끄는 거리는 화면 폭과 무관하게
 * 세로로 얼마든지 벌 수 있다.
 *
 * 조준 수단을 셋 다 둔다 — 어느 하나만으로는 부족하다:
 *   - 위아래 끌기: 대충 맞추기. 160 px 에 전체 범위. Shift 를 누르면 1/5 로 곱게.
 *   - 휠: 한 칸씩. 손잡이를 놓지 않고 미세 조정할 때.
 *   - 화살표 키: 정확히 한 칸. 탭으로 옮겨 다닐 수 있어야 하므로 초점도 받는다.
 * 두 번 누르면 기본값으로 돌아온다 — 만지작거리다 원래 자리를 잃는 일이 잦다.
 */
import React, { useCallback, useRef } from 'react';

interface KnobProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** 두 번 눌렀을 때 돌아갈 자리. 없으면 두 번 눌러도 안 움직인다. */
  resetTo?: number;
  size?: number;
  /** 손잡이 위에 적을 이름. 자리가 없으면 생략하고 `ariaLabel` 만 준다. */
  label?: string;
  /**
   * 읽어 줄 이름. 라벨을 못 붙이는 자리(도크)에서도 **설명이 아니라 이름**이
   * 읽혀야 한다 — `title` 로 대신하면 두 문장짜리 도움말을 통째로 읽는다.
   */
  ariaLabel?: string;
  /** 손잡이 아래 적을 값. 단위는 여기서 붙인다 — 대문자로 굽지 않는다. */
  format?: (v: number) => string;
  /** 채워지는 호의 색. Tailwind 가 아니라 실제 색이어야 SVG stroke 에 먹는다. */
  accent?: string;
  title?: string;
  disabled?: boolean;
}

/** 12시에서 시계방향으로 잰 각도의 좌표. 270° 를 -135°~+135° 로 쓴다. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const SWEEP = 135; // -135° ~ +135°

export const Knob: React.FC<KnobProps> = ({
  value, min, max, step = 1, onChange, resetTo,
  size = 36, label, ariaLabel, format, accent = '#818cf8', title, disabled = false,
}) => {
  const dragRef = useRef<{ y: number; start: number } | null>(null);

  const clamp = useCallback((v: number) => {
    const snapped = Math.round(v / step) * step;
    // step 이 0.001 같은 소수면 부동소수 찌꺼기가 붙는다 — 자릿수를 맞춰 턴다.
    const decimals = (String(step).split('.')[1] ?? '').length;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals))));
  }, [min, max, step]);

  const begin = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { y: e.clientY, start: value };
  };
  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 위로 끌면 커진다. 160 px 에 전체 범위, Shift 면 1/5 로 곱게.
    const span = (max - min) * (e.shiftKey ? 0.2 : 1);
    onChange(clamp(d.start + ((d.y - e.clientY) / 160) * span));
  };
  const end = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (disabled) return;
    onChange(clamp(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 1 : 1)));
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
  const deg = -SWEEP + t * SWEEP * 2;
  const cx = size / 2, cy = size / 2, r = size / 2 - 3;
  const [ix, iy] = polar(cx, cy, r - 4, deg);
  const [hx, hy] = polar(cx, cy, r * 0.42, deg);

  return (
    <div className={`flex flex-col items-center gap-0.5 select-none ${disabled ? 'opacity-30' : ''}`}>
      {label && (
        <span className="text-[9px] font-black text-slate-500 tracking-widest whitespace-nowrap">{label}</span>
      )}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
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
        onWheel={onWheel}
        onKeyDown={onKey}
        onDoubleClick={() => resetTo !== undefined && !disabled && onChange(resetTo)}
        className={`touch-none outline-none rounded-full focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
          disabled ? 'cursor-not-allowed' : 'cursor-ns-resize'
        }`}
        style={{ overflow: 'visible' }}
      >
        {/* 바탕 호 — 어디까지 갈 수 있는지 */}
        <path d={arcPath(cx, cy, r, -SWEEP, SWEEP)} fill="none" stroke="#1e293b" strokeWidth={3} strokeLinecap="round" />
        {/* 채워진 호 — 지금 어디인지 */}
        {t > 0.001 && (
          <path d={arcPath(cx, cy, r, -SWEEP, deg)} fill="none" stroke={accent} strokeWidth={3} strokeLinecap="round" />
        )}
        <circle cx={cx} cy={cy} r={r - 5} fill="#0f172a" stroke="#334155" strokeWidth={1} />
        {/* 가리키는 선 */}
        <line x1={hx} y1={hy} x2={ix} y2={iy} stroke={accent} strokeWidth={2} strokeLinecap="round" />
      </svg>
      {format && (
        <span className="text-[9px] font-mono text-slate-400 tabular-nums whitespace-nowrap leading-none">
          {format(value)}
        </span>
      )}
    </div>
  );
};

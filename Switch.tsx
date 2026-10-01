/**
 * 켜고 끄는 스위치.
 *
 * 네모 체크박스를 바꾼 이유는 **켜졌는지가 멀리서 안 보였기** 때문이다.
 * 체크 표시는 12 px 짜리 글리프 하나라, 화면 아래 도크나 묶음이 넷 붙은
 * 패널에서는 켜짐/꺼짐을 확인하려면 눈을 가까이 대야 했다. 스위치는 손잡이의
 * **자리**와 바탕의 **색**이 함께 바뀌므로 한눈에 읽힌다.
 *
 * `<button role="switch">` 다. 흉내 낸 그림이 아니라 진짜 버튼이라 Space·Enter·
 * 탭 이동이 브라우저에서 그대로 온다 — 직접 구현하면 하나씩 빠뜨린다.
 *
 * 색은 Tailwind 클래스가 아니라 **실제 색 문자열**로 받는다. 클래스 이름을
 * 문자열로 조립하면 빌드 때 훑는 스캐너가 못 찾아서 그 색이 통째로 빠진다 —
 * 이 저장소에서 이미 겪은 일이다(README 「화면 정리」).
 */
import React from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  /** 켜졌을 때의 색. `#34d399` 같은 실제 값이어야 한다. */
  accent?: string;
  title?: string;
  disabled?: boolean;
}

export const Switch: React.FC<SwitchProps> = ({
  checked, onChange, label, accent = '#818cf8', title, disabled = false,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    title={title}
    onClick={() => onChange(!checked)}
    className="flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl disabled:opacity-30 hover:border-slate-600 focus-visible:ring-2 focus-visible:ring-indigo-400/60 outline-none transition-colors"
  >
    <span
      className="relative shrink-0 w-8 h-[18px] rounded-full transition-colors duration-150"
      style={{ background: checked ? accent : '#334155' }}
    >
      <span
        className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-all duration-150"
        style={{ left: checked ? 16 : 2 }}
      />
    </span>
    <span
      className="text-[10px] font-black tracking-widest whitespace-nowrap transition-colors"
      style={{ color: checked ? accent : '#64748b' }}
    >
      {label}
    </span>
  </button>
);

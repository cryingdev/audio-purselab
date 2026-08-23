/**
 * 트랙을 합치지 않고 그대로 들려준다.
 *
 * 클립이 문서가 된 뒤로 **합치기 전에 소리를 못 듣는 것**이 가장 큰 구멍이었다.
 * 배치는 귀로 맞추는 일이라, 들으면서 옮길 수 없으면 트랙이 편집점일 수 없다.
 *
 * 클립마다 소스를 예약해 실시간으로 섞는 대신, `renderComposition` 으로 믹스를
 * 한 번 구워서 그걸 재생한다. 이유는 두 가지다 — 이미 검증된 코드라 화면에서
 * 듣는 것과 내보내는 것이 **정확히 같고**, 페이드·게인 처리를 두 번 쓰지 않는다.
 * 굽는 값이 싸기 때문에 (48 kHz 스테레오 30초가 수 ms) 감당이 된다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CompClip, renderComposition, wrapLoopEnds } from './composer';
import { makeContext, PROJECT_SAMPLE_RATE } from './audioUtils';

/** 끄는 동안 매 프레임 다시 굽지 않도록 잠깐 기다린다. */
const REBUILD_DELAY_MS = 120;

export interface CompositionPlayback {
  /** 지금 믹스. 내보내기도 이걸 쓰면 들은 것과 같은 것이 나간다. */
  mix: AudioBuffer | null;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (sec: number) => void;
  /** 클립을 고친 직후처럼 즉시 다시 구워야 할 때. */
  rebuildNow: () => void;
  /**
   * 되풀이할 구간. `null` 이면 한 번만 재생한다.
   * 이음매가 튀는지는 반복해서 들어 보는 것 말고 판정할 방법이 없다.
   */
  loopRange: { start: number; end: number } | null;
  setLoopRange: (r: { start: number; end: number } | null) => void;
}

/**
 * `wrapMs` 는 끝→시작 말아들기다. **재생에도 걸어야 한다** — 굽기와 내보내기에만
 * 걸면 길이도 이음매도 들은 것과 다른 것이 나간다. 말아든 루프가 제대로 도는지는
 * 귀로 확인하는 일이라 특히 그렇다.
 *
 * 정규화는 일부러 걸지 않는다. 마지막 게인 단계라 내용과 길이를 바꾸지 않고,
 * 여기 걸면 판독줄의 **합산 피크가 늘 −3 dBFS 로 보여 넘쳤다는 사실이 가려진다.**
 */
export function useCompositionPlayback(clips: CompClip[], volume = 1, wrapMs = 0): CompositionPlayback {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  /** 재생을 시작한 컨텍스트 시각. 현재 위치를 여기서 계산한다. */
  const startedAtRef = useRef(0);
  /** 멈춰 있을 때의 위치(초). */
  const offsetRef = useRef(0);
  const rafRef = useRef(0);

  const [mix, setMix] = useState<AudioBuffer | null>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [loopRange, setLoopRange] = useState<{ start: number; end: number } | null>(null);
  /** 재생 중에 구간이 바뀌어도 반영하려면 콜백 안에서 최신 값을 읽어야 한다. */
  const loopRef = useRef(loopRange);
  loopRef.current = loopRange;

  /** 소스에 되풀이 설정을 건다. 브라우저가 표본 단위로 이어 주므로 우리가 셀 필요가 없다. */
  const applyLoop = (src: AudioBufferSourceNode) => {
    const lr = loopRef.current;
    if (lr && lr.end > lr.start) {
      src.loop = true;
      src.loopStart = lr.start;
      src.loopEnd = lr.end;
    } else {
      src.loop = false;
    }
  };

  const ctx = () => {
    if (!ctxRef.current) {
      ctxRef.current = makeContext(PROJECT_SAMPLE_RATE);
      gainRef.current = ctxRef.current.createGain();
      gainRef.current.connect(ctxRef.current.destination);
    }
    return ctxRef.current;
  };

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume;
  }, [volume]);

  const stopSource = useCallback(() => {
    if (srcRef.current) {
      try { srcRef.current.stop(); } catch { /* 이미 끝났으면 무시 */ }
      srcRef.current.disconnect();
      srcRef.current = null;
    }
  }, []);

  /** 클립에서 믹스를 다시 굽는다. 재생 중이면 위치를 지키며 이어 붙인다. */
  const rebuild = useCallback(() => {
    const c = ctx();
    let next = clips.length ? renderComposition(clips, c, PROJECT_SAMPLE_RATE) : null;
    if (next && wrapMs > 0) next = wrapLoopEnds(next, wrapMs, c) ?? next;
    setMix(next);

    if (!next) {
      stopSource();
      setPlaying(false);
      offsetRef.current = 0;
      setCurrentTime(0);
      return;
    }
    // 재생 중이었다면 새 믹스로 갈아끼우되 듣던 자리를 유지한다.
    if (srcRef.current) {
      const at = offsetRef.current + (c.currentTime - startedAtRef.current);
      stopSource();
      const src = c.createBufferSource();
      src.buffer = next;
      src.connect(gainRef.current!);
      applyLoop(src);
      const from = Math.min(Math.max(0, at), next.duration);
      src.start(0, from);
      srcRef.current = src;
      startedAtRef.current = c.currentTime;
      offsetRef.current = from;
    }
  }, [clips, wrapMs, stopSource]);

  // 클립이 바뀌면 다시 굽는다 — 끄는 중에는 잠깐 모아서 한 번만.
  useEffect(() => {
    const t = setTimeout(rebuild, REBUILD_DELAY_MS);
    return () => clearTimeout(t);
  }, [rebuild]);

  const play = useCallback(() => {
    const c = ctx();
    if (!mix) return;
    void c.resume();
    stopSource();
    const src = c.createBufferSource();
    src.buffer = mix;
    src.connect(gainRef.current!);
    applyLoop(src);
    const from = offsetRef.current >= mix.duration ? 0 : offsetRef.current;
    src.start(0, from);
    src.onended = () => {
      // 끝까지 갔을 때만 멈춘 것으로 친다 (갈아끼우기로 끝난 경우는 제외).
      if (srcRef.current === src) {
        srcRef.current = null;
        setPlaying(false);
        offsetRef.current = mix.duration;
        setCurrentTime(mix.duration);
      }
    };
    srcRef.current = src;
    startedAtRef.current = c.currentTime;
    offsetRef.current = from;
    setPlaying(true);
  }, [mix, stopSource]);

  const pause = useCallback(() => {
    const c = ctx();
    if (srcRef.current) {
      offsetRef.current += c.currentTime - startedAtRef.current;
      stopSource();
    }
    setPlaying(false);
  }, [stopSource]);

  const seek = useCallback((sec: number) => {
    const c = ctx();
    const at = Math.max(0, mix ? Math.min(sec, mix.duration) : sec);
    offsetRef.current = at;
    setCurrentTime(at);
    if (srcRef.current && mix) {
      stopSource();
      const src = c.createBufferSource();
      src.buffer = mix;
      src.connect(gainRef.current!);
      applyLoop(src);
      src.start(0, at);
      srcRef.current = src;
      startedAtRef.current = c.currentTime;
    }
  }, [mix, stopSource]);

  const toggle = useCallback(() => { isPlaying ? pause() : play(); }, [isPlaying, pause, play]);

  // 재생 위치를 화면에 흘려 준다.
  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      const c = ctxRef.current;
      if (c && srcRef.current) {
        let t = offsetRef.current + (c.currentTime - startedAtRef.current);
        /*
         * 되풀이 중에는 소리는 구간 안에서 돌지만 우리 시계는 계속 올라간다 —
         * 그대로 두면 재생 헤드가 구간을 넘어 끝까지 흘러가 버린다. 같은 방식으로 접는다.
         */
        const lr = loopRef.current;
        if (lr && lr.end > lr.start && t > lr.end) {
          const span = lr.end - lr.start;
          t = lr.start + ((t - lr.start) % span);
        }
        setCurrentTime(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  useEffect(() => () => {
    stopSource();
    void ctxRef.current?.close();
  }, [stopSource]);

  return {
    mix,
    duration: mix?.duration ?? 0,
    currentTime,
    isPlaying,
    play,
    pause,
    toggle,
    seek,
    rebuildNow: rebuild,
    loopRange,
    setLoopRange,
  };
}

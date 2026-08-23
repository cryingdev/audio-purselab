import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * `define` 으로 GEMINI_API_KEY 를 번들에 주입하던 앱 빌더 잔재를 2026-08-11 에 걷어 냈다.
 * 아무도 쓰지 않는 값이었고, 남겨 두면 나중에 누가 진짜 키를 .env 에 넣는 순간
 * 그게 프런트엔드 번들에 평문으로 박힌다. 이 도구는 서버로 오디오를 보내지 않으므로
 * 애초에 키가 필요 없다.
 */
export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});

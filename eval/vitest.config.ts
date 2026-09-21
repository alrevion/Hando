// Замер понимания фраз на НАСТОЯЩЕЙ модели -- не тест: ходит в Groq, стоит
// денег и упирается в лимит ключа. В `npm test` не входит, запускается сам:
//   npm run eval:brain                 -- весь корпус, продолжает с места обрыва
//   LABEL=low EFFORT=low npm run eval:brain
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['eval/*.eval.ts'],
    environment: 'node',
    testTimeout: 6 * 3_600_000,
  },
});

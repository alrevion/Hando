// Единственный тест, который не может идти в workerd: mcp.test.ts импортирует
// src/index -> src/mcp -> @modelcontextprotocol/sdk -> ajv, а ajv грузит .json
// как модуль, чего workerd не умеет. К базе этот тест не обращается -- проверяет
// bearer-гейт на /mcp, -- поэтому node-пул для него достаточен и честен.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'node', include: ['test/mcp.test.ts'] },
});

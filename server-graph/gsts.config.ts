import { existsSync, readFileSync } from 'node:fs'
import type { GstsConfig } from 'genshin-ts'

// Personal values live in gsts.local.json (git-ignored): { "playerId": <your UID>, "mapId": <level map id> }.
// Without it the graph still compiles, it just isn't injected into a level.
const local = existsSync('./gsts.local.json')
  ? (JSON.parse(readFileSync('./gsts.local.json', 'utf8')) as { playerId?: number; mapId?: number })
  : {}

const config: GstsConfig = {
  compileRoot: '.',
  entries: ['./src'],
  outDir: './dist',
  inject: local.playerId && local.mapId
    ? {
        gameRegion: 'China',
        playerId: local.playerId,
        mapId: local.mapId, // from `npm run maps`
        nodeGraphId: 1073741825 // empty_node on the level entity; must match `id:` in src/main.ts
      }
    : undefined
}

export default config

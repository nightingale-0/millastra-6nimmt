// @gsts:signals

import { defineSignal } from 'genshin-ts/runtime/core'

export const Signal = {
  NimmtAct: defineSignal('NimmtAct', [
    ['seat', 'int'],
    ['key', 'int'],
    ['kind', 'int'],
    ['token', 'int'],
    ['value', 'int']
  ]),
  NimmtChooseRow: defineSignal('NimmtChooseRow', [
    ['token', 'int'],
    ['row', 'int']
  ]),
  NimmtStart: defineSignal('NimmtStart', [
    ['bots', 'int'],
    ['mode', 'int']
  ]),
  NimmtSubmit: defineSignal('NimmtSubmit', [
    ['token', 'int'],
    ['card', 'int']
  ]),
  NimmtSync: defineSignal('NimmtSync', []),
  NimmtVote: defineSignal('NimmtVote', [
    ['token', 'int'],
    ['kind', 'int']
  ])
} as const

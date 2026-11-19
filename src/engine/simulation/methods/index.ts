// The ways a simulation can draw. A new method is one more entry here: the core, the spec's
// schema and the guide a model reads all take their list of methods from this table.
import type { Method } from '../types.js'
import { correlated } from './correlated.js'
import { monteCarlo } from './monte-carlo.js'
import { sequential } from './sequential.js'

export const METHODS: ReadonlyMap<string, Method> = new Map<string, Method>([monteCarlo, correlated, sequential].map((m) => [m.name, m as Method]))

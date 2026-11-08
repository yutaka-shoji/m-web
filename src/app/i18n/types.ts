import type { ja } from './ja';

/** Same tree as the Japanese dictionary, with every leaf widened to `string`. */
type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type Messages = Widen<typeof ja>;

/** Dot-separated key of every leaf, e.g. `'nav.dashboard'`. */
type KeyPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : KeyPaths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = KeyPaths<Messages>;

export type Locale = 'ja' | 'en';

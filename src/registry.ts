/**
 * Discovers which characters and costumes are installed.
 *
 * The engine ships with no models. Everything under `public/models/` is
 * user-supplied, described by a `character.json` per character, so adding or
 * removing a character never touches the code.
 */
export interface Costume {
  id: string;
  name: string;
  /** model3.json path, relative to the character directory. */
  model: string;
}

export interface Character {
  id: string;
  name: string;
  nicknames?: string[];
  defaultCostume?: string;
  costumes: Costume[];
  /** Motion index path, relative to the character directory. Optional. */
  motions?: string;
  /** Directory of voice clips, relative to the character directory. Optional. */
  voice?: string;
  /** Filled in on load so callers can resolve the relative paths above. */
  dir: string;
}

export const MODELS_ROOT = '/models';

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * `index.json` is a flat list of directory names. A web build cannot list a
 * directory, so the installer writes this file.
 */
export async function loadRegistry(root = MODELS_ROOT): Promise<Character[]> {
  const slugs = await json<string[]>(`${root}/index.json`);
  if (!slugs?.length) return [];

  const loaded = await Promise.all(
    slugs.map(async (slug) => {
      const dir = `${root}/${slug}`;
      const c = await json<Character>(`${dir}/character.json`);
      if (!c?.costumes?.length) return null;
      return { ...c, id: c.id || slug, dir };
    })
  );
  return loaded.filter((c): c is Character => c !== null);
}

export function pickCostume(character: Character, id?: string): Costume {
  return (
    character.costumes.find((c) => c.id === id) ??
    character.costumes.find((c) => c.id === character.defaultCostume) ??
    character.costumes[0]
  );
}

/** Splits a model path into the directory to load from and the file inside it. */
export function resolveModel(character: Character, costume: Costume) {
  const full = `${character.dir}/${costume.model}`;
  const cut = full.lastIndexOf('/');
  return { dir: full.slice(0, cut), file: full.slice(cut + 1) };
}

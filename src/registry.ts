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
 * Coerces whatever `index.json` actually contained into a list of slugs.
 *
 * This file is hand-written when installing a model, so it gets the shape
 * wrong in predictable ways. A bare `"name"` is unambiguous enough to accept;
 * anything else earns a message naming the expected format, because the
 * alternative is a `map is not a function` stack trace at boot.
 */
function toSlugs(raw: unknown, onProblem: (msg: string) => void): string[] {
  if (typeof raw === 'string') {
    onProblem(`models/index.json should be a list: ["${raw}"], not "${raw}"`);
    return [raw];
  }
  if (!Array.isArray(raw)) {
    onProblem('models/index.json must be a list of directory names, e.g. ["my-character"]');
    return [];
  }
  const good = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (good.length !== raw.length) {
    onProblem('models/index.json: every entry must be a directory name in quotes');
  }
  return good;
}

/**
 * `index.json` is a flat list of directory names. A web build cannot list a
 * directory, so the installer writes this file.
 */
export async function loadRegistry(
  onProblem: (msg: string) => void = () => {},
  root = MODELS_ROOT
): Promise<Character[]> {
  const raw = await json<unknown>(`${root}/index.json`);
  if (raw === null) {
    onProblem(`no ${root}/index.json — see README, "Adding a character"`);
    return [];
  }

  const loaded = await Promise.all(
    toSlugs(raw, onProblem).map(async (slug) => {
      const dir = `${root}/${slug}`;
      const c = await json<Character>(`${dir}/character.json`);
      // say which character failed: index.json lists it, so a miss is a typo
      // in the name or a file that was never written
      if (c === null) {
        onProblem(`${slug}: no character.json in ${dir} (or it isn't valid JSON)`);
        return null;
      }
      if (!c.costumes?.length) {
        onProblem(`${slug}: character.json has no "costumes" entries`);
        return null;
      }
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

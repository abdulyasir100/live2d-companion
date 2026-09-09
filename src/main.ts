/**
 * Spike harness: prove Cubism 5 Core loads a scraped moc3 v5, render it, and
 * cycle the expressions that came out of the game bundles.
 */
import { CubismFramework, Option } from '../vendor/CubismWebFramework/src/live2dcubismframework';
import { LogLevel } from '../vendor/CubismWebFramework/src/live2dcubismframework';
import { CompanionModel } from './model';
import { installCoreCompat } from './core-compat';
import {
  setupPet,
  report,
  saveCapture,
  enableResize,
  onNextCostume,
  onCursor,
  inTauri
} from './pet';
import { LipSync } from './audio';
import { Companion } from './companion';
import { IdleDirector } from './idle';
import { loadRegistry, pickCostume, resolveModel } from './registry';



// Optional server link. Baked in from VITE_AVATAR_HOST (see .env.example), or
// set at runtime with localStorage.setItem('avatarHost', 'host:port'), which
// also lets a shipped build be repointed without a rebuild. Empty is fine —
// she just runs on her own.
const AVATAR_HOST: string =
  localStorage.getItem('avatarHost') ??
  (import.meta as any).env?.VITE_AVATAR_HOST ??
  '';

// Which character/costume to show. Models are user-supplied and discovered at
// runtime, so nothing here names a specific one.
const WANT_CHARACTER = localStorage.getItem('character') ?? undefined;
const WANT_COSTUME = localStorage.getItem('costume') ?? undefined;

let voiceUrl = '';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const logEl = document.getElementById('log') as HTMLDivElement;

const lines: HTMLElement[] = [];
const log = (msg: string, tone: 'plain' | 'ok' | 'fail' = 'plain') => {
  const el = document.createElement(tone === 'ok' ? 'b' : tone === 'fail' ? 'i' : 'span');
  el.textContent = msg; // messages can carry URLs and error text — never innerHTML
  lines.push(el);
  logEl.replaceChildren(
    ...lines.slice(-4).flatMap((n, i) => (i ? [document.createTextNode('\n'), n] : [n]))
  );
};
const ok = (msg: string) => log(msg, 'ok');
const fail = (msg: string) => log(msg, 'fail');

async function main() {
  // sizes the drawing buffer to the window before WebGL sees it
  await setupPet(canvas);

  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return fail('no WebGL context');

  installCoreCompat(log);

  const option = new Option();
  option.logFunction = (m: string) => console.log('[cubism]', m);
  option.loggingLevel = LogLevel.LogLevel_Warning;
  CubismFramework.startUp(option);
  CubismFramework.initialize();
  log(`Core ${Live2DCubismCore.Version.csmGetVersion()}, ` +
      `newest moc3 it supports: ${Live2DCubismCore.Version.csmGetLatestMocVersion()}`);

  // a bad registry is the first thing a new install hits, so say what is
  // wrong on screen rather than only in the console
  const problems: string[] = [];
  const characters = await loadRegistry((msg) => {
    problems.push(msg);
    fail(msg);
    report(`registry: ${msg}`);
  });
  if (!characters.length) {
    report('no models installed under public/models/');
    if (!problems.length) {
      fail('No characters installed. Add one under public/models/ — see README.');
    }
    return;
  }

  const character =
    characters.find((c) => c.id === WANT_CHARACTER) ?? characters[0];
  let current = pickCostume(character, WANT_COSTUME);
  const { dir, file } = resolveModel(character, current);
  voiceUrl = `${character.dir}/${character.voice ?? 'voice'}/greet.wav`;
  log(`${character.name} — ${current.name}`);

  let model: CompanionModel;
  try {
    model = await CompanionModel.load(
      gl,
      dir,
      file,
      log,
      character.motions ? `${character.dir}/${character.motions}` : undefined
    );
  } catch (e) {
    console.error('[load]', e);
    return fail(`load failed: ${(e as Error).message}`);
  }
  report(`loaded ${character.id}/${current.id} (${characters.length} character(s) installed)`);
  ok(`rendering — ${model.getModel().getParameterCount()} parameters live`);
  const stage = () => model;
  (window as any).__model = stage;
  enableResize(canvas, model.artAspect);

  await model.loadMotions();

  /**
   * Swaps costume in place. Outfits differ in rig and silhouette, so the old
   * model's GPU resources are released and the window re-fitted to the new one.
   */
  let switching = false;
  const switchCostume = async (id: string): Promise<void> => {
    const next = character.costumes.find((c) => c.id === id);
    if (!next || switching || next.id === current.id) return;
    switching = true;
    const previous = model;
    try {
      const at = resolveModel(character, next);
      const fresh = await CompanionModel.load(
        gl,
        at.dir,
        at.file,
        () => {},
        character.motions ? `${character.dir}/${character.motions}` : undefined
      );
      await fresh.loadMotions();
      model = fresh;
      current = next;
      localStorage.setItem('costume', next.id);
      previous.release();
      enableResize(canvas, model.artAspect);
      report(`costume -> ${next.id} (aspect ${model.artAspect.toFixed(3)})`);
      log(`costume: ${next.name}`);
    } catch (e) {
      report(`costume switch failed: ${(e as Error).message}`);
    } finally {
      switching = false;
    }
  };
  (window as any).__switchCostume = switchCostume;

  const cycleCostume = () => {
    const list = character.costumes;
    const at = list.findIndex((c) => c.id === current.id);
    void switchCostume(list[(at + 1) % list.length].id);
  };
  onNextCostume(cycleCostume);
  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) cycleCostume(); // middle-click, for when the tray is hidden
  });

  if (character.costumes.length > 1) {
    const picker = document.createElement('select');
    for (const c of character.costumes) {
      const opt = new Option(c.name, c.id);
      opt.selected = c.id === current.id;
      picker.append(opt);
    }
    picker.onchange = () => switchCostume(picker.value);
    hud.appendChild(picker);
  }

  for (const name of model.expressions.keys()) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => model.setExpression(name);
    hud.appendChild(b);
  }

  if (model.motionIndex.length) {
    const picker = document.createElement('select');
    picker.append(new Option(`${model.motionIndex.length} motions…`, ''));
    for (const e of model.motionIndex) {
      picker.append(new Option(`${e.name}  (${e.duration.toFixed(1)}s)`, e.name));
    }
    picker.onchange = () => picker.value && model.playMotion(picker.value);
    hud.appendChild(picker);
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const lipSync = new LipSync();
  (window as any).__lipSync = lipSync;

  // Natively she follows the OS cursor anywhere on screen; the DOM fallback is
  // for the browser harness, where only in-window movement is visible. Running
  // both would fight, since they measure from different origins.
  if (inTauri()) {
    let firstCursor = true;
    onCursor((x, y) => {
      model.lookAt(x, y);
      if (firstCursor) {
        firstCursor = false;
        report(`global cursor tracking live (${x.toFixed(2)}, ${y.toFixed(2)})`);
      }
    });
  } else {
    const track = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      model.lookAt(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -(((e.clientY - r.top) / r.height) * 2 - 1)
      );
    };
    window.addEventListener('mousemove', track);
    window.addEventListener('mouseleave', () => model.lookAt(0, 0));
  }

  const speak = document.createElement('button');
  speak.textContent = 'speak';
  speak.onclick = () => lipSync.play(voiceUrl).catch((e) => fail(String(e)));
  hud.appendChild(speak);

  const idle = new IdleDirector(stage, {
    onPlay: (name) => report(`idle ${name}`)
  });
  (window as any).__idle = idle;

  // with no host configured she simply runs offline, rather than retrying a
  // socket that was never going to connect
  if (AVATAR_HOST) {
    const companion = new Companion(stage, lipSync, {
      host: AVATAR_HOST,
      onState: (s) => {
        log(`avatar-server: ${s}`);
        report(`ws ${s} (${AVATAR_HOST})`);
        if (s === 'sleeping' || s === 'awake') idle.setSleeping(s === 'sleeping');
      },
      onReply: (text, emotion) => {
        report(`reply [${emotion}] ${text.slice(0, 80)}`);
        void captureReaction(model, emotion);
      }
    });
    companion.connect();
    (window as any).__companion = companion;
  } else {
    log('no avatarHost set — offline');
  }

  const probe = { done: false, painted: 0, glError: 0 };
  (window as any).__spike = probe;

  // grabbing the canvas has to happen inside the frame for the same reason as
  // the coverage probe, so expose a request the render loop fulfils
  let pendingCapture: ((dataUrl: string) => void) | null = null;
  (window as any).__capture = (w = 320, crop?: [number, number, number, number]) =>
    new Promise<string>((resolve) => {
      pendingCapture = (url) => resolve(url);
      (window as any).__captureOpts = { w, crop };
    });

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, canvas.width, canvas.height);

    model.setMouthOpen(lipSync.update(dt));
    idle.update(dt, lipSync.speaking);
    model.update(dt);
    model.draw(gl, canvas.width, canvas.height);

    // coverage has to be sampled inside the frame: without preserveDrawingBuffer
    // the drawing buffer reads back empty once the frame ends
    if (!probe.done) {
      const px = new Uint8Array(4);
      let painted = 0;
      for (let x = 1; x < 8; x++)
        for (let y = 1; y < 8; y++) {
          gl.readPixels(((canvas.width * x) / 8) | 0, ((canvas.height * y) / 8) | 0,
                        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (px[3] > 8) painted++;
        }
      probe.painted = painted;
      probe.glError = gl.getError();
      probe.done = true;
    }

    if (pendingCapture) {
      const { w = 320, crop } = (window as any).__captureOpts ?? {};
      const [sx, sy, sw, sh] = crop ?? [0, 0, canvas.width, canvas.height];
      const shot = document.createElement('canvas');
      shot.width = w;
      shot.height = Math.round((w * sh) / sw);
      shot
        .getContext('2d')!
        .drawImage(canvas, sx, sy, sw, sh, 0, 0, shot.width, shot.height);
      const done = pendingCapture;
      pendingCapture = null;
      done(shot.toDataURL('image/png'));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  await selfCheck(model, lipSync);
}

/**
 * Records what she actually did in response to a server reply - mouth movement
 * proves the audio reached the lip sync, and the frame shows the expression.
 */
async function captureReaction(model: CompanionModel, emotion: string): Promise<void> {
  const core = model.getModel()._model;
  const ids: string[] = Array.from(core.parameters.ids);
  const mouth = ids.indexOf('ParamMouthOpenY');
  const arm = ids.indexOf('ParamArmR01');

  const mouthSeen: number[] = [];
  const armSeen: number[] = [];
  for (let i = 0; i < 110; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (mouth >= 0) mouthSeen.push(core.parameters.values[mouth]);
    if (arm >= 0) armSeen.push(core.parameters.values[arm]);
    if (i === 45) {
      const grab = (window as any).__capture as (w: number) => Promise<string>;
      await saveCapture('capture-reaction', await grab(420));
    }
  }
  const range = (s: number[]) =>
    s.length ? +(Math.max(...s) - Math.min(...s)).toFixed(2) : -1;
  report(
    `reaction [${emotion}] mouth=${range(mouthSeen)} arm=${range(armSeen)}`
  );
}

/**
 * Exercises look-tracking and lip sync and reports the parameter ranges, so the
 * running app can be verified from the Rust log without a browser attached.
 */
async function selfCheck(model: CompanionModel, lipSync: LipSync): Promise<void> {
  const core = model.getModel()._model;
  const ids: string[] = Array.from(core.parameters.ids);
  const spread = async (frames: number, watch: string[]) => {
    const seen: Record<string, number[]> = Object.fromEntries(watch.map((n) => [n, []]));
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      for (const n of watch) {
        const k = ids.indexOf(n);
        if (k >= 0) seen[n].push(core.parameters.values[k]);
      }
    }
    return Object.fromEntries(
      Object.entries(seen).map(([n, s]) => [
        n,
        s.length ? +(Math.max(...s) - Math.min(...s)).toFixed(2) : -1
      ])
    );
  };

  const eyes = ['ParamAngleX', 'ParamEyeBallX', 'ParamMouthOpenY'];
  model.lookAt(-1, -1);
  await spread(12, eyes);
  model.lookAt(1, 1);
  const looking = await spread(25, eyes);
  model.lookAt(0, 0);

  let speaking: Record<string, number> = { ParamMouthOpenY: -1 };
  try {
    const dur = await lipSync.play(voiceUrl);
    speaking = await spread(Math.min(90, Math.ceil(dur * 60)), ['ParamMouthOpenY']);
  } catch (e) {
    report(`lipsync unavailable: ${(e as Error).message}`);
  }

  report(
    `selfcheck look ParamAngleX=${looking.ParamAngleX} ParamEyeBallX=${looking.ParamEyeBallX} | ` +
      `speak ParamMouthOpenY=${speaking.ParamMouthOpenY}`
  );

  // pull the camera back far enough to show the whole model canvas, so anything
  // outside the normal framing (legs, feet) becomes visible if it exists
  const grab = (window as any).__capture as (w: number) => Promise<string>;

  for (const [name, zoom] of [['capture-normal', 1.0], ['capture-wide', 0.42]] as const) {
    model.zoom = zoom;
    await new Promise((r) => requestAnimationFrame(r));
    await saveCapture(name, await grab(560));
  }
  model.zoom = 1.0;
}

main().catch((e) => fail(String(e)));

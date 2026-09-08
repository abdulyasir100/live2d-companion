/**
 * Loads a rebuilt Cubism model (moc3 + textures + expressions) and drives it.
 *
 * The scraped models ship no motion files, so idle life comes from the
 * framework's procedural effects - CubismEyeBlink and CubismBreath - rather
 * than from .motion3.json playback.
 */
import { CubismUserModel } from '../vendor/CubismWebFramework/src/model/cubismusermodel';
import { CubismModelSettingJson } from '../vendor/CubismWebFramework/src/cubismmodelsettingjson';
import { CubismMatrix44 } from '../vendor/CubismWebFramework/src/math/cubismmatrix44';
import { CubismEyeBlink } from '../vendor/CubismWebFramework/src/effect/cubismeyeblink';
import {
  CubismBreath,
  BreathParameterData
} from '../vendor/CubismWebFramework/src/effect/cubismbreath';
import { CubismFramework } from '../vendor/CubismWebFramework/src/live2dcubismframework';
import { CubismDefaultParameterId as DefaultId } from '../vendor/CubismWebFramework/src/cubismdefaultparameterid';
import { csmVector } from '../vendor/CubismWebFramework/src/type/csmvector';

const fetchBuffer = async (url: string): Promise<ArrayBuffer> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.arrayBuffer();
};

function makeTexture(gl: WebGLRenderingContext, img: HTMLImageElement): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export class CompanionModel extends CubismUserModel {
  private setting: CubismModelSettingJson;
  private projection = new CubismMatrix44();
  private baseDir = '';
  readonly expressions = new Map<string, any>();
  readonly motions = new Map<string, any>();
  motionIndex: { name: string; file: string; duration: number; loop: boolean }[] = [];
  mocVersion = 0;

  /** Motion index URL; motions live at character level, shared by costumes. */
  motionsUrl?: string;

  static async load(
    gl: WebGLRenderingContext,
    baseDir: string,
    model3: string,
    onStep: (msg: string) => void,
    motionsUrl?: string
  ): Promise<CompanionModel> {
    const self = new CompanionModel();
    const settingBuf = await fetchBuffer(`${baseDir}/${model3}`);
    self.setting = new CubismModelSettingJson(settingBuf, settingBuf.byteLength);

    const mocBuf = await fetchBuffer(`${baseDir}/${self.setting.getModelFileName()}`);
    // read the version straight from the header rather than via the framework,
    // whose helper for this moved between releases
    self.mocVersion = new Uint8Array(mocBuf)[4];
    const supported = Live2DCubismCore.Version.csmGetLatestMocVersion();
    onStep(`moc3 v${self.mocVersion}, Core supports up to v${supported}`);
    if (self.mocVersion > supported) {
      throw new Error(`moc3 v${self.mocVersion} is newer than this Core (v${supported})`);
    }

    self.loadModel(mocBuf, true); // consistency-check the moc while we're here
    if (!self.getModel()) throw new Error('Core rejected the moc3');

    // physics is optional and not yet rebuilt for these models
    const physicsFile = self.setting.getPhysicsFileName();
    if (physicsFile) {
      const buf = await fetchBuffer(`${baseDir}/${physicsFile}`);
      self.loadPhysics(buf, buf.byteLength);
      onStep('physics loaded');
    }

    for (let i = 0; i < self.setting.getExpressionCount(); i++) {
      const name = self.setting.getExpressionName(i);
      const buf = await fetchBuffer(`${baseDir}/${self.setting.getExpressionFileName(i)}`);
      const motion = self.loadExpression(buf, buf.byteLength, name);
      if (motion) self.expressions.set(name, motion);
    }
    onStep(`${self.expressions.size} expressions loaded`);

    self.setupIdle();

    const count = self.setting.getTextureCount();
    self.createRenderer(0, 0);
    self.getRenderer().startUp(gl);
    self.getRenderer().setIsPremultipliedAlpha(true);
    for (let i = 0; i < count; i++) {
      const img = new Image();
      img.src = `${baseDir}/${self.setting.getTextureFileName(i)}`;
      await img.decode();
      self.getRenderer().bindTexture(i, makeTexture(gl, img));
    }
    onStep(`${count} texture(s) bound`);

    self.baseDir = baseDir;
    self.motionsUrl = motionsUrl ?? `${baseDir}/motions/index.json`;
    self.setInitialized(true);
    return self;
  }

  /**
   * CubismMotion leaves its eye-blink and lip-sync id lists null until the app
   * supplies them, and dereferences them on the first update — so every loaded
   * motion needs these, even when the lists are empty.
   */
  private effectIds(): [csmVector<any>, csmVector<any>] {
    if (!this._effectIds) {
      const eye = new csmVector<any>();
      for (let i = 0; i < this.setting.getEyeBlinkParameterCount(); i++) {
        eye.pushBack(this.setting.getEyeBlinkParameterId(i));
      }
      const lip = new csmVector<any>();
      for (let i = 0; i < this.setting.getLipSyncParameterCount(); i++) {
        lip.pushBack(this.setting.getLipSyncParameterId(i));
      }
      this._effectIds = [eye, lip];
    }
    return this._effectIds;
  }
  private _effectIds?: [csmVector<any>, csmVector<any>];

  /** Motions are optional — without them she still blinks and breathes. */
  async loadMotions(): Promise<number> {
    if (!this.motionsUrl) return 0;
    const res = await fetch(this.motionsUrl).catch(() => null);
    if (!res?.ok) return 0;
    this.motionIndex = await res.json();
    this.motionsBase = this.motionsUrl.slice(0, this.motionsUrl.lastIndexOf('/'));
    return this.motionIndex.length;
  }

  private motionsBase = '';

  /** True when no motion is playing, so something else may take the body. */
  get motionIdle(): boolean {
    return !this._motionManager || this._motionManager.isFinished();
  }

  async playMotion(name: string): Promise<boolean> {
    let motion = this.motions.get(name);
    if (!motion) {
      const entry = this.motionIndex.find((e) => e.name === name);
      if (!entry) return false;
      const buf = await fetchBuffer(`${this.motionsBase}/${entry.file}`);
      motion = this.loadMotion(buf, buf.byteLength, name);
      if (!motion) return false;
      motion.setEffectIds(...this.effectIds());
      motion.setIsLoop?.(entry.loop);
      this.motions.set(name, motion);
    }
    this._motionManager.startMotion(motion, false);
    return true;
  }

  /** Blink and breathe without any motion files. */
  private setupIdle(): void {
    this._eyeBlink = CubismEyeBlink.create(this.setting);

    const id = CubismFramework.getIdManager();
    // offset, peak, cycle, weight — slow, out-of-phase cycles so the idle never
    // visibly loops
    const breath = new csmVector<BreathParameterData>();
    for (const [param, offset, peak, cycle, weight] of [
      [DefaultId.ParamAngleX, 0.0, 15.0, 6.5345, 0.5],
      [DefaultId.ParamAngleY, 0.0, 8.0, 3.5345, 0.5],
      [DefaultId.ParamAngleZ, 0.0, 10.0, 5.5345, 0.5],
      [DefaultId.ParamBodyAngleX, 0.0, 4.0, 15.5345, 0.5],
      [DefaultId.ParamBreath, 0.5, 0.5, 3.2345, 0.5]
    ] as [string, number, number, number, number][]) {
      breath.pushBack(
        new BreathParameterData(id.getId(param), offset, peak, cycle, weight)
      );
    }
    this._breath = CubismBreath.create();
    this._breath.setParameters(breath);
  }

  setExpression(name: string): void {
    const motion = this.expressions.get(name);
    if (motion) this._expressionManager.startMotion(motion, false);
  }

  /** Where she should be looking, in -1..1 across the viewport. */
  lookAt(x: number, y: number): void {
    this.lookTarget.x = Math.max(-1, Math.min(1, x));
    this.lookTarget.y = Math.max(-1, Math.min(1, y));
  }

  /** 0..1 mouth openness; set every frame while speaking, 0 when silent. */
  setMouthOpen(v: number): void {
    this.mouthOpen = v;
  }

  private lookTarget = { x: 0, y: 0 };
  private lookCurrent = { x: 0, y: 0 };
  private mouthOpen = 0;
  private ids?: Record<string, any>;

  private id(name: string) {
    if (!this.ids) this.ids = {};
    return (this.ids[name] ??= CubismFramework.getIdManager().getId(name));
  }

  update(dt: number): void {
    const model = this.getModel();
    model.loadParameters(); // restore last frame, then re-apply everything

    // a playing motion owns the pose; blink only runs when nothing else drives it
    let motionPlayed = false;
    if (this._motionManager && !this._motionManager.isFinished()) {
      motionPlayed = this._motionManager.updateMotion(model, dt);
    }
    model.saveParameters();

    this._expressionManager?.updateMotion(model, dt);
    if (!motionPlayed) this._eyeBlink?.updateParameters(model, dt);

    // Look and speech are layered on top of whatever the motion did, so she can
    // track the cursor mid-gesture. Applied before physics, so the hair follows.
    const ease = Math.min(1, 9 * dt); // higher = snappier tracking, lower = floatier
    this.lookCurrent.x += (this.lookTarget.x - this.lookCurrent.x) * ease;
    this.lookCurrent.y += (this.lookTarget.y - this.lookCurrent.y) * ease;
    const { x, y } = this.lookCurrent;
    model.addParameterValueById(this.id('ParamAngleX'), x * 30);
    model.addParameterValueById(this.id('ParamAngleY'), y * 30);
    model.addParameterValueById(this.id('ParamAngleZ'), x * y * -30);
    model.addParameterValueById(this.id('ParamBodyAngleX'), x * 10);
    model.addParameterValueById(this.id('ParamEyeBallX'), x);
    model.addParameterValueById(this.id('ParamEyeBallY'), y);

    if (this.mouthOpen > 0.01) {
      model.setParameterValueById(this.id('ParamMouthOpenY'), this.mouthOpen);
      model.setParameterValueById(this.id('ParamLipSync'), this.mouthOpen);
    }

    this._breath?.updateParameters(model, dt);
    this._physics?.evaluate(model, dt);
    model.update();
  }

  /** <1 pulls the camera back, revealing anything outside the normal framing. */
  zoom = 1.0;
  /** Fraction of the viewport left empty around her when fitting. */
  margin = 0.06;
  private art?: { cx: number; cy: number; w: number; h: number };

  /**
   * Bounding box of every drawable, in model units.
   *
   * This model is cropped mid-thigh, so its art fills only part of the model
   * canvas - fitting to the canvas would leave a third of the window empty.
   * Fitting to the art itself frames whatever the model actually draws.
   */
  private artBounds() {
    if (this.art) return this.art;
    const d = this.getModel()._model.drawables;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < d.count; i++) {
      const v = d.vertexPositions[i];
      for (let k = 0; k < v.length; k += 2) {
        if (v[k] < x0) x0 = v[k];
        if (v[k] > x1) x1 = v[k];
        if (v[k + 1] < y0) y0 = v[k + 1];
        if (v[k + 1] > y1) y1 = v[k + 1];
      }
    }
    this.art = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    return this.art;
  }

  /** Width/height of the drawn artwork - the aspect the window should hold. */
  get artAspect(): number {
    const a = this.artBounds();
    return a.w / a.h;
  }

  draw(gl: WebGLRenderingContext, width: number, height: number): void {
    // fit the model's canvas into the viewport without distorting it
    this.projection.loadIdentity();
    this.projection.scale(1.0, width / height);
    this.projection.multiplyByMatrix(this._modelMatrix);

    // then scale and centre so the artwork fills the viewport
    const a = this.artBounds();
    const m = this._modelMatrix.getArray();
    const aspect = width / height;
    const wClip = a.w * m[0];
    const hClip = a.h * m[5] * aspect;
    const usable = 2 * (1 - this.margin);
    const k = Math.min(usable / wClip, usable / hClip) * this.zoom;
    const cx = a.cx * m[0] + m[12];
    const cy = (a.cy * m[5] + m[13]) * aspect;
    this.projection.scaleRelative(k, k);
    this.projection.translateRelative(-k * cx, -k * cy);

    const renderer = this.getRenderer();
    renderer.setMvpMatrix(this.projection);
    renderer.setRenderState(null, [0, 0, width, height]);
    renderer.drawModel();
  }
}
